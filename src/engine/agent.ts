import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { MarketSnapshot } from "./market.js";
import type { SurveyPool } from "./survey.js";

export type Ship = components["schemas"]["Ship"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How often a halted agent re-checks whether the fleet has resumed. */
const HALT_POLL_MS = 1_000;

export interface AgentOptions {
  api: SpaceTradersAPI;
  /** Logger callback; defaults to console.log. */
  log?: (msg: string) => void;
  /** Optional persistence hook, called for sell/refuel transactions. */
  recordLedger?: (entry: {
    timestamp: string;
    shipSymbol: string;
    waypointSymbol: string;
    type: "SELL" | "REFUEL" | "PURCHASE";
    tradeSymbol?: string;
    units?: number;
    pricePerUnit?: number;
    total: number;
  }) => void;
  /** Called with this ship when it holds cargo. Returns a destination to fly to, `true` if handled, or falsy if nothing to do. */
  deliverCargo?: (ship: Ship) => Promise<string | true | null | undefined>;
  /** Called for notable events (extract, sell, refuel, navigate) for the live feed. */
  onActivity?: (kind: string, detail: string, credits?: number) => void;
  /** Called when the ship docks at a marketplace so prices can be snapshotted. */
  recordMarket?: (waypointSymbol: string) => Promise<void>;
  /** Shared survey registry: surveyor scouts deposit, miners consume. */
  surveyPool?: SurveyPool;
  /** Trade symbols reserved for missions; these must never be sold/jettisoned. */
  protectedGoods?: () => Set<string>;
  /** Marketplace waypoints to tour periodically so price snapshots stay fresh. */
  marketTourTargets?: () => string[];
  /** Markets whose snapshots are older than the freshness window — tour these first. */
  staleMarketTargets?: () => string[];
  /** Shipyard waypoints to tour periodically so ship stock stays fresh. */
  shipyardTourTargets?: () => string[];
  /** Called when the ship docks at a shipyard so its inventory can be recorded. */
  recordShipyard?: (waypointSymbol: string) => Promise<void>;
  /** Stationary keeper: the market this ship polls on a timer to keep prices fresh. */
  keeperMarket?: () => string | undefined;
  /**
   * Whether the ship is allowed to act at all right now. False while the fleet
   * is halted.
   *
   * Halt used to gate only `FleetManager.tick()`, so pressing it stopped the
   * coordinator while every ship kept mining, buying and selling — and the one
   * thing that *did* stop was `rescueStranded()`. A halted fleet therefore kept
   * burning fuel with recovery switched off, which is the worst combination.
   */
  shouldRun?: () => boolean;
}

/** Coordinates of a waypoint within a system, used for distance/fuel estimation. */
export interface WaypointPos {
  symbol: string;
  x: number;
  y: number;
  type?: components["schemas"]["WaypointType"];
}

/** A decision point in the ship lifecycle. */
export type ShipGoal =
  | { kind: "mine"; target: string }
  | { kind: "sell"; at: string }
  | { kind: "refuel"; at: string }
  | { kind: "buy"; good: string; units: number; at: string }
  | { kind: "survey"; target: string }
  | { kind: "idle"; waypoint?: string };

const ORE_GOODS = [
  "IRON_ORE",
  "COPPER_ORE",
  "ALUMINUM_ORE",
  "SILVER_ORE",
  "GOLD_ORE",
  "PLATINUM_ORE",
  "DIAMONDS",
  "URANITE_ORE",
  "MERITIUM_ORE",
  "QUARTZ_SAND",
  "SILICON_CRYSTALS",
  "PRECIOUS_STONES",
  "ICE_WATER",
  "AMMONIA_ICE",
];

/** Maps a basic (saleable) good to the processed good refine produces from it (10:1). */
const REFINE_RECIPES: Record<string, "IRON" | "COPPER" | "SILVER" | "GOLD" | "ALUMINUM" | "PLATINUM" | "URANITE" | "MERITIUM" | "FUEL"> = {
  IRON_ORE: "IRON",
  COPPER_ORE: "COPPER",
  ALUMINUM_ORE: "ALUMINUM",
  SILVER_ORE: "SILVER",
  GOLD_ORE: "GOLD",
  PLATINUM_ORE: "PLATINUM",
  URANITE_ORE: "URANITE",
  MERITIUM_ORE: "MERITIUM",
};

/**
 * Drives a single ship through the survival loop:
 * orbit → navigate → extract → (cargo full) → dock → sell → refuel → repeat.
 * Uses market snapshots to decide where to mine and where to sell.
 */
export class ShipAgent {
  readonly symbol: string;
  private readonly api: SpaceTradersAPI;
  private readonly log: (msg: string) => void;
  private readonly systemSymbol: string;
  private readonly recordLedger: AgentOptions["recordLedger"];
  private readonly deliverCargo: AgentOptions["deliverCargo"];
  private readonly onActivity: AgentOptions["onActivity"];
  private readonly recordMarket: AgentOptions["recordMarket"];
  private readonly waypointPositions = new Map<string, WaypointPos>();
  private markets: MarketSnapshot[] = [];
  private readonly surveyPool: SurveyPool | undefined;
  private readonly protectedGoods?: () => Set<string>;
  private readonly marketTourTargets?: () => string[];
  private readonly staleMarketTargets?: () => string[];
  private readonly shipyardTourTargets?: () => string[];
  private readonly recordShipyard?: (waypointSymbol: string) => Promise<void>;
  private readonly keeperMarket?: () => string | undefined;
  private readonly shouldRun?: () => boolean;
  private ship: Ship;
  private goal: ShipGoal = { kind: "idle" };
  private manualGoal: ShipGoal | null = null;
  private suspended = false;
  private surveyedFields = new Set<string>();
  /** Operator-chosen asteroid field; overrides the ship's own nearest-field pick. */
  private pinnedMiningTarget?: string;
  private marketTourIndex = 0;
  running = false;

  constructor(ship: Ship, opts: AgentOptions) {
    this.symbol = ship.symbol;
    this.ship = ship;
    this.api = opts.api;
    this.log = opts.log ?? ((m) => console.log(`[${this.symbol}] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.deliverCargo = opts.deliverCargo;
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
    this.surveyPool = opts.surveyPool;
    this.protectedGoods = opts.protectedGoods;
    this.marketTourTargets = opts.marketTourTargets;
    this.staleMarketTargets = opts.staleMarketTargets;
    this.shipyardTourTargets = opts.shipyardTourTargets;
    this.recordShipyard = opts.recordShipyard;
    this.keeperMarket = opts.keeperMarket;
    this.shouldRun = opts.shouldRun;
    this.systemSymbol = ship.nav.systemSymbol;
  }

  /** Seed the agent with known waypoint positions and market snapshots for its system. */
  withWorld(positions: WaypointPos[], markets: MarketSnapshot[]): this {
    for (const p of positions) this.waypointPositions.set(p.symbol, p);
    this.markets = markets;
    return this;
  }

  getShip(): Ship {
    return this.ship;
  }

  private async refresh(): Promise<void> {
    this.ship = await this.api.getShip(this.symbol);
  }

  private async waitCooldown(): Promise<void> {
    const cd = this.ship.cooldown;
    if (!cd || cd.remainingSeconds <= 0) return;
    this.log(`cooldown ${cd.remainingSeconds}s`);
    await sleep(cd.remainingSeconds * 1000 + 250);
    await this.refresh();
  }

  private async ensureInOrbit(): Promise<void> {
    if (this.ship.nav.status === "IN_ORBIT") return;
    if (this.ship.nav.status === "IN_TRANSIT") {
      await this.waitForArrival();
    }
    if (this.ship.nav.status === "DOCKED") {
      this.log("docking → orbit");
      await this.api.orbitShip(this.symbol);
      await this.refresh();
    }
  }

  private async ensureDocked(): Promise<void> {
    if (this.ship.nav.status === "DOCKED") return;
    if (this.ship.nav.status === "IN_TRANSIT") {
      await this.waitForArrival();
    }
    if (this.ship.nav.status === "IN_ORBIT") {
      this.log("orbit → dock");
      await this.api.dockShip(this.symbol);
      await this.refresh();
      if (this.recordMarket) await this.recordMarket(this.ship.nav.waypointSymbol);
    }
  }

  /** Wait until the ship has finished its current transit. */
  private async waitForArrival(): Promise<void> {
    for (;;) {
      const arrival = new Date(this.ship.nav.route.arrival).getTime();
      const wait = arrival - Date.now();
      if (wait > 0) {
        this.log(`in transit, arrival in ${Math.round(wait / 1000)}s`);
        await sleep(wait + 1000);
      }
      await this.refresh();
      if (this.ship.nav.status !== "IN_TRANSIT") return;
    }
  }

  private async navigateTo(waypoint: string): Promise<void> {
    if (this.ship.nav.waypointSymbol === waypoint && this.ship.nav.status !== "IN_TRANSIT") {
      return;
    }
    await this.ensureInOrbit();
    const need = this.estimatedFuelTo(waypoint);
    if (this.ship.fuel.capacity > 0 && this.ship.fuel.current < need) {
      this.log(`cannot navigate to ${waypoint}: need ${need} fuel, have ${this.ship.fuel.current} (stranded?)`);
      return;
    }
    try {
      const arrival = await this.api.navigateShip(this.symbol, waypoint);
      this.ship = { ...this.ship, nav: arrival.nav, fuel: arrival.fuel };
      this.onActivity?.("navigate", `→ ${waypoint} (${arrival.fuel.current}/${arrival.fuel.capacity} fuel)`);
      const wait = new Date(arrival.nav.route.arrival).getTime() - Date.now();
      if (wait > 0) {
        this.log(`navigating to ${waypoint}, ETA ${Math.round(wait / 1000)}s`);
        await sleep(wait + 1000);
      }
      await this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already located at the destination|already at the destination/i.test(msg)) {
        // Stale cached nav state — the ship is already there. Refresh and continue.
        await this.refresh();
        return;
      }
      throw err;
    }
  }

  private cargoFree(): number {
    return this.ship.cargo.capacity - this.ship.cargo.units;
  }

  /** True if the ship has a mining mount installed. */
  private canMine(): boolean {
    return this.ship.mounts.some((m) => m.symbol.startsWith("MOUNT_MINING_LASER"));
  }

  /** True if the ship can refine ores (a refinery/processor module is installed). */
  private canRefine(): boolean {
    return this.ship.modules.some((m) =>
      ["MODULE_ORE_REFINERY_I", "MODULE_FUEL_REFINERY_I"].includes(m.symbol),
    );
  }

  /** Best price this ship could get selling `symbol` at any reachable market, or 0. */
  private bestReachableSellPrice(symbol: string): number {
    let best = 0;
    const cap = this.ship.fuel.capacity;
    for (const m of this.markets) {
      const g = m.tradeGoods[symbol];
      if (!g) continue;
      if (cap > 0 && this.estimatedFuelTo(m.symbol) > cap) continue;
      if (g.sellPrice > best) best = g.sellPrice;
    }
    return best;
  }

  /** True when refining is worth pursuing here: some ore we can mine has a refined
   *  counterpart that sells for more per unit than the raw ore at reachable markets. */
  private refineProfitable(): boolean {
    for (const [ore, produce] of Object.entries(REFINE_RECIPES)) {
      const orePrice = this.bestReachableSellPrice(ore);
      const metalPrice = this.bestReachableSellPrice(produce);
      if (orePrice > 0 && metalPrice > orePrice) return true;
    }
    return false;
  }

  private cargoValue(): number {
    let total = 0;
    for (const item of this.ship.cargo.inventory) {
      const m = this.markets.find((mm) => mm.tradeGoods[item.symbol]);
      const price = m?.tradeGoods[item.symbol]?.sellPrice ?? 0;
      total += price * item.units;
    }
    return total;
  }

  /** Pick the nearest mining target the ship can reach and return from. */
  private pickMiningTarget(): WaypointPos | undefined {
    // An operator-pinned field wins over the ship's own choice — but only if we
    // actually know where it is. A pin to an unknown waypoint falls through to
    // the normal pick rather than stranding the ship on a target it can't plot.
    if (this.pinnedMiningTarget) {
      const pinned = this.waypointPositions.get(this.pinnedMiningTarget);
      if (pinned) return pinned;
      this.log(`pinned field ${this.pinnedMiningTarget} is not in the atlas; picking the nearest instead`);
    }
    // If we're parked at a market, we can refuel before leaving — budget a full tank.
    const atMarket = this.markets.some((m) => m.symbol === this.ship.nav.waypointSymbol);
    const fuelBudget =
      this.ship.fuel.capacity > 0 ? (atMarket ? this.ship.fuel.capacity : this.ship.fuel.current) : 0;
    let best: WaypointPos | undefined;
    let bestDist = Infinity;
    for (const wp of this.waypointPositions.values()) {
      if (wp.type !== "ASTEROID_FIELD" && wp.type !== "ASTEROID" && wp.type !== "ENGINEERED_ASTEROID") continue;
      const dist = this.distanceTo(wp);
      if (dist >= bestDist) continue;
      if (this.ship.fuel.capacity > 0) {
        // Prefer targets reachable round-trip, but allow one-way trips if the ship can
        // reach the asteroid AND there is a market reachable from it to refuel at.
        const roundTrip = this.fuelNeededRoundTrip(wp.symbol);
        if (roundTrip <= fuelBudget) {
          // full round-trip is fine
        } else {
          const out = this.estimatedFuelTo(wp.symbol);
          if (out > fuelBudget) continue; // can't even get there
          const refuelFromAsteroid = this.nearestMarketTo(wp.symbol);
          if (!refuelFromAsteroid) continue; // no way to refuel after mining
          const back = this.estimatedFuelToBetween(wp.symbol, refuelFromAsteroid);
          if (out + back > fuelBudget) continue; // can't reach asteroid + nearest market
        }
      }
      bestDist = dist;
      best = wp;
    }
    return best;
  }

  /** Nearest market (reachable with current fuel) from which some asteroid is minable, if any. */
  private async pickRelocationTarget(): Promise<string | undefined> {
    if (this.ship.fuel.capacity <= 0) return undefined;
    let best: string | undefined;
    let bestDist = Infinity;
    for (const m of this.markets) {
      if (m.symbol === this.ship.nav.waypointSymbol) continue;
      const d = this.estimatedFuelTo(m.symbol);
      if (d > this.ship.fuel.current) continue; // can't reach it now
      const mineableFromThere = [...this.waypointPositions.values()].some(
        (wp) =>
          (wp.type === "ASTEROID_FIELD" || wp.type === "ASTEROID" || wp.type === "ENGINEERED_ASTEROID") &&
          this.fuelNeededRoundTripFrom(m.symbol, wp.symbol) <= this.ship.fuel.capacity,
      );
      if (!mineableFromThere) continue;
      if (d < bestDist) {
        bestDist = d;
        best = m.symbol;
      }
    }
    return best;
  }

  /** Round-trip fuel from an arbitrary market to a target and back to its nearest market. */
  private fuelNeededRoundTripFrom(market: string, target: string): number {
    const out = this.estimatedFuelToBetween(market, target);
    const nearest = this.nearestMarketTo(target);
    const back = nearest ? this.estimatedFuelToBetween(target, nearest) : out;
    return out + back + 5;
  }

  private distanceTo(wp: WaypointPos): number {
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    if (!here) return 0;
    return Math.hypot(wp.x - here.x, wp.y - here.y);
  }

  /** Choose a selling destination. Prefer a market that imports the good (profile visible remotely).
   *  Only markets the ship could actually reach with a full tank are considered, so a ship stranded
   *  far from a niche-importer (e.g. ore importers at B7, 303 fuel away from an 80-tank ship) does
   *  not chase an unreachable sell target forever. */
  private pickSellTarget(): string | undefined {
    const good = this.ship.cargo.inventory[0];
    if (!good) return undefined;
    const candidates = this.markets.filter((m) => {
      if (m.imports.includes(good.symbol) || m.exchange.includes(good.symbol)) return true;
      const g = m.tradeGoods[good.symbol];
      return g && (g.type === "IMPORT" || g.type === "EXCHANGE");
    });
    const fuelCap = this.ship.fuel.capacity;
    const reachable = candidates.filter(
      (m) => fuelCap <= 0 || this.estimatedFuelTo(m.symbol) <= fuelCap,
    );
    // Never chase a market the ship cannot reach even on a full tank (e.g. ore importer
    // B7 at 303 fuel vs an 80-tank ship) — that just loops on "cannot navigate".
    const pool = reachable.length > 0 ? reachable : [];
    if (pool.length === 0) return undefined;
    pool.sort((a, b) => {
      const pa = a.tradeGoods[good.symbol]?.purchasePrice ?? 0;
      const pb = b.tradeGoods[good.symbol]?.purchasePrice ?? 0;
      return pb - pa;
    });
    return pool[0]?.symbol;
  }

  /** Dock at a market waypoint and refresh its price snapshot. */
  private async observeMarket(waypoint: string): Promise<void> {
    await this.navigateTo(waypoint);
    await this.ensureDocked();
    const market = await this.api.getMarket(this.systemSymbol, waypoint);
    const snapshot = this.markets.find((m) => m.symbol === waypoint) ?? {
      symbol: waypoint,
      systemSymbol: this.systemSymbol,
      tradeGoods: {},
      imports: (market.imports ?? []).map((g) => g.symbol),
      exports: (market.exports ?? []).map((g) => g.symbol),
      exchange: (market.exchange ?? []).map((g) => g.symbol),
      fetchedAt: new Date().toISOString(),
    };
    for (const g of market.tradeGoods ?? []) {
      snapshot.tradeGoods[g.symbol] = g;
    }
    snapshot.fetchedAt = new Date().toISOString();
    if (!this.markets.some((m) => m.symbol === waypoint)) this.markets.push(snapshot);
  }

  /** Tour unvisited markets to build the price table. Returns true if a tour happened. */
  private async discoverMarkets(): Promise<boolean> {
    const candidates = this.markets
      .filter((m) => Object.keys(m.tradeGoods).length === 0)
      .filter((m) => this.ship.fuel.capacity <= 0 || this.fuelNeededRoundTrip(m.symbol) <= this.ship.fuel.capacity)
      .sort(
        (a, b) =>
          this.distanceTo(this.waypointPositions.get(a.symbol)!) -
          this.distanceTo(this.waypointPositions.get(b.symbol)!),
      );
    const target = candidates[0];
    if (!target) return false;
    this.log(`discovering market at ${target.symbol}`);
    await this.refuelIfNeeded(5, target.symbol);
    await this.observeMarket(target.symbol);
    return true;
  }

  private estimatedFuelTo(waypoint: string): number {
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    const there = this.waypointPositions.get(waypoint);
    if (!here || !there) return 0;
    return Math.max(1, Math.round(Math.hypot(there.x - here.x, there.y - here.y)));
  }

  /** Estimate the fuel needed to reach a target and return to the nearest market, with reserve. */
  private fuelNeededRoundTrip(target: string): number {
    const here = this.ship.nav.waypointSymbol;
    const nearestMarket = this.nearestMarketTo(target);
    const out = this.estimatedFuelTo(target);
    const back = nearestMarket ? this.estimatedFuelToBetween(target, nearestMarket) : out;
    return out + back + 5;
  }

  private nearestMarketTo(waypoint: string): string | undefined {
    let best: string | undefined;
    let bestDist = Infinity;
    for (const m of this.markets) {
      const d = this.estimatedFuelToBetween(waypoint, m.symbol);
      if (d < bestDist) {
        bestDist = d;
        best = m.symbol;
      }
    }
    return best;
  }

  private estimatedFuelToBetween(a: string, b: string): number {
    const pa = this.waypointPositions.get(a);
    const pb = this.waypointPositions.get(b);
    if (!pa || !pb) return 0;
    return Math.max(1, Math.round(Math.hypot(pb.x - pa.x, pb.y - pa.y)));
  }

  /** Find the nearest market the ship can reach with current fuel. */
  private nearestReachableMarket(): string | undefined {
    let best: string | undefined;
    let bestDist = Infinity;
    for (const m of this.markets) {
      const need = this.estimatedFuelTo(m.symbol);
      if (need > this.ship.fuel.current) continue;
      if (need < bestDist) {
        bestDist = need;
        best = m.symbol;
      }
    }
    return best;
  }

  private async refuelIfNeeded(reserve: number, target?: string): Promise<boolean> {
    if (this.ship.fuel.capacity <= 0) return true;
    const atMarket = this.markets.some((m) => m.symbol === this.ship.nav.waypointSymbol);
    const trip = target ? this.fuelNeededRoundTrip(target) : this.ship.fuel.capacity * 0.9;
    if (this.ship.fuel.current > trip + reserve) return true;
    if (atMarket) {
      await this.ensureDocked();
      this.log(`refueling (${this.ship.fuel.current}/${this.ship.fuel.capacity})`);
      const res = await this.api.refuelShip(this.symbol);
      this.recordLedger?.({
        timestamp: new Date().toISOString(),
        shipSymbol: this.symbol,
        waypointSymbol: this.ship.nav.waypointSymbol,
        type: "REFUEL",
        units: res.fuel.current,
        total: res.transaction.totalPrice,
      });
      await this.refresh();
      return true;
    }
    // Not at a market and fuel is low: try to reach the nearest reachable market first.
    const refuelStop = this.nearestReachableMarket();
    if (refuelStop && refuelStop !== this.ship.nav.waypointSymbol) {
      this.log(`fuel low, detouring to refuel at ${refuelStop}`);
      await this.navigateTo(refuelStop);
      await this.ensureDocked();
      this.log(`refueling (${this.ship.fuel.current}/${this.ship.fuel.capacity})`);
      const res = await this.api.refuelShip(this.symbol);
      this.recordLedger?.({
        timestamp: new Date().toISOString(),
        shipSymbol: this.symbol,
        waypointSymbol: this.ship.nav.waypointSymbol,
        type: "REFUEL",
        units: res.fuel.current,
        total: res.transaction.totalPrice,
      });
      await this.refresh();
      return true;
    }
    this.log(`WARN: stranded (${this.ship.fuel.current}/${this.ship.fuel.capacity} fuel, need ${trip}) and no reachable market`);
    return false;
  }

  /** Find the best arbitrage route starting from a given (or current) market. */
  private findArbitrageRouteFrom(origin?: string): {
    good: string;
    buyAt: string;
    sellAt: string;
    buyPrice: number;
    sellPrice: number;
    units: number;
    profit: number;
  } | undefined {
    const here = origin ?? this.ship.nav.waypointSymbol;
    const buyMarket = this.markets.find((m) => m.symbol === here);
    if (!buyMarket || Object.keys(buyMarket.tradeGoods).length === 0) return undefined;
    let best: ReturnType<typeof this.findArbitrageRouteFrom> | undefined;
    for (const [good, buy] of Object.entries(buyMarket.tradeGoods)) {
      for (const sellMarket of this.markets) {
        if (sellMarket.symbol === here) continue;
        const sell = sellMarket.tradeGoods[good];
        if (!sell) continue;
        const margin = sell.sellPrice - buy.purchasePrice;
        if (margin <= 2) continue;
        const fuelToSell = this.estimatedFuelToBetween(here, sellMarket.symbol);
        // Assume we can refuel at the origin market before leaving.
        if (this.ship.fuel.capacity > 0 && fuelToSell > this.ship.fuel.capacity - 5) continue;
        const units = Math.min(buy.tradeVolume, sell.tradeVolume, this.ship.cargo.capacity);
        const fuelCost = fuelToSell * (this.priceTableFuel(here) ?? 72);
        const profit = margin * units - fuelCost;
        if (profit <= 50) continue;
        if (!best || profit > best.profit) {
          best = { good, buyAt: here, sellAt: sellMarket.symbol, buyPrice: buy.purchasePrice, sellPrice: sell.sellPrice, units, profit };
        }
      }
    }
    return best;
  }

  private priceTableFuel(waypoint: string): number | undefined {
    const m = this.markets.find((mm) => mm.symbol === waypoint);
    return m?.tradeGoods["FUEL"]?.purchasePrice;
  }

  /** Buy a good at the current market and fly to sell elsewhere. */
  private async executeArbitrage(route: NonNullable<ReturnType<typeof this.findArbitrageRouteFrom>>): Promise<boolean> {
    await this.ensureDocked();
    await this.refuelIfNeeded(5, route.sellAt);
    const units = Math.min(route.units, this.cargoFree());
    if (units <= 0) return false;
    this.log(`arbitrage: buying ${units}u ${route.good} @ ${route.buyPrice}c`);
    const bought = await this.api.purchaseCargo(this.symbol, route.good, units);
    this.ship = { ...this.ship, cargo: bought.cargo };
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol: this.symbol,
      waypointSymbol: this.ship.nav.waypointSymbol,
      type: "PURCHASE",
      tradeSymbol: route.good,
      units,
      pricePerUnit: bought.transaction.pricePerUnit,
      total: bought.transaction.totalPrice,
    });
    this.onActivity?.("buy", `${units}u ${route.good} @ ${bought.transaction.pricePerUnit}c at ${route.buyAt}`, -bought.transaction.totalPrice);
    await this.navigateTo(route.sellAt);
    await this.ensureDocked();
    const sold = await this.api.sellCargo(this.symbol, route.good, units);
    this.ship = { ...this.ship, cargo: sold.cargo };
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol: this.symbol,
      waypointSymbol: this.ship.nav.waypointSymbol,
      type: "SELL",
      tradeSymbol: route.good,
      units,
      pricePerUnit: sold.transaction.pricePerUnit,
      total: sold.transaction.totalPrice,
    });
    const gain = sold.transaction.totalPrice - bought.transaction.totalPrice;
    this.log(`arbitrage: sold ${units}u ${route.good} @ ${sold.transaction.pricePerUnit}c (gain ${gain}c)`);
    this.onActivity?.("sell", `${units}u ${route.good} @ ${sold.transaction.pricePerUnit}c at ${route.sellAt}`, sold.transaction.totalPrice);
    return true;
  }
  async tick(): Promise<boolean> {
    if (this.suspended) {
      this.log("suspended: holding position");
      return false;
    }
    await this.refresh();
    await this.waitCooldown();

    // Manual override: if dispatched, stay at the target waypoint and idle.
    if (this.manualGoal) {
      if (this.manualGoal.kind === "idle" && this.manualGoal.waypoint) {
        const target = this.manualGoal.waypoint;
        if (this.ship.nav.waypointSymbol !== target || this.ship.nav.status === "IN_TRANSIT") {
          this.log(`manual: holding course to ${target}`);
          await this.refuelIfNeeded(5, target);
          await this.navigateTo(target);
          await this.ensureDocked();
          return true;
        }
      }
      this.log("manual: holding position");
      return false;
    }

    // If the ship is stranded (no fuel and not at a market), it can't act.
    if (this.ship.fuel.capacity > 0 && this.ship.fuel.current <= 0 && !this.markets.some((m) => m.symbol === this.ship.nav.waypointSymbol)) {
      this.log(`stranded at ${this.ship.nav.waypointSymbol} (0 fuel, no market); idling`);
      return false;
    }

    // Top up fuel whenever docked at a market and below a safe threshold.
    if (this.ship.fuel.capacity > 0 && this.ship.fuel.current < this.ship.fuel.capacity * 0.5) {
      const atMarket = this.markets.some((m) => m.symbol === this.ship.nav.waypointSymbol);
      if (atMarket) {
        await this.ensureDocked();
        this.log(`refueling (${this.ship.fuel.current}/${this.ship.fuel.capacity})`);
        const res = await this.api.refuelShip(this.symbol);
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: this.symbol,
          waypointSymbol: this.ship.nav.waypointSymbol,
          type: "REFUEL",
          units: res.fuel.current,
          total: res.transaction.totalPrice,
        });
        await this.refresh();
      }
    }

    const cargoFree = this.cargoFree();
    const cargoValue = this.cargoValue();

    // 1. If cargo is held for a contract delivery, route it first.
    if (this.ship.cargo.units > 0 && this.deliverCargo) {
      const result = await this.deliverCargo(this.ship);
      if (typeof result === "string") {
        this.log(`delivering cargo → ${result}`);
        const canRefuel = await this.refuelIfNeeded(5, result);
        if (!canRefuel) {
          this.log(`delivery to ${result} impossible: not enough fuel and no reachable refuel stop`);
          return false;
        }
        await this.navigateTo(result);
        await this.ensureDocked();
        await this.deliverCargo(this.ship);
        await this.refresh();
        return true;
      }
      if (result === true) {
        await this.refresh();
        return true;
      }
    }

    // 2. Otherwise sell any remaining cargo.
    if (this.ship.cargo.units > 0) {
      const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
      const sellable = this.ship.cargo.inventory.filter((i) => !protectedGoods.has(i.symbol));
      if (sellable.length > 0) {
        const target = this.pickSellTarget();
        if (target) {
          await this.refuelIfNeeded(5, target);
          this.log(`selling ${sellable.length} saleable cargo worth ~${cargoValue}c`);
          await this.navigateTo(target);
          await this.ensureDocked();
          await this.sellAllCargo();
          await this.refresh();
          return true;
        }
        // Cargo full but no known buyer: tour markets to discover prices.
        if (this.ship.cargo.units >= this.ship.cargo.capacity * 0.8) {
          const toured = await this.discoverMarkets();
          if (toured) return true;
        }
      }
    }

    // 3. After selling, if empty at a market, run a quick arbitrage route.
    if (this.ship.cargo.units === 0) {
      const route = this.findArbitrageRouteFrom();
      if (route) {
        this.log(`arbitrage opportunity: ${route.good} ${route.buyAt} → ${route.sellAt}, +${route.profit}c`);
        await this.executeArbitrage(route);
        return true;
      }
    }

    // 4. Otherwise mine.
    if (!this.canMine()) {
      this.goal = { kind: "idle" };
      this.log("no mining mount; idling");
      return false;
    }
    const target = this.pickMiningTarget();
    if (!target) {
      // No asteroid reachable from here. If we're parked at a market with fuel,
      // relocate to a market that has a minable asteroid within round-trip range.
      const relocate = await this.pickRelocationTarget();
      if (relocate) {
        this.log(`relocating to ${relocate}: no asteroids in range from ${this.ship.nav.waypointSymbol}`);
        await this.refuelIfNeeded(5, relocate);
        await this.navigateTo(relocate);
        return true;
      }
      this.goal = { kind: "idle" };
      this.log("no mining target found");
      return false;
    }
    await this.refuelIfNeeded(5, target.symbol);
    this.log(`mining at ${target.symbol}`);
    await this.navigateTo(target.symbol);
    await this.ensureInOrbit();
    if (this.canRefine() && (this.hasSurveyor() || this.refineProfitable())) {
      await this.mineAndRefine();
    } else {
      await this.extractUntilFull();
    }
    await this.refresh();
    return true;
  }

  /**
   * Mine ore and refine it in-orbit, packing the hold with processed metal.
   * Each 10:1 refine frees 9 cargo slots that we refill by mining again, so a
   * trip carries ~10x the value per slot. When a surveyor mount is installed,
   * surveys the asteroid first and extracts the refinable deposit so a single
   * ore accumulates to 10+ units. Stops when the hold is full of
   * non-refinable cargo (or the loop safety cap is hit).
   */
  private async mineAndRefine(): Promise<void> {
    let safety = 0;
    let survey: components["schemas"]["Survey"] | undefined;
    if (this.hasSurveyor()) {
      survey = await this.createAndPickSurvey();
    } else if (this.surveyPool) {
      survey = this.surveyPool.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d]));
      if (survey) this.log(`using shared survey at ${this.ship.nav.waypointSymbol}`);
    }
    while (safety < 60 && this.running) {
      safety += 1;
      // Refine a full batch of ore first (frees room), then mine to refill.
      const target = this.ship.cargo.inventory.find((i) => (REFINE_RECIPES[i.symbol] ?? "") && i.units >= 10);
      if (target) {
        const produce = REFINE_RECIPES[target.symbol]!;
        try {
          this.log(`refining ${target.units}u ${target.symbol} → ${produce}`);
          const res = await this.api.refine(this.symbol, produce);
          this.ship = { ...this.ship, cargo: res.cargo, cooldown: res.cooldown };
          const made = res.produced[0];
          const used = res.consumed[0];
          this.onActivity?.(
            "refine",
            `+${made?.units ?? 0}u ${made?.tradeSymbol ?? "?"} (from ${used?.units ?? 0}u ${used?.tradeSymbol ?? "?"}) (${this.ship.cargo.units}/${this.ship.cargo.capacity})`,
          );
          await this.waitCooldown();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("cooldown")) {
            this.log(`refine pending cooldown, waiting…`);
            await sleep(6_000);
            await this.refresh();
            continue;
          }
          this.log(`refine failed: ${msg}`);
          return;
        }
        continue;
      }
      // Nothing left to refine: mine until the hold is full.
      if (this.cargoFree() === 0) return;
      try {
        let res: {
          cooldown: components["schemas"]["Cooldown"];
          extraction: components["schemas"]["Extraction"];
          cargo: components["schemas"]["ShipCargo"];
        };
        if (survey) {
          res = await this.api.extractWithSurvey(this.symbol, survey);
        } else {
          res = await this.api.extract(this.symbol);
        }
        this.ship = { ...this.ship, cargo: res.cargo, cooldown: res.cooldown };
        const got = res.extraction.yield;
        this.onActivity?.("extract", `+${got.units}u ${got.symbol} (${this.ship.cargo.units}/${this.ship.cargo.capacity})`);
        this.log(`extracted ${got.units}u ${got.symbol}`);
        await this.waitCooldown();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("cooldown")) {
          this.log(`extract pending cooldown, waiting…`);
          await sleep(6_000);
          await this.refresh();
          continue;
        }
        if (survey && /exhaust|expire|signature|invalid/i.test(msg)) {
          this.log(`survey no longer usable: ${msg}; re-surveying`);
          this.surveyPool?.invalidate(this.ship.nav.waypointSymbol, survey.signature);
          survey = this.hasSurveyor()
            ? await this.createAndPickSurvey()
            : this.surveyPool?.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d]));
          if (survey) continue;
          this.log("no usable survey; falling back to plain extraction");
        }
        this.log(`extract failed: ${msg}`);
        return;
      }
    }
    if (safety >= 60) this.log("mineAndRefine hit safety cap");
  }

  /** True if the ship has a surveyor mount installed. */
  private hasSurveyor(): boolean {
    return this.ship.mounts.some((m) => m.symbol.startsWith("MOUNT_SURVEYOR"));
  }

  /** Survey the current waypoint and pick the deposit that refines into the most valuable metal. */
  private async createAndPickSurvey(): Promise<components["schemas"]["Survey"] | undefined> {
    try {
      const res = await this.api.createSurvey(this.symbol);
      this.ship = { ...this.ship, cooldown: res.cooldown };
      await this.waitCooldown();
      let best: components["schemas"]["Survey"] | undefined;
      let bestPrice = 0;
      let anyRefinable: components["schemas"]["Survey"] | undefined;
      for (const s of res.surveys) {
        for (const d of s.deposits) {
          const produce = REFINE_RECIPES[d.symbol];
          if (!produce) continue;
          anyRefinable ??= s;
          const price = this.bestReachableSellPrice(produce);
          if (price > bestPrice) {
            bestPrice = price;
            best = s;
          }
        }
      }
      best ??= anyRefinable;
      // Deposit the survey in the shared pool so non-surveyor miners can use it too.
      this.surveyPool?.record(this.ship.nav.waypointSymbol, ...res.surveys);
      this.log(
        best
          ? `survey: ${best.deposits.map((d) => d.symbol).join(",")} (${best.size}, exp ${new Date(best.expiration).toISOString().slice(11, 16)})`
          : `survey: no refinable deposits (${res.surveys.map((s) => s.deposits.map((d) => d.symbol).join(",")).join(" | ")})`,
      );
      return best;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("cooldown")) {
        this.log(`survey pending cooldown, waiting…`);
        await sleep(6_000);
        await this.refresh();
        return undefined;
      }
      this.log(`survey failed: ${msg}`);
      return undefined;
    }
  }

  /**
   * Surveyor scout: fly between asteroid fields surveying each and depositing
   * the surveys into the shared pool for the mining fleet. The ship must have a
   * surveyor mount; it does not need a mining laser or cargo capacity.
   */
  async surveyScout(): Promise<boolean> {
    if (this.suspended) {
      this.log("survey scout: suspended, holding");
      return false;
    }
    await this.refresh();
    await this.waitCooldown();
    this.log(`survey scout: tick @ ${this.ship.nav.waypointSymbol} (fuel ${this.ship.fuel.current}/${this.ship.fuel.capacity})`);

    // Priority 1: actually survey asteroid fields so miners have deposits to use.
    // Market/shipyard tours are secondary intel work.
    const target = this.pickSurveyTarget();
    if (target) {
      await this.refuelIfNeeded(5, target.symbol);
      this.log(`survey scout: surveying ${target.symbol}`);
      await this.navigateTo(target.symbol);
      await this.ensureInOrbit();
      const survey = await this.createAndPickSurvey();
      if (survey) {
        this.surveyedFields.add(target.symbol);
        this.onActivity?.("survey", `deposited ${survey.deposits.map((d) => d.symbol).join(",")} at ${target.symbol}`);
      }
      return true;
    }

    // No asteroid field needs a survey right now: do intel tours instead.
    // Periodically tour marketplaces so price snapshots stay fresh and we catch
    // new goods (e.g. modules) as market inventory rotates. One market per tick.
    const tourTargets = this.marketTourTargets?.() ?? [];
    if (tourTargets.length > 0) {
      const marketTarget = tourTargets[this.marketTourIndex % tourTargets.length];
      if (marketTarget && marketTarget !== this.ship.nav.waypointSymbol) {
        await this.refuelIfNeeded(5, marketTarget);
        this.log(`survey scout: touring market ${marketTarget}`);
        await this.observeMarket(marketTarget);
        this.marketTourIndex += 1;
        return true;
      }
      this.marketTourIndex += 1;
    }

    // Periodically tour shipyards so their stock stays fresh (ship inventory is
    // only visible when a ship is docked there). One shipyard per tick.
    const yardTargets = this.shipyardTourTargets?.() ?? [];
    if (yardTargets.length > 0) {
      const yardTarget = yardTargets[this.marketTourIndex % yardTargets.length];
      if (yardTarget && yardTarget !== this.ship.nav.waypointSymbol) {
        await this.refuelIfNeeded(5, yardTarget);
        this.log(`survey scout: touring shipyard ${yardTarget}`);
        await this.navigateTo(yardTarget);
        await this.ensureDocked();
        if (this.recordShipyard) await this.recordShipyard(yardTarget);
        this.marketTourIndex += 1;
        return true;
      }
      this.marketTourIndex += 1;
    }

    this.goal = { kind: "idle" };
    this.log("survey scout: no survey target found");
    return false;
  }

  /**
   * Tour scout: fly between marketplaces and shipyards, docking at each to keep
   * price snapshots and ship-stock intel fresh. No cargo, no mining, no surveyor
   * mount required — just navigation + docking. One target per tick.
   */
  async tourScout(): Promise<boolean> {
    if (this.suspended) {
      this.log("tour scout: suspended, holding");
      return false;
    }
    await this.refresh();
    // If manually dispatched, hold at the target until released — a fleet
    // operator moving a ship to a shipyard must not have the tour loop yank it
    // off to the next market.
    if (this.manualGoal && this.manualGoal.kind === "idle" && this.manualGoal.waypoint) {
      if (this.ship.nav.waypointSymbol !== this.manualGoal.waypoint || this.ship.nav.status === "IN_TRANSIT") {
        await this.navigateTo(this.manualGoal.waypoint);
        await this.ensureDocked();
      }
      return true;
    }
    this.log(`tour scout: tick @ ${this.ship.nav.waypointSymbol} (fuel ${this.ship.fuel.current}/${this.ship.fuel.capacity})`);

    const marketTargets = this.marketTourTargets?.() ?? [];
    const yardTargets = this.shipyardTourTargets?.() ?? [];
    const targets = [...marketTargets, ...yardTargets];
    if (targets.length === 0) {
      this.log("tour scout: no tour targets");
      return false;
    }
    // Prefer markets whose snapshots have gone stale — that's the whole point
    // of the tour. Fall back to nearest-reachable when everything is fresh.
    const stale = new Set(this.staleMarketTargets?.() ?? []);
    const here = this.ship.nav.waypointSymbol;
    const herePos = this.waypointPositions.get(here);
    const reachable = targets
      .filter((t) => t !== here)
      .map((t) => {
        const pos = this.waypointPositions.get(t);
        const dist = herePos && pos ? Math.max(1, Math.round(Math.hypot(pos.x - herePos.x, pos.y - herePos.y))) : Infinity;
        return { t, dist, stale: stale.has(t) };
      })
      .filter((x) => x.dist <= this.ship.fuel.capacity)
      .sort((a, b) => Number(b.stale) - Number(a.stale) || a.dist - b.dist);
    const target = reachable[0]?.t;
    if (!target) {
      this.log(`tour scout: no reachable target from ${here} (${targets.length} known)`);
      return false;
    }
    await this.refuelIfNeeded(5, target);
    this.log(`tour scout: touring ${target}`);
    await this.navigateTo(target);
    await this.ensureDocked();
    if (this.recordMarket) await this.recordMarket(target);
    if (this.recordShipyard) await this.recordShipyard(target);
    return true;
  }

  /** Nearest unreviewed asteroid field, rotating once all are covered. */
  private pickSurveyTarget(): WaypointPos | undefined {
    const fields = [...this.waypointPositions.values()].filter(
      (wp) => wp.type === "ASTEROID_FIELD" || wp.type === "ASTEROID" || wp.type === "ENGINEERED_ASTEROID",
    );
    if (fields.length > 0 && fields.every((f) => this.surveyedFields.has(f.symbol))) {
      // Full pass complete: start a fresh rotation so fields get re-surveyed as surveys expire.
      this.surveyedFields.clear();
    }
    // If we're already in an asteroid field, prefer staying put — re-surveying the
    // current field keeps the pool fresh and avoids burning fuel flying around.
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    if (here && fields.some((f) => f.symbol === here.symbol)) {
      return here;
    }
    const candidates = fields.filter((f) => !this.surveyedFields.has(f.symbol));
    let best: WaypointPos | undefined;
    let bestDist = Infinity;
    for (const wp of candidates) {
      const dist = this.distanceTo(wp);
      if (dist >= bestDist) continue;
      if (this.ship.fuel.capacity > 0) {
        const roundTrip = this.fuelNeededRoundTrip(wp.symbol);
        if (roundTrip > this.ship.fuel.current) {
          const out = this.estimatedFuelTo(wp.symbol);
          if (out > this.ship.fuel.current) continue;
        }
      }
      bestDist = dist;
      best = wp;
    }
    return best;
  }

  private async extractUntilFull(): Promise<void> {
    let safety = 0;
    // Non-refiners can still mine far more per action by extracting through a
    // shared survey (surveys guarantee a high-yield deposit). Prefer a pooled
    // survey at this waypoint; fall back to plain extraction.
    let survey: components["schemas"]["Survey"] | undefined =
      this.surveyPool?.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d])) ??
      (this.hasSurveyor() ? await this.createAndPickSurvey() : undefined);
    if (survey) this.log(`using survey at ${this.ship.nav.waypointSymbol}`);
    while (this.cargoFree() > 0 && safety < 40) {
      safety += 1;
      try {
        const res = survey
          ? await this.api.extractWithSurvey(this.symbol, survey)
          : await this.api.extract(this.symbol);
        this.ship = { ...this.ship, cargo: res.cargo, cooldown: res.cooldown };
        const got = res.extraction.yield;
        this.onActivity?.("extract", `+${got.units}u ${got.symbol} (${this.ship.cargo.units}/${this.ship.cargo.capacity})`);
        this.log(`extracted ${got.units}u ${got.symbol}`);
        await this.waitCooldown();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("cooldown")) {
          this.log(`extract pending cooldown, waiting…`);
          await sleep(6_000);
          await this.refresh();
          continue;
        }
        if (survey && /exhaust|expire|signature|invalid/i.test(msg)) {
          this.log(`survey no longer usable: ${msg}`);
          this.surveyPool?.invalidate(this.ship.nav.waypointSymbol, survey.signature);
          survey =
            this.surveyPool?.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d])) ??
            (this.hasSurveyor() ? await this.createAndPickSurvey() : undefined);
          if (survey) continue;
          this.log("no usable survey; falling back to plain extraction");
        }
        this.log(`extract failed: ${msg}`);
        return;
      }
    }
    if (safety >= 40) this.log("extract loop hit safety cap");
  }

  private async sellAllCargo(): Promise<void> {
    const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
    const inventory = [...this.ship.cargo.inventory];
    for (const item of inventory) {
      if (protectedGoods.has(item.symbol)) {
        this.log(`keeping ${item.symbol} (reserved for mission)`);
        continue;
      }
      try {
        const res = await this.api.sellCargo(this.symbol, item.symbol, item.units);
        this.ship = { ...this.ship, cargo: res.cargo };
        this.recordLedger?.({
          timestamp: new Date().toISOString(),
          shipSymbol: this.symbol,
          waypointSymbol: this.ship.nav.waypointSymbol,
          type: "SELL",
          tradeSymbol: item.symbol,
          units: item.units,
          pricePerUnit: res.transaction.pricePerUnit,
          total: res.transaction.totalPrice,
        });
        this.log(
          `sold ${item.units}u ${item.symbol} @ ${res.transaction.pricePerUnit}c = ${res.transaction.totalPrice}c`,
        );
        this.onActivity?.("sell", `${item.units}u ${item.symbol} @ ${res.transaction.pricePerUnit}c`, res.transaction.totalPrice);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`sell failed: ${msg}`);
      }
    }
  }

  /**
   * True when the fleet is halted and this ship must not act.
   *
   * Every agent loop checks this at the top of each iteration. It is a stopgap:
   * the loops are what make Halt hard to enforce in the first place, and the
   * greenfield scheduler makes it structural by simply not dispatching work
   * (see docs/greenfield-design.md, pillar 3). Until then, this is the honest
   * fix — a halted fleet must actually stop.
   */
  private halted(): boolean {
    return this.shouldRun !== undefined && !this.shouldRun();
  }

  async runLoop(maxTicks: number): Promise<void> {
    this.running = true;
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
      if (this.halted()) { await sleep(HALT_POLL_MS); continue; }
      try {
        const made = await this.tick();
        if (!made) {
          await sleep(30_000);
        }
      } catch (err) {
        this.log(`agent error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(10_000);
      }
    }
    this.running = false;
  }

  /** Surveyor-only loop: survey fields and deposit into the shared pool. */
  async surveyLoop(maxTicks: number): Promise<void> {
    this.running = true;
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
      if (this.halted()) { await sleep(HALT_POLL_MS); continue; }
      try {
        const made = await this.surveyScout();
        if (!made) {
          await sleep(30_000);
        }
      } catch (err) {
        this.log(`surveyor error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(10_000);
      }
    }
    this.running = false;
  }

  /** Drive the tour scout loop (market/shipyard inventory refresh). */
  async tourLoop(maxTicks: number): Promise<void> {
    this.running = true;
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
      if (this.halted()) { await sleep(HALT_POLL_MS); continue; }
      try {
        const made = await this.tourScout();
        if (!made) await sleep(30_000);
      } catch (err) {
        this.log(`tour error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(10_000);
      }
    }
    this.running = false;
  }

  /**
   * Stationary keeper: poll one market on a timer so its prices never go stale.
   * The ship stays docked at its assigned market and re-snapshots it every
   * KEEPER_POLL_MS. Used for probes (0 fuel, can only sit at their spawn
   * shipyard) and repurposed miners parked at outer buy markets.
   */
  async keeperLoop(maxTicks: number): Promise<void> {
    this.running = true;
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
      if (this.halted()) { await sleep(HALT_POLL_MS); continue; }
      try {
        const market = this.keeperMarket?.();
        if (!market) {
          this.log("keeper: no assigned market");
          await sleep(30_000);
          continue;
        }
        await this.refresh();
        // If we're not at the assigned market, fly there (one-time reposition).
        // Refuel first — navigateTo() bails when fuel is short instead of
        // topping up, which would strand the keeper mid-hop.
        if (this.ship.nav.waypointSymbol !== market || this.ship.nav.status === "IN_TRANSIT") {
          await this.refuelIfNeeded(5, market);
          await this.navigateTo(market);
        }
        await this.ensureDocked();
        if (this.recordMarket) await this.recordMarket(market);
        // Shipyard-markets (A2/C43/H56) also need their ship stock kept fresh —
        // shipyard inventory is only visible when a ship is docked there.
        if (this.recordShipyard) await this.recordShipyard(market);
        this.log(`keeper: snapshot ${market} (${this.ship.fuel.current}/${this.ship.fuel.capacity} fuel)`);
        await sleep(5 * 60_000);
      } catch (err) {
        this.log(`keeper error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(10_000);
      }
    }
    this.running = false;
  }

  /** True when the ship is under a manual command instead of autonomous loop. */
  isManual(): boolean {
    return this.manualGoal !== null;
  }

  /** True while the fleet holds the ship for coordinated work (rescue/mission). */
  isSuspended(): boolean {
    return this.suspended;
  }

  /** Manually dispatch this ship to a waypoint; once there it will idle until released. */
  async dispatchTo(waypointSymbol: string): Promise<void> {
    this.manualGoal = { kind: "idle", waypoint: waypointSymbol };
    this.log(`manual dispatch → ${waypointSymbol}`);
    await this.refresh();
    if (this.ship.nav.waypointSymbol !== waypointSymbol || this.ship.nav.status === "IN_TRANSIT") {
      await this.refuelIfNeeded(5, waypointSymbol);
      await this.navigateTo(waypointSymbol);
      await this.ensureDocked();
    }
    this.manualGoal = { kind: "idle", waypoint: waypointSymbol };
  }

  /**
   * Pin this ship's mining to one asteroid field.
   *
   * Deliberately NOT a manual goal: `dispatchTo` parks a ship at a waypoint and
   * stops it working, which is the wrong tool for "go mine over there". The
   * ship keeps its full autonomous cycle — mine, fill, fly out, sell, come
   * back — it just stops choosing the field for itself. That's the operator
   * overriding one decision rather than taking the ship off the board.
   */
  mineAt(waypointSymbol: string): void {
    this.pinnedMiningTarget = waypointSymbol;
    this.log(`mining pinned to ${waypointSymbol}`);
  }

  /** The asteroid this ship is pinned to, if any. */
  pinnedField(): string | undefined {
    return this.pinnedMiningTarget;
  }

  /** Hand the choice of field back to the ship. */
  unpinMining(): void {
    if (!this.pinnedMiningTarget) return;
    this.pinnedMiningTarget = undefined;
    this.log("mining unpinned; choosing its own field again");
  }

  /** Prevent the agent from acting while the fleet coordinates it manually (e.g. rescues). */
  suspend(): void {
    this.suspended = true;
    this.log("suspended");
  }

  /** Resume autonomous control after a fleet-coordinated operation. */
  resume(): void {
    this.suspended = false;
    this.log("resumed");
  }

  /** Clear any stranded flag (miners can't strand for fuel, so this is a no-op). */
  clearStranded(): void {}

  /** Release the ship back to autonomous operation. */
  release(): void {
    this.unpinMining();
    if (this.manualGoal) {
      this.manualGoal = null;
      this.log("released to autonomous control");
    }
  }

  stop(): void {
    this.running = false;
  }
}

export { ORE_GOODS };
