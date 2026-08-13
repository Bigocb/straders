import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { MarketSnapshot } from "./market.js";
import type { GalaxyAtlas } from "./galaxy.js";
import type { TraderAssignment } from "./dispatcher.js";

export type Ship = components["schemas"]["Ship"];

/** The subset of a route needed to fly it directly — the shape shared by a
 *  full DispatchRoute (the claim path) and a "direct"-role TraderAssignment. */
interface DirectLeg {
  good: string;
  buyAt: string;
  sellAt: string;
  buyPrice: number;
  sellPrice: number;
}

/** A direct leg the ship has priced against its own table and can fly now. */
interface Route extends DirectLeg {
  margin: number;
  volume: number;
}

export interface TraderOptions {
  api: SpaceTradersAPI;
  log?: (msg: string) => void;
  recordLedger?: (entry: {
    timestamp: string;
    shipSymbol: string;
    waypointSymbol: string;
    type: "PURCHASE" | "SELL" | "REFUEL";
    tradeSymbol?: string;
    units?: number;
    pricePerUnit?: number;
    total: number;
  }) => void;
  /** Called for notable events for the live feed. */
  onActivity?: (kind: string, detail: string, credits?: number) => void;
  /** Called when the ship docks at a marketplace so prices can be snapshotted. */
  recordMarket?: (waypointSymbol: string) => Promise<void>;
  /** Provide latest market snapshots from persistent store on each tick. */
  getMarketSnapshots?: () => { waypointSymbol: string; goodSymbol: string; purchasePrice: number; sellPrice: number; tradeVolume: number }[];
  /** Multi-system atlas for jump routing between systems. */
  atlas?: GalaxyAtlas;
  /** Trade symbols reserved for missions; the trader must never buy/sell these. */
  protectedGoods?: () => Set<string>;
  /** Trade symbols being carried / traded by another ship; avoid these to prevent buying competition. */
  reservedGoods?: () => Set<string>;
  /** Centralized dispatch: the specific assignment this trader holds (or undefined if it holds no claim). */
  assignedRoute?: () => TraderAssignment | undefined;
  /**
   * Take the best dispatch route no other trader holds. `accept` rejects routes
   * this ship can't actually fly, so the dispatcher moves on to the next-best
   * one within the same call. Must be synchronous: that's what makes the claim
   * atomic against the other traders' loops. Only ever hands back a "direct"
   * assignment — the dispatcher's live-claim path predates warehousing roles.
   */
  claimRoute?: (accept: (route: DirectLeg) => boolean) => TraderAssignment | undefined;
  /** Give up this trader's claim so a fleetmate can take the good. */
  releaseRoute?: () => void;
  /** Current credit balance, used to cap purchase volume by affordability. */
  getCredits?: () => number;
  /** Max acceptable loss per unit (percent of cost basis) before refusing to sell. Default 15. */
  maxLossPct?: number;
  /** Minimum per-unit margin for a route to be worth taking. Default 10. */
  marginFloor?: number;
  /**
   * How long a price stays usable, in minutes. The dispatcher filters its route
   * list by the same number, so both are reasoning about the same markets.
   * Default 90.
   */
  intelMaxAgeMin?: () => number;
  /** Where the warehouse ship is parked, if one is designated — the rendezvous point for buy/sell-role legs. */
  getWarehouseShip?: () => { shipSymbol: string; waypointSymbol: string } | undefined;
  /** Units of a good currently held in the warehouse, for sizing a sell-role withdrawal. */
  warehouseBalance?: (good: string) => number;
  /** Record a deposit into the warehouse's bookkeeping — call only after the real transferCargo into the warehouse ship has succeeded. */
  warehouseDeposit?: (good: string, units: number, price: number, shipSymbol: string) => void;
  /** Record a withdrawal from the warehouse's bookkeeping — call only after the real transferCargo out of the warehouse ship has succeeded. Returns the actual units removed and their cost basis. */
  warehouseWithdraw?: (good: string, units: number, shipSymbol: string) => { units: number; avgCost: number };
  /** Minimum per-unit margin over cost basis required to sell out of the warehouse. Default 0 (any profit clears). */
  warehouseMinMargin?: () => number;
  /** Whether the ship may act right now. False while the fleet is halted. */
  shouldRun?: () => boolean;
  /** Recover a cost basis this process never saw, from the trade ledger. */
  recoverCostBasis?: (good: string) => number | undefined;
}


export interface WaypointPos {
  symbol: string;
  x: number;
  y: number;
  type?: components["schemas"]["WaypointType"];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How often a halted agent re-checks whether the fleet has resumed. */
const HALT_POLL_MS = 1_000;

/**
 * A hauler/trader ship that executes buy-low → sell-high arbitrage routes.
 * Price knowledge is gathered by docking at markets (prices are only exposed
 * when a ship is present), so the trader keeps a running price table.
 */
export class TraderAgent {
  readonly symbol: string;
  private readonly api: SpaceTradersAPI;
  private readonly log: (msg: string) => void;
  private readonly recordLedger: TraderOptions["recordLedger"];
  private readonly onActivity: TraderOptions["onActivity"];
  private readonly recordMarket: TraderOptions["recordMarket"];
  private readonly getMarketSnapshots: TraderOptions["getMarketSnapshots"];
  private readonly protectedGoods?: () => Set<string>;
  private readonly reservedGoods?: () => Set<string>;
  private readonly assignedRoute?: () => TraderAssignment | undefined;
  private readonly claimRoute?: TraderOptions["claimRoute"];
  private readonly releaseRoute?: () => void;
  private readonly getCredits?: () => number;
  private readonly maxLossPct: number;
  private readonly marginFloor: number;
  private readonly intelMaxAgeMin: () => number;
  private readonly atlas?: GalaxyAtlas;
  private readonly getWarehouseShip?: TraderOptions["getWarehouseShip"];
  private readonly warehouseBalance?: TraderOptions["warehouseBalance"];
  private readonly warehouseDeposit?: TraderOptions["warehouseDeposit"];
  private readonly warehouseWithdraw?: TraderOptions["warehouseWithdraw"];
  private readonly warehouseMinMargin?: TraderOptions["warehouseMinMargin"];
  private readonly shouldRun?: () => boolean;
  private readonly recoverCostBasis?: (good: string) => number | undefined;
  private ship: Ship;
  private positions = new Map<string, WaypointPos>();
  /** Good → price seen at each market. Rebuilt every tick by `loadSnapshots`. */
  private priceTable = new Map<string, Map<string, { buy: number; sell: number; volume: number }>>();
  /** Prices this ship read live at a market, and when. Newer than the store. */
  private observed = new Map<string, Map<string, { buy: number; sell: number; volume: number }>>();
  private observedAt = new Map<string, number>();
  private manualWaypoint: string | null = null;
  private suspended = false;
  /** Good → cost basis per unit for cargo currently in the hold. */
  private heldCost = new Map<string, number>();
  /** Routes rejected by the live buy-price guard this tick (good@buyAt). */
  private deadRoutes = new Set<string>();
  private stranded = false;
  running = false;

  constructor(ship: Ship, opts: TraderOptions) {
    this.symbol = ship.symbol;
    this.ship = ship;
    this.api = opts.api;
    this.log = opts.log ?? ((m) => console.log(`[${this.symbol}] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
    this.getMarketSnapshots = opts.getMarketSnapshots;
    this.protectedGoods = opts.protectedGoods;
    this.reservedGoods = opts.reservedGoods;
    this.assignedRoute = opts.assignedRoute;
    this.claimRoute = opts.claimRoute;
    this.releaseRoute = opts.releaseRoute;
    this.getCredits = opts.getCredits;
    this.maxLossPct = opts.maxLossPct ?? 15;
    this.marginFloor = opts.marginFloor ?? 10;
    this.intelMaxAgeMin = opts.intelMaxAgeMin ?? (() => 90);
    this.atlas = opts.atlas;
    this.getWarehouseShip = opts.getWarehouseShip;
    this.warehouseBalance = opts.warehouseBalance;
    this.warehouseDeposit = opts.warehouseDeposit;
    this.warehouseWithdraw = opts.warehouseWithdraw;
    this.warehouseMinMargin = opts.warehouseMinMargin;
    this.shouldRun = opts.shouldRun;
    this.recoverCostBasis = opts.recoverCostBasis;
  }

  isManual(): boolean {
    return this.manualWaypoint !== null;
  }

  /** True while the fleet holds the ship for coordinated work (rescue/mission). */
  isSuspended(): boolean {
    return this.suspended;
  }

  async dispatchTo(waypointSymbol: string): Promise<void> {
    this.manualWaypoint = waypointSymbol;
    this.log(`manual dispatch → ${waypointSymbol}`);
    await this.refresh();
    await this.navigateTo(waypointSymbol);
    await this.ensureDocked();
  }

  release(): void {
    if (this.manualWaypoint) {
      this.manualWaypoint = null;
      this.log("released to autonomous control");
    }
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

  withWorld(positions: WaypointPos[]): this {
    for (const p of positions) this.positions.set(p.symbol, p);
    return this;
  }

  getShip(): Ship {
    return this.ship;
  }

  private async refresh(): Promise<void> {
    this.ship = await this.api.getShip(this.symbol);
  }

  private async ensureInOrbit(): Promise<void> {
    if (this.ship.nav.status === "IN_ORBIT") return;
    if (this.ship.nav.status === "IN_TRANSIT") await this.waitForArrival();
    if (this.ship.nav.status === "DOCKED") {
      await this.api.orbitShip(this.symbol);
      await this.refresh();
    }
  }

  private async ensureDocked(): Promise<void> {
    if (this.ship.nav.status === "DOCKED") return;
    if (this.ship.nav.status === "IN_TRANSIT") await this.waitForArrival();
    if (this.ship.nav.status === "IN_ORBIT") {
      await this.api.dockShip(this.symbol);
      await this.refresh();
    }
  }

  private async waitForArrival(): Promise<void> {
    for (;;) {
      const wait = new Date(this.ship.nav.route.arrival).getTime() - Date.now();
      if (wait > 0) {
        this.log(`in transit, arrival in ${Math.round(wait / 1000)}s`);
        await sleep(wait + 1000);
      }
      await this.refresh();
      if (this.ship.nav.status !== "IN_TRANSIT") return;
    }
  }

  private distBetween(a: string, b: string): number {
    const pa = this.positions.get(a);
    const pb = this.positions.get(b);
    if (!pa || !pb) return 1000;
    return Math.max(1, Math.round(Math.hypot(pb.x - pa.x, pb.y - pa.y)));
  }

  private systemOf(wp: string): string {
    return wp.slice(0, wp.lastIndexOf("-"));
  }

  private async navigateTo(waypoint: string): Promise<void> {
    if (this.ship.nav.waypointSymbol === waypoint && this.ship.nav.status !== "IN_TRANSIT") return;
    const targetSystem = this.systemOf(waypoint);
    if (targetSystem !== this.ship.nav.systemSymbol) {
      await this.jumpToSystem(targetSystem, waypoint);
      return;
    }
    // Refuel if we're low. Prefer a market, but burn FUEL from the cargo hold
    // when there's no market here — a trader hauling fuel must never be stranded
    // at a non-market waypoint (e.g. an asteroid) while carrying its own fuel.
    // Never refuel while in transit — refuelAt() calls navigateTo() again, and a
    // ship that is IN_TRANSIT to a fuel market would recurse forever.
    if (this.ship.nav.status !== "IN_TRANSIT" && this.ship.fuel.current < this.ship.fuel.capacity * 0.5) {
      const here = this.ship.nav.waypointSymbol;
      const isFuelMarket = this.priceTable.get(here)?.has("FUEL");
      if (isFuelMarket) {
        await this.refuelAt(here);
      } else {
        await this.refuelFromCargo();
      }
    }
    await this.ensureInOrbit();
    await this.api.navigateShip(this.symbol, waypoint);
    await this.waitForArrival();
  }

  /** Jump to a waypoint in another system using the nearest jump gate. */
  private async jumpToSystem(targetSystem: string, destination: string): Promise<void> {
    if (!this.atlas) {
      this.log(`cannot jump to ${targetSystem}: no galaxy atlas`);
      return;
    }
    const fromSystem = this.ship.nav.systemSymbol;
    const gates = this.atlas.gatesTo(fromSystem, targetSystem);
    let gate = gates[0];
    if (!gate) {
      await this.atlas.scanJumpGates(fromSystem);
      gate = this.atlas.gatesTo(fromSystem, targetSystem)[0];
    }
    if (!gate) {
      this.log(`no jump gate from ${fromSystem} to ${targetSystem}`);
      return;
    }
    // Guard against infinite recursion: the gate must be in the current system.
    // If the atlas returns a gate in a different system (stale state after a
    // jump), navigating to it would call jumpToSystem again forever.
    if (this.systemOf(gate) !== fromSystem) {
      this.log(`gate ${gate} is not in ${fromSystem}; skipping jump to ${targetSystem}`);
      return;
    }
    await this.navigateTo(gate);
    await this.ensureInOrbit();
    this.log(`jumping ${fromSystem} -> ${targetSystem} via ${gate}`);
    const res = await this.api.jumpShip(this.symbol, destination);
    this.ship = { ...this.ship, nav: res.nav };
    this.onActivity?.("jump", `jumped to ${destination}`, -res.transaction.totalPrice);
    await this.refresh();
    if (this.recordMarket) await this.recordMarket(this.ship.nav.waypointSymbol);
  }

  /** Dock at a waypoint and refresh prices for its market. */
  private async observeMarket(waypoint: string): Promise<void> {
    await this.navigateTo(waypoint);
    await this.ensureDocked();
    if (this.recordMarket) await this.recordMarket(waypoint);
    const m = await this.api.getMarket(this.ship.nav.systemSymbol, waypoint);
    const table = new Map<string, { buy: number; sell: number; volume: number }>();
    for (const g of m.tradeGoods ?? []) {
      table.set(g.symbol, { buy: g.purchasePrice, sell: g.sellPrice, volume: g.tradeVolume });
    }
    this.observed.set(waypoint, table);
    this.observedAt.set(waypoint, Date.now());
    const merged = this.priceTable.get(waypoint) ?? new Map();
    for (const [good, price] of table) merged.set(good, price);
    this.priceTable.set(waypoint, merged);
  }

  /** Best buy location + price for a good among observed markets. */
  private bestBuy(good: string): { waypoint: string; buy: number; sell: number; volume: number } | undefined {
    let best: { waypoint: string; buy: number; sell: number; volume: number } | undefined;
    for (const [wp, table] of this.priceTable) {
      const g = table.get(good);
      if (!g) continue;
      if (!best || g.buy < best.buy) best = { waypoint: wp, ...g };
    }
    return best;
  }

  /** Best sell location + price for a good among observed markets. */
  private bestSell(good: string): { waypoint: string; buy: number; sell: number; volume: number } | undefined {
    let best: { waypoint: string; buy: number; sell: number; volume: number } | undefined;
    for (const [wp, table] of this.priceTable) {
      const g = table.get(good);
      if (!g) continue;
      if (!best || g.sell > best.sell) best = { waypoint: wp, ...g };
    }
    return best;
  }

  /** Live sell price at a market, or undefined if the market is unreachable. */
  private async liveSellPrice(waypoint: string, good: string): Promise<number | undefined> {
    try {
      const m = await this.api.getMarket(this.systemOf(waypoint), waypoint);
      const g = m.tradeGoods?.find((t) => t.symbol === good);
      return g?.sellPrice;
    } catch {
      return undefined;
    }
  }

  /** Live purchase price at a market, or undefined if the market is unreachable. */
  private async liveBuyPrice(waypoint: string, good: string): Promise<number | undefined> {
    try {
      const m = await this.api.getMarket(this.systemOf(waypoint), waypoint);
      const g = m.tradeGoods?.find((t) => t.symbol === good);
      return g?.purchasePrice;
    } catch {
      return undefined;
    }
  }

  /**
   * What this ship paid per unit for a good it's holding.
   *
   * `heldCost` only lives as long as the process, so a restart used to leave it
   * empty — and an empty basis meant `exceedsLossFloor` returned false for
   * everything, i.e. no loss protection at all. Every ship holding cargo across
   * a restart therefore sold it at whatever the market offered on its first
   * tick. The trade ledger has the answer, so recover from it and memoize.
   *
   * A good with genuinely no purchase history — mined ore, siphoned gas — still
   * returns undefined, and *should*: it has no cost basis to protect, so it may
   * sell at any price. That's the meaningful distinction the old code couldn't
   * make, because "never bought" and "forgot what we paid" looked identical.
   */
  private costBasis(good: string): number | undefined {
    const known = this.heldCost.get(good);
    if (known !== undefined && known > 0) return known;
    const recovered = this.recoverCostBasis?.(good);
    if (recovered !== undefined && recovered > 0) {
      this.heldCost.set(good, recovered);
      this.log(`recovered cost basis for ${good}: ${Math.round(recovered)}c (from trade ledger)`);
      return recovered;
    }
    return undefined;
  }

  /** True when selling at `price` would exceed the allowed loss vs the cost basis. */
  private exceedsLossFloor(good: string, price: number): boolean {
    const cost = this.costBasis(good);
    if (cost === undefined || cost <= 0) return false;
    const floor = cost * (1 - this.maxLossPct / 100);
    return price < floor;
  }

  /**
   * The route this trader should fly next.
   *
   * Order matters, and it is the whole convergence fix:
   *
   * 1. The route the dispatcher already gave us — good *and* markets, so we fly
   *    the leg it priced rather than re-deriving our own from a price table
   *    that may disagree with it.
   * 2. Failing that, claim the best route no fleetmate holds. The claim is one
   *    synchronous call into the dispatcher, so two traders evaluating routes
   *    at the same moment cannot both walk away with the same good.
   * 3. Only when no dispatcher is wired at all (standalone trader) do we fall
   *    back to picking for ourselves.
   */
  private findRoute(): Route | undefined {
    const assigned = this.asDirectLeg(this.assignedRoute?.());
    if (assigned) {
      const viable = this.viableRoute(assigned);
      if (viable) return viable;
    }

    if (this.claimRoute) {
      const claimed = this.asDirectLeg(this.claimRoute((r) => this.viableRoute(r) !== undefined));
      return claimed ? this.viableRoute(claimed) : undefined;
    }

    return this.freeChoice();
  }

  /**
   * Narrow a dispatcher assignment down to a direct leg this ship can
   * evaluate. A "buy"/"sell"/"haul" assignment reads as "nothing for the
   * direct pipeline" rather than crashing on the missing buyAt/sellAt —
   * those roles are handled by runBuy/runSell instead.
   */
  private asDirectLeg(a: TraderAssignment | undefined): DirectLeg | undefined {
    if (!a || a.role !== "direct" || !a.buyAt || !a.sellAt || a.buyPrice === undefined || a.sellPrice === undefined) {
      return undefined;
    }
    return { good: a.good, buyAt: a.buyAt, sellAt: a.sellAt, buyPrice: a.buyPrice, sellPrice: a.sellPrice };
  }

  /**
   * Turn a direct leg into something this ship can actually fly, or
   * undefined if it can't: wrong system, no prices for those markets, margin
   * below the floor, nothing affordable, or fuel eats the profit.
   */
  private viableRoute(r: DirectLeg): Route | undefined {
    if (r.buyAt === r.sellAt) return undefined;
    if (this.protectedGoods?.().has(r.good)) return undefined;
    if (this.deadRoutes.has(`${r.good}@${r.buyAt}`)) return undefined;
    // Same-system only: a cross-system leg needs a jump gate that may be under
    // construction, so it would fail at navigation.
    if (this.systemOf(r.buyAt) !== this.systemOf(r.sellAt)) return undefined;
    const buy = this.priceTable.get(r.buyAt)?.get(r.good);
    const sell = this.priceTable.get(r.sellAt)?.get(r.good);
    if (!buy || !sell || buy.buy <= 0) return undefined;
    const margin = sell.sell - buy.buy;
    if (margin <= this.marginFloor) return undefined;
    const credits = this.getCredits?.() ?? Infinity;
    const affordable = credits > 0 ? Math.floor(credits / buy.buy) : Infinity;
    const volume = Math.min(buy.volume, sell.volume, this.ship.cargo.capacity, affordable);
    if (volume <= 0) return undefined;
    const fuel = this.distBetween(r.buyAt, r.sellAt);
    const profit = margin * volume - fuel * (this.priceTable.get(r.buyAt)?.get("FUEL")?.buy ?? 72);
    if (profit <= 0) return undefined;
    return { good: r.good, buyAt: r.buyAt, buyPrice: buy.buy, sellAt: r.sellAt, sellPrice: sell.sell, margin, volume };
  }

  /**
   * Pick the most profitable good for ourselves. Only reachable when no
   * dispatcher is wired — with one, allocation goes through `claimRoute`,
   * because this path is a read-modify-write race: `reservedGoods` reflects
   * cargo already in holds, so two traders in here at the same time both see
   * the same good as free and both take it.
   */
  private freeChoice(): Route | undefined {
    const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
    const reservedGoods = this.reservedGoods?.() ?? new Set<string>();
    const goods = new Set<string>();
    for (const table of this.priceTable.values()) for (const g of table.keys()) goods.add(g);
    let best: Route | undefined;

    for (const good of goods) {
      if (protectedGoods.has(good) || reservedGoods.has(good)) continue;
      const buy = this.bestBuy(good);
      const sell = this.bestSell(good);
      if (!buy || !sell) continue;
      if (sell.waypoint === buy.waypoint) continue;
      if (this.deadRoutes.has(`${good}@${buy.waypoint}`)) continue;
      // Only trade within the same system — cross-system routes need a jump gate
      // that may be under construction, so they'd fail at navigation.
      if (this.systemOf(buy.waypoint) !== this.systemOf(sell.waypoint)) continue;
      const margin = sell.sell - buy.buy;
      if (margin <= this.marginFloor) continue;
      const fuel = this.distBetween(buy.waypoint, sell.waypoint);
      const credits = this.getCredits?.() ?? Infinity;
      const affordable = credits > 0 ? Math.floor(credits / buy.buy) : Infinity;
      const volume = Math.min(buy.volume, sell.volume, this.ship.cargo.capacity, affordable);
      if (volume <= 0) continue;
      const profit = margin * volume - fuel * (this.priceTable.get(buy.waypoint)?.get("FUEL")?.buy ?? 72);
      if (profit <= 0) continue;
      const candidate = {
        good,
        buyAt: buy.waypoint,
        buyPrice: buy.buy,
        sellAt: sell.waypoint,
        sellPrice: sell.sell,
        margin,
        volume,
      };
      if (!best || profit > this.routeProfit(best)) best = candidate;
    }
    return best;
  }

  private routeProfit(r: Route): number {
    const fuel = this.distBetween(r.buyAt, r.sellAt);
    const fuelPrice = this.priceTable.get(r.buyAt)?.get("FUEL")?.buy ?? 72;
    return (r.sellPrice - r.buyPrice) * r.volume - fuel * fuelPrice;
  }

  private async refuelAt(waypoint: string): Promise<void> {
    await this.navigateTo(waypoint);
    await this.ensureDocked();
    const fuelNeeded = this.ship.fuel.capacity - this.ship.fuel.current;
    if (fuelNeeded > 0) {
      const res = await this.api.refuelShip(this.symbol);
      this.recordLedger?.({
        timestamp: new Date().toISOString(),
        shipSymbol: this.symbol,
        waypointSymbol: this.ship.nav.waypointSymbol,
        type: "REFUEL",
        units: res.fuel.current,
        total: res.transaction.totalPrice,
      });
    }
  }

  /** Top up the tank from FUEL carried in the cargo hold (no market needed).
   *  Returns true if the tank gained any fuel. */
  private async refuelFromCargo(): Promise<boolean> {
    const fuel = this.ship.cargo.inventory?.find((i) => i.symbol === "FUEL");
    if (!fuel || fuel.units <= 0) return false;
    const room = this.ship.fuel.capacity - this.ship.fuel.current;
    if (room <= 0) return false;
    const use = Math.min(fuel.units, room);
    await this.api.refuelShip(this.symbol, undefined, true);
    await this.refresh();
    this.log(`refueled ${use}u from cargo hold`);
    return true;
  }

  /**
   * Rebuild the price table from the store's snapshots.
   *
   * This *replaces* the table rather than merging into it. Merging meant a
   * price the fleet had since aged out of its freshness window lived on in
   * memory forever, so the trader kept planning routes the dispatcher no
   * longer believed in — the two ended up flying different maps. Prices we
   * observed live at a market this tick are re-applied on top, since those are
   * fresher than anything the store has.
   */
  private loadSnapshots(): void {
    const snaps = this.getMarketSnapshots?.() ?? [];
    const next = new Map<string, Map<string, { buy: number; sell: number; volume: number }>>();
    for (const s of snaps) {
      const table = next.get(s.waypointSymbol) ?? new Map();
      table.set(s.goodSymbol, { buy: s.purchasePrice, sell: s.sellPrice, volume: s.tradeVolume });
      next.set(s.waypointSymbol, table);
    }
    const cutoff = Date.now() - this.intelMaxAgeMin() * 60_000;
    for (const [wp, table] of this.observed) {
      if ((this.observedAt.get(wp) ?? 0) < cutoff) {
        this.observed.delete(wp);
        this.observedAt.delete(wp);
        continue;
      }
      const merged = next.get(wp) ?? new Map();
      for (const [good, price] of table) merged.set(good, price);
      next.set(wp, merged);
    }
    this.priceTable = next;
  }

  /**
   * Sweep cargo already sitting in the hold (crash recovery, or a leftover
   * deposit that failed to reach the warehouse ship) before evaluating new
   * routes this tick. Sells at the best same-system market — including the
   * current route's good; excluding it used to let a trader sit at the sell
   * market holding cargo while route logic kept flying it back for more.
   * Returns a tick result if it handled everything, or undefined to fall
   * through to routing — e.g. when docking failed and the cargo is still
   * stuck in the hold.
   */
  private async clearLeftoverCargo(): Promise<boolean | undefined> {
    const leftover = (this.ship.cargo.inventory ?? []).filter((i) => i.units > 0);
    if (leftover.length === 0) return undefined;
    const item = leftover[0]!;
    // Only sell leftover within the current system — a cross-system sell
    // market needs a jump gate that may be under construction, and flying
    // there would fail (or worse, recurse in navigation).
    const sell = this.bestSell(item.symbol);
    if (sell && sell.waypoint !== this.ship.nav.waypointSymbol && this.systemOf(sell.waypoint) === this.ship.nav.systemSymbol) {
      await this.navigateTo(sell.waypoint);
    }
    // Dock before selling — a ship sitting in orbit at a market would
    // otherwise skip the sell and fall through to buying MORE cargo.
    await this.ensureDocked();
    if (this.ship.nav.status !== "DOCKED") return undefined;
    try {
      const live = await this.liveSellPrice(this.ship.nav.waypointSymbol, item.symbol);
      if (live !== undefined && this.exceedsLossFloor(item.symbol, live)) {
        this.log(`holding ${item.units}u ${item.symbol}: live sell ${live}c is below loss floor (cost ${this.heldCost.get(item.symbol)}c)`);
        return true;
      }
      const sold = await this.api.sellCargo(this.symbol, item.symbol, item.units);
      this.ship = { ...this.ship, cargo: sold.cargo };
      this.recordLedger?.({
        timestamp: new Date().toISOString(),
        shipSymbol: this.symbol,
        waypointSymbol: this.ship.nav.waypointSymbol,
        type: "SELL",
        tradeSymbol: item.symbol,
        units: item.units,
        pricePerUnit: sold.transaction.pricePerUnit,
        total: sold.transaction.totalPrice,
      });
      this.log(`cleared leftover ${item.units}u ${item.symbol} @ ${sold.transaction.pricePerUnit}c`);
      this.onActivity?.("sell", `${item.units}u ${item.symbol} @ ${sold.transaction.pricePerUnit}c`, sold.transaction.totalPrice);
      return true;
    } catch (err) {
      // market doesn't buy it — jettison to free the hold
      const j = await this.api.jettisonCargo(this.symbol, item.symbol, item.units);
      this.ship = { ...this.ship, cargo: j.cargo };
      this.log(`jettisoned ${item.units}u ${item.symbol} (no buyer)`);
      return true;
    }
  }

  /**
   * No profitable route right now: refresh prices instead of sleeping and
   * retrying the same dead route forever. `preferred` is checked first (the
   * markets the caller actually wanted fresh intel on), then any other known
   * market.
   */
  private async discoverPrices(preferred: string[]): Promise<boolean> {
    const knownMarkets = [...new Set((this.getMarketSnapshots?.() ?? []).map((s) => s.waypointSymbol))];
    const here = this.ship.nav.waypointSymbol;
    const target = preferred.filter((m) => m && m !== here).find((m) => knownMarkets.includes(m)) ?? knownMarkets.find((m) => m !== here) ?? knownMarkets[0];
    if (!target) return false;
    this.log("discovering prices...");
    // Navigate to the market first, then refuel there — refueling at the
    // current spot fails if it's an asteroid with no fuel market.
    await this.navigateTo(target);
    await this.refuelAt(target);
    await this.observeMarket(target);
    return true;
  }

  /** The legacy direct buy→sell pipeline: one ship owns the whole round
   *  trip. Used for "direct"/unassigned traders, and as the fallback when a
   *  buy/sell-role assignment can't be flown (e.g. no warehouse ship yet). */
  private async runArbitrage(assigned: TraderAssignment | undefined): Promise<boolean> {
    // Try routes in order of profitability, skipping any the live buy-price
    // guard rejects, until one actually buys. A single pass: no recursion.
    for (;;) {
      const route = this.findRoute();
      if (!route) break;
      await this.navigateTo(route.buyAt);
      await this.ensureDocked();
      // Re-verify the live buy price before committing. The snapshot that drove
      // the route may be stale; if the price has inflated past the expected sell
      // price, buying now would lock in a loss. Refuse and let the next tick
      // re-evaluate (or pick a different route) instead of buying on a bad basis.
      const liveBuy = await this.liveBuyPrice(route.buyAt, route.good);
      if (liveBuy !== undefined && liveBuy > route.buyPrice) {
        const liveMargin = route.sellPrice - liveBuy;
        if (liveMargin < this.marginFloor) {
          this.log(
            `skipping buy: ${route.good} at ${route.buyAt} is now ${liveBuy}c (snapshot ${route.buyPrice}c), margin ${liveMargin}c below floor ${this.marginFloor}c`
          );
          // Remember this dead route so findRoute stops proposing it, then try
          // the next best route instead of retrying the same one every tick.
          this.deadRoutes.add(`${route.good}@${route.buyAt}`);
          continue;
        }
      }
      // Size the purchase against live credit, not the cached fleet balance the
      // route was planned under. The fleet refreshes credits only once per tick,
      // so after buying a new ship the cached figure is stale and this ship would
      // otherwise over-commit and fail the purchase (observed: trying to buy 58
      // FOOD with far fewer credits in hand).
      const liveCredits = (await this.api.getMyAgent()).credits;
      const buyPrice = liveBuy ?? route.buyPrice;
      const affordable = buyPrice > 0 ? Math.floor(liveCredits / buyPrice) : 0;
      let units = Math.min(route.volume, this.ship.cargo.capacity - this.ship.cargo.units, affordable);
      if (units <= 0) return true;
      // Also guard against over-filling the hold with a single oversized buy.
      units = Math.max(0, Math.floor(units));
      const res = await this.api.purchaseCargo(this.symbol, route.good, units);
      this.ship = { ...this.ship, cargo: res.cargo };
      this.heldCost.set(route.good, res.transaction.pricePerUnit);
      this.recordLedger?.({
        timestamp: new Date().toISOString(),
        shipSymbol: this.symbol,
        waypointSymbol: this.ship.nav.waypointSymbol,
        type: "PURCHASE",
        tradeSymbol: route.good,
        units,
        pricePerUnit: res.transaction.pricePerUnit,
        total: res.transaction.totalPrice,
      });
      this.log(`bought ${units}u ${route.good} @ ${res.transaction.pricePerUnit}c at ${route.buyAt}`);
      this.onActivity?.("buy", `${units}u ${route.good} @ ${res.transaction.pricePerUnit}c at ${route.buyAt}`, -res.transaction.totalPrice);
      await this.navigateTo(route.sellAt);
      await this.ensureDocked();
      const live = await this.liveSellPrice(route.sellAt, route.good);
      if (live !== undefined && this.exceedsLossFloor(route.good, live)) {
        this.log(`holding ${units}u ${route.good}: live sell ${live}c is below loss floor (cost ${this.heldCost.get(route.good)}c)`);
        return true;
      }
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
      this.log(`sold ${units}u ${route.good} @ ${sold.transaction.pricePerUnit}c at ${route.sellAt} (+${sold.transaction.totalPrice - res.transaction.totalPrice}c)`);
      this.onActivity?.("sell", `${units}u ${route.good} @ ${sold.transaction.pricePerUnit}c at ${route.sellAt}`, sold.transaction.totalPrice);
      return true;
    }

    // Prefer the assigned route's own buy/sell markets (that's where the
    // dispatcher wants us) for the price-discovery fallback.
    const direct = this.asDirectLeg(assigned);
    return this.discoverPrices(direct ? [direct.buyAt, direct.sellAt] : []);
  }

  /**
   * role = "buy": buy at `assigned.buyAt`, carry it to the warehouse ship's
   * waypoint, and hand it over with a real `transferCargo`. Falls back to
   * direct arbitrage when there's no warehouse ship to rendezvous with, or
   * the assignment isn't otherwise flyable — see docs/warehousing-plan.md §9.
   */
  private async runBuy(assigned: TraderAssignment): Promise<boolean> {
    const warehouse = this.getWarehouseShip?.();
    const buyAt = assigned.buyAt;
    if (!warehouse || !buyAt) return this.runArbitrage(undefined);
    // A missionBuy assignment exists specifically to acquire a
    // protectedGoods-listed good on the mission's behalf — the block is
    // there to stop ORDINARY trading from competing for a reserved good,
    // not to stop the mission from sourcing its own material this way.
    if (!assigned.missionBuy && this.protectedGoods?.().has(assigned.good)) return this.runArbitrage(undefined);
    if (this.deadRoutes.has(`${assigned.good}@${buyAt}`)) return this.runArbitrage(undefined);
    // Same-system only, same reasoning as the direct path: a cross-system
    // leg needs a jump gate that may be under construction.
    if (this.systemOf(buyAt) !== this.systemOf(warehouse.waypointSymbol)) return this.runArbitrage(undefined);

    await this.navigateTo(buyAt);
    await this.ensureDocked();

    const cached = this.priceTable.get(buyAt)?.get(assigned.good);
    const liveBuy = await this.liveBuyPrice(buyAt, assigned.good);
    const buyPrice = liveBuy ?? cached?.buy;
    if (buyPrice === undefined || buyPrice <= 0) return this.discoverPrices([buyAt]);
    if (assigned.buyPrice !== undefined && buyPrice > assigned.buyPrice) {
      this.log(`skipping buy: ${assigned.good} at ${buyAt} is now ${buyPrice}c (snapshot ${assigned.buyPrice}c)`);
      this.deadRoutes.add(`${assigned.good}@${buyAt}`);
      return this.discoverPrices([buyAt]);
    }

    const liveCredits = (await this.api.getMyAgent()).credits;
    const affordable = buyPrice > 0 ? Math.floor(liveCredits / buyPrice) : 0;
    const volume = cached?.volume ?? affordable;
    let units = Math.min(volume, this.ship.cargo.capacity - this.ship.cargo.units, affordable);
    units = Math.max(0, Math.floor(units));
    if (units <= 0) return this.discoverPrices([buyAt]);

    const res = await this.api.purchaseCargo(this.symbol, assigned.good, units);
    this.ship = { ...this.ship, cargo: res.cargo };
    // Warehouse-bound cargo needs a cost basis too. Without this, a deposit
    // that failed its rendezvous left the goods in the hold with no basis, so
    // the leftover sweeper cleared them at any price the market offered.
    this.heldCost.set(assigned.good, res.transaction.pricePerUnit);
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol: this.symbol,
      waypointSymbol: this.ship.nav.waypointSymbol,
      type: "PURCHASE",
      tradeSymbol: assigned.good,
      units,
      pricePerUnit: res.transaction.pricePerUnit,
      total: res.transaction.totalPrice,
    });
    this.log(`bought ${units}u ${assigned.good} @ ${res.transaction.pricePerUnit}c at ${buyAt}`);
    this.onActivity?.("buy", `${units}u ${assigned.good} @ ${res.transaction.pricePerUnit}c at ${buyAt}`, -res.transaction.totalPrice);

    await this.navigateTo(warehouse.waypointSymbol);
    await this.ensureDocked();
    try {
      const xfer = await this.api.transferCargo(this.symbol, assigned.good, units, warehouse.shipSymbol);
      this.ship = { ...this.ship, cargo: xfer.cargo };
      this.warehouseDeposit?.(assigned.good, units, res.transaction.pricePerUnit, this.symbol);
      this.log(`deposited ${units}u ${assigned.good} into warehouse ship ${warehouse.shipSymbol}`);
      this.onActivity?.("warehouse-deposit", `${units}u ${assigned.good} into ${warehouse.shipSymbol}`);
    } catch (err) {
      // Rendezvous failed this tick (warehouse ship not there yet, etc). The
      // cargo stays in the hold; clearLeftoverCargo sweeps it to market next
      // tick if the deposit keeps failing, rather than stranding it forever.
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`deposit into warehouse ship failed: ${msg}`);
    }
    return true;
  }

  /**
   * role = "sell": withdraw from the warehouse ship with a real
   * `transferCargo`, carry it to `assigned.sellAt`, and sell. Falls back to
   * direct arbitrage under the same conditions as runBuy.
   */
  private async runSell(assigned: TraderAssignment): Promise<boolean> {
    const warehouse = this.getWarehouseShip?.();
    const sellAt = assigned.sellAt;
    if (!warehouse || !sellAt) return this.runArbitrage(undefined);
    if (this.protectedGoods?.().has(assigned.good)) return this.runArbitrage(undefined);
    if (this.systemOf(warehouse.waypointSymbol) !== this.systemOf(sellAt)) return this.runArbitrage(undefined);

    const balance = this.warehouseBalance?.(assigned.good) ?? 0;
    if (balance <= 0) return this.discoverPrices([sellAt]);

    await this.navigateTo(warehouse.waypointSymbol);
    await this.ensureDocked();

    const room = this.ship.cargo.capacity - this.ship.cargo.units;
    const units = Math.max(0, Math.floor(Math.min(balance, room)));
    if (units <= 0) return this.discoverPrices([sellAt]);

    let withdrawn: { units: number; avgCost: number };
    try {
      // The warehouse ship is the sender here, so this call is made as the
      // warehouse ship, not this trader — transferCargo is parameterized by
      // ship symbol, not by who's "logged in".
      await this.api.transferCargo(warehouse.shipSymbol, assigned.good, units, this.symbol);
      // The response carries the SENDER's (warehouse ship's) cargo, not
      // ours — refresh to pick up what we actually received.
      await this.refresh();
      withdrawn = this.warehouseWithdraw?.(assigned.good, units, this.symbol) ?? { units, avgCost: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`withdraw from warehouse ship failed: ${msg}`);
      return false;
    }
    if (withdrawn.units <= 0) return false;
    this.heldCost.set(assigned.good, withdrawn.avgCost);
    this.log(`withdrew ${withdrawn.units}u ${assigned.good} from warehouse ship ${warehouse.shipSymbol} (cost basis ${withdrawn.avgCost}c)`);
    this.onActivity?.("warehouse-withdraw", `${withdrawn.units}u ${assigned.good} from ${warehouse.shipSymbol}`);

    await this.navigateTo(sellAt);
    await this.ensureDocked();
    const live = await this.liveSellPrice(sellAt, assigned.good);
    if (live !== undefined && this.exceedsLossFloor(assigned.good, live)) {
      this.log(`holding ${withdrawn.units}u ${assigned.good}: live sell ${live}c is below loss floor (cost ${withdrawn.avgCost}c)`);
      return true;
    }
    const minMargin = this.warehouseMinMargin?.() ?? 0;
    if (live !== undefined && live - withdrawn.avgCost < minMargin) {
      this.log(`holding ${withdrawn.units}u ${assigned.good}: live sell ${live}c clears cost basis (${withdrawn.avgCost}c) by only ${live - withdrawn.avgCost}c, below warehouse margin floor ${minMargin}c`);
      return true;
    }
    const sold = await this.api.sellCargo(this.symbol, assigned.good, withdrawn.units);
    this.ship = { ...this.ship, cargo: sold.cargo };
    this.recordLedger?.({
      timestamp: new Date().toISOString(),
      shipSymbol: this.symbol,
      waypointSymbol: this.ship.nav.waypointSymbol,
      type: "SELL",
      tradeSymbol: assigned.good,
      units: withdrawn.units,
      pricePerUnit: sold.transaction.pricePerUnit,
      total: sold.transaction.totalPrice,
    });
    this.log(`sold ${withdrawn.units}u ${assigned.good} @ ${sold.transaction.pricePerUnit}c at ${sellAt}`);
    this.onActivity?.("sell", `${withdrawn.units}u ${assigned.good} @ ${sold.transaction.pricePerUnit}c at ${sellAt}`, sold.transaction.totalPrice);
    return true;
  }

  /**
   * role = "haul": withdraw from the warehouse ship — same rendezvous as
   * runSell — and deliver to a mission's construction site instead of a
   * market. `assigned.sellAt` carries the construction waypoint (dispatcher's
   * toHaulAssignment repurposes the field rather than adding a haul-only
   * one). No loss-floor/margin gate: this isn't a sale, it's fulfilling a
   * requirement, so whatever's withdrawn gets delivered.
   */
  private async runHaul(assigned: TraderAssignment): Promise<boolean> {
    const warehouse = this.getWarehouseShip?.();
    const targetWaypoint = assigned.sellAt;
    if (!warehouse || !targetWaypoint) return this.runArbitrage(undefined);
    if (this.systemOf(warehouse.waypointSymbol) !== this.systemOf(targetWaypoint)) return this.runArbitrage(undefined);

    const balance = this.warehouseBalance?.(assigned.good) ?? 0;
    if (balance <= 0) return this.discoverPrices([]);

    await this.navigateTo(warehouse.waypointSymbol);
    await this.ensureDocked();

    const room = this.ship.cargo.capacity - this.ship.cargo.units;
    const units = Math.max(0, Math.floor(Math.min(balance, room)));
    if (units <= 0) return this.discoverPrices([]);

    let withdrawn: { units: number; avgCost: number };
    try {
      // Same as runSell: made as the warehouse ship, since it's the sender.
      await this.api.transferCargo(warehouse.shipSymbol, assigned.good, units, this.symbol);
      await this.refresh();
      withdrawn = this.warehouseWithdraw?.(assigned.good, units, this.symbol) ?? { units, avgCost: 0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`withdraw from warehouse ship failed: ${msg}`);
      return false;
    }
    if (withdrawn.units <= 0) return false;
    this.log(`withdrew ${withdrawn.units}u ${assigned.good} from warehouse ship ${warehouse.shipSymbol} for haul to ${targetWaypoint}`);
    this.onActivity?.("warehouse-withdraw", `${withdrawn.units}u ${assigned.good} from ${warehouse.shipSymbol} (haul)`);

    await this.navigateTo(targetWaypoint);
    await this.ensureDocked();
    try {
      const res = await this.api.supplyConstruction(this.systemOf(targetWaypoint), targetWaypoint, this.symbol, assigned.good, withdrawn.units);
      this.ship = { ...this.ship, cargo: res.cargo };
      this.log(`hauled ${withdrawn.units}u ${assigned.good} to ${targetWaypoint}`);
      this.onActivity?.("haul", `${withdrawn.units}u ${assigned.good} to ${targetWaypoint}`);
    } catch (err) {
      // Delivery failed this tick (mission already complete, site unreachable,
      // etc). The cargo stays in the hold; clearLeftoverCargo sweeps it to
      // market next tick if it keeps failing, rather than stranding it.
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`supply to ${targetWaypoint} failed: ${msg}`);
    }
    return true;
  }

  /** One trade cycle: ensure prices → dispatch on role → act. */
  async tick(): Promise<boolean> {
    if (this.suspended) {
      this.log("suspended: holding position");
      return false;
    }
    await this.refresh();
    // If manually dispatched, hold at the target until released.
    if (this.manualWaypoint) {
      if (this.ship.nav.waypointSymbol !== this.manualWaypoint || this.ship.nav.status === "IN_TRANSIT") {
        await this.navigateTo(this.manualWaypoint);
        await this.ensureDocked();
      }
      return false;
    }
    this.loadSnapshots();
    const assignedAtTickStart = this.assignedRoute?.();
    // Dead routes are per-tick: a market's price can recover, so forget them
    // once we've had a chance to pick a different route.
    this.deadRoutes.clear();

    const leftoverResult = await this.clearLeftoverCargo();
    if (leftoverResult !== undefined) return leftoverResult;

    if (assignedAtTickStart?.role === "buy") return this.runBuy(assignedAtTickStart);
    if (assignedAtTickStart?.role === "sell") return this.runSell(assignedAtTickStart);
    if (assignedAtTickStart?.role === "haul") return this.runHaul(assignedAtTickStart);
    return this.runArbitrage(assignedAtTickStart);
  }

  /** True when the fleet is halted and this ship must not act. Stopgap until
   *  the greenfield scheduler enforces pause at dispatch (pillar 3). */
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
        if (!made) await sleep(30_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`trader error: ${msg}`);
        // If navigation failed for lack of fuel, we're stranded — the fleet's
        // tender rescue needs this flag to find us.
        if (/fuel/i.test(msg)) this.markStranded();
        await sleep(10_000);
      }
    }
    this.running = false;
  }

  stop(): void {
    this.running = false;
  }

  /** True when the ship can't reach any market (low fuel) and needs a tender. */
  isStranded(): boolean {
    return this.stranded;
  }

  /** Mark the ship stranded so the fleet's fuel-tender rescue can find it. */
  markStranded(): void {
    this.stranded = true;
    this.log("marked stranded (insufficient fuel to reach a market)");
  }

  /** Clear the stranded flag once the ship can move again. */
  clearStranded(): void {
    this.stranded = false;
  }
}
