import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { WaypointPos } from "./agent.js";
import type { MarketSnapshot } from "./market.js";

export type Ship = components["schemas"]["Ship"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How often a halted agent re-checks whether the fleet has resumed. */
const HALT_POLL_MS = 1_000;

export interface ScoutOptions {
  api: SpaceTradersAPI;
  /** Logger callback; defaults to console.log. */
  log?: (msg: string) => void;
  /** Optional persistence hook, called for refuel transactions. */
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
  /** Called for notable events (chart, refuel, navigate) for the live feed. */
  onActivity?: (kind: string, detail: string, credits?: number) => void;
  /** Called when the ship docks at a marketplace so prices can be snapshotted. */
  recordMarket?: (waypointSymbol: string) => Promise<void>;
  /** Called with the results of a sensor scan so the fleet can ingest them. */
  onScan?: (res: { systems?: components["schemas"]["ScannedSystem"][]; waypoints?: components["schemas"]["ScannedWaypoint"][] }) => void;
  /** Minimum minutes between sensor scans. 0 disables scanning. */
  scanIntervalMin?: number;
  /** Whether the ship may act right now. False while the fleet is halted. */
  shouldRun?: () => boolean;
}


/**
 * Chart scout: flies between uncharted waypoints and charts them, revealing
 * traits for the whole server and earning a one-time credit reward. Refuels at
 * markets between targets. No cargo, no mining — just navigation + charting.
 */
export class ScoutAgent {
  readonly symbol: string;
  private readonly api: SpaceTradersAPI;
  private readonly log: (msg: string) => void;
  private readonly recordLedger: ScoutOptions["recordLedger"];
  private readonly onActivity: ScoutOptions["onActivity"];
  private readonly recordMarket: ScoutOptions["recordMarket"];
  private readonly onScan: ScoutOptions["onScan"];
  private readonly scanIntervalMs: number;
  private readonly systemSymbol: string;
  private readonly waypointPositions = new Map<string, WaypointPos>();
  private readonly shouldRun?: () => boolean;
  private markets: MarketSnapshot[] = [];
  private readonly charted = new Set<string>();
  private ship: Ship;
  private suspended = false;
  private manualGoal: string | null = null;
  private lastScanAt = 0;
  private scanCooldownUntil = 0;
  private scanSystemsNext = true;
  running = false;

  constructor(ship: Ship, opts: ScoutOptions) {
    this.symbol = ship.symbol;
    this.ship = ship;
    this.api = opts.api;
    this.log = opts.log ?? ((m) => console.log(`[${this.symbol}] ${m}`));
    this.recordLedger = opts.recordLedger;
    this.onActivity = opts.onActivity;
    this.recordMarket = opts.recordMarket;
    this.shouldRun = opts.shouldRun;
    this.onScan = opts.onScan;
    this.scanIntervalMs = (opts.scanIntervalMin ?? 0) * 60_000;
    this.systemSymbol = ship.nav.systemSymbol;
  }

  /** Seed the scout with known waypoint positions and market snapshots. */
  withWorld(positions: WaypointPos[], markets: MarketSnapshot[] = []): this {
    for (const p of positions) this.waypointPositions.set(p.symbol, p);
    this.markets = markets;
    return this;
  }

  /** Seed already-charted waypoints so the scout never visits them again. */
  withCharted(symbols: Iterable<string>): this {
    for (const s of symbols) this.charted.add(s);
    return this;
  }

  getShip(): Ship {
    return this.ship;
  }

  isManual(): boolean {
    return this.manualGoal !== null;
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  suspend(): void {
    this.suspended = true;
  }

  resume(): void {
    this.suspended = false;
  }

  /** One-shot manual dispatch: chart this waypoint, then return to autonomous mode. */
  dispatchTo(waypoint: string): void {
    this.manualGoal = waypoint;
  }

  release(): void {
    this.manualGoal = null;
  }

  private async refresh(): Promise<void> {
    this.ship = await this.api.getShip(this.symbol);
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
      this.log(`cannot navigate to ${waypoint}: need ${need} fuel, have ${this.ship.fuel.current}`);
      return;
    }
    const arrival = await this.api.navigateShip(this.symbol, waypoint);
    this.ship = { ...this.ship, nav: arrival.nav, fuel: arrival.fuel };
    this.onActivity?.("navigate", `→ ${waypoint} (${arrival.fuel.current}/${arrival.fuel.capacity} fuel)`);
    const wait = new Date(arrival.nav.route.arrival).getTime() - Date.now();
    if (wait > 0) {
      this.log(`navigating to ${waypoint}, ETA ${Math.round(wait / 1000)}s`);
      await sleep(wait + 1000);
    }
    await this.refresh();
  }

  private distanceTo(wp: WaypointPos): number {
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    if (!here) return 0;
    return Math.hypot(wp.x - here.x, wp.y - here.y);
  }

  private estimatedFuelTo(waypoint: string): number {
    const here = this.waypointPositions.get(this.ship.nav.waypointSymbol);
    const there = this.waypointPositions.get(waypoint);
    if (!here || !there) return 0;
    return Math.max(1, Math.round(Math.hypot(there.x - here.x, there.y - here.y)));
  }

  private estimatedFuelToBetween(a: string, b: string): number {
    const pa = this.waypointPositions.get(a);
    const pb = this.waypointPositions.get(b);
    if (!pa || !pb) return 0;
    return Math.max(1, Math.round(Math.hypot(pb.x - pa.x, pb.y - pa.y)));
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

  private fuelNeededRoundTrip(target: string): number {
    const out = this.estimatedFuelTo(target);
    const market = this.nearestMarketTo(target);
    const back = market ? this.estimatedFuelToBetween(target, market) : out;
    return out + back + 5;
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
      this.onActivity?.("refuel", `${this.symbol} refueled to ${res.fuel.current}/${res.fuel.capacity}`, -res.transaction.totalPrice);
      this.ship = { ...this.ship, fuel: res.fuel };
      return true;
    }
    const nearest = this.nearestReachableMarket();
    if (!nearest) {
      this.log(`low fuel (${this.ship.fuel.current}) and no reachable market`);
      return false;
    }
    this.log(`fuel ${this.ship.fuel.current}, heading to ${nearest} to refuel`);
    await this.navigateTo(nearest);
    return this.refuelIfNeeded(reserve, target);
  }

  /** Nearest uncharted waypoint that can be reached and returned from on one tank, or undefined. */
  private pickChartTarget(): WaypointPos | undefined {
    const candidates = [...this.waypointPositions.values()]
      .filter((w) => !this.charted.has(w.symbol))
      .filter((w) => this.ship.fuel.capacity <= 0 || this.fuelNeededRoundTrip(w.symbol) <= this.ship.fuel.capacity);
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => this.distanceTo(a) - this.distanceTo(b));
    return candidates[0];
  }

  /** Can this scout run sensor scans right now? Needs a mounted array + interval/cooldown window. */
  private canScan(): boolean {
    if (this.scanIntervalMs <= 0) return false;
    if (!this.ship.mounts?.some((m) => m.symbol.startsWith("MOUNT_SENSOR_ARRAY"))) return false;
    if (Date.now() < this.scanCooldownUntil) return false;
    return Date.now() - this.lastScanAt >= this.scanIntervalMs;
  }

  /** Run one sensor scan pass (alternating systems/waypoints) and hand results to the fleet. */
  private async sensorScan(): Promise<void> {
    await this.ensureInOrbit();
    const coverCooldown = (res: { cooldown: { expiration?: string } }): void => {
      this.scanCooldownUntil = res.cooldown.expiration ? new Date(res.cooldown.expiration).getTime() + 1_000 : Date.now() + 60_000;
    };
    if (this.scanSystemsNext) {
      const res = await this.api.scanSystems(this.symbol);
      coverCooldown(res);
      this.onScan?.({ systems: res.systems });
      this.log(`sensor scan: revealed ${res.systems.length} systems`);
      this.onActivity?.("scan", `sensor scan revealed ${res.systems.length} systems`);
    } else {
      const res = await this.api.scanWaypoints(this.symbol);
      coverCooldown(res);
      this.onScan?.({ waypoints: res.waypoints });
      this.log(`sensor scan: revealed ${res.waypoints.length} waypoints`);
      this.onActivity?.("scan", `sensor scan revealed ${res.waypoints.length} waypoints`);
    }
    this.scanSystemsNext = !this.scanSystemsNext;
    this.lastScanAt = Date.now();
  }

  /** One scout pass: chart the nearest uncharted waypoint. Returns true if a chart was attempted. */
  async tick(): Promise<boolean> {
    if (this.suspended) {
      this.log("scout: suspended, holding");
      return false;
    }
    await this.refresh();
    const target = this.manualGoal ?? this.pickChartTarget()?.symbol;
    if (!target) {
      if (await this.canScan()) {
        try {
          await this.sensorScan();
          return true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(`sensor scan failed: ${msg}`);
          this.scanCooldownUntil = Date.now() + 60_000;
          return false;
        }
      }
      this.log("scout: no uncharted waypoints to chart");
      return false;
    }
    await this.refuelIfNeeded(5, target);
    await this.navigateTo(target);
    await this.ensureInOrbit();
    try {
      const res = await this.api.chartShip(this.symbol);
      this.charted.add(target);
      const traits = (res.waypoint.traits ?? []).map((t) => t.symbol).join(", ");
      this.log(`charted ${target} (${res.waypoint.type})${traits ? `: ${traits}` : ""}`);
      this.onActivity?.("chart", `charted ${target}${traits ? `: ${traits}` : ""}`);
      if (this.manualGoal === target) this.manualGoal = null;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already charted/i.test(msg)) {
        this.log(`scout: ${target} already charted, skipping`);
      } else {
        this.log(`chart failed at ${target}: ${msg}`);
      }
      this.charted.add(target); // never retry a known-charted/failed target
      if (this.manualGoal === target) this.manualGoal = null;
      return false;
    }
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
        if (!made) {
          await sleep(30_000);
        }
      } catch (err) {
        this.log(`scout error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(10_000);
      }
    }
    this.running = false;
  }

  stop(): void {
    this.running = false;
  }
}
