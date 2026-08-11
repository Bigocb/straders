import type { ActivityEntry } from "./store.js";
import { ChatLLM, withRetry, type ChatLLMOptions } from "../core/chatLLM.js";

interface ShipSnapshot {
  symbol: string;
  nav?: { waypointSymbol?: string; status?: string };
}

const TONE = [
  "The bridge is quiet except for the hum of the reactors.",
  "Starlight flickers across the command console.",
  "A soft chime marks another completed cycle.",
  "The fleet moves like clockwork through the dark.",
];

function randomPick(arr: string[]): string {
  const item = arr[Math.floor(Math.random() * arr.length)];
  return item ?? "Silence on the comms.";
}

function kindVerb(kind: string): string {
  switch (kind) {
    case "extract": return "extracted";
    case "sell": return "sold";
    case "buy": return "purchased";
    case "navigate": return "navigated";
    case "refuel": return "refueled";
    default: return kind;
  }
}

/** Templated fallback used when no LLM is configured or the call fails. */
export function generateLog(
  activity: ActivityEntry[],
  credits: number,
  ships: ShipSnapshot[],
): string {
  if (activity.length === 0) {
    return `${randomPick(TONE)} Awaiting the first telemetry burst from the fleet.`;
  }
  const latest = activity[0];
  const lines: string[] = [];
  lines.push(`${randomPick(TONE)}`);

  const shipCount = ships.length;
  const activeShips = ships.filter((s) => s.nav?.status !== "DOCKED").length;
  lines.push(`Command reports ${shipCount} ship${shipCount === 1 ? "" : "s"} on the board, ${activeShips} currently underway.`);

  const sells = activity.filter((a) => a.kind === "sell");
  const buys = activity.filter((a) => a.kind === "buy");
  const extracts = activity.filter((a) => a.kind === "extract");

  if (sells.length) {
    const total = sells.reduce((sum, a) => sum + (a.credits ?? 0), 0);
    lines.push(`Recent trades brought in ${total.toLocaleString("en-US")} credits across ${sells.length} transaction${sells.length === 1 ? "" : "s"}.`);
  }
  if (extracts.length) {
    lines.push(`Mining lasers have cut ${extracts.length} new extraction${extracts.length === 1 ? "" : "s"} from the asteroid fields.`);
  }
  if (buys.length) {
    const spent = buys.reduce((sum, a) => sum + Math.abs(a.credits ?? 0), 0);
    lines.push(`The quartermaster logged ${spent.toLocaleString("en-US")} credits in procurement.`);
  }

  if (latest) {
    lines.push(`Latest event: ${latest.shipSymbol} ${kindVerb(latest.kind)} — ${latest.detail}.`);
  }
  lines.push(`Current treasury: ${credits.toLocaleString("en-US")} credits.`);

  return lines.join(" ");
}

const NARRATIVE_SYSTEM = `You are the captain's log of a SpaceTraders fleet — a first-person ship's log written by the captain, not a corporate report.

Write 2-4 sentences in a dry, wry, spacefaring voice. Ground every claim in the telemetry you are given: never invent ships, credits, or events that are not in the data. Vary the phrasing between entries; do not repeat the same opening. Keep it under 60 words. No markdown, no headers, no bullet points — just prose.`;

/** Summarize activity into a compact telemetry block for the model. */
function telemetryBlock(activity: ActivityEntry[], credits: number, ships: ShipSnapshot[]): string {
  const sells = activity.filter((a) => a.kind === "sell");
  const buys = activity.filter((a) => a.kind === "buy");
  const extracts = activity.filter((a) => a.kind === "extract");
  const sellTotal = sells.reduce((sum, a) => sum + (a.credits ?? 0), 0);
  const buyTotal = buys.reduce((sum, a) => sum + Math.abs(a.credits ?? 0), 0);
  const activeShips = ships.filter((s) => s.nav?.status !== "DOCKED").length;
  const latest = activity[0];

  const lines = [
    `Credits: ${credits.toLocaleString("en-US")}`,
    `Ships: ${ships.length} total, ${activeShips} underway`,
    `Recent activity (${activity.length} events):`,
    ...activity.slice(0, 12).map((a) => `- ${a.shipSymbol} ${a.kind}${a.credits ? ` (${a.credits >= 0 ? "+" : ""}${a.credits})` : ""}: ${a.detail}`),
  ];
  if (sells.length) lines.push(`Sells: ${sells.length} for ${sellTotal.toLocaleString("en-US")} credits`);
  if (buys.length) lines.push(`Buys: ${buys.length} for ${buyTotal.toLocaleString("en-US")} credits`);
  if (extracts.length) lines.push(`Extractions: ${extracts.length}`);
  if (latest) lines.push(`Latest: ${latest.shipSymbol} ${latest.kind} — ${latest.detail}`);
  return lines.join("\n");
}

export interface NarrativeWriterOptions {
  llm?: ChatLLM;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  onEvent?: ChatLLMOptions["onEvent"];
}

/**
 * LLM-backed captain's log. Falls back to the templated `generateLog` when no
 * LLM is configured or a generation fails, so the dashboard never goes blank.
 */
export class NarrativeWriter {
  private readonly llm?: ChatLLM;
  private lastKey = "";
  private lastLog = "";

  constructor(opts: NarrativeWriterOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ST_LLM_API_KEY;
    if (apiKey) {
      this.llm =
        opts.llm ??
        new ChatLLM({
          apiKey,
          model: opts.model ?? process.env.ST_LLM_MODEL ?? "deepseek-v4-flash:0731",
          baseUrl: opts.baseUrl,
          onEvent: opts.onEvent,
        });
    }
  }

  /** Whether an LLM is available for narrative generation. */
  get enabled(): boolean {
    return this.llm !== undefined;
  }

  /**
   * Generate a captain's log entry. Cached by a key derived from the latest
   * activity so the dashboard's 15s poll doesn't burn tokens on unchanged data.
   */
  async generate(
    activity: ActivityEntry[],
    credits: number,
    ships: ShipSnapshot[],
  ): Promise<string> {
    const key = `${activity[0]?.timestamp ?? ""}|${activity[0]?.detail ?? ""}|${credits}|${ships.length}`;
    if (key === this.lastKey && this.lastLog) return this.lastLog;
    this.lastKey = key;

    if (!this.llm) return generateLog(activity, credits, ships);

    try {
      const telemetry = telemetryBlock(activity, credits, ships);
      const { reply } = await withRetry(() =>
        this.llm!.complete(
          [
            { role: "system", content: NARRATIVE_SYSTEM },
            { role: "user", content: `Telemetry:\n${telemetry}\n\nWrite today's log entry.` },
          ],
          { maxTokens: 200 },
        ),
      );
      const trimmed = reply.trim();
      this.lastLog = trimmed || generateLog(activity, credits, ships);
      return this.lastLog;
    } catch (err) {
      console.error("[narrative] LLM generation failed, using template:", err instanceof Error ? err.message : err);
      return generateLog(activity, credits, ships);
    }
  }
}
