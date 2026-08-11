import express from "express";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Store } from "../engine/store.js";
import type { FleetState } from "../engine/state.js";
import type { FleetManager } from "../engine/fleet.js";
import { generateLog } from "../engine/narrative.js";
import { getDiscord } from "../engine/discord.js";
import { optimizeLoadouts } from "../engine/loadoutGa.js";
import type { ChatAgent } from "../engine/agentChat.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "../../public");

export interface ServerOptions {
  state: FleetState;
  store: Store;
  fleet?: FleetManager;
  chat?: ChatAgent;
  port?: number;
}

/** Serves the command-center dashboard and its JSON APIs from shared state. */
export function startServer(opts: ServerOptions): void {
  const app = express();
  const port = opts.port ?? Number(process.env.ST_PORT ?? 3000);

  app.use(express.json());

  app.get("/api/state", (_req, res) => {
    res.json(opts.state.get());
  });

  app.get("/api/systems", (_req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    res.json({
      systems: opts.fleet.getGalaxy().listSystems().map((s) => s.symbol),
      connections: opts.fleet.getGalaxy().jumpConnections(),
    });
  });

  app.get("/api/system/:symbol/waypoints", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const known = opts.fleet.getGalaxy().getSystem(req.params.symbol);
    if (!known) return res.status(404).json({ error: "system not known" });
    res.json({
      system: known.symbol,
      waypoints: known.waypoints.map((w) => ({
        symbol: w.symbol,
        x: w.x,
        y: w.y,
        type: w.type,
        traits: w.traits.map((t) => t.symbol),
      })),
    });
  });

  app.get("/api/intel", (_req, res) => {
    try {
      res.json({
        snapshots: opts.store.latestMarketSnapshots(),
        bestTrades: opts.store.bestTrades(),
        shipyards: opts.fleet?.getIntel().shipyards ?? [],
        modules: opts.fleet?.getIntel().modules ?? [],
      });
    } catch (err) {
      console.error("[server] /api/intel error", err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/api/activity", (_req, res) => {
    res.json({ activity: opts.store.recentActivity(100) });
  });

  app.get("/api/missions", (_req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    res.json({ missions: opts.fleet.getMissions() });
  });

  app.get("/api/construct", async (_req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    res.json({ missions: opts.fleet.getMissions() });
  });

  /** Start a construction-supply mission (or check one). */
  app.post("/api/missions/start", async (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    try {
      const waypoint = String(req.body?.waypoint ?? "");
      if (!waypoint) return res.status(400).json({ error: "waypoint required" });
      await opts.fleet.startMission(waypoint);
      res.json({ ok: true, missions: opts.fleet.getMissions() });
    } catch (err) {
      console.error("[server] /api/missions/start error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Pause a construction mission (stop sourcing/spending). */
  app.post("/api/missions/pause", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const waypoint = String(req.body?.waypoint ?? "");
    if (!waypoint) return res.status(400).json({ error: "waypoint required" });
    opts.fleet.pauseMission(waypoint);
    res.json({ ok: true, missions: opts.fleet.getMissions() });
  });

  /** Resume a paused construction mission. */
  app.post("/api/missions/resume", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const waypoint = String(req.body?.waypoint ?? "");
    if (!waypoint) return res.status(400).json({ error: "waypoint required" });
    opts.fleet.resumeMission(waypoint);
    res.json({ ok: true, missions: opts.fleet.getMissions() });
  });

  app.get("/api/prices", (req, res) => {
    const good = String(req.query.good ?? "");
    const since = String(req.query.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    if (!good) return res.status(400).json({ error: "good required" });
    try {
      res.json({ points: opts.store.goodPriceHistory(good, since) });
    } catch (err) {
      console.error("[server] /api/prices error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/goods", (_req, res) => {
    try {
      const snaps = opts.store.latestMarketSnapshots();
      const goods = [...new Set(snaps.map((s) => s.goodSymbol))].sort();
      res.json({ goods });
    } catch (err) {
      console.error("[server] /api/goods error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/surveys", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const waypoint = req.query.waypoint ? String(req.query.waypoint) : undefined;
    res.json({
      waypoint,
      surveys: opts.fleet.surveyData(waypoint).map((s) => ({
        signature: s.signature,
        size: s.size,
        expiration: s.expiration,
        deposits: s.deposits.map((d) => d.symbol),
      })),
    });
  });

  app.get("/api/narrative", (_req, res) => {
    const activity = opts.store.recentActivity(30);
    const state = opts.state.get();
    res.json({ log: generateLog(activity, state.agent?.credits ?? 0, state.ships ?? []) });
  });

  app.get("/api/loadout", async (_req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    try {
      const scores = await opts.fleet.scanLoadouts();
      res.json({ scores });
    } catch (err) {
      console.error("[server] /api/loadout error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/loadout/ga", async (_req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    try {
      const agent = await opts.fleet.getApi().getMyAgent();
      const scores = await opts.fleet.scanLoadouts();
      const baseShips = scores.map((s) => ({
        ...scores.find((x) => x.type === s.type)!,
      }));
      // Deduplicate base ship types.
      const seen = new Set<string>();
      const uniqueBaseShips = baseShips.filter((s) => {
        if (seen.has(s.type)) return false;
        seen.add(s.type);
        return true;
      });
      // Build minimal ShipyardShip objects from scan results (we don't have full ship specs here).
      const ships = uniqueBaseShips.map((s) => ({
        type: s.type,
        purchasePrice: s.purchasePrice,
        frame: { fuelCapacity: s.fuelCapacity, moduleSlots: s.moduleSlots, mountingPoints: s.mountingPoints, name: s.type, description: "", condition: 100, requirements: {} },
        engine: { speed: 10, name: "", description: "", condition: 100, requirements: {} },
        reactor: { name: "", description: "", condition: 100, requirements: {} },
        modules: [] as any[],
        mounts: [] as any[],
        name: s.type,
        description: "",
        crew: { required: 0, capacity: 0, current: 0 },
      } as any));
      const candidates = optimizeLoadouts(ships, agent.credits - 20_000, { population: 30, generations: 20 });
      res.json({ candidates: candidates.slice(0, 8) });
    } catch (err) {
      console.error("[server] /api/loadout/ga error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/fleet/pause", (_req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    opts.fleet.setPaused(true);
    res.json({ paused: true });
  });

  app.post("/api/fleet/resume", (_req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    opts.fleet.setPaused(false);
    res.json({ paused: false });
  });

  app.get("/api/fleet/status", (_req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    res.json({
      paused: opts.fleet.isPaused(),
      running: opts.fleet.running,
      ships: opts.fleet.getShipStatuses(),
      stranded: opts.fleet.getStrandedShips(),
    });
  });

  app.post("/api/fleet/dispatch", async (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol, waypointSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof waypointSymbol !== "string") {
      return res.status(400).json({ error: "shipSymbol and waypointSymbol required" });
    }

    // Pre-check fuel range so the UI gets honest feedback instead of a false success.
    try {
      const api = opts.fleet.getApi();
      const ship = await api.getShip(shipSymbol);
      const need = opts.fleet.estimatedFuelTo(shipSymbol, waypointSymbol);
      if (ship.fuel.capacity > 0 && ship.fuel.current < need) {
        return res.status(400).json({
          error: `${shipSymbol} needs ${need} fuel to reach ${waypointSymbol}, but has ${ship.fuel.current}/${ship.fuel.capacity}`,
        });
      }
    } catch (err) {
      // If the pre-check itself fails, fall through to the normal dispatch path.
      console.error("[server] dispatch pre-check error", err);
    }

    const status = opts.fleet.getShipStatuses().find((s) => s.symbol === shipSymbol);
    if (status && status.role !== "idle") {
      // Fire-and-forget for fleet-controlled miners/traders.
      opts.fleet
        .dispatchShip(shipSymbol, waypointSymbol)
        .catch((err) => console.error("[server] dispatch error", err));
    } else {
      // Fire-and-forget direct API navigation for idle/uncontrolled ships.
      const api = opts.fleet.getApi();
      api.getShip(shipSymbol)
        .then((ship) => {
          if (ship.nav.status === "DOCKED") return api.orbitShip(shipSymbol);
        })
        .then(() => api.navigateShip(shipSymbol, waypointSymbol))
        .catch((err) => console.error("[server] fallback dispatch error", err));
    }
    res.json({ ok: true, shipSymbol, waypointSymbol });
  });

  app.post("/api/fleet/release", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string") {
      return res.status(400).json({ error: "shipSymbol required" });
    }
    try {
      opts.fleet.releaseShip(shipSymbol);
      res.json({ ok: true, shipSymbol });
    } catch (err) {
      console.error("[server] release error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/fleet/dock", async (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string") {
      return res.status(400).json({ error: "shipSymbol required" });
    }
    try {
      const api = opts.fleet.getApi();
      const ship = await api.getShip(shipSymbol);
      if (ship.nav.status === "IN_TRANSIT") {
        return res.status(400).json({ error: `${shipSymbol} is in transit — wait for arrival` });
      }
      if (ship.nav.status === "DOCKED") {
        await api.orbitShip(shipSymbol);
      } else {
        await api.dockShip(shipSymbol);
      }
      const updated = await api.getShip(shipSymbol);
      res.json({ ok: true, shipSymbol, status: updated.nav.status });
    } catch (err) {
      console.error("[server] dock error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/fleet/transfer", async (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol, toShipSymbol, tradeSymbol, units } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof toShipSymbol !== "string" || typeof tradeSymbol !== "string" || typeof units !== "number") {
      return res.status(400).json({ error: "shipSymbol, toShipSymbol, tradeSymbol and units required" });
    }
    try {
      const api = opts.fleet.getApi();
      // Cargo transfer requires both ships at the same waypoint in the SAME state
      // (both docked or both in orbit). Align the sender to the receiver automatically.
      const receiver = await api.getShip(toShipSymbol);
      const sender = await api.getShip(shipSymbol);
      if (receiver.nav.waypointSymbol !== sender.nav.waypointSymbol) {
        return res.status(400).json({ error: `${shipSymbol} (${sender.nav.waypointSymbol}) and ${toShipSymbol} (${receiver.nav.waypointSymbol}) are not at the same waypoint` });
      }
      if (sender.nav.status === "IN_TRANSIT" || receiver.nav.status === "IN_TRANSIT") {
        return res.status(400).json({ error: "a ship is in transit — wait for arrival before transferring" });
      }
      if (sender.nav.status !== receiver.nav.status) {
        if (receiver.nav.status === "DOCKED") await api.dockShip(shipSymbol);
        else await api.orbitShip(shipSymbol);
      }
      const result = await api.transferCargo(shipSymbol, tradeSymbol, units, toShipSymbol);
      res.json({ ok: true, shipSymbol, toShipSymbol, tradeSymbol, units, cargo: result.cargo });
    } catch (err) {
      console.error("[server] transfer error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/contracts/accept", (req, res) => {
    if (!opts.fleet?.contracts) return res.status(503).json({ error: "contracts not ready" });
    const { contractId } = req.body ?? {};
    if (typeof contractId !== "string") {
      return res.status(400).json({ error: "contractId required" });
    }
    opts.fleet.contracts
      .acceptById(contractId)
      .then((c) => res.json({ ok: true, contractId: c.id }))
      .catch((err) => {
        console.error("[server] accept error", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  app.post("/api/fleet/buy", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipType, yardSymbol } = req.body ?? {};
    if (typeof shipType !== "string" || typeof yardSymbol !== "string") {
      return res.status(400).json({ error: "shipType and yardSymbol required" });
    }
    opts.fleet
      .buyShip(shipType as never, yardSymbol)
      .then((ship) => res.json({ ok: true, shipSymbol: ship.symbol }))
      .catch((err) => {
        console.error("[server] buy error", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  app.post("/api/fleet/refuel", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string") return res.status(400).json({ error: "shipSymbol required" });
    opts.fleet
      .refuelShip(shipSymbol)
      .then((r) => res.json({ ok: true, ...r }))
      .catch((err) => {
        console.error("[server] refuel error", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  app.post("/api/fleet/jump", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol, waypointSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof waypointSymbol !== "string") {
      return res.status(400).json({ error: "shipSymbol and waypointSymbol required" });
    }
    opts.fleet
      .jumpShip(shipSymbol, waypointSymbol)
      .then(() => res.json({ ok: true, shipSymbol, waypointSymbol }))
      .catch((err) => {
        console.error("[server] jump error", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  app.post("/api/fleet/explore", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol, targetSystem } = req.body ?? {};
    if (typeof shipSymbol !== "string") {
      return res.status(400).json({ error: "shipSymbol required" });
    }
    opts.fleet
      .exploreSystem(shipSymbol, typeof targetSystem === "string" ? targetSystem : undefined)
      .then((system) => res.json({ ok: true, shipSymbol, system }))
      .catch((err) => {
        console.error("[server] explore error", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  app.post("/api/fleet/buy-install", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol, componentSymbol, marketWaypoint } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof componentSymbol !== "string" || typeof marketWaypoint !== "string") {
      return res.status(400).json({ error: "shipSymbol, componentSymbol and marketWaypoint required" });
    }
    opts.fleet
      .buyAndInstallComponent(shipSymbol, componentSymbol, marketWaypoint)
      .then(() => res.json({ ok: true, shipSymbol, componentSymbol, marketWaypoint }))
      .catch((err) => {
        console.error("[server] buy-install error", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  app.post("/api/fleet/install", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol, componentSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof componentSymbol !== "string") {
      return res.status(400).json({ error: "shipSymbol and componentSymbol required" });
    }
    opts.fleet
      .installComponent(shipSymbol, componentSymbol)
      .then(() => res.json({ ok: true, shipSymbol, componentSymbol }))
      .catch((err) => {
        console.error("[server] install error", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  app.post("/api/fleet/remove-component", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol, componentSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof componentSymbol !== "string") {
      return res.status(400).json({ error: "shipSymbol and componentSymbol required" });
    }
    opts.fleet
      .removeComponent(shipSymbol, componentSymbol)
      .then(() => res.json({ ok: true, shipSymbol, componentSymbol }))
      .catch((err) => {
        console.error("[server] remove-component error", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  app.post("/api/fleet/trade", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol, good, units, action } = req.body ?? {};
    if (typeof shipSymbol !== "string" || typeof good !== "string" || typeof units !== "number" || (action !== "buy" && action !== "sell")) {
      return res.status(400).json({ error: "shipSymbol, good, units, action (buy|sell) required" });
    }
    const op = action === "buy" ? opts.fleet.buyCargo(shipSymbol, good, units) : opts.fleet.sellCargo(shipSymbol, good, units);
    op.then(() => res.json({ ok: true }))
      .catch((err) => {
        console.error("[server] trade error", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
  });

  app.post("/api/discord", (req, res) => {
    const { webhookUrl } = req.body ?? {};
    if (typeof webhookUrl !== "string") {
      return res.status(400).json({ error: "webhookUrl required" });
    }
    try {
      getDiscord().setWebhook(webhookUrl);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/chat/history", (_req, res) => {
    try {
      res.json({ messages: opts.store.chatHistory(100) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/chat", async (req, res) => {
    if (!opts.chat) {
      return res.status(503).json({ error: "co-pilot not configured (set ST_LLM_API_KEY or ST_LLM_MODEL and restart)" });
    }
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message required" });
    try {
      const history = opts.store.chatHistory(60).map((m) => ({
        role: m.role as "user" | "assistant" | "tool",
        content: m.content,
      }));
      const result = await opts.chat.chat(message, history);
      opts.store.recordChatMessage({ role: "user", content: message });
      // Persist only the final assistant reply. Tool calls/results are transient
      // to a single turn; storing them would leave orphaned tool messages in
      // future histories, which some providers reject.
      if (result.reply) opts.store.recordChatMessage({ role: "assistant", content: result.reply });
      res.json({ reply: result.reply, usage: result.usage });
    } catch (err) {
      console.error("[server] /api/chat error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.use(express.static(PUBLIC_DIR));

  app.listen(port, () => {
    console.log(`[server] command center on http://localhost:${port}`);
  });
}
