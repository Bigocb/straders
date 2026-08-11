/**
 * Minimal OpenAI-compatible chat client used by the co-pilot agent.
 *
 * Kept dependency-free so the agent framework stays swappable: the rest of the
 * code talks to `ChatLLM` (an interface), so swapping in LangGraph / ADK / the
 * Anthropic SDK later means replacing only this file.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Tool-call id, only for messages that are tool *results*. */
  tool_call_id?: string;
  /** Present when this assistant message contains tool calls. */
  tool_calls?: ChatToolCall[];
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A tool the agent can invoke. `execute` receives parsed args, returns text. */
export interface ChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Whether the tool mutates state. Reserved for later execution expansion. */
  readOnly?: boolean;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface ChatLLMOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Seconds to wait before giving up on a request. */
  timeoutMs?: number;
  /** Optional callback for debugging model/tool activity. */
  onEvent?: (event: { type: "model_start" | "tool_call" | "tool_result" | "model_complete"; detail: string }) => void;
}

const DEFAULT_BASE = "https://ollama.com/v1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** OpenAI-compatible chat completions client with streaming + tool calls. */
export class ChatLLM {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly onEvent: ChatLLMOptions["onEvent"];

  constructor(opts: ChatLLMOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? process.env.ST_LLM_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.onEvent = opts.onEvent;
  }

  private async request(
    messages: ChatMessage[],
    tools: ChatTool[] | undefined,
    signal?: AbortSignal,
  ): Promise<{ message: ChatMessage; finishReason: string; usage: { prompt_tokens?: number; completion_tokens?: number } }> {
    this.onEvent?.({ type: "model_start", detail: `${messages.length} messages, ${tools?.length ?? 0} tools` });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          tools: tools?.length ? tools : undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LLM ${res.status}: ${text.slice(0, 500) || res.statusText}`);
      }
      const json = (await res.json()) as {
        choices?: { message: ChatMessage; finish_reason: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = json.choices?.[0];
      if (!choice) throw new Error("LLM returned no choices");
      return {
        message: choice.message ?? { role: "assistant", content: "" },
        finishReason: choice.finish_reason ?? "",
        usage: json.usage ?? {},
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * One-shot completion with no tool loop. Used for generation tasks like the
   * captain's log where the model just writes text from a prompt.
   */
  async complete(
    messages: ChatMessage[],
    opts?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<{ reply: string; usage: { prompt_tokens: number; completion_tokens: number } }> {
    this.onEvent?.({ type: "model_start", detail: `complete: ${messages.length} messages` });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    opts?.signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          max_tokens: opts?.maxTokens,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LLM ${res.status}: ${text.slice(0, 500) || res.statusText}`);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const reply = json.choices?.[0]?.message?.content ?? "";
      this.onEvent?.({ type: "model_complete", detail: `complete reply (${reply.length} chars)` });
      return {
        reply,
        usage: { prompt_tokens: json.usage?.prompt_tokens ?? 0, completion_tokens: json.usage?.completion_tokens ?? 0 },
      };
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Run a chat loop: the model may issue tool calls, which are executed and
   * fed back, until it returns a plain-text reply.
   */
  async run(
    messages: ChatMessage[],
    tools: ChatTool[] = [],
    opts?: { maxIterations?: number; signal?: AbortSignal },
  ): Promise<{ reply: string; history: ChatMessage[]; usage: { prompt_tokens: number; completion_tokens: number } }> {
    const maxIterations = opts?.maxIterations ?? 6;
    const history: ChatMessage[] = [...messages];
    let totalPrompt = 0;
    let totalCompletion = 0;

    for (let i = 0; i < maxIterations; i += 1) {
      const toolDefs = tools.length ? tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        },
      })) : undefined;

      const { message, finishReason, usage } = await this.request(history, tools, opts?.signal);
      totalPrompt += usage.prompt_tokens ?? 0;
      totalCompletion += usage.completion_tokens ?? 0;

      const calls = message.tool_calls ?? [];
      if (calls.length === 0 || finishReason === "stop") {
        history.push(message);
        this.onEvent?.({ type: "model_complete", detail: `reply (${message.content.length} chars)` });
        return { reply: message.content ?? "", history, usage: { prompt_tokens: totalPrompt, completion_tokens: totalCompletion } };
      }

      history.push(message);
      for (const call of calls) {
        const tool = tools.find((t) => t.name === call.function.name);
        let result: string;
        if (!tool) {
          result = `Error: unknown tool "${call.function.name}". Available: ${tools.map((t) => t.name).join(", ")}`;
        } else {
          let args: Record<string, unknown> = {};
          try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch (err) {
            result = `Error: invalid JSON arguments: ${err instanceof Error ? err.message : String(err)}`;
            history.push({ role: "tool", tool_call_id: call.id, content: result });
            continue;
          }
          this.onEvent?.({ type: "tool_call", detail: `${tool.name}(${JSON.stringify(args)})` });
          try {
            result = await tool.execute(args);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
          this.onEvent?.({ type: "tool_result", detail: `${tool.name} -> ${result.slice(0, 120)}` });
        }
        history.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }

    // Max iterations reached without a final reply — surface a partial answer.
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    return {
      reply: lastAssistant?.content || "The agent hit its iteration limit before replying.",
      history,
      usage: { prompt_tokens: totalPrompt, completion_tokens: totalCompletion },
    };
  }
}

/** Tiny retry wrapper for flaky LLM providers. */
export async function withRetry<T>(fn: () => Promise<T>, retries = 2, backoffMs = 1000): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(backoffMs * 2 ** attempt);
    }
  }
}
