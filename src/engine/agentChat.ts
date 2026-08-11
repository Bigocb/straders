import type { SpaceTradersAPI } from "../core/client.js";
import { ChatLLM, withRetry, type ChatMessage, type ChatTool, type ChatLLMOptions } from "../core/chatLLM.js";
import type { FleetState } from "./state.js";
import type { Store } from "./store.js";
import type { FleetManager } from "./fleet.js";
import type { MarketSnapshot, TradeOpportunity } from "./market.js";
import { MarketIntel } from "./market.js";

/** Live-world snapshot the agent's tools read from. */
export interface ChatAgentContext {
  state: FleetState;
  store?: Store;
  fleet?: FleetManager;
  api?: SpaceTradersAPI;
}

export interface ChatAgentOptions extends ChatAgentContext {
  llm?: ChatLLM;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  agentSymbol?: string;
  /** Custom tools to add (e.g. future execution tools). */
  extraTools?: ChatTool[];
  onEvent?: ChatLLMOptions["onEvent"];
}

const CURRENT_SYSTEM = `You are the onboard tactical AI of a SpaceTraders fleet — an AI crewmate with a dry, confident personality.

You live inside the fleet's systems and you know it intimately: you can read the ship registry, market feeds, price history, the ledger, survey data and current missions. You talk like someone who has been flying cargo haulers for years, not a corporate assistant. Short sentences. A little wry. Occasionally a spaceport metaphor. You call the human operator "captain".

Your job is to help the captain with planning, answering questions, and pointing out what the data says. You answer from live data via your tools whenever the question touches fleet status, credits, markets, prices, routes, ships or missions. You never fabricate numbers — if you have not fetched it, you say so and fetch it.

Rules:
- Answer in the same language the captain uses.
- Keep answers focused: a verdict first, then a line or two of reasoning.
- When giving a plan, propose the next concrete action and note the cost/benefit.
- If something looks broken (stranded ship, no fuel, bad spread), say so plainly.
- You may call tools to gather the facts, then reply.

A few real examples the captain may care about:
- "Are we profitable?" — fetch the ledger totals and recent activity.
- "Where should the next hauler run?" — fetch best trades and market snapshots.
- "Is my fleet stuck?" — check fleet status and stranded ships.
- "What can we afford?" — fetch the agent's credits.
- "How's a price moving?" — fetch price history for the good.
- "What's trading in system X?" — if the store has no data for that system, call scan_system_markets to pull live prices, then answer from the fresh data.
- "How far is it between waypoints?" — call get_waypoint_coords for the system, then get_distance for the leg(s).

You do not take action on the fleet (no moving ships, no purchases). You only advise.`;

/** Default model for the co-pilot. */
const DEFAULT_MODEL = "deepseek-v4-flash:0731";

/**
 * Co-pilot agent for the command center. A read-only tactical AI that plans
 * and answers from live fleet data. Adding an execution tool later is one
 * object in `tools` — nothing else changes.
 */
export class ChatAgent {
  private readonly llm: ChatLLM;
  private readonly context: ChatAgentContext;
  private readonly tools: ChatTool[];

  constructor(opts: ChatAgentOptions) {
    const llm =
      opts.llm ??
      new ChatLLM({
        apiKey: opts.apiKey ?? process.env.ST_LLM_API_KEY ?? "",
        model: opts.model ?? process.env.ST_LLM_MODEL ?? DEFAULT_MODEL,
        baseUrl: opts.baseUrl,
        onEvent: opts.onEvent,
      });
    this.llm = llm;
    this.context = { state: opts.state, store: opts.store, fleet: opts.fleet, api: opts.api };
    this.tools = [
      ...this.baseTools(),
      ...(opts.extraTools ?? []),
    ];
  }

  /** Build the tools that read live fleet state. */
  private baseTools(): ChatTool[] {
    const ctx = this.context;
    return [
      {
        name: "get_fleet_status",
        description: "Current fleet status: paused, running, per-ship role/status, and any stranded ships.",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          const s = ctx.state.get();
          if (!ctx.fleet) return JSON.stringify({ error: "fleet not ready" });
          const status = ctx.fleet.getShipStatuses();
          const stranded = ctx.fleet.getStrandedShips();
          return JSON.stringify({
            paused: ctx.fleet.isPaused(),
            credits: s.agent?.credits ?? null,
            ships: status,
            stranded,
          });
        },
      },
      {
        name: "get_agent",
        description: "The agent profile: symbol, credits, ship count, headquarters.",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          const a = ctx.state.get().agent;
          if (!a) return JSON.stringify({ error: "agent not loaded yet" });
          return JSON.stringify({ symbol: a.symbol, credits: a.credits, shipCount: a.shipCount, headquarters: a.headquarters });
        },
      },
      {
        name: "get_systems",
        description: "Known star systems and their jump-gate connections.",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          if (!ctx.fleet) return JSON.stringify({ error: "fleet not ready" });
          return JSON.stringify({
            systems: ctx.fleet.getGalaxy().listSystems().map((s) => s.symbol),
            connections: ctx.fleet.getGalaxy().jumpConnections(),
          });
        },
      },
      {
        name: "get_waypoint_coords",
        description:
          "Coordinates (x, y) of waypoints in a system, plus their type. Use this to reason about distances between waypoints.",
        parameters: {
          type: "object",
          properties: { system: { type: "string", description: "System symbol, e.g. X1-BY69" } },
        },
        readOnly: true,
        execute: async ({ system }) => {
          if (!ctx.fleet) return JSON.stringify({ error: "fleet not ready" });
          const positions = ctx.fleet.getGalaxy().allPositions();
          const filtered = system ? positions.filter((p) => p.systemSymbol === String(system)) : positions;
          return JSON.stringify(
            filtered.map((p) => ({ symbol: p.symbol, x: p.x, y: p.y, type: p.type, system: p.systemSymbol })),
          );
        },
      },
      {
        name: "get_distance",
        description:
          "Straight-line distance (and estimated fuel units) between two waypoints. Waypoints must be in the same system.",
        parameters: {
          type: "object",
          properties: {
            from: { type: "string", description: "Origin waypoint symbol, e.g. X1-BY69-H55" },
            to: { type: "string", description: "Destination waypoint symbol, e.g. X1-BY69-F52" },
            waypointSymbol: { type: "string", description: "Alias for from." },
            waypointSymbol2: { type: "string", description: "Alias for to." },
            originSymbol: { type: "string", description: "Alias for from." },
            destinationSymbol: { type: "string", description: "Alias for to." },
            waypointA: { type: "string", description: "Alias for from." },
            waypointB: { type: "string", description: "Alias for to." },
          },
        },
        readOnly: true,
        execute: async (args) => {
          if (!ctx.fleet) return JSON.stringify({ error: "fleet not ready" });
          const from = String(args.from ?? args.waypointSymbol ?? args.originSymbol ?? args.waypointA ?? "").trim();
          const to = String(args.to ?? args.waypointSymbol2 ?? args.destinationSymbol ?? args.waypointB ?? "").trim();
          if (!from || !to) {
            return JSON.stringify({ error: "from and to waypoint symbols required" });
          }
          const positions = ctx.fleet.getGalaxy().allPositions();
          const a = positions.find((p) => p.symbol === from);
          const b = positions.find((p) => p.symbol === to);
          if (!a || !b) {
            return JSON.stringify({
              error: `Unknown waypoint(s): ${!a ? from : ""} ${!b ? to : ""}. Call get_waypoint_coords to list known waypoints.`,
            });
          }
          if (a.systemSymbol !== b.systemSymbol) {
            return JSON.stringify({ error: "Waypoints are in different systems; distance requires a jump gate." });
          }
          const dist = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y)));
          return JSON.stringify({ from: a.symbol, to: b.symbol, system: a.systemSymbol, distance: dist, estimatedFuel: dist });
        },
      },
      {
        name: "get_ship",
        description: "Live state for one ship by symbol: nav, fuel, cargo, role.",
        parameters: {
          type: "object",
          properties: { shipSymbol: { type: "string", description: "Ship symbol, e.g. SHIP-ABC-01" } },
          required: ["shipSymbol"],
        },
        readOnly: true,
        execute: async ({ shipSymbol }) => {
          if (!ctx.api) return JSON.stringify({ error: "API not available" });
          const ship = await ctx.api.getShip(String(shipSymbol));
          return JSON.stringify({
            symbol: ship.symbol,
            role: ctx.fleet?.getShipStatuses().find((s) => s.symbol === ship.symbol)?.role ?? "idle",
            nav: ship.nav,
            fuel: ship.fuel,
            cargo: ship.cargo,
          });
        },
      },
      {
        name: "list_ships",
        description: "All ships in the fleet, their role, and current status.",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          const ships = ctx.state.get().ships ?? [];
          const statuses = ctx.fleet?.getShipStatuses() ?? [];
          return JSON.stringify(
            ships.map((s) => {
              const st = statuses.find((x) => x.symbol === s.symbol);
              return {
                symbol: s.symbol,
                role: st?.role ?? "idle",
                status: s.nav.status,
                waypoint: s.nav.waypointSymbol,
                fuel: s.fuel.current,
                fuelCapacity: s.fuel.capacity,
                cargo: s.cargo.units,
                cargoCapacity: s.cargo.capacity,
              };
            }),
          );
        },
      },
      {
        name: "get_contracts",
        description: "Active contracts: accepted, deadlines, deliverables and payment.",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          const contracts = ctx.state.get().contracts ?? [];
          return JSON.stringify(
            contracts.map((c) => ({
              id: c.id,
              type: c.type,
              accepted: c.accepted,
              deadlineToAccept: c.deadlineToAccept,
              deadlineToFulfill: c.terms.deadline,
              payment: c.terms.payment,
              deliverables: c.terms.deliver ?? [],
            })),
          );
        },
      },
      {
        name: "get_best_trades",
        description: "Best buy-low/sell-high spreads across known markets, by profit margin. Optionally filter by system or trade good.",
        parameters: {
          type: "object",
          properties: {
            system: { type: "string", description: "Optional system symbol, e.g. X1-BY69" },
            good: { type: "string", description: "Optional trade good symbol, e.g. IRON" },
          },
        },
        readOnly: true,
        execute: async ({ system, good }) => {
          if (!ctx.store) return JSON.stringify({ error: "store not available" });
          let trades = ctx.store.bestTrades(system ? String(system) : undefined);
          if (good) trades = trades.filter((t) => t.goodSymbol === String(good));
          const out = trades.slice(0, 10);
          if (out.length === 0 && system) {
            return JSON.stringify({
              trades: out,
              hint: `No recorded trades for ${system}. Call scan_system_markets with system="${system}" to pull live prices from the API, then re-query.`,
            });
          }
          return JSON.stringify(out);
        },
      },
      {
        name: "get_market_snapshots",
        description: "Latest known market prices per good per waypoint. Optionally filter by system or trade good.",
        parameters: {
          type: "object",
          properties: {
            system: { type: "string", description: "Optional system symbol, e.g. X1-BY69" },
            good: { type: "string", description: "Optional trade good symbol, e.g. IRON" },
          },
        },
        readOnly: true,
        execute: async ({ system, good }) => {
          if (!ctx.store) return JSON.stringify({ error: "store not available" });
          let snaps = ctx.store.latestMarketSnapshots();
          if (system) snaps = snaps.filter((s) => s.systemSymbol === String(system));
          if (good) snaps = snaps.filter((s) => s.goodSymbol === String(good));
          const out = snaps.slice(0, 50);
          if (out.length === 0 && system) {
            return JSON.stringify({
              snapshots: out,
              hint: `No recorded market data for ${system}. Call scan_system_markets with system="${system}" to pull live prices from the API, then re-query.`,
            });
          }
          return JSON.stringify(out);
        },
      },
      {
        name: "scan_system_markets",
        description:
          "Live-scan a star system's markets via the API and record fresh prices. Use this when a system has no recorded data yet, or to refresh stale prices. Returns the markets found.",
        parameters: {
          type: "object",
          properties: {
            system: { type: "string", description: "System symbol, e.g. X1-RK29" },
            systemSymbol: { type: "string", description: "Alias for system." },
          },
        },
        readOnly: true,
        execute: async ({ system, systemSymbol }) => {
          if (!ctx.api || !ctx.store) return JSON.stringify({ error: "API or store not available" });
          const sys = String(system ?? systemSymbol ?? "").trim();
          if (!sys) return JSON.stringify({ error: "system required" });
          const intel = new MarketIntel(ctx.api);
          const markets = await intel.getSystemMarkets(sys);
          for (const m of markets) {
            for (const g of Object.values(m.tradeGoods)) {
              ctx.store.recordMarket({
                systemSymbol: m.systemSymbol,
                waypointSymbol: m.symbol,
                goodSymbol: g.symbol,
                type: g.type,
                supply: g.supply,
                purchasePrice: g.purchasePrice,
                sellPrice: g.sellPrice,
                tradeVolume: g.tradeVolume,
              });
            }
          }
          return JSON.stringify({
            system: sys,
            markets: markets.length,
            goods: markets.flatMap((m) => Object.keys(m.tradeGoods)),
          });
        },
      },
      {
        name: "get_goods",
        description: "List of trade goods with known prices.",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          if (!ctx.store) return JSON.stringify({ error: "store not available" });
          const snaps = ctx.store.latestMarketSnapshots();
          return JSON.stringify([...new Set(snaps.map((s) => s.goodSymbol))].sort());
        },
      },
      {
        name: "get_price_history",
        description: "Average/min/max sell price over time for one trade good.",
        parameters: {
          type: "object",
          properties: { good: { type: "string", description: "Trade good symbol, e.g. IRON" } },
          required: ["good"],
        },
        readOnly: true,
        execute: async ({ good }) => {
          if (!ctx.store) return JSON.stringify({ error: "store not available" });
          const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
          return JSON.stringify(ctx.store.goodPriceHistory(String(good), since));
        },
      },
      {
        name: "get_activity",
        description: "Recent fleet activity feed: extracts, sells, buys, navigation. Optionally filter by ship symbol.",
        parameters: {
          type: "object",
          properties: { ship: { type: "string", description: "Optional ship symbol, e.g. RLC8989-1" } },
        },
        readOnly: true,
        execute: async ({ ship }) => {
          if (!ctx.store) return JSON.stringify({ error: "store not available" });
          let activity = ctx.store.recentActivity(50);
          if (ship) activity = activity.filter((a) => a.shipSymbol === String(ship));
          return JSON.stringify(activity);
        },
      },
      {
        name: "get_ledger_totals",
        description: "Aggregate ledger: total buys, sells, and net credits.",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          if (!ctx.store) return JSON.stringify({ error: "store not available" });
          return JSON.stringify(ctx.store.ledgerTotals());
        },
      },
      {
        name: "get_missions",
        description: "Current construction/supply missions and their status.",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          if (!ctx.fleet) return JSON.stringify({ error: "fleet not ready" });
          return JSON.stringify(ctx.fleet.getMissions());
        },
      },
      {
        name: "get_loadout_scores",
        description: "Shipyard ship scores by cargo/fuel/mounts per credit.",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          if (!ctx.fleet) return JSON.stringify({ error: "fleet not ready" });
          const scores = await ctx.fleet.scanLoadouts();
          return JSON.stringify(scores.slice(0, 10));
        },
      },
      {
        name: "get_surveys",
        description: "Active survey data (asteroid deposits) from the shared survey pool.",
        parameters: { type: "object", properties: {} },
        readOnly: true,
        execute: async () => {
          if (!ctx.fleet) return JSON.stringify({ error: "fleet not ready" });
          return JSON.stringify(ctx.fleet.surveyData());
        },
      },
    ];
  }

  /** Run one turn of the co-pilot with a user message, returning the reply. */
  async chat(userMessage: string, history: ChatMessage[] = [], signal?: AbortSignal): Promise<{
    reply: string;
    history: ChatMessage[];
    usage: { prompt_tokens: number; completion_tokens: number };
  }> {
    const system = this.buildSystemPrompt();
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userMessage },
    ];
    const result = await withRetry(() => this.llm.run(messages, this.tools, { signal }));
    return result;
  }

  /** Compose the system prompt with live world context, so the AI always knows where it is. */
  private buildSystemPrompt(): string {
    const s = this.context.state.get();
    const agent = s.agent;
    const lines = [CURRENT_SYSTEM];
    lines.push(
      `Live context:`,
      `- Agent: ${agent ? `${agent.symbol} @ ${agent.headquarters}, ${agent.credits.toLocaleString("en-US")} credits, ${agent.shipCount} ships` : "not loaded"}`,
      `- Home system: ${s.systemSymbol || "unknown"}`,
      `- Known systems: ${s.systems.map((x) => x.symbol).join(", ") || "none yet"}`,
      `- Ship count in snapshot: ${(s.ships ?? []).length}`,
      `- Net (sells - buys): ${(s.totals.sells - s.totals.buys).toLocaleString("en-US")} credits`,
    );
    return lines.join("\n");
  }

  /** The tools exposed to the agent (for debugging / extension). */
  getTools(): ChatTool[] {
    return this.tools;
  }
}

export type { MarketSnapshot, TradeOpportunity };
