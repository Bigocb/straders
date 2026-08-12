import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { Store } from "./store.js";

export type Construction = components["schemas"]["Construction"];
export type Ship = components["schemas"]["Ship"];

/** A single required material tracked toward completion. */
export interface MissionMaterial {
  tradeSymbol: string;
  required: number;
  fulfilled: number;
}

export type MissionKind = "SUPPLY_CONSTRUCTION";

/**
 * A task the fleet has committed to: deliver enough of each material to a
 * construction site (e.g. a jump gate) until the site reports complete.
 */
export interface Mission {
  kind: MissionKind;
  targetSystem: string;
  targetWaypoint: string;
  status: "active" | "complete";
  assignedShip?: string;
  materials: MissionMaterial[];
  /** True while the operator has this mission held (no sourcing, no spending). */
  paused?: boolean;
}

interface MissionOptions {
  api: SpaceTradersAPI;
  store?: Store;
  log?: (msg: string) => void;
  onActivity?: (kind: string, detail: string, credits?: number) => void;
  /** Resolve current position/fuel for a ship. */
  getShip?: (symbol: string) => Promise<Ship>;
  /** Estimate fuel between two waypoints. */
  estimatedFuelBetween?: (a: string, b: string) => number;
  /** True if a ship can physically reach the mission target (directly or via refuel stops). */
  canReach?: (shipSymbol: string, targetWaypoint: string) => boolean;
  /** Fly a ship to a waypoint (any system), returning when it arrives/docked. */
  dispatchShip?: (shipSymbol: string, waypointSymbol: string) => Promise<void>;
  /** Pick an idle cargo-capable ship to run this mission. */
  pickCarrier?: (exclude: Set<string>, targetWaypoint?: string) => Promise<string | undefined>;
  /** Suspend/resume a ship's autonomous agent while it works the mission. */
  suspend?: (shipSymbol: string) => void;
  resume?: (shipSymbol: string) => void;
  /** Sources known to sell a trade good, cheapest first: { waypoint, purchasePrice, tradeVolume }. */
  listBuyers?: (tradeSymbol: string) => { waypoint: string; purchasePrice: number; tradeVolume: number }[];
  /** Survey a small batch of unknown markets looking for the good; returns newly found buyers. */
  discoverBuyers?: (tradeSymbol: string) => Promise<{ waypoint: string; purchasePrice: number }[]>;
  /** Credits available to spend on mission supplies. */
  getCredits?: () => Promise<number>;
  /** Sell cargo for a ship (used to free space / top up credits). */
  sellCargo?: (shipSymbol: string, good: string, units: number) => Promise<unknown>;
  jettisonCargo?: (shipSymbol: string, good: string, units: number) => Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Coordinates fleet missions: assigns a carrier ship to a construction site,
 * sources the required materials from known markets, ferries them, and reports
 * progress. One step per call (each coordinator tick), never blocking on transit.
 */
export class MissionManager {
  private readonly api: SpaceTradersAPI;
  private readonly store?: Store;
  private readonly log: (msg: string) => void;
  private readonly onActivity: MissionOptions["onActivity"];
  private readonly getShip?: MissionOptions["getShip"];
  private readonly estimatedFuelBetween?: MissionOptions["estimatedFuelBetween"];
  private readonly canReach?: MissionOptions["canReach"];
  private readonly dispatchShip?: MissionOptions["dispatchShip"];
  private readonly pickCarrier?: MissionOptions["pickCarrier"];
  private readonly suspend?: MissionOptions["suspend"];
  private readonly resume?: MissionOptions["resume"];
  private readonly listBuyers?: MissionOptions["listBuyers"];
  private readonly discoverBuyers?: MissionOptions["discoverBuyers"];
  private readonly getCredits?: MissionOptions["getCredits"];
  private readonly sellCargo?: MissionOptions["sellCargo"];
  private readonly jettisonCargo?: MissionOptions["jettisonCargo"];

  private active = new Map<string, Mission>();
  /** Per-mission transient state (not persisted): what the carrier is doing right now. */
  private tasks = new Map<string, TaskState>();
  /** Waypoints whose missions are paused (no sourcing/spending until resumed). */
  private paused = new Set<string>();

  constructor(opts: MissionOptions) {
    this.api = opts.api;
    this.store = opts.store;
    this.log = opts.log ?? ((m) => console.log(`[mission] ${m}`));
    this.onActivity = opts.onActivity;
    this.getShip = opts.getShip;
    this.estimatedFuelBetween = opts.estimatedFuelBetween;
    this.canReach = opts.canReach;
    this.dispatchShip = opts.dispatchShip;
    this.pickCarrier = opts.pickCarrier;
    this.suspend = opts.suspend;
    this.resume = opts.resume;
    this.listBuyers = opts.listBuyers;
    this.discoverBuyers = opts.discoverBuyers;
    this.getCredits = opts.getCredits;
    this.sellCargo = opts.sellCargo;
    this.jettisonCargo = opts.jettisonCargo;
  }

  /** Register a mission to build/complete a construction site. */
  async startConstruction(waypointSymbol: string, materials?: MissionMaterial[]): Promise<void> {
    const system = waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-"));
    if (this.active.has(waypointSymbol)) return;
    const persisted = this.store?.latestMissions().find((m) => m.targetWaypoint === waypointSymbol && m.status === "active");
    if (persisted) {
      // Resume an interrupted mission from persistent state.
      const mission: Mission = { kind: "SUPPLY_CONSTRUCTION", targetSystem: system, targetWaypoint: waypointSymbol, status: "active", materials: persisted.materials, assignedShip: persisted.assignedShip ?? undefined };
      this.active.set(waypointSymbol, mission);
      if (persisted.paused) {
        // Stay paused across restarts — don't re-suspend the carrier or start sourcing.
        this.paused.add(waypointSymbol);
        this.log(`mission resumed (from prior state, PAUSED): supply ${waypointSymbol}`);
        return;
      }
      this.tasks.set(waypointSymbol, { step: "source", currentMaterial: undefined, market: undefined, retryAt: 0 });
      if (mission.assignedShip) this.suspend?.(mission.assignedShip);
      this.log(`mission resumed (from prior state): supply ${waypointSymbol}`);
      return;
    }
    let mats = materials;
    if (!mats) {
      const c = await this.api.getConstruction(system, waypointSymbol);
      mats = c.materials.map((m) => ({ tradeSymbol: m.tradeSymbol, required: m.required, fulfilled: m.fulfilled }));
      if (c.isComplete) {
        this.log(`construction ${waypointSymbol} already complete`);
        this.store?.completeMission(waypointSymbol);
        return;
      }
    }
    const mission: Mission = { kind: "SUPPLY_CONSTRUCTION", targetSystem: system, targetWaypoint: waypointSymbol, status: "active", materials: mats };
    this.active.set(waypointSymbol, mission);
    this.tasks.set(waypointSymbol, { step: "source", currentMaterial: undefined, market: undefined, retryAt: 0 });
    this.persist(mission);
    this.log(`mission started: supply ${waypointSymbol} (${mats.map((m) => `${m.tradeSymbol} ${m.fulfilled}/${m.required}`).join(", ")})`);
    this.onActivity?.("mission", `mission started: supply ${waypointSymbol}`, 0);
  }

  /** Full list of known missions, newest first. */
  list(): Mission[] {
    const persisted: Mission[] = (this.store?.latestMissions() ?? []).map((m) => ({
      kind: m.kind,
      targetSystem: m.targetSystem,
      targetWaypoint: m.targetWaypoint,
      status: m.status,
      assignedShip: m.assignedShip ?? undefined,
      materials: m.materials,
    }));
    // Paused is live state, not something the persisted row can be trusted for
    // — the operator can pause and resume between writes. The UI needs it to
    // know which button to offer.
    return [...this.active.values(), ...persisted.filter((p) => !this.active.has(p.targetWaypoint))]
      .map((m) => ({ ...m, paused: this.paused.has(m.targetWaypoint) }));
  }

  /** Are any ships currently committed to missions? (fleet should not reassign them) */
  committedShips(): Set<string> {
    const out = new Set<string>();
    for (const m of this.active.values()) if (m.assignedShip) out.add(m.assignedShip);
    return out;
  }

  /**
   * Trade symbols still needed by any active mission (not yet fully supplied).
   * The fleet must never sell, jettison, or arbitrage these — they are reserved
   * for the construction site.
   */
  protectedGoods(): Set<string> {
    const out = new Set<string>();
    for (const m of this.active.values()) {
      for (const mat of m.materials) {
        if (mat.fulfilled < mat.required) out.add(mat.tradeSymbol);
      }
    }
    return out;
  }

  /** Advance every active mission by one step. Call once per coordinator tick. */
  async tick(): Promise<void> {
    for (const mission of [...this.active.values()]) {
      if (this.paused.has(mission.targetWaypoint)) {
        // Paused missions don't source/spend, but still reconcile their progress
        // against the live construction site so the dashboard shows real numbers.
        await this.reconcile(mission);
        continue;
      }
      try {
        await this.step(mission);
      } catch (err) {
        this.log(`mission ${mission.targetWaypoint} step error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Refresh a mission's fulfilled counts from the authoritative construction state. */
  private async reconcile(mission: Mission): Promise<void> {
    try {
      const c = await this.api.getConstruction(mission.targetSystem, mission.targetWaypoint);
      let changed = false;
      for (const m of mission.materials) {
        const live = c.materials.find((x) => x.tradeSymbol === m.tradeSymbol);
        if (live && live.fulfilled !== m.fulfilled) {
          m.fulfilled = live.fulfilled;
          changed = true;
        }
      }
      if (changed) this.persist(mission);
    } catch (err) {
      // ignore: construction may be temporarily unreachable
    }
  }

  /**
   * Manually set (or replace) a mission's carrier, overriding whatever the
   * auto-picker chose. Releases any previous carrier back to autonomy first,
   * and resets in-flight sourcing state — a chosen market or a purchase
   * mid-flight belonged to the old ship, not this one, so the new carrier
   * starts its step loop from scratch.
   */
  assignCarrier(waypointSymbol: string, shipSymbol: string): void {
    const mission = this.active.get(waypointSymbol);
    if (!mission) throw new Error(`no active mission at ${waypointSymbol}`);
    if (mission.assignedShip === shipSymbol) return;
    if (mission.assignedShip) {
      this.resume?.(mission.assignedShip);
      this.log(`mission ${waypointSymbol}: released ${mission.assignedShip} (reassigned)`);
    }
    mission.assignedShip = shipSymbol;
    this.suspend?.(shipSymbol);
    if (!this.paused.has(waypointSymbol)) {
      this.tasks.set(waypointSymbol, { step: "source", currentMaterial: undefined, market: undefined, retryAt: 0 });
    }
    this.persist(mission);
    this.log(`mission ${waypointSymbol}: carrier manually set to ${shipSymbol}`);
    this.onActivity?.("mission", `${shipSymbol} assigned to ${waypointSymbol} by operator`, 0);
  }

  /** Pause a mission: stop sourcing/spending, release the carrier to autonomy. */
  pause(waypointSymbol: string): void {
    if (!this.active.has(waypointSymbol)) return;
    this.paused.add(waypointSymbol);
    const mission = this.active.get(waypointSymbol)!;
    if (mission.assignedShip) {
      this.resume?.(mission.assignedShip);
      this.log(`mission ${waypointSymbol}: paused, released ${mission.assignedShip}`);
    }
    this.tasks.delete(waypointSymbol);
    this.persist({ ...mission, paused: true });
  }

  /** Resume a paused mission. */
  resumeMission(waypointSymbol: string): void {
    if (!this.paused.delete(waypointSymbol)) return;
    const mission = this.active.get(waypointSymbol);
    if (mission) {
      this.tasks.set(waypointSymbol, { step: "source", currentMaterial: undefined, market: undefined, retryAt: 0 });
      this.persist({ ...mission, paused: false });
      this.log(`mission ${waypointSymbol}: resumed`);
    }
  }

  /** True if the mission at `waypointSymbol` is paused. */
  isPaused(waypointSymbol: string): boolean {
    return this.paused.has(waypointSymbol);
  }

  /** Advance a single mission one step. */
  private async step(mission: Mission): Promise<void> {
    // Reconcile fulfilled counts against the authoritative construction state.
    const c = await this.api.getConstruction(mission.targetSystem, mission.targetWaypoint);
    for (const m of mission.materials) {
      const live = c.materials.find((x) => x.tradeSymbol === m.tradeSymbol);
      if (live) m.fulfilled = live.fulfilled;
    }
    if (c.isComplete || mission.materials.every((m) => m.fulfilled >= m.required)) {
      mission.status = "complete";
      this.releaseCarrier(mission);
      this.store?.completeMission(mission.targetWaypoint);
      this.log(`MISSION COMPLETE: ${mission.targetWaypoint}`);
      this.onActivity?.("mission", `mission complete: ${mission.targetWaypoint}`, 0);
      return;
    }

    const t = this.tasks.get(mission.targetWaypoint);
    if (!t) return;
    // Back off if we hit a rate limit / error recently.
    if (t.retryAt > Date.now()) return;
    // Assign a carrier only once we know there's real work to do (a market that
    // sells a needed material). Otherwise the mission surveys markets while every
    // ship keeps producing — a blocked mission must never idle a miner.
    if (!mission.assignedShip) {
      const buyers = this.listBuyers?.(mission.materials.find((m) => m.fulfilled < m.required)?.tradeSymbol ?? "") ?? [];
      if (buyers.length === 0) {
        await this.maybeDiscover(mission, t);
        return;
      }
      const carrier = await this.pickCarrier?.(this.committedShips(), mission.targetWaypoint);
      if (!carrier) return; // no free ship; retry next tick
      mission.assignedShip = carrier;
      this.suspend?.(carrier);
      this.log(`mission ${mission.targetWaypoint}: assigned carrier ${carrier}`);
      this.persist(mission);
      this.onActivity?.("mission", `assigned ${carrier} to ${mission.targetWaypoint}`, 0);
    }

    await this.stepCarrier(mission, t);
  }

  /** When sourcing is blocked, survey unknown markets for the material before assigning a ship. */
  private async maybeDiscover(mission: Mission, t: TaskState): Promise<void> {
    if (!this.discoverBuyers) return;
    t.retryAt = Date.now() + 15_000;
    const need = mission.materials.find((m) => m.fulfilled < m.required);
    if (!need) return;
    const found = await this.discoverBuyers(need.tradeSymbol);
    if (found.length > 0) {
      this.log(`mission ${mission.targetWaypoint}: discovered sellers of ${need.tradeSymbol}: ${found.map((b) => `${b.waypoint}@${b.purchasePrice}c`).join(", ")}`);
    } else {
      this.log(`mission ${mission.targetWaypoint}: no source found for ${need.tradeSymbol}; still surveying (next in 15s)`);
    }
  }

  /** Drive the carrier ship through the supply loop. */
  private async stepCarrier(mission: Mission, t: TaskState): Promise<void> {
    const ship = await this.getShip?.(mission.assignedShip!);
    if (!ship) return;
    if (ship.nav.status === "IN_TRANSIT") return; // wait for arrival

    // A carrier that cannot reach the target on a full tank — directly, or via
    // refuel stops along the way — can never complete the mission. Release it so
    // a capable ship can be picked instead.
    if (this.canReach && !this.canReach(ship.symbol, mission.targetWaypoint)) {
      this.log(`mission ${mission.targetWaypoint}: ${ship.symbol} cannot reach target (no viable route); releasing`);
      this.releaseCarrier(mission);
      return;
    }
    if (!this.canReach && this.estimatedFuelBetween && ship.fuel.capacity > 0) {
      const need = this.estimatedFuelBetween(ship.nav.waypointSymbol, mission.targetWaypoint);
      if (need > ship.fuel.capacity) {
        this.log(`mission ${mission.targetWaypoint}: ${ship.symbol} cannot reach target (need ${need} fuel, tank ${ship.fuel.capacity}); releasing`);
        this.releaseCarrier(mission);
        return;
      }
    }

    // 1) Choose the next material that still needs units.
    if (!t.currentMaterial) {
      t.currentMaterial = mission.materials.find((m) => m.fulfilled < m.required)?.tradeSymbol;
      if (!t.currentMaterial) return;
      t.market = undefined;
    }
    const need = mission.materials.find((m) => m.tradeSymbol === t.currentMaterial);
    if (!need) { t.currentMaterial = undefined; return; }

    // 2) Pick a source market for that material, if not already chosen.
    if (!t.market) {
      const buyers = this.listBuyers?.(t.currentMaterial) ?? [];
      if (buyers.length === 0) {
        // No buyer known — a carrier should never have been assigned. Back off and re-source.
        t.retryAt = Date.now() + 60_000;
        this.log(`mission ${mission.targetWaypoint}: no market sells ${t.currentMaterial}; pausing 60s`);
        return;
      }
      t.market = buyers[0]!.waypoint;
    }

    const material = t.currentMaterial;
    const market = t.market;

    // 3) Step through the loop: fly to market → buy → fly to site → supply.
    // Priority: if the carrier is holding any material the site still needs, deliver
    // it FIRST — never wander off to source while carrying cargo the site is waiting
    // on (e.g. after a resume mid-transit).
    const cargo = await this.api.getShipCargo(ship.symbol);
    const neededHeld = mission.materials
      .filter((m) => m.fulfilled < m.required)
      .map((m) => ({ mat: m, held: cargo.inventory.find((i) => i.symbol === m.tradeSymbol)?.units ?? 0 }))
      .filter((x) => x.held > 0)
      .sort((a, b) => b.held - a.held)[0];
    if (neededHeld) {
      if (ship.nav.waypointSymbol !== mission.targetWaypoint) {
        await this.dispatchShip?.(ship.symbol, mission.targetWaypoint);
        return;
      }
      if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(ship.symbol);
      const toSupply = Math.min(neededHeld.held, neededHeld.mat.required - neededHeld.mat.fulfilled);
      if (toSupply > 0) {
        await this.api.supplyConstruction(mission.targetSystem, mission.targetWaypoint, ship.symbol, neededHeld.mat.tradeSymbol, toSupply);
        this.log(`mission ${mission.targetWaypoint}: supplied ${toSupply}u ${neededHeld.mat.tradeSymbol}`);
        this.onActivity?.("mission", `${ship.symbol} supplied ${toSupply}u ${neededHeld.mat.tradeSymbol} to ${mission.targetWaypoint}`, 0);
      }
      t.step = "source";
      t.currentMaterial = undefined;
      // Free cargo so the carrier can haul the next batch.
      const freshCargo = await this.api.getShipCargo(ship.symbol);
      if (this.jettisonCargo) {
        for (const item of freshCargo.inventory) {
          if (item.symbol === neededHeld.mat.tradeSymbol || item.symbol === "FUEL") continue;
          if (item.units > 0) await this.jettisonCargo(ship.symbol, item.symbol, item.units);
        }
      }
      return;
    }
    if (ship.nav.waypointSymbol !== market && t.step !== "supply") {
      await this.dispatchShip?.(ship.symbol, market);
      return;
    }
    if (ship.nav.waypointSymbol === market && t.step === "source") {
      if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(ship.symbol);
      const toBuy = Math.min(need.required - need.fulfilled, ship.cargo.capacity - ship.cargo.units);
      if (toBuy > 0) {
        const credits = (await this.getCredits?.()) ?? 0;
        const buyer = this.listBuyers?.(material)?.find((b) => b.waypoint === market);
        const price = buyer?.purchasePrice ?? 0;
        const affordable = price > 0 ? Math.floor(credits / price) : toBuy;
        // Respect the market's per-transaction trade volume limit (e.g. FAB_MATS
        // caps at 20u/tx) — buying more than that fails the whole purchase.
        const volumeCap = buyer?.tradeVolume && buyer.tradeVolume > 0 ? buyer.tradeVolume : toBuy;
        const units = Math.max(1, Math.min(toBuy, affordable, volumeCap));
        try {
          await this.api.purchaseCargo(ship.symbol, material, units);
          this.log(`mission ${mission.targetWaypoint}: ${ship.symbol} bought ${units}u ${material} @ ${price}c at ${market}`);
        } catch (err) {
          // Market may not actually stock it (stale intel); re-source next tick.
          t.retryAt = Date.now() + 15_000;
          this.log(`mission ${mission.targetWaypoint}: buy ${material} failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }
      t.step = "supply";
    }
    if (t.step === "supply") {
      if (ship.nav.waypointSymbol !== mission.targetWaypoint) {
        await this.dispatchShip?.(ship.symbol, mission.targetWaypoint);
        return;
      }
      const cargo = await this.api.getShipCargo(ship.symbol);
      const held = cargo.inventory.find((i) => i.symbol === material)?.units ?? 0;
      const toSupply = Math.min(held, need.required - need.fulfilled);
      if (toSupply > 0) {
        if (ship.nav.status === "IN_ORBIT") await this.api.dockShip(ship.symbol);
        await this.api.supplyConstruction(mission.targetSystem, mission.targetWaypoint, ship.symbol, material, toSupply);
        this.log(`mission ${mission.targetWaypoint}: supplied ${toSupply}u ${material}`);
        this.onActivity?.("mission", `${ship.symbol} supplied ${toSupply}u ${material} to ${mission.targetWaypoint}`, 0);
      }
      t.step = "source";
      t.currentMaterial = undefined; // move to next material (or end)
      // Free cargo for the next material so the carrier can keep working.
      if (this.jettisonCargo) {
        for (const item of cargo.inventory) {
          if (item.symbol === material || item.symbol === "FUEL") continue;
          if (item.units > 0) await this.jettisonCargo(ship.symbol, item.symbol, item.units);
        }
      }
    }
  }

  /** Restore a carrier to autonomous control once the mission ends. */
  private releaseCarrier(mission: Mission): void {
    if (mission.assignedShip) {
      this.resume?.(mission.assignedShip);
      this.log(`mission ${mission.targetWaypoint}: released ${mission.assignedShip}`);
    }
    this.tasks.delete(mission.targetWaypoint);
    this.active.delete(mission.targetWaypoint);
  }

  private persist(m: Mission & { paused?: boolean }): void {
    this.store?.recordMission({
      kind: m.kind,
      targetSystem: m.targetSystem,
      targetWaypoint: m.targetWaypoint,
      status: m.status,
      assignedShip: m.assignedShip,
      materials: m.materials,
      paused: m.paused,
    });
  }
}

interface TaskState {
  step: "source" | "supply";
  currentMaterial?: string;
  market?: string;
  retryAt: number;
}
