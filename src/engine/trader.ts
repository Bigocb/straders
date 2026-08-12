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
  /** Trade symbols currently being carried / traded by another ship; avoid these routes to prevent buying competition. */
  reservedGoods?: () => Set<string>;
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
    // Refuel at the current market if we're low and it's a market.
    if (this.ship.fuel.current < this.ship.fuel.capacity * 0.5) {
      const here = this.ship.nav.waypointSymbol;
      if (this.priceTable.get(here)?.has("FUEL")) {
        await this.refuelAt(here);
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
    for (const good of goods) {
      if (protectedGoods.has(good) || reservedGoods.has(good)) continue;
      const buy = this.bestBuy(good);
      const sell = this.bestSell(good);
      if (!buy || !sell) continue;
      if (sell.waypoint === buy.waypoint) continue;
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
    // Clear leftover cargo (e.g. from a prior mission role) so it doesn't block the hold.
    const leftover = (this.ship.cargo.inventory ?? []).filter((i) => i.units > 0);
    if (leftover.length > 0) {
      const route = this.findRoute();
      const routeGood = route?.good;
      const toClear = leftover.filter((i) => i.symbol !== routeGood);
      if (toClear.length > 0) {
        const item = toClear[0]!;
        const sell = this.bestSell(item.symbol);
        if (sell && sell.waypoint !== this.ship.nav.waypointSymbol) {
          await this.navigateTo(sell.waypoint);
          await this.ensureDocked();
        }
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
    }
    const route = this.findRoute();
    if (route) {
      await this.navigateTo(route.buyAt);
      await this.ensureDocked();
      const units = Math.min(route.volume, this.ship.cargo.capacity - this.ship.cargo.units);
      if (units <= 0) return true;
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
          return true;
        }
      }
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

    // No route known yet: tour markets to build the price table.
    const markets = [...new Set(this.priceTable.keys())];
    const known = markets.filter((m) => this.priceTable.get(m)?.size);
    if (known.length < 2) {
      this.log("discovering prices...");
      await this.refuelAt(this.ship.nav.waypointSymbol);
      const candidates = [...this.positions.values()].filter((w) =>
        w.symbol.startsWith("X1-") && !this.priceTable.has(w.symbol),
      );
      const target = candidates[0];
      if (target) {
        await this.observeMarket(target.symbol);
        return true;
      }
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
        this.log(`trader error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(10_000);
      }
    }
    this.running = false;
  }

  stop(): void {
    this.running = false;
  }
}
