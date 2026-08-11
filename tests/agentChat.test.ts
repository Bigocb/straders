import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChatLLM, type ChatMessage, type ChatTool } from "../src/core/chatLLM.js";
import { ChatAgent } from "../src/engine/agentChat.js";
import { FleetState } from "../src/engine/state.js";

/** Mock global fetch to serve a scripted sequence of chat completions. */
function mockFetch(responses: unknown[]): void {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () => {
    const body = responses[i] ?? responses[responses.length - 1];
    i += 1;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  (globalThis as any).__restoreFetch = () => {
    globalThis.fetch = original;
  };
}

function completion(message: ChatMessage, finishReason = "stop"): unknown {
  return {
    choices: [{ message, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

describe("ChatLLM", () => {
  it("executes tool calls and feeds results back until a final reply", async () => {
    mockFetch([
      completion(
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_credits", arguments: "{}" } },
          ],
        },
        "tool_calls",
      ),
      completion({ role: "assistant", content: "We have 5000 credits, captain." }),
    ]);
    try {
      const llm = new ChatLLM({ apiKey: "test", model: "test-model", baseUrl: "http://localhost:1" });
      const tool: ChatTool = {
        name: "get_credits",
        description: "Get credits",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => "5000",
      };
      const res = await llm.run([{ role: "user", content: "credits?" }], [tool]);
      assert.equal(res.reply, "We have 5000 credits, captain.");
      assert.ok(res.history.some((m) => m.role === "tool" && m.content === "5000"));
    } finally {
      (globalThis as any).__restoreFetch();
    }
  });

  it("reports unknown tools instead of crashing", async () => {
    mockFetch([
      completion(
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "nope", arguments: "{}" } },
          ],
        },
        "tool_calls",
      ),
      completion({ role: "assistant", content: "done" }),
    ]);
    try {
      const llm = new ChatLLM({ apiKey: "test", model: "test-model", baseUrl: "http://localhost:1" });
      const res = await llm.run([{ role: "user", content: "hi" }], []);
      assert.equal(res.reply, "done");
      const toolMsg = res.history.find((m) => m.role === "tool");
      assert.ok(toolMsg && /unknown tool/.test(toolMsg.content));
    } finally {
      (globalThis as any).__restoreFetch();
    }
  });
});

describe("ChatAgent", () => {
  it("passes user message and returns the reply", async () => {
    const state = new FleetState();
    state.update({
      agent: { symbol: "TEST-01", credits: 5000, shipCount: 2, headquarters: "X1-HQ" } as any,
      systemSymbol: "X1",
      totals: { credits: 1000, buys: 2000, sells: 3000 },
    });
    const llm = new ChatLLM({ apiKey: "test", model: "test-model", baseUrl: "http://localhost:1" });
    (llm as any).run = async (messages: ChatMessage[]) => ({
      reply: "Aye, captain.",
      history: [...messages, { role: "assistant", content: "Aye, captain." }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const agent = new ChatAgent({ state, llm });
    const res = await agent.chat("status?");
    assert.equal(res.reply, "Aye, captain.");
    assert.ok(res.history.some((m) => m.role === "user" && m.content === "status?"));
  });

  it("exposes read-only base tools", () => {
    const agent = new ChatAgent({ state: new FleetState() });
    const names = agent.getTools().map((t) => t.name);
    assert.ok(names.includes("get_fleet_status"));
    assert.ok(names.includes("get_best_trades"));
    assert.ok(agent.getTools().every((t) => t.readOnly === true));
  });
});
