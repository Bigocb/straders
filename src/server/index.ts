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
import { buildTriage } from "../engine/triage.js";

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

  /* ── Bridge ──────────────────────────────────────────────────
     Everything the operating view needs in one call: the earning rate, the
     triage queue ranked by cost of inaction, and per-ship earnings. */
  app.get("/api/bridge", (_req, res) => {
    try {
      const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      const series = opts.store.netSeries(since, 60);
      const byShip = opts.store.earningsByShip(new Date(Date.now() - 3600 * 1000).toISOString());
      const state = opts.state.get();
      const status = opts.fleet
        ? { ships: opts.fleet.getShipStatuses(), stranded: opts.fleet.getStrandedShips(), paused: opts.fleet.isPaused() }
        : { ships: [], stranded: [], paused: false };

      // Rate: the last complete hour, falling back to the partial current one.
      const complete = series.slice(0, -1);
      const rate = Math.round(complete.at(-1)?.net ?? series.at(-1)?.net ?? 0);
      const prev = Math.round(complete.at(-2)?.net ?? 0);

      // A distinct, longer baseline for "what does this ship normally make" —
      // must not be the same window used to decide idleness (an idle ship's
      // own net in THAT window is 0 by definition, which is why every idle
      // ship used to collapse to the same fleet-median number).
      const HISTORY_HOURS = 24;
      const historyStart = new Date(Date.now() - HISTORY_HOURS * 3600_000).toISOString();
      const historicalRates = opts.store
        .earningsByShip(historyStart)
        .map((r) => ({ shipSymbol: r.shipSymbol, net: r.net / HISTORY_HOURS }));

      const { triage, forgone } = buildTriage({
        ships: status.ships,
        stranded: status.stranded,
        earnings: byShip,
        historicalRates,
        contracts: (state.contracts ?? []) as any[],
      });

      res.json({
        rate, prevRate: prev, forgone,
        series: series.map((p) => p.net),
        credits: state.agent?.credits ?? 0,
        shipCount: state.agent?.shipCount ?? 0,
        totals: state.totals ?? { sells: 0, buys: 0 },
        paused: status.paused,
        earnings: byShip,
        stranded: status.stranded,
        shipStatus: status.ships,
        triage,
      });
    } catch (err) {
      console.error("[server] /api/bridge error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ── Markets ─────────────────────────────────────────────────
     Reference data, with routes ranked by profit per round trip net of fuel
     rather than by margin percentage — a 111% margin on 3 units 41 fuel away
     is not a trade. */
  app.get("/api/markets", (_req, res) => {
    try {
      const snapshots = opts.store.latestMarketSnapshots();

      // Ask the fleet for its own ranked routes rather than recomputing them
      // here. This endpoint used to price a round trip while the dispatcher
      // priced one way, so the Markets tab showed the operator a different
      // route list than the fleet was actually flying — and disagreed about
      // which routes existed at all, since it read its freshness window from an
      // env var instead of the doctrine.
      // Without a fleet there are no waypoint positions, so every route would
      // price at zero fuel and read as far more profitable than it is. Better
      // to show none than to show a fiction.
      const routes = (opts.fleet?.computeDispatchRoutes() ?? [])
        .map((r) => ({
          goodSymbol: r.good,
          buyAt: r.buyAt,
          buySystem: r.buySystem,
          buyPrice: r.buyPrice,
          sellAt: r.sellAt,
          sellSystem: r.sellSystem,
          sellPrice: r.sellPrice,
          volume: r.volume,
          distance: r.distance || null,
          fuelUnits: r.fuelUnits || null,
          fuelCost: r.fuelCost,
          marginPerUnit: Math.round((r.sellPrice - r.buyPrice) * 10) / 10,
          marginPct: Math.round(((r.sellPrice - r.buyPrice) / r.buyPrice) * 1000) / 10,
          grossPerTrip: Math.round((r.sellPrice - r.buyPrice) * r.volume),
          profitPerTrip: r.profitPerTrip,
          crossSystem: r.buySystem !== r.sellSystem,
          ageMinutes: r.ageMinutes,
        }))
        .slice(0, 25);

      res.json({
        routes,
        snapshots,
        shipyards: opts.fleet?.getIntel().shipyards ?? [],
        modules: opts.fleet?.getIntel().modules ?? [],
      });
    } catch (err) {
      console.error("[server] /api/markets error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ── Doctrine ────────────────────────────────────────────────
     The policy the engine flies by. Reads are live, so an edit takes effect on
     the next tick without a restart. */
  app.get("/api/doctrine", (_req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    res.json({ rules: opts.fleet.doctrine.list() });
  });

  app.post("/api/doctrine", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { key, value, enabled } = req.body ?? {};
    if (typeof key !== "string") return res.status(400).json({ error: "key required" });
    if (value !== undefined && typeof value !== "number") return res.status(400).json({ error: "value must be a number" });
    if (enabled !== undefined && typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean" });
    try {
      const rule = opts.fleet.doctrine.set(key, { value, enabled });
      res.json({ ok: true, rule, rules: opts.fleet.doctrine.list() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ── Dispatch ────────────────────────────────────────────────
     The centralized route dispatcher: which trader runs which good. Reads the
     current assignments; a POST with a good re-assigns a trader (operator
     override), or clears the override when good is omitted. */
  app.get("/api/dispatch", (_req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    res.json({
      routes: opts.fleet.computeDispatchRoutes(),
      assignments: opts.fleet.dispatcher.list(),
    });
  });

  app.post("/api/dispatch", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol, good, buyAt, sellAt, buyPrice, sellPrice, profitPerTrip, clear } = req.body ?? {};
    if (typeof shipSymbol !== "string") return res.status(400).json({ error: "shipSymbol required" });
    try {
      if (clear) {
        opts.fleet.dispatcher.setManual(shipSymbol, undefined);
      } else {
        if (typeof good !== "string") return res.status(400).json({ error: "good required" });
        opts.fleet.dispatcher.setManual(shipSymbol, {
          shipSymbol,
          good,
          buyAt: typeof buyAt === "string" ? buyAt : "",
          sellAt: typeof sellAt === "string" ? sellAt : "",
          buyPrice: typeof buyPrice === "number" ? buyPrice : 0,
          sellPrice: typeof sellPrice === "number" ? sellPrice : 0,
          profitPerTrip: typeof profitPerTrip === "number" ? profitPerTrip : 0,
          source: "manual",
        });
      }
      res.json({ ok: true, assignments: opts.fleet.dispatcher.list() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/missions", (_req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    res.json({ missions: opts.fleet.getMissions() });
  });

  /** Contracts with delivery/payment details plus declined flags. */
  app.get("/api/contracts", async (_req, res) => {
    if (!opts.fleet?.contracts) return res.status(503).json({ error: "contracts not ready" });
    try {
      const contracts = await opts.fleet.contracts.listActive();
      res.json({
        contracts: contracts.map((c) => ({
          id: c.id,
          factionSymbol: c.factionSymbol,
          type: c.type,
          accepted: c.accepted,
          fulfilled: c.fulfilled,
          deadlineToAccept: c.deadlineToAccept ?? c.expiration,
          deadline: c.terms.deadline,
          onAccepted: c.terms.payment.onAccepted,
          onFulfilled: c.terms.payment.onFulfilled,
          deliver: (c.terms.deliver ?? []).map((d) => ({
            tradeSymbol: d.tradeSymbol,
            destinationSymbol: d.destinationSymbol,
            unitsRequired: d.unitsRequired,
            unitsFulfilled: d.unitsFulfilled,
          })),
          declined: opts.fleet!.contracts!.isDeclined(c.id),
        })),
      });
    } catch (err) {
      console.error("[server] /api/contracts error", err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Decline a contract so the fleet stops auto-accepting it. */
  app.post("/api/contracts/decline", (req, res) => {
    if (!opts.fleet?.contracts) return res.status(503).json({ error: "contracts not ready" });
    const { contractId } = req.body ?? {};
    if (typeof contractId !== "string") return res.status(400).json({ error: "contractId required" });
    opts.fleet.contracts.decline(contractId);
    res.json({ ok: true });
  });

  /** Undo a decline — the contract becomes auto-acceptable again. */
  app.post("/api/contracts/undecline", (req, res) => {
    if (!opts.fleet?.contracts) return res.status(503).json({ error: "contracts not ready" });
    const { contractId } = req.body ?? {};
    if (typeof contractId !== "string") return res.status(400).json({ error: "contractId required" });
    opts.fleet.contracts.undecline(contractId);
    res.json({ ok: true });
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

  /** Put ONE ship under manual control, holding it in place. The per-ship
   *  counterpart to /api/fleet/pause, which halts the entire fleet. */
  app.post("/api/fleet/hold", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string") {
      return res.status(400).json({ error: "shipSymbol required" });
    }
    opts.fleet
      .holdShip(shipSymbol)
      .then(() => res.json({ ok: true, shipSymbol }))
      .catch((err) => {
        console.error("[server] hold error", err);
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      });
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

  app.post("/api/fleet/scrap", (req, res) => {
    if (!opts.fleet) return res.status(503).json({ error: "fleet not ready" });
    const { shipSymbol } = req.body ?? {};
    if (typeof shipSymbol !== "string") return res.status(400).json({ error: "shipSymbol required" });
    opts.fleet
      .scrapShip(shipSymbol)
      .then((r) => res.json({ ok: true, shipSymbol, totalPrice: r.transaction.totalPrice }))
      .catch((err) => {
        console.error("[server] scrap error", err);
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
