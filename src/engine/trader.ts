import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { MarketSnapshot } from "./market.js";
import type { GalaxyAtlas } from "./galaxy.js";

export type Ship = components["schemas"]["Ship"];

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
  /** Centralized dispatch: the specific route this trader is assigned (or undefined to fall back to free choice). */
  assignedRoute?: () => { good: string; buyAt: string; sellAt: string; sellPrice: number } | undefined;
  /** Current credit balance, used to cap purchase volume by affordability. */
  getCredits?: () => number;
  /** Max acceptable loss per unit (percent of cost basis) before refusing to sell. Default 15. */
  maxLossPct?: number;
  /** Minimum per-unit margin for a route to be worth taking. Default 10. */
  marginFloor?: number;
}

export interface WaypointPos {
  symbol: string;
  x: number;
  y: number;
  type?: components["schemas"]["WaypointType"];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  private readonly assignedRoute?: () => { good: string; buyAt: string; sellAt: string; sellPrice: number } | undefined;
  private readonly getCredits?: () => number;
  private readonly maxLossPct: number;
  private readonly marginFloor: number;
  private readonly atlas?: GalaxyAtlas;
  private ship: Ship;
  private positions = new Map<string, WaypointPos>();
  /** Good → price seen at each market. */
  private priceTable = new Map<string, Map<string, { buy: number; sell: number; volume: number }>>();
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
    this.getCredits = opts.getCredits;
    this.maxLossPct = opts.maxLossPct ?? 15;
    this.marginFloor = opts.marginFloor ?? 10;
    this.atlas = opts.atlas;
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
    const table = this.priceTable.get(waypoint) ?? new Map();
    for (const g of m.tradeGoods ?? []) {
      table.set(g.symbol, { buy: g.purchasePrice, sell: g.sellPrice, volume: g.tradeVolume });
    }
    this.priceTable.set(waypoint, table);
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

  /** True when selling at `price` would exceed the allowed loss vs the cost basis. */
  private exceedsLossFloor(good: string, price: number): boolean {
    const cost = this.heldCost.get(good);
    if (cost === undefined || cost <= 0) return false;
    const floor = cost * (1 - this.maxLossPct / 100);
    return price < floor;
  }

  /** Find the most profitable arbitrage opportunity net of travel. */
  private findRoute(): {
    good: string;
    buyAt: string;
    buyPrice: number;
    sellAt: string;
    sellPrice: number;
    margin: number;
    volume: number;
  } | undefined {
    const protectedGoods = this.protectedGoods?.() ?? new Set<string>();
    const reservedGoods = this.reservedGoods?.() ?? new Set<string>();
    const goods = new Set<string>();
    for (const table of this.priceTable.values()) for (const g of table.keys()) goods.add(g);
    let best: ReturnType<typeof this.findRoute> | undefined;

    // Prefer the centralized dispatcher's assigned route for this trader, so two
    // traders never converge on the same good. Only fall back to free choice if
    // the assigned route is unavailable (e.g. its market rotated away).
    const assigned = this.assignedRoute?.();
    if (assigned && goods.has(assigned.good)) {
      const buy = this.bestBuy(assigned.good);
      const sell = this.bestSell(assigned.good);
      if (buy && sell && sell.waypoint !== buy.waypoint && this.systemOf(buy.waypoint) === this.systemOf(sell.waypoint)) {
        const margin = sell.sell - buy.buy;
        if (margin > this.marginFloor && !this.deadRoutes.has(`${assigned.good}@${buy.waypoint}`)) {
          const fuel = this.distBetween(buy.waypoint, sell.waypoint);
          const credits = this.getCredits?.() ?? Infinity;
          const affordable = credits > 0 ? Math.floor(credits / buy.buy) : Infinity;
          const volume = Math.min(buy.volume, sell.volume, this.ship.cargo.capacity, affordable);
          if (volume > 0) {
            const profit = margin * volume - fuel * (this.priceTable.get(buy.waypoint)?.get("FUEL")?.buy ?? 72);
            if (profit > 0) {
              return { good: assigned.good, buyAt: buy.waypoint, buyPrice: buy.buy, sellAt: sell.waypoint, sellPrice: sell.sell, margin, volume };
            }
          }
        }
      }
    }

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

  private routeProfit(r: NonNullable<ReturnType<typeof this.findRoute>>): number {
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

  /** Seed price table from persistent market snapshots. */
  private loadSnapshots(): void {
    const snaps = this.getMarketSnapshots?.() ?? [];
    for (const s of snaps) {
      const table = this.priceTable.get(s.waypointSymbol) ?? new Map();
      table.set(s.goodSymbol, { buy: s.purchasePrice, sell: s.sellPrice, volume: s.tradeVolume });
      this.priceTable.set(s.waypointSymbol, table);
    }
  }

  /** One trade cycle: ensure prices → pick route → buy → fly → sell. */
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
    // Dead routes are per-tick: a market's price can recover, so forget them
    // once we've had a chance to pick a different route.
    this.deadRoutes.clear();
    // Clear leftover cargo (e.g. from a prior mission role) so it doesn't block the hold.
    // Sell ANY held good at its best same-system market — including the current
    // route good. Excluding it let a trader sit at the sell market holding cargo
    // while the route logic kept flying it back to the buy market for more.
    const leftover = (this.ship.cargo.inventory ?? []).filter((i) => i.units > 0);
    if (leftover.length > 0) {
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
      if (this.ship.nav.status === "DOCKED") {
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
    }
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

    // No profitable route right now: tour a market to refresh prices. Stale
    // snapshots are the usual reason a route vanished, so keep the table fresh
    // instead of sleeping and retrying the same dead route forever. Only visit
    // known marketplaces (from snapshots) — an asteroid has no prices to observe.
    // loadSnapshots() already seeds every known market, so rotate through them
    // rather than excluding ones already in the table (which would be all of them).
    const knownMarkets = [...new Set((this.getMarketSnapshots?.() ?? []).map((s) => s.waypointSymbol))];
    const here = this.ship.nav.waypointSymbol;
    const target = knownMarkets.find((m) => m !== here) ?? knownMarkets[0];
    if (target) {
      this.log("discovering prices...");
      // Navigate to the market first, then refuel there — refueling at the
      // current spot fails if it's an asteroid with no fuel market.
      await this.navigateTo(target);
      await this.refuelAt(target);
      await this.observeMarket(target);
      return true;
    }
    return false;
  }

  async runLoop(maxTicks: number): Promise<void> {
    this.running = true;
    let ticks = 0;
    while (this.running && ticks < maxTicks) {
      ticks += 1;
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
