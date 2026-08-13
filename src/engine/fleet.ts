import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import { ShipAgent } from "./agent.js";
import { TraderAgent, type TraderOptions } from "./trader.js";
import { ScoutAgent } from "./scout.js";
import { SiphonerAgent } from "./siphoner.js";
import { ContractManager } from "./contract.js";
import { MissionManager } from "./mission.js";
import type { MarketSnapshot } from "./market.js";
import type { WaypointPos } from "./agent.js";
import type { Store } from "./store.js";
import { GalaxyAtlas } from "./galaxy.js";
import { SurveyPool } from "./survey.js";
import { scoreShips, type ShipScore, type ShipyardShip } from "./loadout.js";
import { getDiscord } from "./discord.js";
import { Doctrine } from "./doctrine.js";
import { RouteDispatcher, type DispatchRoute, type WarehouseTarget, type HaulTarget, type MissionBuyTarget, type TraderAssignment } from "./dispatcher.js";

export type Ship = components["schemas"]["Ship"];
export type ShipType = components["schemas"]["ShipType"];

/** How long the cached agent credit balance stays good for. See `refreshCredits`. */
const CREDITS_TTL_MS = 30_000;

/** Buy markets keepers are stationed at to keep prices fresh. Configurable via
 *  the dashboard; persisted as a JSON `fleet_flags` row named `keeperMarkets`. */
export const DEFAULT_KEEPER_MARKETS = [
  "X1-BY69-D46", "X1-BY69-E48", "X1-BY69-K85", "X1-BY69-C43", "X1-BY69-H56",
  "X1-BY69-G54", "X1-BY69-D45", "X1-BY69-E49", "X1-BY69-F52",
];

/**
 * The control surface every ship agent shares, regardless of role. Used so the
 * coordinator can command any ship uniformly instead of switch-casing on role.
 */
interface ControlledAgent {
  readonly symbol: string;
  getShip(): Ship;
  isManual(): boolean;
  isSuspended(): boolean;
  dispatchTo(waypointSymbol: string): void | Promise<void>;
  release(): void;
  suspend(): void;
  resume(): void;
}

export interface FleetOptions {
  api: SpaceTradersAPI;
  contracts?: ContractManager;
  log?: (msg: string) => void;
  store?: Store;
  recordLedger?: (entry: {
    timestamp: string;
    shipSymbol: string;
    waypointSymbol: string;
    type: "SELL" | "REFUEL" | "PURCHASE" | "SHIP";
    tradeSymbol?: string;
    units?: number;
    pricePerUnit?: number;
    total: number;
  }) => void;
  /** Called for notable events for the live feed. */
  onActivity?: (kind: string, detail: string, credits?: number) => void;
  minCashReserve?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A single in-progress fuel-ferry rescue mission. */
interface TenderPlan {
  strandedSymbol: string;
  strandedWaypoint: string;
  tenderSymbol: string;
  market: string;
  fuelUnits: number;
  phase: "buy" | "transit" | "transfer" | "done";
}

/**
 * Single coordinator for the whole fleet: assigns roles, ticks every ship,
 * drives the contract pipeline, and grows the fleet by buying ships.
 */
export class FleetManager {
  private readonly api: SpaceTradersAPI;
  readonly contracts?: ContractManager;
  readonly missions: MissionManager;
  private readonly log: (msg: string) => void;
  private readonly recordLedger: FleetOptions["recordLedger"];
  private readonly onActivity: FleetOptions["onActivity"];
  private readonly minCashReserveDefault: number;
  readonly doctrine: Doctrine;
  private systemSymbol = "";
  private positions: WaypointPos[] = [];
  private rawWaypoints: components["schemas"]["Waypoint"][] = [];
  private markets: MarketSnapshot[] = [];
  private miners = new Map<string, ShipAgent>();
  private traders = new Map<string, TraderAgent>();
  private surveyors = new Map<string, ShipAgent>();
  private scouts = new Map<string, ScoutAgent>();
  private siphoners = new Map<string, SiphonerAgent>();
  private tours = new Map<string, ShipAgent>();
  private keepers = new Map<string, ShipAgent>();
  /** Keeper ship → market it polls. Mutable so the fleet can reassign keepers. */
  private keeperMarkets = new Map<string, string>();
  private idleShips = new Map<string, Ship>();
  /**
   * The warehouse ship (docs/warehousing-plan.md §2): one designated hull,
   * held permanently at a chosen waypoint via the ordinary manual-dispatch
   * mechanism, so buy/sell-role traders have somewhere real to transfer
   * cargo to/from. Not a new role map — the ship stays wherever
   * `controlledAgent` already tracks it (miner, trader, whatever it was),
   * it's just parked and held like any other manual pin.
   */
  private warehouseShip?: { shipSymbol: string; waypointSymbol: string };
  private paused = false;
  running = false;

  private readonly surveyPool = new SurveyPool();

  private readonly store?: Store;
  private readonly galaxy: GalaxyAtlas;
  private surveyedSystems = new Set<string>();
  private gateBlockedSystems = new Set<string>();
  private lastExploreTick = 0;
  private rescuePlans = new Map<string, TenderPlan>();
  private maxCargoCapacity = 0;
  private credits = 0;
  private lastCreditsFetch = 0;
  /** Centralized route dispatcher: distinct route per trader + operator overrides. */
  readonly dispatcher = new RouteDispatcher();

  constructor(opts: FleetOptions) {
    this.api = opts.api;
    this.contracts = opts.contracts;
    this.log = opts.log ?? ((m) => console.log(`[fleet] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.onActivity = opts.onActivity;
    this.minCashReserveDefault = opts.minCashReserve ?? 20_000;
    this.store = opts.store;
    // Restored synchronously here (better-sqlite3 is synchronous, in-process)
    // rather than in init(), so a halted fleet stays halted for the whole
    // window before init()'s awaited API calls resolve — never a moment of
    // silently running unhalted right after a restart.
    this.paused = this.store?.getFleetFlag("paused") === "true";
    this.doctrine = new Doctrine(opts.store);
    this.galaxy = new GalaxyAtlas(this.api);
    this.missions = new MissionManager({
      api: this.api,
      store: opts.store,
      log: (m) => this.log(`mission: ${m}`),
      onActivity: opts.onActivity,
      getShip: (s) => this.api.getShip(s),
      estimatedFuelBetween: (a, b) => this.estimatedFuelBetween(a, b),
      canReach: (shipSymbol, targetWaypoint) => this.canReachTarget(shipSymbol, targetWaypoint),
      dispatchShip: (s, w) => this.dispatchShipHop(s, w),
      pickCarrier: (exclude, targetWaypoint) => this.pickMissionCarrier(exclude, targetWaypoint),
      suspend: (s) => this.suspendAgent(s),
      resume: (s) => this.resumeAgent(s),
      listBuyers: (good) => this.materialBuyers(good),
      discoverBuyers: (good) => this.discoverMaterialBuyers(good),
      getCredits: async () => (await this.api.getMyAgent()).credits,
      sellCargo: (s, g, u) => this.sellCargo(s, g, u),
      jettisonCargo: (s, g, u) => this.api.jettisonCargo(s, g, u),
    });
  }

  /** Load world state and register all owned ships. */
  async init(markets?: MarketSnapshot[]): Promise<void> {
    const agent = await this.api.getMyAgent();
    this.credits = agent.credits;
    this.systemSymbol = agent.headquarters.slice(0, agent.headquarters.lastIndexOf("-"));
    await this.galaxy.loadSystem(this.systemSymbol);
    await this.galaxy.scanJumpGates(this.systemSymbol);
    const known = this.galaxy.getSystem(this.systemSymbol)!;
    this.rawWaypoints = known.waypoints;
    this.positions = known.waypoints.map((w) => ({ symbol: w.symbol, x: w.x, y: w.y, type: w.type }));
    this.markets = markets ?? [];

    // Survey the home system's shipyards so the dashboard has intel immediately.
    // (Markets are discovered by the engine's own discovery loop.)
    try {
      await this.galaxy.surveyShipyards(this.systemSymbol, this.store);
    } catch (err) {
      this.log(`home shipyard survey failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const ships = await this.api.listAllShips();
    // Prefer the largest-cargo ship as the arbitrage trader once we have enough miners.
    this.maxCargoCapacity = Math.max(0, ...ships.map((s) => s.cargo?.capacity ?? 0));
    // Reserve every persisted keeper market up front so the coordinator never
    // re-stations a second keeper on a covered market while roles restore.
    for (const r of this.store?.getFleetState() ?? []) {
      if (r.role === "keeper" && r.keeperMarket) this.keeperMarkets.set(r.shipSymbol, r.keeperMarket);
    }
    for (const ship of ships) {
      if (ship.frame?.symbol) this.doctrine.ensureShipTypeRule(ship.frame.symbol);
      await this.assignRole(ship);
    }
    // Restore converted keepers immediately instead of re-crawling one per
    // coordinator pass. Probe keepers re-derive in assignRole above; this
    // resurrects converted miners/shuttles whose role is a runtime decision.
    this.restorePersistedKeepers(ships);
    // Promote the largest-cargo ship to trader if we have enough miners and no trader yet.
    if (this.miners.size >= 3 && this.traders.size === 0) {
      const best = ships
        .filter((s) => (s.cargo?.capacity ?? 0) >= 15)
        .sort((a, b) => (b.cargo?.capacity ?? 0) - (a.cargo?.capacity ?? 0))[0];
      if (best) {
        this.miners.delete(best.symbol);
        this.surveyors.delete(best.symbol);
        this.traders.set(
          best.symbol,
          new TraderAgent(best, this.traderOptions(best.symbol)).withWorld(this.positions),
        );
        this.log(`role: trader ${best.symbol} (promoted, largest cargo)`);
      }
    }
    if (this.miners.size >= this.doctrine.value("promoteAtMiners", Infinity)) {
      // A mining-capable ship with a large hold (e.g. the COMMAND frigate) earns
      // far more arbitrage trading than ore. Once the drone fleet covers mining,
      // promote the biggest-hold miner to trader so it prints credits instead.
      const best = [...this.miners.values()]
        .map((a) => a.getShip())
        .filter((s) => (s.cargo?.capacity ?? 0) >= 40)
        .sort((a, b) => (b.cargo?.capacity ?? 0) - (a.cargo?.capacity ?? 0))[0];
      if (best) {
        this.miners.delete(best.symbol);
        this.traders.set(
          best.symbol,
          new TraderAgent(best, this.traderOptions(best.symbol)).withWorld(this.positions),
        );
        this.log(`role: trader ${best.symbol} (promoted, large hold)`);
      }
    }

    // Restore operator-set manual state that isn't part of a ship's role and
    // so doesn't come back from fleet_state/assignRole above: the warehouse
    // ship binding, per-ship holds/mining pins, and dispatch overrides. Each
    // replays the same mutation the corresponding UI action would make.
    const warehouseFlag = this.store?.getFleetFlag("warehouseShip");
    if (warehouseFlag) {
      try {
        const { shipSymbol, waypointSymbol } = JSON.parse(warehouseFlag) as { shipSymbol: string; waypointSymbol: string };
        if (ships.some((s) => s.symbol === shipSymbol)) {
          await this.designateWarehouseShip(shipSymbol, waypointSymbol);
        } else {
          this.store?.removeFleetFlag("warehouseShip"); // scrapped while we were down
        }
      } catch (err) {
        this.log(`restore warehouse ship failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const [shipSymbol, st] of Object.entries(this.loadShipManualState())) {
      if (!ships.some((s) => s.symbol === shipSymbol)) continue; // scrapped while we were down
      if (st.minePin) {
        try {
          this.mineAt(shipSymbol, st.minePin);
        } catch (err) {
          this.log(`restore mine pin ${shipSymbol} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (st.holdWaypoint) {
        try {
          await this.holdShip(shipSymbol);
        } catch (err) {
          this.log(`restore hold ${shipSymbol} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const dispatchFlag = this.store?.getFleetFlag("dispatchManual");
    if (dispatchFlag) {
      try {
        const all = JSON.parse(dispatchFlag) as Record<string, TraderAssignment>;
        for (const [shipSymbol, assignment] of Object.entries(all)) {
          if (ships.some((s) => s.symbol === shipSymbol)) this.dispatcher.setManual(shipSymbol, assignment);
        }
      } catch (err) {
        this.log(`restore manual dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Live cash floor. Read from doctrine each time so an edit applies on the
   *  next tick; falls back to the value the coordinator was constructed with. */
  private minCashReserve(): number {
    return this.doctrine.value("cashFloor", 0) || this.minCashReserveDefault;
  }

  /** Headroom above the cash floor before a ship purchase is even considered. */
  private shipBudget(): number {
    return this.doctrine.value("shipBudget", 0);
  }

  /** Number of FRAME_DRONE hulls in the fleet (miners + surveyors + scouts). */
  private droneCount(): number {
    let n = 0;
    for (const a of this.miners.values()) if (a.getShip().frame?.symbol === "FRAME_DRONE") n += 1;
    for (const a of this.surveyors.values()) if (a.getShip().frame?.symbol === "FRAME_DRONE") n += 1;
    for (const a of this.scouts.values()) if (a.getShip().frame?.symbol === "FRAME_DRONE") n += 1;
    for (const a of this.siphoners.values()) if (a.getShip().frame?.symbol === "FRAME_DRONE") n += 1;
    return n;
  }

  /**
   * Ship count per hull (frame) type, from locally-tracked agents — no API
   * call. A ship's frame never changes after purchase, so the in-memory
   * roster (which mirrors every buy/scrap as it happens, same as
   * `droneCount` above) is exactly as authoritative as re-fetching it, and
   * far cheaper. This used to call `listAllShips()`, which pages through
   * every 20 ships — and `maybeBuyShip` runs it on every 2s coordinator
   * tick, so a fleet past 20 hulls was making multiple API calls a tick for
   * a number that already lived in memory.
   */
  private hullCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const bump = (frame?: string) => {
      const key = frame ?? "?";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    };
    for (const a of this.miners.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.traders.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.surveyors.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.tours.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.keepers.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.scouts.values()) bump(a.getShip().frame?.symbol);
    for (const a of this.siphoners.values()) bump(a.getShip().frame?.symbol);
    for (const s of this.idleShips.values()) bump(s.frame?.symbol);
    return counts;
  }

  getSystemSymbol(): string {
    return this.systemSymbol;
  }

  /** Expose the multi-system atlas for server/state use. */
  getGalaxy(): GalaxyAtlas {
    return this.galaxy;
  }

  getApi(): SpaceTradersAPI {
    return this.api;
  }

  /** How long a market price stays usable. One number, read by everyone. */
  private intelMaxAgeMin(): number {
    // Disabled means "don't filter", not "filter to zero" — a decade of minutes.
    return this.doctrine.value("snapshotMaxAgeMin", 5_256_000);
  }

  /**
   * The market view the whole fleet flies by. The dispatcher ranks routes from
   * this same window (`computeDispatchRoutes`), so when intel goes stale both
   * sides lose the same markets at the same moment. They used to disagree —
   * the dispatcher filtered by age, the traders didn't — so an aged-out market
   * left the dispatcher with no routes to hand out while every trader still
   * saw it, ran the same scoring function over the same stale table, and
   * independently picked the same "best" good.
   */
  private freshSnapshots(): { waypointSymbol: string; goodSymbol: string; purchasePrice: number; sellPrice: number; tradeVolume: number }[] {
    return (
      this.store?.freshMarketSnapshots(this.intelMaxAgeMin()).map((s) => ({
        waypointSymbol: s.waypointSymbol,
        goodSymbol: s.goodSymbol,
        purchasePrice: s.purchasePrice,
        sellPrice: s.sellPrice,
        tradeVolume: s.tradeVolume,
      })) ?? []
    );
  }

  /**
   * The options every trader is built with. Kept in one place so all three
   * construction sites (promotion by hold size, promotion at miner count, and
   * initial role assignment) can't drift apart — they did, and a trader built
   * on one path reasoned about different markets than one built on another.
   */

  private traderOptions(shipSymbol: string): TraderOptions {
    return {
      api: this.api,
      log: (m) => this.log(`${shipSymbol}: ${m}`),
      recordLedger: this.recordLedger,
      onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${shipSymbol} ${detail}`, credits),
      recordMarket: (wp) => this.recordMarketSnapshot(wp),
      getMarketSnapshots: () => this.freshSnapshots(),
      intelMaxAgeMin: () => this.intelMaxAgeMin(),
      atlas: this.galaxy,
      shouldRun: () => !this.paused,
      protectedGoods: () => this.missions.protectedGoods(),
      reservedGoods: () => this.reservedTradeGoods(shipSymbol),
      assignedRoute: () => this.dispatcher.assignmentFor(shipSymbol),
      claimRoute: (accept) => this.dispatcher.claim(shipSymbol, (r) => accept(r)),
      releaseRoute: () => this.dispatcher.release(shipSymbol),
      getCredits: () => this.credits,
      maxLossPct: this.doctrine.value("maxLossPct", 100),
      marginFloor: this.doctrine.value("marginFloor", 0),
      getWarehouseShip: () => this.getWarehouseShip(),
      warehouseBalance: (good) => this.store?.warehouseBalance(good) ?? 0,
      warehouseDeposit: (good, units, price, shipSymbol) => {
        this.store?.warehouseDeposit(good, units, price, shipSymbol, "buy");
      },
      warehouseWithdraw: (good, units, shipSymbol) => {
        if (!this.store) return { units: 0, avgCost: 0 };
        const current = this.store.warehouseAll().find((g) => g.goodSymbol === good)?.avgCost ?? 0;
        return this.store.warehouseWithdraw(good, units, current, shipSymbol, "sell");
      },
      warehouseMinMargin: () => this.doctrine.value("warehouseMinMargin", 0),
    };
  }

  /** Collect trade symbols currently held by other trader ships, so no two traders compete on the same route. */
  private reservedTradeGoods(excludeSymbol?: string): Set<string> {
    const goods = new Set<string>();
    for (const [symbol, trader] of this.traders) {
      if (symbol === excludeSymbol) continue;
      const cargo = trader.getShip().cargo?.inventory ?? [];
      for (const item of cargo) if (item.units > 0) goods.add(item.symbol);
    }
    // Also reserve goods the dispatcher assigned to OTHER traders, so a trader
    // whose own assignment is temporarily unviable can't free-pick a good that
    // belongs to a fleetmate (which is how all traders ended up on EQUIPMENT).
    for (const a of this.dispatcher.list()) {
      if (a.shipSymbol === excludeSymbol) continue;
      goods.add(a.good);
    }
    return goods;
  }

  /**
   * Traders eligible for a dispatcher assignment this cycle. The warehouse
   * ship is excluded — it's parked under a permanent manual hold and would
   * never act on an assignment, but without this it could still claim a
   * good's slot and lock real traders out of it.
   */
  private dispatcherTraders(): { shipSymbol: string; capacity: number; busy: boolean }[] {
    return [...this.traders.entries()]
      .filter(([sym]) => sym !== this.warehouseShip?.shipSymbol)
      .map(([sym, a]) => ({
        shipSymbol: sym,
        capacity: a.getShip().cargo?.capacity ?? 0,
        // Cargo in the hold means the ship is mid-haul on its current route.
        // Reassigning it there strands that cargo, so the dispatcher leaves it be.
        busy: (a.getShip().cargo?.units ?? 0) > 0,
      }));
  }

  /**
   * Per-good warehouse targets for the dispatcher's buy/sell split. Gated
   * behind `warehouseTarget`'s own enabled flag — the master switch for
   * warehousing: disabled (the default) means nothing is targeted, so
   * `recompute` only ever emits "direct" assignments, same as before tracer
   * 2 existed. Only goods on the curated list (`warehouse_targets`) are
   * ever bought/sold through the warehouse, however profitable their route —
   * without an operator explicitly adding a good, it just trades direct.
   * `warehouseMax` still bounds every per-good target, so a target set
   * above the cap never asks a buy trader to overfill the hold.
   */
  private computeWarehouseTargets(routes: DispatchRoute[]): WarehouseTarget[] {
    if (!this.doctrine.isEnabled("warehouseTarget")) return [];
    const curated = this.store?.warehouseTargetList() ?? [];
    if (!curated.length) return [];
    const max = this.doctrine.value("warehouseMax", Infinity);
    const routedGoods = new Set(routes.map((r) => r.good));
    return curated
      .filter((c) => !c.forMission && routedGoods.has(c.goodSymbol))
      .map((c) => ({ good: c.goodSymbol, target: Math.min(c.target, max), balance: this.store?.warehouseBalance(c.goodSymbol) ?? 0 }));
  }

  /**
   * Mission materials the warehouse already holds stock of. Gated behind the
   * same `warehouseTarget` master switch as `computeWarehouseTargets` —
   * hauling is a warehousing behavior (it withdraws from the warehouse ship),
   * so it stays off with the rest of the feature until the operator opts in.
   * Does not by itself create demand for mission goods to be bought into the
   * warehouse — `computeMissionBuyTargets` is the pathway for that, and only
   * for goods explicitly flagged "buy for mission" on the curated list.
   */
  private computeHaulTargets(): HaulTarget[] {
    if (!this.doctrine.isEnabled("warehouseTarget")) return [];
    const targets: HaulTarget[] = [];
    for (const m of this.missions.list()) {
      if (m.status !== "active" || m.paused) continue;
      for (const mat of m.materials) {
        const needed = mat.required - mat.fulfilled;
        if (needed <= 0) continue;
        const balance = this.store?.warehouseBalance(mat.tradeSymbol) ?? 0;
        if (balance <= 0) continue;
        targets.push({ good: mat.tradeSymbol, targetWaypoint: m.targetWaypoint, needed, balance });
      }
    }
    return targets;
  }

  /**
   * Goods flagged "buy for mission" on the curated list, with an active,
   * unpaused mission currently short of them. Unlike ordinary warehousing
   * there's usually no profitable resale route to source from — this reuses
   * `materialBuyers`, the same cheapest-known-market lookup MissionManager's
   * own carrier sources from, instead of `computeDispatchRoutes`. Gated
   * behind the same warehouseTarget master switch as the rest of warehousing.
   */
  private computeMissionBuyTargets(): MissionBuyTarget[] {
    if (!this.doctrine.isEnabled("warehouseTarget")) return [];
    const forMissionGoods = new Set((this.store?.warehouseTargetList() ?? []).filter((c) => c.forMission).map((c) => c.goodSymbol));
    if (!forMissionGoods.size) return [];
    const targets: MissionBuyTarget[] = [];
    for (const m of this.missions.list()) {
      if (m.status !== "active" || m.paused) continue;
      for (const mat of m.materials) {
        if (!forMissionGoods.has(mat.tradeSymbol)) continue;
        const needed = mat.required - mat.fulfilled;
        if (needed <= 0) continue;
        const cheapest = this.materialBuyers(mat.tradeSymbol)[0];
        if (!cheapest) continue; // no known market for it yet
        const balance = this.store?.warehouseBalance(mat.tradeSymbol) ?? 0;
        targets.push({ good: mat.tradeSymbol, buyAt: cheapest.waypoint, buyPrice: cheapest.purchasePrice, needed, balance });
      }
    }
    return targets;
  }

  /** The curated list of goods the warehouse is allowed to buy/sell — a good
   *  with no entry here is never warehoused, however profitable its route. */
  warehouseTargetList(): { goodSymbol: string; target: number; forMission: boolean }[] {
    return this.store?.warehouseTargetList() ?? [];
  }

  /** Add a good to the curated list, or update its target/forMission flag. */
  setWarehouseTarget(goodSymbol: string, target: number, forMission: boolean): void {
    if (!this.store) throw new Error("store not available");
    if (target <= 0) throw new Error("target must be a positive number");
    this.store.setWarehouseTarget(goodSymbol, target, forMission);
  }

  /** Remove a good from the curated list — it stops being bought/sold through the warehouse. */
  removeWarehouseTarget(goodSymbol: string): void {
    this.store?.removeWarehouseTarget(goodSymbol);
  }

  /** Compute all profitable trade routes (net of fuel), ranked by profit per trip. */
  /**
   * Operator override for which trader runs which route. Routes through here
   * (rather than `dispatcher.setManual` directly) so the override survives a
   * restart — persisted as one `fleet_flags` JSON blob, same mechanism as
   * `shipManualState`.
   */
  setManualDispatch(shipSymbol: string, assignment: TraderAssignment | undefined): void {
    this.dispatcher.setManual(shipSymbol, assignment);
    const raw = this.store?.getFleetFlag("dispatchManual");
    let all: Record<string, TraderAssignment> = {};
    if (raw) {
      try {
        all = JSON.parse(raw);
      } catch {
        all = {};
      }
    }
    if (assignment) all[shipSymbol] = { ...assignment, source: "manual" };
    else delete all[shipSymbol];
    if (Object.keys(all).length === 0) this.store?.removeFleetFlag("dispatchManual");
    else this.store?.setFleetFlag("dispatchManual", JSON.stringify(all));
  }

  computeDispatchRoutes(): DispatchRoute[] {
    const positions = new Map<string, { x: number; y: number }>();
    for (const p of this.galaxy.allPositions()) positions.set(p.symbol, { x: p.x, y: p.y });
    const fuelAt = new Map<string, number>();
    for (const s of this.store?.latestMarketSnapshots() ?? []) {
      if (s.goodSymbol === "FUEL" && s.purchasePrice > 0) fuelAt.set(s.waypointSymbol, s.purchasePrice);
    }
    const legs = this.store?.tradeLegs(this.intelMaxAgeMin()) ?? [];
    return legs
      .map((l) => {
        const a = positions.get(l.buyAt);
        const b = positions.get(l.sellAt);
        const dist = a && b ? Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y))) : null;
        // Match the trader's own profitability model: one-way fuel cost. The
        // return leg is the next buy run, not a cost of this trip.
        const fuelUnits = dist === null ? null : dist;
        const fuelCost = fuelUnits === null ? 0 : fuelUnits * (fuelAt.get(l.buyAt) ?? 72);
        const gross = (l.sellPrice - l.buyPrice) * l.volume;
        const profitPerTrip = Math.round(gross - fuelCost);
        return {
          good: l.goodSymbol,
          buyAt: l.buyAt,
          buySystem: l.buySystem,
          buyPrice: l.buyPrice,
          sellAt: l.sellAt,
          sellSystem: l.sellSystem,
          sellPrice: l.sellPrice,
          volume: l.volume,
          distance: dist ?? 0,
          fuelUnits: fuelUnits ?? 0,
          fuelCost: Math.round(fuelCost),
          profitPerTrip,
          ageMinutes: Math.round((Date.now() - new Date(l.stalestIso).getTime()) / 60_000),
        };
      })
      .filter((r) => r.profitPerTrip > 0)
      .sort((a, b) => b.profitPerTrip - a.profitPerTrip);
  }

  /** Refresh a system's waypoints, markets and shipyards (used after jumping/scouting). */
  async surveySystem(systemSymbol: string): Promise<void> {
    await this.galaxy.loadSystem(systemSymbol);
    await this.galaxy.scanJumpGates(systemSymbol);
    this.log(`surveyMarkets: fetching markets in ${systemSymbol}`);
    const markets = await this.galaxy.surveyMarkets(systemSymbol, this.store);
    const shipyards = await this.galaxy.surveyShipyards(systemSymbol, this.store);
    for (const m of markets) {
      for (const g of Object.values(m.tradeGoods)) {
        this.store?.recordMarket({
          systemSymbol,
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
    this.markets = [...this.markets.filter((m) => m.systemSymbol !== systemSymbol), ...markets];
    this.positions = this.galaxy.allPositions().map((p) => ({ symbol: p.symbol, x: p.x, y: p.y, type: p.type }));
    this.log(`surveyed ${systemSymbol}: ${markets.length} markets, ${shipyards.length} shipyards`);
  }

  /** Snapshot current market prices at a waypoint if it has a MARKETPLACE trait.
   *  Called whenever a ship docks so the dashboard stays current. */
  async recordMarketSnapshot(waypointSymbol: string): Promise<void> {
    const systemSymbol = waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
    const known = this.galaxy.getSystem(systemSymbol);
    const isMarket = known?.waypoints.some(
      (w) => w.symbol === waypointSymbol && w.traits.some((t) => t.symbol === "MARKETPLACE"),
    );
    if (!isMarket) return;
    try {
      const market = await this.api.getMarket(systemSymbol, waypointSymbol);
      const goods = market.tradeGoods ?? [];
      if (!goods.length) return;
      const moduleGoods: { symbol: string; name: string; category: string; purchasePrice: number }[] = [];
      const mountGoods: { symbol: string; name: string; category: string; purchasePrice: number }[] = [];
      for (const g of goods) {
        this.store?.recordMarket({
          systemSymbol,
          waypointSymbol,
          goodSymbol: g.symbol,
          type: g.type,
          supply: g.supply,
          purchasePrice: g.purchasePrice,
          sellPrice: g.sellPrice,
          tradeVolume: g.tradeVolume,
        });
        if (g.symbol.startsWith("MODULE_")) {
          moduleGoods.push({ symbol: g.symbol, name: g.symbol, category: g.type, purchasePrice: g.purchasePrice });
        } else if (g.symbol.startsWith("MOUNT_")) {
          mountGoods.push({ symbol: g.symbol, name: g.symbol, category: g.type, purchasePrice: g.purchasePrice });
        }
      }
      if (moduleGoods.length) this.store?.recordModuleCatalog(systemSymbol, waypointSymbol, moduleGoods, "module");
      if (mountGoods.length) this.store?.recordModuleCatalog(systemSymbol, waypointSymbol, mountGoods, "mount");
      this.onActivity?.("market", `snapshot ${waypointSymbol} (${goods.length} goods)`, 0);
    } catch (err) {
      // ignore: market may not be scannable
    }
  }

  /** Decide a ship's role: miner (has mining mount + cargo) vs trader (cargo) vs scout vs idle. */
  private async assignRole(ship: Ship): Promise<void> {
    const hasMining = ship.mounts.some((m) => m.symbol.startsWith("MOUNT_MINING_LASER"));
    const hasSurveyor = ship.mounts.some((m) => m.symbol.startsWith("MOUNT_SURVEYOR"));
    const hasGasSiphon = ship.mounts.some((m) => m.symbol.startsWith("MOUNT_GAS_SIPHON"));
    const hasCargo = ship.cargo.capacity >= 15;
    // Once we have enough miners, dedicate a cargo-capable ship to arbitrage trading
    // (CLOTHING/JEWELRY/MEDICINE → A1 etc.) which out-earns raw ore mining.
    // Prefer the largest-cargo ship (e.g. the COMMAND frigate) as the trader.
    const wantTrader = false;
    if (hasMining && hasCargo && !wantTrader) {
      this.miners.set(
        ship.symbol,
        new ShipAgent(ship, {
          api: this.api,
          shouldRun: () => !this.paused,
          log: (m) => this.log(`${ship.symbol}: ${m}`),
          recordLedger: this.recordLedger,
          onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
          recordMarket: (wp) => this.recordMarketSnapshot(wp),
          deliverCargo: (s) => this.contracts?.deliverVia(s) ?? Promise.resolve(null),
          surveyPool: this.surveyPool,
          protectedGoods: () => this.missions.protectedGoods(),
        }).withWorld(this.positions, this.markets),
      );
      this.log(`role: miner ${ship.symbol}`);
    } else if (hasSurveyor) {
      this.surveyors.set(
        ship.symbol,
        new ShipAgent(ship, {
          api: this.api,
          shouldRun: () => !this.paused,
          log: (m) => this.log(`${ship.symbol}: ${m}`),
          recordLedger: this.recordLedger,
          onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
          recordMarket: (wp) => this.recordMarketSnapshot(wp),
          surveyPool: this.surveyPool,
          protectedGoods: () => this.missions.protectedGoods(),
          marketTourTargets: () => this.marketTourTargets(),
          shipyardTourTargets: () => this.shipyardTourTargets(),
          recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
        }).withWorld(this.positions, this.markets),
      );
      this.log(`role: surveyor ${ship.symbol}`);
    } else if (hasGasSiphon) {
      // Siphon drone: dedicated to gas-giant extraction (HYDROCARBON etc.), a
      // second raw-income floor that doesn't compete with the miners' asteroids.
      this.siphoners.set(
        ship.symbol,
        new SiphonerAgent(ship, {
          api: this.api,
          shouldRun: () => !this.paused,
          log: (m) => this.log(`${ship.symbol}: ${m}`),
          recordLedger: this.recordLedger,
          onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
          recordMarket: (wp) => this.recordMarketSnapshot(wp),
          protectedGoods: () => this.missions.protectedGoods(),
        }).withWorld(this.positions, this.markets),
      );
      this.log(`role: siphoner ${ship.symbol}`);
    } else if (ship.registration.role === "SATELLITE" || ship.frame?.symbol === "FRAME_PROBE") {
      // Probes/satellites: 0 fuel, 0 cargo, 0 mounts — they can't move, mine or
      // trade. But a probe parked at a shipyard-market keeps that market's
      // prices permanently fresh (market data is only visible when one of our
      // ships is at the waypoint). Chart the waypoint first (free credits +
      // traits), then park as a keeper.
      const keeperMarket = this.keeperMarketFor(ship);
      if (keeperMarket) {
        // Chart the spawn waypoint first: free credits + reveals traits. The
        // probe is sitting right there, so this costs nothing but one call.
        try {
          const charted = await this.api.chartShip(ship.symbol);
          this.onActivity?.("chart", `${ship.symbol} charted ${charted.waypoint.symbol}`, 0);
        } catch (err) {
          // chart may already be done or the waypoint unchartable; ignore
        }
        this.keepers.set(
          ship.symbol,
          new ShipAgent(ship, {
            api: this.api,
            shouldRun: () => !this.paused,
            log: (m) => this.log(`${ship.symbol}: ${m}`),
            recordLedger: this.recordLedger,
            onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
            recordMarket: (wp) => this.recordMarketSnapshot(wp),
            recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
            keeperMarket: () => this.keeperMarkets.get(ship.symbol),
          }).withWorld(this.positions, this.markets),
        );
        this.keeperMarkets.set(ship.symbol, keeperMarket);
        this.store?.setFleetState(ship.symbol, "keeper", keeperMarket);
        this.log(`role: keeper ${ship.symbol} (stationed at ${keeperMarket})`);
      } else {
        this.idleShips.set(ship.symbol, ship);
        this.log(`role: idle ${ship.symbol} (satellite: no keeper market)`);
      }
    } else if (ship.frame?.symbol === "FRAME_SHUTTLE") {
      // Light shuttle: no cargo, no mining — dedicated to touring markets & shipyards
      // so price snapshots and ship-stock intel stay fresh.
      this.tours.set(
        ship.symbol,
        new ShipAgent(ship, {
          api: this.api,
          shouldRun: () => !this.paused,
          log: (m) => this.log(`${ship.symbol}: ${m}`),
          recordLedger: this.recordLedger,
          onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
          recordMarket: (wp) => this.recordMarketSnapshot(wp),
          marketTourTargets: () => this.sectorTourTargets(ship.symbol),
          staleMarketTargets: () => this.staleMarketTargets(),
          shipyardTourTargets: () => this.shipyardTourTargets(),
          recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
        }).withWorld(this.positions, this.markets),
      );
      this.log(`role: tour ${ship.symbol} (market/shipyard intel)`);
    } else if (hasCargo) {
      this.traders.set(
        ship.symbol,
        new TraderAgent(ship, this.traderOptions(ship.symbol)).withWorld(this.positions),
      );
      this.log(`role: trader ${ship.symbol}`);
    } else {
      // Chart scout: no cargo, no mining — flies to uncharted waypoints and charts them.
      this.registerScout(ship);
    }
    // The run() loop array is built at startup, so a ship assigned a role
    // mid-run (purchase, promotion) needs its loop launched here — same
    // pattern as keeper conversions.
    if (this.running) {
      void this.traders.get(ship.symbol)?.runLoop(1_000_000);
      void this.miners.get(ship.symbol)?.runLoop(1_000_000);
      void this.surveyors.get(ship.symbol)?.surveyLoop(1_000_000);
      void this.tours.get(ship.symbol)?.tourLoop(1_000_000);
      void this.scouts.get(ship.symbol)?.runLoop(1_000_000);
      void this.siphoners.get(ship.symbol)?.runLoop(1_000_000);
      if (this.keepers.get(ship.symbol) && ship.frame?.symbol === "FRAME_PROBE") {
        void this.keepers.get(ship.symbol)!.keeperLoop(1_000_000);
      }
    }
  }

  /**
   * Resurrect keepers whose assignment was a runtime decision (converted
   * miner/shuttle) rather than a deterministic re-derivation. Called during
   * init() so keeper count snaps back before the first coordinator pass.
   */
  private restorePersistedKeepers(ships: Ship[]): void {
    for (const r of this.store?.getFleetState() ?? []) {
      if (r.role !== "keeper") continue;
      if (this.keepers.has(r.shipSymbol)) continue;
      const ship = ships.find((s) => s.symbol === r.shipSymbol);
      if (!ship) continue; // scrapped while we were down; row is now inert
      const market = r.keeperMarket ?? this.keeperMarketFor(ship);
      if (!market) continue;
      // Whatever assignRole gave it is wrong — stop and release that role.
      this.miners.get(r.shipSymbol)?.stop();
      this.surveyors.get(r.shipSymbol)?.stop();
      this.tours.get(r.shipSymbol)?.stop();
      this.traders.get(r.shipSymbol)?.stop();
      this.scouts.get(r.shipSymbol)?.stop();
      this.siphoners.get(r.shipSymbol)?.stop();
      this.miners.delete(r.shipSymbol);
      this.surveyors.delete(r.shipSymbol);
      this.tours.delete(r.shipSymbol);
      this.traders.delete(r.shipSymbol);
      this.scouts.delete(r.shipSymbol);
      this.siphoners.delete(r.shipSymbol);
      this.dispatcher.release(r.shipSymbol);
      const keeper = new ShipAgent(ship, {
        api: this.api,
        shouldRun: () => !this.paused,
        log: (m) => this.log(`${r.shipSymbol}: ${m}`),
        recordLedger: this.recordLedger,
        onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${r.shipSymbol} ${detail}`, credits),
        recordMarket: (wp) => this.recordMarketSnapshot(wp),
        recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
        keeperMarket: () => this.keeperMarkets.get(r.shipSymbol),
      }).withWorld(this.positions, this.markets);
      this.keepers.set(r.shipSymbol, keeper);
      this.keeperMarkets.set(r.shipSymbol, market);
      this.log(`restored keeper ${r.shipSymbol} (stationed at ${market})`);
    }
  }

  private registerScout(ship: Ship): void {
    this.scouts.set(
      ship.symbol,
      new ScoutAgent(ship, {
        api: this.api,
        shouldRun: () => !this.paused,
        log: (m) => this.log(`${ship.symbol}: ${m}`),
        recordLedger: this.recordLedger,
        onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${ship.symbol} ${detail}`, credits),
        recordMarket: (wp) => this.recordMarketSnapshot(wp),
        scanIntervalMin: this.doctrine.value("sensorScanIntervalMin", 0),
        onScan: (res) => this.ingestScanResults(ship.symbol, res),
      })
        .withWorld(this.positions, this.markets)
        .withCharted(this.rawWaypoints.filter((w) => w.chart).map((w) => w.symbol)),
    );
    this.log(`role: scout ${ship.symbol} (chart)`);
  }

  /** Fold sensor-scan results into galaxy knowledge so the map/missions see them. */
  private ingestScanResults(shipSymbol: string, res: { systems?: components["schemas"]["ScannedSystem"][]; waypoints?: components["schemas"]["ScannedWaypoint"][] }): void {
    if (res.systems?.length) {
      const added = this.galaxy.ingestScannedSystems(res.systems);
      this.log(`${shipSymbol}: scan revealed ${added} systems`);
      this.onActivity?.("scan", `${shipSymbol} revealed ${added} systems`);
    }
    if (res.waypoints?.length) {
      const added = this.galaxy.ingestScannedWaypoints(res.waypoints);
      this.log(`${shipSymbol}: scan revealed ${added} waypoints`);
      this.onActivity?.("scan", `${shipSymbol} revealed ${added} waypoints`);
    }
  }

  /** Give the chart scout a sensor array if a shipyard sells one and we can afford it. */
  private async maybeInstallScanner(): Promise<void> {
    if (this.scouts.size === 0) return;
    const scout = [...this.scouts.entries()][0];
    if (!scout) return;
    const ship = scout[1].getShip();
    const mountingPoints = ship.frame?.mountingPoints ?? ship.mounts.length;
    if (ship.mounts.some((m) => m.symbol.startsWith("MOUNT_SENSOR_ARRAY")) || ship.mounts.length >= mountingPoints) return;
    const seller = (this.store?.moduleCatalog("MOUNT_SENSOR_ARRAY_I") ?? []).find((m) => m.symbol === "MOUNT_SENSOR_ARRAY_I");
    if (!seller) return;
    if (this.credits < this.minCashReserve() + seller.purchasePrice) return;
    this.log(`installing MOUNT_SENSOR_ARRAY_I on ${scout[0]} from ${seller.waypointSymbol}`);
    await this.buyAndInstallComponent(scout[0], "MOUNT_SENSOR_ARRAY_I", seller.waypointSymbol);
  }

  /** Scan local shipyards and score available ships by utility per credit. */
  async scanLoadouts(): Promise<ShipScore[]> {
    const agent = await this.api.getMyAgent();
    const allYards = this.galaxy.listSystems().flatMap((sys) =>
      sys.waypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD")).map((w) => ({ ...w, systemSymbol: sys.symbol }))
    );
    const available: { ship: ShipyardShip; yardSymbol: string }[] = [];
    // Prefer the store's recorded inventory (kept fresh by the tour shuttle) so
    // the buy pass doesn't hammer every shipyard API every 2s tick. Only fall
    // back to live scans for yards the store has never seen.
    const recorded = new Map<string, { shipType: string; purchasePrice: number; frameSymbol: string; fuelCapacity: number; cargoCapacity: number; moduleSlots: number; mountingPoints: number }[]>();
    for (const r of this.store?.shipyardInventory() ?? []) {
      const list = recorded.get(r.waypointSymbol) ?? [];
      list.push({
        shipType: r.shipType,
        purchasePrice: r.purchasePrice,
        frameSymbol: r.frameSymbol,
        fuelCapacity: r.fuelCapacity,
        cargoCapacity: r.cargoCapacity,
        moduleSlots: r.moduleSlots,
        mountingPoints: r.mountingPoints,
      });
      recorded.set(r.waypointSymbol, list);
    }
    for (const yard of allYards) {
      const cached = recorded.get(yard.symbol);
      if (cached && cached.length > 0) {
        for (const c of cached) {
          this.doctrine.ensureShipTypeRule(c.frameSymbol);
          available.push({
            ship: {
              type: c.shipType as ShipType,
              purchasePrice: c.purchasePrice,
              frame: { symbol: c.frameSymbol, fuelCapacity: c.fuelCapacity, moduleSlots: c.moduleSlots, mountingPoints: c.mountingPoints },
              engine: { speed: 0 },
              modules: [],
              mounts: [],
            } as unknown as ShipyardShip,
            yardSymbol: yard.symbol,
          });
        }
        continue;
      }
      try {
        const shipyard = await this.api.getShipyard(yard.systemSymbol, yard.symbol);
        for (const ship of shipyard.ships ?? []) {
          available.push({ ship, yardSymbol: yard.symbol });
          // Register a doctrine cap for every hull the shipyard sells, not just
          // ones we own — so the operator can tune the cap before the first buy.
          this.doctrine.ensureShipTypeRule(ship.frame.symbol);
        }
      } catch (err) {
        // shipyard may be unreachable; ignore
      }
    }
    return scoreShips(available, agent.credits - this.minCashReserve());
  }

  /** Purchase a specific ship type at a specific shipyard. */
  async buyShip(type: ShipType, yardSymbol: string): Promise<Ship> {
    const agent = await this.api.getMyAgent();
    const yardSystem = yardSymbol.slice(0, yardSymbol.lastIndexOf("-"));
    const shipyard = await this.api.getShipyard(yardSystem, yardSymbol);
    const offer = shipyard.ships?.find((s) => s.type === type);
    if (!offer) throw new Error(`${type} not available at ${yardSymbol}`);
    if (agent.credits < offer.purchasePrice + this.minCashReserve()) {
      throw new Error(`need ${offer.purchasePrice + this.minCashReserve()}c, have ${agent.credits}c`);
    }
    this.log(`purchasing ${type} at ${yardSymbol} for ${offer.purchasePrice} credits`);
    const res = await this.api.purchaseShip(type, yardSymbol);
    this.doctrine.ensureShipTypeRule(type);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol: res.ship.symbol,
      waypointSymbol: yardSymbol,
      type: "SHIP",
      tradeSymbol: type,
      total: res.transaction.price,
    });
    await getDiscord().postActivity({
      timestamp: new Date().toISOString(),
      shipSymbol: "fleet",
      kind: "ship",
      detail: `purchased ship ${res.ship.symbol} (${type}) at ${yardSymbol} for ${res.transaction.price}c`,
      credits: -res.transaction.price,
    });
    await this.assignRole(res.ship);
    return res.ship;
  }

  /** True if there are any waypoints we know of (loaded systems) that are uncharted. */
  private hasUnchartedWork(): boolean {
    for (const sys of this.galaxy.listSystems()) {
      for (const w of sys.waypoints) {
        if (!w.chart) return true;
      }
    }
    return false;
  }

  /** True if the scout can actually reach uncharted work: same system, or a jump gate that is complete. */
  private async scoutCanReachUncharted(): Promise<boolean> {
    for (const sys of this.galaxy.listSystems()) {
      const uncharted = sys.waypoints.some((w) => !w.chart);
      if (!uncharted) continue;
      if (sys.symbol === this.systemSymbol) return true;
      const gates = this.galaxy.gatesTo(this.systemSymbol, sys.symbol);
      for (const gate of gates) {
        try {
          const constr = await this.api.getConstruction(this.systemSymbol, gate);
          if (constr.isComplete) return true;
        } catch {
          return true; // no construction record → gate already built
        }
      }
    }
    return false;
  }

  /**
   * Buy a chart scout (cheap surveyor hull, 80 fuel) when there is actually
   * uncharted work to do and we can afford it. No uncharted waypoints in any
   * known system → no purchase (avoids buying a ship that would sit idle).
   */
  async maybeBuyScout(): Promise<void> {
    if (this.scouts.size > 0) return;
    const scanWanted = this.doctrine.value("sensorScanIntervalMin", 0) > 0;
    if (!scanWanted) {
      if (!this.hasUnchartedWork()) return;
      if (!(await this.scoutCanReachUncharted())) return;
    }
    const agent = await this.api.getMyAgent();
    if (agent.credits < this.minCashReserve() + 35_000) return;

    const yards = this.rawWaypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD"));
    for (const yard of yards) {
      try {
        const shipyard = await this.api.getShipyard(this.systemSymbol, yard.symbol);
        const available = shipyard.ships?.find((s) => s.type === "SHIP_SURVEYOR");
        if (!available) {
          this.log(`scout: no SHIP_SURVEYOR at ${yard.symbol} (stock: ${shipyard.ships?.map((s) => s.type).join(", ") ?? "none"})`);
          continue;
        }
        // Respect the per-hull doctrine cap: a surveyor scout is a FRAME_DRONE,
        // so it must not slip past the drone cap the operator set.
        if (this.doctrine.value(`shipCap:${available.frame.symbol}`, Infinity) <= this.droneCount()) return;
        if (agent.credits < available.purchasePrice + this.minCashReserve()) return;
        this.log(`purchasing SHIP_SURVEYOR scout at ${yard.symbol} for ${available.purchasePrice} credits`);
        const res = await this.api.purchaseShip("SHIP_SURVEYOR", yard.symbol);
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: res.ship.symbol,
          waypointSymbol: yard.symbol,
          type: "SHIP",
          tradeSymbol: "SHIP_SURVEYOR",
          total: res.transaction.price,
        });
        await getDiscord().postActivity({
          timestamp: new Date().toISOString(),
          shipSymbol: "fleet",
          kind: "ship",
          detail: `purchased scout ship ${res.ship.symbol} (SHIP_SURVEYOR) at ${yard.symbol} for ${res.transaction.price}c`,
          credits: -res.transaction.price,
        });
        await this.registerScout(res.ship);
        return;
      } catch (err) {
        this.log(`scout shipyard ${yard.symbol} unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Buy a SHIP_SIPHON_DRONE when the siphonTarget doctrine wants one and we
   * don't have one yet. Deliberately ignores the FRAME_DRONE cap — the drone
   * cap exists to stop mining-drone spending; the siphoner is governed by its
   * own hull-specific cap (`shipCap:SHIP_SIPHON_DRONE`) so turning the drone
   * cap to 0 doesn't silently kill the gas-income role.
   */
  async maybeBuySiphoner(): Promise<void> {
    if (this.siphoners.size > 0) return;
    if (this.doctrine.value("siphonTarget", 0) <= 0) return;
    const agent = await this.api.getMyAgent();
    if (agent.credits < this.minCashReserve() + 35_000) return;

    const yards = this.rawWaypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD"));
    for (const yard of yards) {
      try {
        const shipyard = await this.api.getShipyard(this.systemSymbol, yard.symbol);
        const available = shipyard.ships?.find((s) => s.type === "SHIP_SIPHON_DRONE");
        if (!available) {
          this.log(`siphon: no SHIP_SIPHON_DRONE at ${yard.symbol} (stock: ${shipyard.ships?.map((s) => s.type).join(", ") ?? "none"})`);
          continue;
        }
        this.doctrine.ensureShipTypeRule("SHIP_SIPHON_DRONE");
        if (this.doctrine.value(`shipCap:SHIP_SIPHON_DRONE`, Infinity) <= this.siphoners.size) return;
        if (agent.credits < available.purchasePrice + this.minCashReserve()) return;
        this.log(`purchasing SHIP_SIPHON_DRONE at ${yard.symbol} for ${available.purchasePrice} credits`);
        const res = await this.api.purchaseShip("SHIP_SIPHON_DRONE", yard.symbol);
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: res.ship.symbol,
          waypointSymbol: yard.symbol,
          type: "SHIP",
          tradeSymbol: "SHIP_SIPHON_DRONE",
          total: res.transaction.price,
        });
        await getDiscord().postActivity({
          timestamp: new Date().toISOString(),
          shipSymbol: "fleet",
          kind: "ship",
          detail: `purchased siphon drone ${res.ship.symbol} (SHIP_SIPHON_DRONE) at ${yard.symbol} for ${res.transaction.price}c`,
          credits: -res.transaction.price,
        });
        await this.assignRole(res.ship);
        return;
      } catch (err) {
        this.log(`siphon shipyard ${yard.symbol} unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Purchase the highest-scored affordable ship, if any. */
  async maybeBuyShip(): Promise<void> {
    const agent = await this.api.getMyAgent();
    if (agent.credits < this.minCashReserve() + this.shipBudget()) return;

    const yards = this.rawWaypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD"));
    if (yards.length === 0) return;

    // Count current hulls so per-type doctrine caps can stop the auto-buyer.
    const hullCounts = this.hullCounts();
    const atCap = (frameSymbol: string): boolean => {
      const cap = this.doctrine.value(`shipCap:${frameSymbol}`, Infinity);
      return (hullCounts.get(frameSymbol) ?? 0) >= cap;
    };

    // Priority: buy a Light Shuttle for the market/shipyard tour role first (keeps
    // intel fresh), then grow mining throughput, then the best-scored ship for the
    // fleet's biggest gap. Scoring (not a hardcoded ladder) lets the fleet graduate
    // to bigger hulls as credits grow instead of buying Light Haulers forever.
    let type: ShipType | undefined;
    if (this.tours.size === 0) {
      type = "SHIP_LIGHT_SHUTTLE";
    } else if (this.miners.size < this.doctrine.value("minerTarget", 0)) {
      type = "SHIP_MINING_DRONE";
    }

    // Try the priority type first, then fall through the scored candidates in
    // order. Shipyard stock rotates, so a purchase can fail even when the last
    // snapshot said the hull was available — keep trying the next best pick
    // instead of aborting the whole buy pass.
    const attempts: { type: ShipType; yardSymbol: string; price: number; frameSymbol: string; reason: string }[] = [];

    if (type) {
      for (const yard of yards) {
        try {
          const shipyard = await this.api.getShipyard(this.systemSymbol, yard.symbol);
          const available = shipyard.ships?.find((s) => s.type === type);
          if (available) {
            attempts.push({ type, yardSymbol: yard.symbol, price: available.purchasePrice, frameSymbol: available.frame.symbol, reason: "priority" });
            break;
          }
        } catch (err) {
          this.log(`shipyard ${yard.symbol} unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (attempts.length === 0) {
      // No shuttle/miner gap to fill: buy the best-scored ship we can afford.
      // Prefer traders (the fleet's money printer) but take a strong miner if the
      // scoring says it's the best value and we're still under the miner target.
      const scored = await this.scanLoadouts();
      const wantMiner = this.miners.size < this.doctrine.value("minerTarget", 0);
      const picks = scored.filter((s) => (wantMiner ? s.role === "miner" : s.role === "trader"));
      for (const pick of picks.length > 0 ? picks : scored) {
        attempts.push({ type: pick.type as ShipType, yardSymbol: pick.yardSymbol, price: pick.purchasePrice, frameSymbol: pick.frameSymbol, reason: `score ${pick.score}, ${pick.reason}` });
      }
    }

    for (const attempt of attempts) {
      if (atCap(attempt.frameSymbol)) continue;
      if (agent.credits < attempt.price + this.minCashReserve()) continue;
      try {
        this.log(`purchasing ${attempt.type} at ${attempt.yardSymbol} for ${attempt.price} credits (${attempt.reason})`);
        const res = await this.api.purchaseShip(attempt.type, attempt.yardSymbol);
        this.doctrine.ensureShipTypeRule(attempt.type);
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: res.ship.symbol,
          waypointSymbol: attempt.yardSymbol,
          type: "SHIP",
          tradeSymbol: attempt.type,
          total: res.transaction.price,
        });
        await getDiscord().postActivity({
          timestamp: new Date().toISOString(),
          shipSymbol: "fleet",
          kind: "ship",
          detail: `purchased ship ${res.ship.symbol} (${attempt.type}) at ${attempt.yardSymbol} for ${res.transaction.price}c`,
          credits: -res.transaction.price,
        });
        await this.assignRole(res.ship);
        return;
      } catch (err) {
        // Stock rotated or the yard is unreachable — try the next candidate.
        this.log(`purchase of ${attempt.type} at ${attempt.yardSymbol} failed (${err instanceof Error ? err.message : String(err)}); trying next pick`);
      }
    }
  }

  /** Jump a ship to a connected waypoint in another system. */
  async jumpShip(shipSymbol: string, waypointSymbol: string): Promise<void> {
    const ship = await this.api.getShip(shipSymbol);
    const sourceSystem = ship.nav.systemSymbol;
    const targetSystem = waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
    if (sourceSystem === targetSystem) {
      throw new Error(`${waypointSymbol} is in the same system; use dispatch instead`);
    }
    const gates = this.galaxy.gatesTo(sourceSystem, targetSystem);
    if (gates.length === 0) {
      await this.galaxy.scanJumpGates(sourceSystem);
    }
    const gate = this.galaxy.gatesTo(sourceSystem, targetSystem)[0];
    if (!gate) throw new Error(`no jump gate from ${sourceSystem} to ${targetSystem}`);
    if (ship.nav.waypointSymbol !== gate || ship.nav.status === "IN_TRANSIT") {
      await this.dispatchShip(shipSymbol, gate);
      await this.api.orbitShip(shipSymbol);
    }
    this.log(`${shipSymbol} jumping ${gate} -> ${waypointSymbol}`);
    const res = await this.api.jumpShip(shipSymbol, waypointSymbol);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol,
      type: "REFUEL",
      units: 0,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("jump", `${shipSymbol} jumped to ${waypointSymbol}`, -res.transaction.totalPrice);
    await this.surveySystem(targetSystem);
  }

  /** Send an idle/explorer ship to scout a connected system. */
  async exploreSystem(shipSymbol: string, targetSystem?: string): Promise<string> {
    const ship = await this.api.getShip(shipSymbol);
    const currentSystem = ship.nav.systemSymbol;
    const connected = this.galaxy.connectedSystems(currentSystem);
    const target = targetSystem ?? connected[0];
    if (!target) throw new Error(`no connected systems known from ${currentSystem}`);
    await this.galaxy.loadSystem(target);
    const gates = this.galaxy.gatesTo(currentSystem, target);
    const gate = gates[0];
    if (!gate) throw new Error(`no jump gate to ${target}`);
    const remoteGate = this.galaxy.getSystem(target)!.waypoints.find((w) => w.type === "JUMP_GATE");
    if (!remoteGate) throw new Error(`${target} has no jump gate waypoint`);

    // A gate that is still under construction cannot be jumped through — no point
    // burning fuel to reach it. Skip these systems until the gate is completed.
    try {
      const constr = await this.api.getConstruction(currentSystem, gate);
      if (!constr.isComplete) {
        throw new Error(`gate ${gate} is under construction (${constr.materials.map((m) => `${m.tradeSymbol} ${m.fulfilled}/${m.required}`).join(", ")})`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("under construction")) throw err;
      // No construction record means the gate is already built — jump is fine.
    }

    await this.jumpShip(shipSymbol, remoteGate.symbol);
    await this.surveySystem(target);
    this.log(`${shipSymbol} explored ${target}`);
    return target;
  }

  /** Manually refuel a ship (docks first if needed). */
  async refuelShip(shipSymbol: string): Promise<{ fuel: number; capacity: number; cost: number }> {
    const ship = await this.api.getShip(shipSymbol);
    if (ship.nav.status === "IN_TRANSIT") throw new Error(`${shipSymbol} is in transit`);
    if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
    const res = await this.api.refuelShip(shipSymbol);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol: ship.nav.waypointSymbol,
      type: "REFUEL",
      units: res.fuel.current,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("refuel", `${shipSymbol} refueled to ${res.fuel.current}/${res.fuel.capacity}`, -res.transaction.totalPrice);
    return { fuel: res.fuel.current, capacity: res.fuel.capacity, cost: res.transaction.totalPrice };
  }

  /** Scrap a ship at a shipyard, removing it from the fleet and returning credits. */
  async scrapShip(shipSymbol: string): Promise<{ transaction: components["schemas"]["ScrapTransaction"] }> {
    const ship = await this.api.getShip(shipSymbol);
    if (ship.nav.status === "IN_TRANSIT") throw new Error(`${shipSymbol} is in transit`);
    if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
    const res = await this.api.scrapShip(shipSymbol);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol: ship.nav.waypointSymbol,
      type: "SHIP",
      tradeSymbol: "SCRAP",
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("scrap", `${shipSymbol} scrapped at ${ship.nav.waypointSymbol} for ${res.transaction.totalPrice}c`, res.transaction.totalPrice);
    this.removeShip(shipSymbol);
    return { transaction: res.transaction };
  }

  /** Remove a ship from all role maps (after scrapping). */
  private removeShip(shipSymbol: string): void {
    this.miners.get(shipSymbol)?.stop();
    this.traders.get(shipSymbol)?.stop();
    this.surveyors.get(shipSymbol)?.stop();
    this.scouts.get(shipSymbol)?.stop();
    this.tours.get(shipSymbol)?.stop();
    this.keepers.get(shipSymbol)?.stop();
    this.siphoners.get(shipSymbol)?.stop();
    this.miners.delete(shipSymbol);
    this.traders.delete(shipSymbol);
    // Free the route claim, or the good stays reserved for a ship that's gone.
    this.dispatcher.release(shipSymbol);
    this.surveyors.delete(shipSymbol);
    this.scouts.delete(shipSymbol);
    this.tours.delete(shipSymbol);
    this.keepers.delete(shipSymbol);
    this.siphoners.delete(shipSymbol);
    // Free the market too, or maybeAssignKeepers sees it as still covered and
    // never stations a replacement — the market just goes stale forever.
    this.keeperMarkets.delete(shipSymbol);
    this.store?.removeFleetState(shipSymbol);
    this.idleShips.delete(shipSymbol);
    // A scrapped warehouse ship leaves nothing for buy/sell-role traders to
    // rendezvous with — clear the designation rather than pointing at a hull
    // that no longer exists.
    if (this.warehouseShip?.shipSymbol === shipSymbol) {
      this.warehouseShip = undefined;
      this.store?.removeFleetFlag("warehouseShip");
    }
    // Drop any persisted hold/mine-pin and manual dispatch override too, or a
    // scrapped ship's ghost assignment would come back on the next restart.
    this.updateShipManualState(shipSymbol, { holdWaypoint: null, minePin: null });
    this.setManualDispatch(shipSymbol, undefined);
  }

  /** Verify a ship is at a market before trading. */
  private async ensureShipAtMarket(shipSymbol: string): Promise<{ ship: Ship; systemSymbol: string; waypointSymbol: string }> {
    const ship = await this.api.getShip(shipSymbol);
    if (ship.nav.status === "IN_TRANSIT") throw new Error(`${shipSymbol} is in transit — wait for arrival`);
    const waypointSymbol = ship.nav.waypointSymbol;
    const systemSymbol = ship.nav.systemSymbol;
    await this.galaxy.loadSystem(systemSymbol);
    const known = this.galaxy.getSystem(systemSymbol);
    const waypoint = known?.waypoints.find((w) => w.symbol === waypointSymbol);
    if (!waypoint || !waypoint.traits.some((t) => t.symbol === "MARKETPLACE")) {
      throw new Error(`${waypointSymbol} is not a marketplace`);
    }
    return { ship, systemSymbol, waypointSymbol };
  }

  /** Buy cargo for a ship at its current market. */
  async buyCargo(shipSymbol: string, good: string, units: number): Promise<void> {
    const { ship, waypointSymbol } = await this.ensureShipAtMarket(shipSymbol);
    if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
    const res = await this.api.purchaseCargo(shipSymbol, good, units);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol,
      type: "PURCHASE",
      tradeSymbol: good,
      units,
      pricePerUnit: res.transaction.pricePerUnit,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("buy", `${shipSymbol} bought ${units}u ${good} @ ${res.transaction.pricePerUnit}c`, -res.transaction.totalPrice);
  }

  /** Sell cargo for a ship at its current market. */
  async sellCargo(shipSymbol: string, good: string, units: number): Promise<void> {
    const { ship, waypointSymbol } = await this.ensureShipAtMarket(shipSymbol);
    const held = ship.cargo.inventory?.find((i) => i.symbol === good);
    if (!held || held.units <= 0) {
      throw new Error(`${shipSymbol} has no ${good} in cargo`);
    }
    const toSell = Math.min(units, held.units);
    if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
    const res = await this.api.sellCargo(shipSymbol, good, toSell);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol,
      type: "SELL",
      tradeSymbol: good,
      units: toSell,
      pricePerUnit: res.transaction.pricePerUnit,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("sell", `${shipSymbol} sold ${toSell}u ${good} @ ${res.transaction.pricePerUnit}c`, res.transaction.totalPrice);
  }

  /** Install a module/mount from a ship's cargo at the nearest shipyard. */
  async installComponent(shipSymbol: string, componentSymbol: string): Promise<void> {
    const ship = await this.api.getShip(shipSymbol);
    const systemSymbol = ship.nav.systemSymbol;
    await this.galaxy.loadSystem(systemSymbol);
    const known = this.galaxy.getSystem(systemSymbol);
    const yards = known?.waypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD")) ?? [];
    if (yards.length === 0) throw new Error(`no shipyard in ${systemSymbol}`);

    const held = ship.cargo.inventory?.find((i) => i.symbol === componentSymbol);
    if (!held || held.units <= 0) throw new Error(`${shipSymbol} has no ${componentSymbol} in cargo`);

    // Fly to the nearest shipyard and dock.
    const yard = yards[0]!;
    if (ship.nav.waypointSymbol !== yard.symbol || ship.nav.status === "IN_TRANSIT") {
      await this.dispatchShip(shipSymbol, yard.symbol);
    }
    const docked = await this.api.getShip(shipSymbol);
    if (docked.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);

    const isMount = componentSymbol.startsWith("MOUNT_");
    const res = isMount
      ? await this.api.installMount(shipSymbol, componentSymbol)
      : await this.api.installModule(shipSymbol, componentSymbol);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol: yard.symbol,
      type: "SHIP",
      tradeSymbol: componentSymbol,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("install", `${shipSymbol} installed ${componentSymbol} at ${yard.symbol}`, -res.transaction.totalPrice);
    this.log(`installed ${componentSymbol} on ${shipSymbol} at ${yard.symbol}`);
  }

  /** Remove a module/mount from a ship at the nearest shipyard (goes back to cargo). */
  async removeComponent(shipSymbol: string, componentSymbol: string): Promise<void> {
    const ship = await this.api.getShip(shipSymbol);
    const systemSymbol = ship.nav.systemSymbol;
    await this.galaxy.loadSystem(systemSymbol);
    const known = this.galaxy.getSystem(systemSymbol);
    const yards = known?.waypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD")) ?? [];
    if (yards.length === 0) throw new Error(`no shipyard in ${systemSymbol}`);

    const yard = yards[0]!;
    if (ship.nav.waypointSymbol !== yard.symbol || ship.nav.status === "IN_TRANSIT") {
      await this.dispatchShip(shipSymbol, yard.symbol);
    }
    const docked = await this.api.getShip(shipSymbol);
    if (docked.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);

    const isMount = componentSymbol.startsWith("MOUNT_");
    const res = isMount
      ? await this.api.removeMount(shipSymbol, componentSymbol)
      : await this.api.removeModule(shipSymbol, componentSymbol);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol: yard.symbol,
      type: "SHIP",
      tradeSymbol: componentSymbol,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("install", `${shipSymbol} removed ${componentSymbol} at ${yard.symbol}`, -res.transaction.totalPrice);
    this.log(`removed ${componentSymbol} from ${shipSymbol} at ${yard.symbol}`);
  }

  /** Buy a module/mount from a market and install it on a ship (flies there if needed). */
  async buyAndInstallComponent(shipSymbol: string, componentSymbol: string, marketWaypoint: string): Promise<void> {
    const ship = await this.api.getShip(shipSymbol);
    const systemSymbol = ship.nav.systemSymbol;
    const targetSystem = marketWaypoint.slice(0, marketWaypoint.lastIndexOf("-"));
    if (ship.nav.systemSymbol !== targetSystem) {
      await this.jumpShip(shipSymbol, marketWaypoint);
    } else if (ship.nav.waypointSymbol !== marketWaypoint || ship.nav.status === "IN_TRANSIT") {
      await this.dispatchShip(shipSymbol, marketWaypoint);
    }
    const atMarket = await this.api.getShip(shipSymbol);
    if (atMarket.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
    const res = await this.api.purchaseCargo(shipSymbol, componentSymbol, 1);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol,
      waypointSymbol: marketWaypoint,
      type: "PURCHASE",
      tradeSymbol: componentSymbol,
      units: 1,
      pricePerUnit: res.transaction.pricePerUnit,
      total: res.transaction.totalPrice,
    });
    this.onActivity?.("buy", `${shipSymbol} bought ${componentSymbol} @ ${res.transaction.pricePerUnit}c`, -res.transaction.totalPrice);
    await this.installComponent(shipSymbol, componentSymbol);
  }

  /** Pick an idle cargo-capable ship to run a mission, preferring the largest hold. */
  private async pickMissionCarrier(exclude: Set<string>, targetWaypoint?: string): Promise<string | undefined> {
    const notBusy = (a: ShipAgent | TraderAgent) => !a.isManual() && !a.isSuspended();
    const candidates: { sym: string; cargo: number }[] = [];
    for (const [s, a] of this.miners) if (!exclude.has(s) && notBusy(a)) candidates.push({ sym: s, cargo: a.getShip().cargo.capacity });
    for (const [s, a] of this.traders) if (!exclude.has(s) && notBusy(a)) candidates.push({ sym: s, cargo: a.getShip().cargo.capacity });
    // A carrier must be able to reach the target on a full tank (it can refuel at
    // markets along the way, but never beyond its tank). Skip ships that can't —
    // otherwise the mission loops on "cannot navigate" forever.
    const reachable = targetWaypoint
      ? candidates.filter((c) => {
          const ship = this.cachedShip(c.sym);
          if (!ship) return false;
          if (ship.fuel.capacity <= 0) return false;
          return this.canReachTarget(c.sym, targetWaypoint);
        })
      : candidates;
    reachable.sort((a, b) => b.cargo - a.cargo || a.sym.localeCompare(b.sym));
    return reachable[0]?.sym;
  }
  /** Known fuel stops (marketplaces that list FUEL) in a system, by symbol. */
  private fuelStops(systemSymbol: string): Set<string> {
    const out = new Set<string>();
    for (const r of this.store?.latestMarketSnapshots().filter((r) => r.systemSymbol === systemSymbol && r.goodSymbol === "FUEL" && r.purchasePrice > 0) ?? []) {
      out.add(r.waypointSymbol);
    }
    const known = this.galaxy.getSystem(systemSymbol);
    for (const w of known?.waypoints ?? []) {
      if (w.type === "FUEL_STATION") out.add(w.symbol);
    }
    return out;
  }

  /** Marketplace waypoints to tour periodically so snapshots stay fresh. */
  private marketTourTargets(): string[] {
    const out = new Set<string>();
    for (const r of this.store?.latestMarketSnapshots() ?? []) out.add(r.waypointSymbol);
    const known = this.galaxy.getSystem(this.systemSymbol);
    for (const w of known?.waypoints ?? []) {
      if (w.traits.some((t) => t.symbol === "MARKETPLACE")) out.add(w.symbol);
    }
    return [...out].sort();
  }

  /** Markets whose latest snapshot is older than the freshness window. */
  private staleMarketTargets(): string[] {
    const cutoff = new Date(Date.now() - this.doctrine.value("snapshotMaxAgeMin", 90) * 60_000).toISOString();
    const fresh = new Set<string>();
    for (const r of this.store?.latestMarketSnapshots() ?? []) {
      if (r.timestamp >= cutoff) fresh.add(r.waypointSymbol);
    }
    return this.marketTourTargets().filter((m) => !fresh.has(m));
  }

  /** Shipyard waypoints to tour periodically so ship stock stays fresh. */
  private shipyardTourTargets(): string[] {
    const out = new Set<string>();
    for (const r of this.store?.shipyardInventory() ?? []) out.add(r.waypointSymbol);
    const known = this.galaxy.getSystem(this.systemSymbol);
    for (const w of known?.waypoints ?? []) {
      if (w.traits.some((t) => t.symbol === "SHIPYARD")) out.add(w.symbol);
    }
    return [...out].sort();
  }

  /**
   * Sector-based market tour targets: each tour shuttle covers a distinct slice
   * of the system's markets so coverage spreads instead of every shuttle
   * clustering on the same nearest market. Markets are sorted by position and
   * split round-robin across the tour fleet.
   */
  private sectorTourTargets(shipSymbol: string): string[] {
    const all = this.marketTourTargets();
    const tourShips = [...this.tours.keys()].sort();
    const idx = tourShips.indexOf(shipSymbol);
    if (idx < 0 || tourShips.length <= 1) return all;
    return all.filter((_, i) => i % tourShips.length === idx);
  }

  /**
   * Assign a keeper market to a probe/satellite. Probes can't move, so the
   * keeper market must be where the probe already is — and that waypoint must
   * be a marketplace (so its prices are worth polling). Prefer shipyard-markets
   * (A2, C43, H56) since they're also where we buy ships.
   */
  private keeperMarketFor(ship: Ship): string | undefined {
    const here = ship.nav.waypointSymbol;
    const known = this.galaxy.getSystem(ship.nav.systemSymbol);
    const isMarket = known?.waypoints.some(
      (w) => w.symbol === here && w.traits.some((t) => t.symbol === "MARKETPLACE"),
    );
    if (!isMarket) return undefined;
    return here;
  }

  /** Snapshot a shipyard's inventory at a waypoint (only visible when docked). */
  async recordShipyardSnapshot(waypointSymbol: string): Promise<void> {
    const systemSymbol = waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
    try {
      const yard = await this.api.getShipyard(systemSymbol, waypointSymbol);
      this.store?.recordShipyardInventory(systemSymbol, waypointSymbol, yard.ships ?? []);
      this.onActivity?.("shipyard", `snapshot ${waypointSymbol} (${(yard.ships ?? []).length} ships)`, 0);
    } catch (err) {
      // ignore: shipyard may not be scannable
    }
  }

  /**
   * Can `shipSymbol` physically get to `targetWaypoint` (same system)? A ship can
   * make the trip if the straight-line distance fits in one tank, or if there is a
   * chain of fuel stops where each hop fits in a full tank. Falls back to the
   * direct-tank check when positions are unknown.
   */
  private canReachTarget(shipSymbol: string, targetWaypoint: string): boolean {
    const ship = this.cachedShip(shipSymbol);
    const cap = ship?.fuel.capacity ?? 0;
    if (cap <= 0) return false;
    const start = this.shipWaypoint(shipSymbol);
    if (!start) return false;
    if (targetWaypoint === start) return true;
    const direct = this.estimatedFuelBetween(start, targetWaypoint);
    if (direct <= cap) return true;
    if (!Number.isFinite(direct)) return false;

    const systemSymbol = targetWaypoint.slice(0, targetWaypoint.lastIndexOf("-"));
    const stops = this.fuelStops(systemSymbol);
    stops.add(start);
    stops.add(targetWaypoint);
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of stops) {
        if (seen.has(next)) continue;
        if (this.estimatedFuelBetween(cur, next) <= cap) {
          if (next === targetWaypoint) return true;
          queue.push(next);
        }
      }
    }
    return false;
  }

  private suspendAgent(symbol: string): void {
    this.controlledAgent(symbol)?.suspend();
  }

  private resumeAgent(symbol: string): void {
    this.controlledAgent(symbol)?.resume();
  }

  /** Known markets that sell a trade good, cheapest first (for mission sourcing). */
  private materialBuyers(tradeSymbol: string): { waypoint: string; purchasePrice: number; tradeVolume: number }[] {
    const rows = this.store?.latestMarketSnapshots().filter((r) => r.goodSymbol === tradeSymbol && r.purchasePrice > 0) ?? [];
    return rows
      .map((r) => ({ waypoint: r.waypointSymbol, purchasePrice: r.purchasePrice, tradeVolume: r.tradeVolume }))
      .sort((a, b) => a.purchasePrice - b.purchasePrice);
  }

  /** Survey unknown marketplaces across loaded systems looking for a needed good. */
  private async discoverMaterialBuyers(tradeSymbol: string): Promise<{ waypoint: string; purchasePrice: number }[]> {
    const surveyed = new Set<string>();
    for (const r of this.store?.latestMarketSnapshots() ?? []) surveyed.add(r.waypointSymbol);

    const systems = [...this.galaxy.listSystems(), ...(this.galaxy.getSystem(this.systemSymbol) ? [] : [])];
    const candidates: { system: string; waypoint: string }[] = [];
    for (const sys of systems) {
      for (const w of sys.waypoints) {
        if (!w.traits.some((t) => t.symbol === "MARKETPLACE")) continue;
        if (surveyed.has(w.symbol)) continue;
        candidates.push({ system: sys.symbol, waypoint: w.symbol });
      }
    }
    // Survey at most a small batch per call so we never hammer the API in one tick.
    const batch = candidates.slice(0, 6);
    for (const { system, waypoint } of batch) {
      try {
        const market = await this.api.getMarket(system, waypoint);
        for (const g of market.tradeGoods ?? []) {
          this.store?.recordMarket({
            systemSymbol: system,
            waypointSymbol: waypoint,
            goodSymbol: g.symbol,
            type: g.type,
            supply: g.supply,
            purchasePrice: g.purchasePrice,
            sellPrice: g.sellPrice,
            tradeVolume: g.tradeVolume,
          });
        }
        this.log(`mission discovery: surveyed ${waypoint} (${market.tradeGoods?.length ?? 0} goods)`);
      } catch (err) {
        this.log(`mission discovery: ${waypoint} survey failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.materialBuyers(tradeSymbol);
  }

  /** Active missions for the dashboard. */
  getMissions() {
    return this.missions.list().map((m) => ({ ...m, paused: this.missions.isPaused(m.targetWaypoint) }));
  }

  /** Start a construction-supply mission for a waypoint under construction. */
  startMission(waypointSymbol: string): Promise<void> {
    return this.missions.startConstruction(waypointSymbol);
  }

  /** Pause a construction mission (stop sourcing/spending). */
  pauseMission(waypointSymbol: string): void {
    this.missions.pause(waypointSymbol);
  }

  /** Resume a paused construction mission. */
  resumeMission(waypointSymbol: string): void {
    this.missions.resumeMission(waypointSymbol);
  }

  /**
   * Manually pick which ship carries a mission's supplies, instead of leaving
   * it to the auto-picker (biggest cargo hold that can reach the site). The
   * ship must have a cargo hold and not already be carrying a different
   * mission — reassigning a ship already committed elsewhere would strand
   * that mission's supply run.
   */
  assignMissionCarrier(waypointSymbol: string, shipSymbol: string): void {
    const agent = this.miners.get(shipSymbol) ?? this.traders.get(shipSymbol);
    if (!agent) throw new Error(`${shipSymbol} is not a miner or trader — missions need a cargo hold`);
    if ((agent.getShip().cargo?.capacity ?? 0) <= 0) throw new Error(`${shipSymbol} has no cargo hold`);
    const other = this.missions
      .list()
      .find((m) => m.assignedShip === shipSymbol && m.targetWaypoint !== waypointSymbol && m.status === "active");
    if (other) throw new Error(`${shipSymbol} is already carrying the mission at ${other.targetWaypoint}`);
    this.missions.assignCarrier(waypointSymbol, shipSymbol);
  }

  /** Estimate fuel needed to fly a ship from its current waypoint to a target. */
  estimatedFuelTo(shipSymbol: string, waypointSymbol: string): number {
    const ship = this.positions.find((p) => p.symbol === waypointSymbol);
    const here = this.positions.find((p) => p.symbol === this.shipWaypoint(shipSymbol));
    if (!ship || !here) return 0;
    return Math.max(1, Math.round(Math.hypot(ship.x - here.x, ship.y - here.y)));
  }

  private shipWaypoint(shipSymbol: string): string {
    for (const a of this.miners.values()) if (a.symbol === shipSymbol) return a.getShip().nav.waypointSymbol;
    for (const a of this.traders.values()) if (a.symbol === shipSymbol) return a.getShip().nav.waypointSymbol;
    for (const a of this.surveyors.values()) if (a.symbol === shipSymbol) return a.getShip().nav.waypointSymbol;
    for (const a of this.scouts.values()) if (a.symbol === shipSymbol) return a.getShip().nav.waypointSymbol;
    for (const a of this.siphoners.values()) if (a.symbol === shipSymbol) return a.getShip().nav.waypointSymbol;
    const idle = this.idleShips.get(shipSymbol);
    return idle?.nav.waypointSymbol ?? "";
  }

  /** Return the most recent cached Ship snapshot for a symbol, if known. */
  private cachedShip(shipSymbol: string): Ship | undefined {
    for (const a of this.miners.values()) if (a.symbol === shipSymbol) return a.getShip();
    for (const a of this.traders.values()) if (a.symbol === shipSymbol) return a.getShip();
    for (const a of this.surveyors.values()) if (a.symbol === shipSymbol) return a.getShip();
    for (const a of this.scouts.values()) if (a.symbol === shipSymbol) return a.getShip();
    for (const a of this.siphoners.values()) if (a.symbol === shipSymbol) return a.getShip();
    return this.idleShips.get(shipSymbol);
  }

  /** Return cached shipyard + module intelligence for the dashboard. */
  getIntel(): {
    shipyards: ReturnType<Store["shipyardInventory"]>;
    modules: ReturnType<Store["moduleCatalog"]>;
  } {
    return {
      shipyards: this.store?.shipyardInventory() ?? [],
      modules: this.store?.moduleCatalog() ?? [],
    };
  }

  /** Non-expired surveys in the shared pool, optionally for one waypoint. */
  surveyData(waypoint?: string): ReturnType<SurveyPool["list"]> {
    return this.surveyPool.list(waypoint);
  }

  /** Pause/resume autonomous tick loop. Individual ship commands still work while paused. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.store?.setFleetFlag("paused", paused ? "true" : "false");
    this.log(paused ? "fleet paused" : "fleet resumed");
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * The agent driving a ship, whatever its role. Every agent class exposes the
   * same control surface (dispatchTo/release/suspend/resume), so per-ship
   * commands work for surveyors and tour scouts too — not just the three roles
   * the dashboard used to reach.
   */
  private controlledAgent(shipSymbol: string): ControlledAgent | undefined {
    return (
      this.miners.get(shipSymbol) ??
      this.traders.get(shipSymbol) ??
      this.surveyors.get(shipSymbol) ??
      this.tours.get(shipSymbol) ??
      this.scouts.get(shipSymbol) ??
      this.siphoners.get(shipSymbol)
    );
  }

  /** Dispatch any ship to a specific waypoint, jumping systems if necessary. */
  async dispatchShip(shipSymbol: string, waypointSymbol: string): Promise<void> {
    const ship = await this.api.getShip(shipSymbol);
    const targetSystem = waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
    if (ship.nav.systemSymbol !== targetSystem) {
      await this.jumpShip(shipSymbol, waypointSymbol);
      return;
    }

    const agent = this.controlledAgent(shipSymbol);
    if (!agent) throw new Error(`ship ${shipSymbol} is not under fleet control`);
    await agent.dispatchTo(waypointSymbol);
  }

  /**
   * Put one ship under manual control, holding it where it already is. This is
   * the per-ship counterpart to `setPaused`, which halts the whole fleet — the
   * dashboard's per-ship "stop" must never reach for the fleet-wide switch.
   * Deliberately does not route through `dispatchShip`, so a ship sitting at
   * 0 fuel (exactly the case an operator needs to take manual control of) can
   * still be held rather than failing a fuel pre-check.
   */
  async holdShip(shipSymbol: string): Promise<void> {
    const agent = this.controlledAgent(shipSymbol);
    if (!agent) throw new Error(`ship ${shipSymbol} is not under fleet control`);
    const here = this.shipWaypoint(shipSymbol) || (await this.api.getShip(shipSymbol)).nav.waypointSymbol;
    await agent.dispatchTo(here);
    this.updateShipManualState(shipSymbol, { holdWaypoint: here });
    this.log(`${shipSymbol} held at ${here} under manual control`);
  }

  /** Manual hold + mining-field pin, keyed by ship, as one `fleet_flags` JSON
   *  blob — the same "small settings" mechanism `keeperMarkets` already uses.
   *  Read once at boot to replay holds/pins that would otherwise be lost. */
  private loadShipManualState(): Record<string, { holdWaypoint?: string; minePin?: string }> {
    const raw = this.store?.getFleetFlag("shipManualState");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private updateShipManualState(shipSymbol: string, patch: { holdWaypoint?: string | null; minePin?: string | null }): void {
    if (!this.store) return;
    const all = this.loadShipManualState();
    const next = { ...(all[shipSymbol] ?? {}) };
    if ("holdWaypoint" in patch) {
      if (patch.holdWaypoint) next.holdWaypoint = patch.holdWaypoint;
      else delete next.holdWaypoint;
    }
    if ("minePin" in patch) {
      if (patch.minePin) next.minePin = patch.minePin;
      else delete next.minePin;
    }
    if (Object.keys(next).length === 0) delete all[shipSymbol];
    else all[shipSymbol] = next;
    if (Object.keys(all).length === 0) this.store.removeFleetFlag("shipManualState");
    else this.store.setFleetFlag("shipManualState", JSON.stringify(all));
  }

  /**
   * Designate a ship as the warehouse: fly it to `waypointSymbol` and hold it
   * there permanently, same manual-dispatch/hold mechanism as any other
   * per-ship pin — there's no new stationary-ship role, this ship just never
   * gets released. Only one warehouse ship at a time; designating a new one
   * releases whichever ship held the job before.
   */
  async designateWarehouseShip(shipSymbol: string, waypointSymbol: string): Promise<void> {
    const agent = this.controlledAgent(shipSymbol);
    if (!agent) throw new Error(`${shipSymbol} is not under fleet control`);
    if ((agent.getShip().cargo?.capacity ?? 0) <= 0) throw new Error(`${shipSymbol} has no cargo hold — can't warehouse anything`);
    if (this.warehouseShip && this.warehouseShip.shipSymbol !== shipSymbol) {
      this.releaseWarehouseShip();
    }
    await this.dispatchShip(shipSymbol, waypointSymbol);
    this.warehouseShip = { shipSymbol, waypointSymbol };
    this.store?.setFleetFlag("warehouseShip", JSON.stringify(this.warehouseShip));
    this.log(`${shipSymbol} designated warehouse ship, parked at ${waypointSymbol}`);
  }

  /** Hand the warehouse ship back to normal duty. */
  releaseWarehouseShip(): void {
    if (!this.warehouseShip) return;
    const { shipSymbol } = this.warehouseShip;
    this.warehouseShip = undefined;
    this.store?.removeFleetFlag("warehouseShip");
    try {
      this.releaseShip(shipSymbol);
    } catch {
      // Ship may already be gone (scrapped) — nothing left to release.
    }
    this.log(`${shipSymbol} released from warehouse duty`);
  }

  /** Everything the warehouse currently holds, for the API/UI. */
  warehouseGoods(): { goodSymbol: string; units: number; avgCost: number; value: number }[] {
    return this.store?.warehouseAll() ?? [];
  }

  /** Total value of everything the warehouse holds, at cost basis. */
  warehouseValue(): number {
    return this.store?.warehouseValue() ?? 0;
  }

  /** Recent warehouse deposits/withdrawals, newest first. */
  warehouseLedger(limit?: number): { timestamp: string; goodSymbol: string; delta: number; price: number; shipSymbol: string | null; reason: string }[] {
    return this.store?.warehouseLedger(limit) ?? [];
  }

  /**
   * Manual operator adjustment to the warehouse's bookkeeping — corrections,
   * seeding initial stock, writing off a discrepancy. This is deliberately
   * bookkeeping-only, the same trust level as the dispatcher's manual route
   * override: it does not move any real cargo, so an operator using it to
   * "deposit" units that were never actually loaded onto the warehouse ship
   * will desync the books from the ship's real hold.
   */
  adjustWarehouse(good: string, units: number, direction: "deposit" | "withdraw", price: number): { units: number; avgCost: number } {
    if (!this.store) throw new Error("store not available");
    if (direction === "deposit") {
      const newUnits = this.store.warehouseDeposit(good, units, price, undefined, "adjust");
      const avgCost = this.store.warehouseAll().find((g) => g.goodSymbol === good)?.avgCost ?? price;
      return { units: newUnits, avgCost };
    }
    const currentAvg = this.store.warehouseAll().find((g) => g.goodSymbol === good)?.avgCost ?? 0;
    return this.store.warehouseWithdraw(good, units, currentAvg, undefined, "adjust");
  }

  /** The current warehouse ship and where it's parked, if one is designated. */
  getWarehouseShip(): { shipSymbol: string; waypointSymbol: string } | undefined {
    return this.warehouseShip;
  }

  /**
   * Dispatch a ship to a same-system waypoint, navigating leg-by-leg through
   * fuel stops when the direct hop exceeds the tank. Refuels at each stop so a
   * ship with modest range can reach a distant target (e.g. the gate at I59).
   * Uses the raw API for navigation so it works for any ship, not just managed
   * agents. Only intended for single-stop hops in the same system.
   */
  private async dispatchShipHop(shipSymbol: string, waypointSymbol: string): Promise<void> {
    let ship = await this.api.getShip(shipSymbol);
    const targetSystem = waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
    if (ship.nav.systemSymbol !== targetSystem) {
      await this.dispatchShip(shipSymbol, waypointSymbol);
      return;
    }
    const cap = ship.fuel.capacity;
    if (cap <= 0) {
      await this.dispatchShip(shipSymbol, waypointSymbol);
      return;
    }
    const start = ship.nav.waypointSymbol;
    if (start === waypointSymbol && ship.nav.status !== "IN_TRANSIT") return;

    // If we start at a fuel stop, top up first so we have a full tank to hop with.
    if (this.fuelStops(targetSystem).has(start)) {
      const docked = await this.api.getShip(shipSymbol);
      if (docked.nav.status === "IN_ORBIT") await this.api.dockShip(shipSymbol);
      await this.api.refuelShip(shipSymbol);
      this.log(`${shipSymbol} topped up to full at ${start}`);
    }

    // Plan the hop path: always advance toward the target by preferring the fuel
    // stop that is closest to the destination (not furthest from the start), so the
    // carrier makes forward progress toward the gate instead of wandering.
    const stops = [...this.fuelStops(targetSystem)].filter((s) => s !== waypointSymbol && s !== start);
    stops.sort((a, b) => this.estimatedFuelBetween(a, waypointSymbol) - this.estimatedFuelBetween(b, waypointSymbol));

    let current = start;
    while (current !== waypointSymbol) {
      const fresh = await this.api.getShip(shipSymbol);
      if (fresh.nav.waypointSymbol !== current || fresh.nav.status === "IN_TRANSIT") {
        await this.waitForArrivalShip(shipSymbol);
        current = (await this.api.getShip(shipSymbol)).nav.waypointSymbol;
        continue;
      }
      // Fuel budget: a full tank when at a fuel stop (we just topped up / will refuel),
      // otherwise whatever fuel is currently in the tank.
      const atFuelStop = this.fuelStops(targetSystem).has(current);
      const budget = atFuelStop ? fresh.fuel.capacity : fresh.fuel.current;
      // If we can reach the target now, go straight there.
      if (this.estimatedFuelBetween(current, waypointSymbol) <= budget) {
        if (fresh.nav.status !== "IN_ORBIT") await this.api.orbitShip(shipSymbol);
        const res = await this.api.navigateShip(shipSymbol, waypointSymbol);
        this.log(`${shipSymbol} en route ${current} -> ${waypointSymbol} (${res.fuel.current}/${res.fuel.capacity} fuel)`);
        await this.waitForArrivalShip(shipSymbol);
        current = waypointSymbol;
        break;
      }
      // Otherwise pick a reachable fuel stop that moves us closer.
      const next = stops.find((s) => this.estimatedFuelBetween(current, s) <= budget);
      if (!next) {
        this.log(`${shipSymbol} cannot hop toward ${waypointSymbol} from ${current} (no reachable fuel stop)`);
        return;
      }
      if (fresh.nav.status !== "IN_ORBIT") await this.api.orbitShip(shipSymbol);
      const res = await this.api.navigateShip(shipSymbol, next);
      this.log(`${shipSymbol} hopping ${current} -> ${next} to refuel (${res.fuel.current}/${res.fuel.capacity} fuel)`);
      await this.waitForArrivalShip(shipSymbol);
      // Dock and refuel at the stop.
      await this.api.dockShip(shipSymbol);
      await this.api.refuelShip(shipSymbol);
      this.log(`${shipSymbol} refueled at ${next}`);
      current = next;
    }
  }

  /** Wait for a ship to finish any in-progress transit. */
  private async waitForArrivalShip(shipSymbol: string): Promise<void> {
    for (;;) {
      const ship = await this.api.getShip(shipSymbol);
      if (ship.nav.status !== "IN_TRANSIT") return;
      const arrival = new Date(ship.nav.route.arrival).getTime();
      const wait = arrival - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait + 500));
    }
  }

  /** Release a ship from manual dispatch back to autonomous operation. */
  /**
   * Pin a mining ship to one asteroid field. Unlike `dispatchShip`, this leaves
   * the ship working — it keeps mining, hauling and selling on its own, it just
   * stops picking the field.
   */
  mineAt(shipSymbol: string, waypointSymbol: string): void {
    const agent = this.miners.get(shipSymbol) ?? this.surveyors.get(shipSymbol);
    if (!agent) throw new Error(`ship ${shipSymbol} is not a mining or survey ship`);
    const type = this.galaxy.allPositions().find((p) => p.symbol === waypointSymbol)?.type;
    if (type && !["ASTEROID", "ASTEROID_FIELD", "ENGINEERED_ASTEROID"].includes(type)) {
      throw new Error(`${waypointSymbol} is a ${type}, not an asteroid field`);
    }
    agent.mineAt(waypointSymbol);
    this.updateShipManualState(shipSymbol, { minePin: waypointSymbol });
    this.log(`${shipSymbol} pinned to mine at ${waypointSymbol}`);
  }

  /** Hand field selection back to a pinned mining ship. */
  unpinMining(shipSymbol: string): void {
    const agent = this.miners.get(shipSymbol) ?? this.surveyors.get(shipSymbol);
    if (!agent) throw new Error(`ship ${shipSymbol} is not a mining or survey ship`);
    agent.unpinMining();
    this.updateShipManualState(shipSymbol, { minePin: null });
  }

  releaseShip(shipSymbol: string): void {
    const agent = this.controlledAgent(shipSymbol);
    if (!agent) throw new Error(`ship ${shipSymbol} is not under fleet control`);
    // A ship suspended for a rescue/mission must also be un-suspended, or it
    // would sit idle forever after being "returned to auto".
    agent.release();
    agent.resume();
    // agent.release() also unpins mining (see ShipAgent.release), so both
    // halves of the manual state clear together here.
    this.updateShipManualState(shipSymbol, { holdWaypoint: null, minePin: null });
  }

  getShipStatuses(): { symbol: string; role: string; status: string; paused: boolean; pinnedField?: string }[] {
    const warehouseSymbol = this.warehouseShip?.shipSymbol;
    const notWarehouse = (s: string) => s !== warehouseSymbol;
    const statuses = [
      ...[...this.miners.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "miner", status: a.getShip().nav.status, paused: a.isManual(), pinnedField: a.pinnedField() })),
      ...[...this.traders.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "trader", status: a.getShip().nav.status, paused: a.isManual() })),
      ...[...this.surveyors.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "surveyor", status: a.getShip().nav.status, paused: a.isManual(), pinnedField: a.pinnedField() })),
      ...[...this.tours.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "tour", status: a.getShip().nav.status, paused: a.isManual() })),
      ...[...this.keepers.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "keeper", status: a.getShip().nav.status, paused: a.isManual() })),
      ...[...this.scouts.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "scout", status: a.getShip().nav.status, paused: a.isManual() })),
      ...[...this.siphoners.entries()].filter(([s]) => notWarehouse(s)).map(([s, a]) => ({ symbol: s, role: "siphoner", status: a.getShip().nav.status, paused: a.isManual() })),
      ...[...this.idleShips.keys()].filter(notWarehouse).map((s) => ({ symbol: s, role: "idle", status: "IDLE", paused: false })),
    ];
    if (warehouseSymbol) {
      const agent = this.controlledAgent(warehouseSymbol);
      if (agent) statuses.push({ symbol: warehouseSymbol, role: "warehouse", status: agent.getShip().nav.status, paused: agent.isManual() });
    }
    return statuses;
  }

  /** Detect ships stranded without enough fuel to reach any known market. */
  getStrandedShips(): { symbol: string; waypointSymbol: string; fuel: number; reason: string }[] {
    const stranded: { symbol: string; waypointSymbol: string; fuel: number; reason: string }[] = [];
    for (const ship of [...this.miners.values(), ...this.traders.values()]) {
      const s = ship.getShip();
      if (s.fuel.capacity <= 0) continue;
      // A trader that flagged itself stranded (navigation failed for lack of
      // fuel) needs a tender even if it still has a few units left.
      const flagged = this.traders.get(s.symbol)?.isStranded() ?? false;
      if (flagged) {
        stranded.push({
          symbol: s.symbol,
          waypointSymbol: s.nav.waypointSymbol,
          fuel: s.fuel.current,
          reason: "marked stranded (insufficient fuel to reach a market)",
        });
        continue;
      }
      if (s.fuel.current > 0) continue;
      const atMarket = this.positions.some(
        (p) => p.symbol === s.nav.waypointSymbol && this.galaxy.getSystem(s.nav.systemSymbol)?.waypoints.some((w) => w.symbol === p.symbol && w.traits.some((t) => t.symbol === "MARKETPLACE")),
      );
      if (atMarket) continue;
      stranded.push({
        symbol: s.symbol,
        waypointSymbol: s.nav.waypointSymbol,
        fuel: s.fuel.current,
        reason: "0 fuel and not at a market",
      });
    }
    return stranded;
  }

  /**
   * Refresh the cached credit balance, at most once per `CREDITS_TTL_MS`.
   *
   * This used to run on every 2s coordinator tick — 0.5 req/s of a 2 req/s
   * budget for a number that only gates "should I consider buying a ship" and
   * route affordability ranking. Neither needs second-resolution: a stale-high
   * value at worst attempts a purchase the API refuses, a stale-low one defers
   * a purchase by a few seconds. The paths where an exact balance actually
   * matters — `TraderAgent.runBuy` and the mission carrier's buy sizing — read
   * it live at the point of purchase and are unaffected by this.
   */
  private async refreshCredits(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCreditsFetch < CREDITS_TTL_MS) return;
    this.lastCreditsFetch = now;
    try {
      this.credits = (await this.api.getMyAgent()).credits;
    } catch (err) {
      // ignore: credits refresh is best-effort
    }
  }

  /** One coordination pass over the whole fleet. */
  async tick(): Promise<void> {
    if (this.paused) {
      // Halt stops *automation*, not *recovery*. Rescue is the one thing that
      // must keep running: a halted fleet still has ships sitting at 0 fuel,
      // and previously pausing switched off the only mechanism that recovers
      // them while leaving every ship loop running — so a Halt actively made
      // stranding more likely. Rescue drives its tender directly through the
      // API rather than through an agent loop, so it works while the loops
      // are held.
      await this.rescueStranded();
      return;
    }
    await this.refreshCredits();
    if (this.contracts) {
      await this.contracts.fulfillCompleted();
      await this.contracts.acceptBest();
    }
    // Centralized route dispatch: recompute distinct per-trader assignments.
    const routes = this.computeDispatchRoutes();
    this.dispatcher.recompute(routes, this.dispatcherTraders(), this.computeWarehouseTargets(routes), this.computeHaulTargets(), this.computeMissionBuyTargets());
    await this.maybeAssignKeepers();
    await this.maybeBuyShip();
    await this.maybeBuyScout();
    await this.maybeBuySiphoner();
    await this.maybeInstallScanner();
    await this.autoExplore();
    await this.rescueStranded();
    await this.missions.tick();
  }

  /**
   * Station keepers at the highest-value buy markets so their prices never go
   * stale. Probes already park at shipyard-markets (A2/C43/H56). This converts
   * idle miners (then idle shuttles) into keepers at the outer buy markets the
   * dispatcher prices routes from (D46, E48, K85, F52, E49) — a miner earns
   * ~2k/hr mining, but one fresh route is worth far more.
   */
  private async maybeAssignKeepers(): Promise<void> {
    const target = this.doctrine.value("keeperCount", 0);
    if (target <= 0) return;
    const coverList = this.keeperCoverList();
    const priority = this.keeperPriorityMarkets();
    // Prefer an idle miner (empty hold, not manual, not suspended); fall back
    // to an idle tour shuttle so we never block on a busy ship. Drains the
    // whole uncovered list in one pass when coverList is on; otherwise stops at
    // the keeperCount cap. The conversion itself makes no API calls, so the old
    // one-ship-per-pass crawl just wasted minutes.
    const idle = (a: ShipAgent) => !a.isManual() && !a.isSuspended() && (a.getShip().cargo?.units ?? 0) === 0;
    const miners = [...this.miners.entries()].filter(([, a]) => idle(a));
    const shuttles = [...this.tours.entries()].filter(([, a]) => idle(a));
    for (;;) {
      const need = this.priorityUncovered();
      if (need.length === 0) break;
      if (!coverList && this.keepers.size >= target) break;
      const miner = miners.shift();
      const source = miner ?? shuttles.shift();
      if (!source) break;
      const [sym, agent] = source;
      const what = miner ? "miner" : "shuttle";
      const market = need[0]!;
      // Stop the old loop so it doesn't keep mining/touring while the keeper
      // agent takes over the same ship.
      agent.stop();
      this.miners.delete(sym);
      this.tours.delete(sym);
      const keeper = new ShipAgent(agent.getShip(), {
        api: this.api,
        shouldRun: () => !this.paused,
        log: (m) => this.log(`${sym}: ${m}`),
        recordLedger: this.recordLedger,
        onActivity: (kind, detail, credits) => this.onActivity?.(kind, `${sym} ${detail}`, credits),
        recordMarket: (wp) => this.recordMarketSnapshot(wp),
        recordShipyard: (wp) => this.recordShipyardSnapshot(wp),
        keeperMarket: () => this.keeperMarkets.get(sym),
      }).withWorld(this.positions, this.markets);
      this.keepers.set(sym, keeper);
      this.keeperMarkets.set(sym, market);
      this.store?.setFleetState(sym, "keeper", market);
      this.log(`role: keeper ${sym} (converted from ${what}, stationed at ${market})`);
      // Launch the keeper loop now — the run() loop array was built at startup,
      // so a mid-run conversion needs its own loop.
      void keeper.keeperLoop(1_000_000);
    }
  }

  /** Whether keepers should cover the entire configured list regardless of the
   *  keeperCount cap. Persisted as a fleet flag, toggled from the dashboard. */
  keeperCoverList(): boolean {
    const raw = this.store?.getFleetFlag("keeperCoverList");
    if (raw === undefined) return false;
    try {
      return JSON.parse(raw) === true;
    } catch {
      return false;
    }
  }

  setKeeperCoverList(value: boolean): void {
    this.store?.setFleetFlag("keeperCoverList", JSON.stringify(value));
  }

  /** Priority markets from the configured list that no keeper currently covers. */
  private priorityUncovered(): string[] {
    const covered = new Set(this.keeperMarkets.values());
    return this.keeperPriorityMarkets().filter((m) => !covered.has(m));
  }

  /** Ordered list of buy markets to station keepers at. Stored as a JSON flag
   *  so the dashboard can edit it; falls back to the built-in default. */
  keeperPriorityMarkets(): string[] {
    const raw = this.store?.getFleetFlag("keeperMarkets");
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((m) => typeof m === "string")) return parsed as string[];
      } catch {
        // fall through to the default
      }
    }
    const def = [...DEFAULT_KEEPER_MARKETS];
    this.store?.setFleetFlag("keeperMarkets", JSON.stringify(def));
    return def;
  }

  /** Replace the keeper priority list. Returns the cleaned list actually stored. */
  setKeeperPriorityMarkets(markets: string[]): string[] {
    const clean = [...new Set(markets.map((m) => m.trim().toUpperCase()).filter((m) => m.length > 0))];
    this.store?.setFleetFlag("keeperMarkets", JSON.stringify(clean));
    return clean;
  }

  /** Drop the override and fall back to the built-in default list. */
  resetKeeperPriorityMarkets(): string[] {
    this.store?.removeFleetFlag("keeperMarkets");
    return this.keeperPriorityMarkets();
  }

  /** Current keeper stations for the dashboard: ship → market it guards. */
  keeperStations(): { shipSymbol: string; market: string }[] {
    return [...this.keeperMarkets.entries()].map(([shipSymbol, market]) => ({ shipSymbol, market }));
  }

  /** Attempt to rescue ships stranded at 0 fuel, first from their own cargo hold,
   *  then by dispatching a fuel tender to ferry FUEL to them. */
  private async rescueStranded(): Promise<void> {
    const stranded = this.getStrandedShips();
    for (const s of stranded) {
      try {
        const ship = await this.api.getShip(s.symbol);
        const fuelInCargo = ship.cargo.inventory?.find((i) => i.symbol === "FUEL");
        if (fuelInCargo && fuelInCargo.units > 0) {
          this.log(`rescuing ${s.symbol}: refueling from cargo (${fuelInCargo.units}u FUEL)`);
          await this.api.refuelShip(s.symbol, undefined, true);
          this.onActivity?.("refuel", `${s.symbol} rescued: refueled from cargo hold`, 0);
          continue;
        }
      } catch (err) {
        this.log(`rescue ${s.symbol} failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      await this.tenderRescueStep(s);
    }
  }

  /** Find a tender that can reach the nearest market to the stranded ship, and plan the ferry. */
  private async makeRescuePlan(s: { symbol: string; waypointSymbol: string; fuel: number }): Promise<TenderPlan | undefined> {
    const systemSymbol = s.waypointSymbol.slice(0, s.waypointSymbol.lastIndexOf("-"));
    const known = this.galaxy.getSystem(systemSymbol);

    // Market candidates: any waypoint with a MARKETPLACE trait (known even before survey),
    // plus surveyed snapshots in memory AND in the store DB. Nearest to the stranded ship first.
    const marketSymbols = new Set<string>(this.markets.filter((m) => m.systemSymbol === systemSymbol).map((m) => m.symbol));
    for (const r of this.store?.latestMarketSnapshots().filter((r) => r.systemSymbol === systemSymbol) ?? []) {
      marketSymbols.add(r.waypointSymbol);
    }
    for (const w of known?.waypoints ?? []) {
      if (w.traits.some((t) => t.symbol === "MARKETPLACE")) marketSymbols.add(w.symbol);
    }
    // RLC8989-4's agent discovers markets via observeMarket and keeps its own list, but the
    // coordinator may not have them yet; store is the most reliable source.
    const markets = [...marketSymbols]
      .map((sym) => ({ sym, dist: this.estimatedFuelBetween(s.waypointSymbol, sym) }))
      .sort((a, b) => a.dist - b.dist);
    if (markets.length === 0) {
      this.log(`no fuel tender possible for ${s.symbol}: no market known in ${systemSymbol}`);
      return undefined;
    }
    const strandedCap = this.cachedShip(s.symbol)?.fuel.capacity ?? 20;

    // Find a parked ship in the same system (most fuel first) that can actually get to a market.
    const candidates = [
      ...[...this.miners.entries()].filter(([, a]) => !a.isManual()),
      ...[...this.traders.entries()].filter(([, a]) => !a.isManual()),
    ]
      .map(([sym, a]) => ({ sym, ship: a.getShip() as Ship }))
      .concat([...this.idleShips.entries()].map(([sym, ship]) => ({ sym, ship })))
      .filter(({ sym, ship }) => {
        if (sym === s.symbol) return false;
        if (ship.nav.status === "IN_TRANSIT") return false;
        if (ship.nav.waypointSymbol === s.waypointSymbol) return false;
        if (ship.cargo.capacity <= 0) return false; // can't ferry any fuel
        return true;
      })
      .sort((a, b) => b.ship.fuel.current - a.ship.fuel.current);

    let tender: { sym: string; ship: Ship } | undefined;
    let market: { sym: string; dist: number } | undefined;
    // Rank by total journey cost: distance from the tender to a market, plus that market's
    // distance to the stranded ship. A ship already near the stranded (e.g. RLC8989-4 at E50,
    // a hop from market E47) beats a distant ship parked at a far market (RLC8989-5 at FX5Z).
    const ranked = [...candidates]
      .map((c) => {
        const atMarketIdx = markets.findIndex((m) => m.sym === c.ship.nav.waypointSymbol);
        const near = markets[atMarketIdx >= 0 ? atMarketIdx : 0];
        const toMarket = this.estimatedFuelBetween(c.ship.nav.waypointSymbol, near!.sym);
        const fromMarket = near!.dist;
        return { ...c, toMarket: Number.isFinite(toMarket) ? toMarket : Infinity, fromMarket: Number.isFinite(fromMarket) ? fromMarket : Infinity };
      })
      .sort((a, b) => a.toMarket + a.fromMarket - (b.toMarket + b.fromMarket) || b.ship.fuel.current - a.ship.fuel.current);
    for (const cand of ranked) {
      // Prefer loading at the tender's current waypoint if it's already a market, else the
      // market nearest the stranded ship.
      const nearestIdx = markets.findIndex((m) => m.sym === cand.ship.nav.waypointSymbol);
      const nearest = markets[nearestIdx >= 0 ? nearestIdx : 0];
      const fuelToMarket = this.estimatedFuelBetween(cand.ship.nav.waypointSymbol, nearest!.sym);
      if (cand.ship.fuel.capacity > 0 && cand.ship.fuel.current < fuelToMarket) {
        this.log(`tender ${cand.sym} cannot reach market ${nearest!.sym} (need ${fuelToMarket} fuel, has ${cand.ship.fuel.current})`);
        continue; // try the next candidate instead of abandoning the rescue
      }
      // The tender must also be able to make the loaded leg from the market to
      // the stranded ship. Tank capacity bounds a single leg — loading fuel
      // doesn't extend range, so a small tank can't ferry to a far ship even if
      // it can reach a nearby market.
      if (cand.ship.fuel.capacity > 0 && cand.ship.fuel.capacity < nearest!.dist) {
        this.log(`tender ${cand.sym} tank too small for ${nearest!.sym}->${s.waypointSymbol} (need ${nearest!.dist} fuel, cap ${cand.ship.fuel.capacity})`);
        continue;
      }
      tender = cand;
      market = nearest!;
      break;
    }
    if (!tender || !market) {
      this.log(`no fuel tender available for ${s.symbol} in ${systemSymbol}`);
      return undefined;
    }
    // Count any FUEL the tender is already hauling, so an interrupted rescue can resume
    // without needing cargo room to re-buy.
    const heldFuel = tender.ship.cargo.inventory?.find((i) => i.symbol === "FUEL")?.units ?? 0;
    const cargoFree = tender.ship.cargo.capacity - tender.ship.cargo.units;
    // Size the delivery to what the stranded needs to limp to the nearest market, not its
    // whole tank. Reserve covers the hop plus a safety margin.
    const fuelNeeded = this.estimatedFuelBetween(s.waypointSymbol, market.sym) + 6;
    const fuelUnits = Math.max(
      1,
      Math.min(strandedCap, fuelNeeded, heldFuel + cargoFree),
    );

    // Suspend the tender's agent so it holds position and doesn't fight the rescue.
    const miner = this.miners.get(tender.sym);
    const trader = this.traders.get(tender.sym);
    if (miner) { miner.suspend(); } else if (trader) { trader.suspend(); }

    this.log(`dispatching fuel tender ${tender.sym} to rescue ${s.symbol}: buy ${Math.max(0, fuelUnits - heldFuel)}u FUEL at ${market.sym} (${heldFuel}u already held), fly to ${s.waypointSymbol}`);
    return {
      strandedSymbol: s.symbol,
      strandedWaypoint: s.waypointSymbol,
      tenderSymbol: tender.sym,
      market: market.sym,
      fuelUnits,
      // Skip the buy step entirely if the tender is already hauling enough fuel.
      phase: heldFuel >= fuelUnits ? "transit" : "buy",
    };
  }

  private async tenderRescueStep(s: { symbol: string; waypointSymbol: string; fuel: number }): Promise<void> {
    let plan = this.rescuePlans.get(s.symbol);
    if (!plan) {
      plan = await this.makeRescuePlan(s);
      if (plan) this.rescuePlans.set(s.symbol, plan);
      if (!plan) return;
    }
    await this.stepRescue(plan);
    if (plan.phase === "done") {
      this.rescuePlans.delete(s.symbol);
      const miner = this.miners.get(plan.tenderSymbol);
      const trader = this.traders.get(plan.tenderSymbol);
      if (miner) { miner.resume(); } else if (trader) { trader.resume(); }
    }
  }

  /** Advance one rescue phase per coordinator tick (never blocks on transit). */
  private async stepRescue(plan: TenderPlan): Promise<void> {
    const tender = await this.api.getShip(plan.tenderSymbol);
    if (tender.nav.status === "IN_TRANSIT") return;

    if (plan.phase === "buy") {
      if (tender.nav.waypointSymbol !== plan.market) {
        if (tender.nav.status === "DOCKED") await this.api.orbitShip(plan.tenderSymbol);
        await this.api.navigateShip(plan.tenderSymbol, plan.market);
        this.log(`tender ${plan.tenderSymbol}: flying to ${plan.market} to load FUEL`);
        return;
      }
      if (tender.nav.status === "IN_ORBIT") await this.api.dockShip(plan.tenderSymbol);
      // Top off the tank so the tender can actually make the trip to the stranded ship.
      if (tender.fuel.capacity > 0 && tender.fuel.current < tender.fuel.capacity) {
        await this.api.refuelShip(plan.tenderSymbol);
      }
      const held = tender.cargo.inventory?.find((i) => i.symbol === "FUEL")?.units ?? 0;
      const toBuy = Math.max(0, plan.fuelUnits - held);
      if (toBuy > 0) {
        const res = await this.api.purchaseCargo(plan.tenderSymbol, "FUEL", toBuy);
        this.log(`tender ${plan.tenderSymbol}: loaded ${res.transaction.units}u FUEL @ ${res.transaction.pricePerUnit}c`);
      } else {
        this.log(`tender ${plan.tenderSymbol}: already holding ${held}u FUEL, skipping buy`);
      }
      plan.phase = "transit";
      return;
    }

    if (plan.phase === "transit") {
      if (tender.nav.waypointSymbol !== plan.strandedWaypoint) {
        await this.api.orbitShip(plan.tenderSymbol);
        await this.api.navigateShip(plan.tenderSymbol, plan.strandedWaypoint);
        this.log(`tender ${plan.tenderSymbol}: en route to ${plan.strandedWaypoint} with ${plan.fuelUnits}u FUEL`);
        return;
      }
      plan.phase = "transfer";
    }

    if (plan.phase === "transfer") {
      // Both ships must be at the same waypoint AND in the same dock state
      // (both docked or both in orbit) for cargo transfer to work.
      const stranded = await this.api.getShip(plan.strandedSymbol);
      if (stranded.nav.waypointSymbol !== tender.nav.waypointSymbol) {
        this.log(`tender ${plan.tenderSymbol}: ${tender.nav.waypointSymbol} != stranded ${stranded.nav.waypointSymbol}; returning to buy phase`);
        plan.phase = "buy";
        return;
      }
      if (stranded.nav.status !== tender.nav.status) {
        this.log(`tender ${plan.tenderSymbol}: aligning dock state (${tender.nav.status} vs ${stranded.nav.status})`);
        if (stranded.nav.status === "DOCKED" && tender.nav.status === "IN_ORBIT") {
          await this.api.dockShip(plan.tenderSymbol);
        } else if (stranded.nav.status === "IN_ORBIT" && tender.nav.status === "DOCKED") {
          await this.api.orbitShip(plan.tenderSymbol);
        }
      }
      // The stranded ship must have cargo room to receive the fuel. If it's carrying ore,
      // jettison just enough to fit (the stranded can't use the ore while out of fuel anyway).
      const fresh = await this.api.getShip(plan.strandedSymbol);
      const freeSpace = fresh.cargo.capacity - fresh.cargo.units;
      if (freeSpace < plan.fuelUnits) {
        const overflow = plan.fuelUnits - freeSpace;
        let toDump = overflow;
        for (const item of [...fresh.cargo.inventory]) {
          if (toDump <= 0) break;
          if (item.symbol === "FUEL") continue;
          const drop = Math.min(toDump, item.units);
          await this.api.jettisonCargo(plan.strandedSymbol, item.symbol, drop);
          toDump -= drop;
        }
        this.log(`tender ${plan.tenderSymbol}: jettisoned ${overflow - toDump}u ore from ${plan.strandedSymbol} to make room for fuel`);
      }
      await this.api.transferCargo(plan.tenderSymbol, "FUEL", plan.fuelUnits, plan.strandedSymbol);
      const refueled = await this.api.refuelShip(plan.strandedSymbol, undefined, true);
      this.log(`tender ${plan.tenderSymbol}: transferred ${plan.fuelUnits}u FUEL to ${plan.strandedSymbol}; stranded refueled to ${refueled.fuel.current}/${refueled.fuel.capacity}`);
      this.onActivity?.("refuel", `${plan.strandedSymbol} rescued: fuel tender delivered ${plan.fuelUnits}u FUEL`, 0);
      // Clear the stranded flag so the ship can resume autonomous trading.
      this.traders.get(plan.strandedSymbol)?.clearStranded();
      this.miners.get(plan.strandedSymbol)?.clearStranded();
      plan.phase = "done";
    }
  }

  /** Distance (≈ fuel) between two waypoints using the atlas. */
  private estimatedFuelBetween(a: string, b: string): number {
    const pa = this.positions.find((p) => p.symbol === a);
    const pb = this.positions.find((p) => p.symbol === b);
    if (!pa || !pb) return Infinity;
    return Math.max(1, Math.round(Math.hypot(pb.x - pa.x, pb.y - pa.y)));
  }

  private async autoExplore(): Promise<void> {
    // Survey connected systems occasionally, sending an idle trader to scout them.
    const knownSystems = this.galaxy.listSystems().map((s) => s.symbol);
    const connected = new Set<string>();
    for (const s of knownSystems) {
      for (const c of this.galaxy.connectedSystems(s)) connected.add(c);
    }
    const unsurveyed = [...connected].filter((c) => !this.surveyedSystems.has(c) && !this.gateBlockedSystems.has(c));
    const now = Date.now();
    // Only attempt exploration at most once every 10 minutes.
    if (unsurveyed.length === 0 || now - this.lastExploreTick < 600_000) return;
    this.lastExploreTick = now;

    // Pick the best scout: ONLY dedicated intel ships (tour shuttle / chart
    // scout). Money-making traders and miners must never be pulled off their
    // routes to scout — exploration is opportunistic, not worth interrupting a
    // trade cycle for. If no dedicated ship is free, skip this round entirely.
    const target = unsurveyed[0];
    if (!target) return;
    const idle = (a: { isManual(): boolean; getShip(): components["schemas"]["Ship"] }) =>
      !a.isManual() && a.getShip().cargo.units === 0;
    const rank = (fuel: number) => -fuel; // more fuel = better for a long jump
    type ScoutCandidate = { s: string; a: { isManual(): boolean; getShip(): components["schemas"]["Ship"] }; fuel: number };
    const dedicated: ScoutCandidate[] = [
      ...[...this.tours.entries()].map(([s, a]) => ({ s, a, fuel: a.getShip().fuel.capacity })),
      ...[...this.scouts.entries()].map(([s, a]) => ({ s, a, fuel: a.getShip().fuel.capacity })),
    ].filter((c) => idle(c.a)).sort((a, b) => rank(a.fuel) - rank(b.fuel));
    const scout = dedicated[0];
    if (!scout) return;
    try {
      this.log(`auto-exploring ${target} with ${scout.s} (${scout.fuel} fuel)`);
      await this.exploreSystem(scout.s, target);
      this.surveyedSystems.add(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`auto-explore ${target} failed: ${msg}`);
      if (msg.includes("under construction")) {
        // Gate not built yet — skip this system (and its connected neighbors) so we
        // don't re-probe the same unfinished gate every tick.
        this.gateBlockedSystems.add(target);
      }
      this.surveyedSystems.add(target); // don't retry a known failure
    }
  }

  /** Drive every ship and the coordination loop. */
  async run(maxTicks: number): Promise<void> {
    this.running = true;
    const loops: Promise<void>[] = [
      ...[...this.miners.values()].map((a) => a.runLoop(maxTicks)),
      ...[...this.traders.values()].map((a) => a.runLoop(maxTicks)),
      ...[...this.surveyors.values()].map((a) => a.surveyLoop(maxTicks)),
      ...[...this.tours.values()].map((a) => a.tourLoop(maxTicks)),
      ...[...this.keepers.values()].map((a) => a.keeperLoop(maxTicks)),
      ...[...this.scouts.values()].map((a) => a.runLoop(maxTicks)),
      ...[...this.siphoners.values()].map((a) => a.runLoop(maxTicks)),
    ];
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
      try {
        await this.tick();
      } catch (err) {
        this.log(`coordinator error: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(2_000);
    }
    this.running = false;
    await Promise.allSettled(loops);
  }

  stop(): void {
    this.running = false;
  }
}
