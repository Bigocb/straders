export interface DispatchRoute {
  good: string;
  buyAt: string;
  buySystem: string;
  buyPrice: number;
  sellAt: string;
  sellSystem: string;
  sellPrice: number;
  volume: number;
  distance: number;
  fuelUnits: number;
  fuelCost: number;
  profitPerTrip: number;
  ageMinutes: number;
}

/**
 * "direct" — buy here, carry it yourself, sell there. One trader owns the
 *            whole round trip; this is every assignment before warehousing.
 * "buy"    — buy here, deposit into the warehouse. No sell leg of its own.
 * "sell"   — withdraw from the warehouse, sell there. No buy leg of its own.
 * "haul"   — withdraw from the warehouse, deliver to a mission/construction
 *            site instead of a market. Not produced yet (tracer 6).
 */
export type TraderRole = "direct" | "buy" | "sell" | "haul";

export interface TraderAssignment {
  shipSymbol: string;
  good: string;
  role: TraderRole;
  /** Populated for "direct"/"buy"/"haul"; absent for a pure "sell". */
  buyAt?: string;
  /** Populated for "direct"/"sell"/"haul"; absent for a pure "buy". */
  sellAt?: string;
  buyPrice?: number;
  sellPrice?: number;
  profitPerTrip: number;
  /** "auto" (allocated) or "manual" (operator override). */
  source: "auto" | "manual";
  /** True only for a "buy" assignment sourced to feed an active mission's
   *  outstanding demand — exempts it from the trader's protectedGoods
   *  block, which otherwise refuses to buy a mission-reserved good. */
  missionBuy?: boolean;
}

/** A good's warehouse state, as input to deciding whether it needs a buy or
 *  sell trader this cycle. Supplied by the caller (fleet.ts) — the
 *  dispatcher doesn't read the store directly. */
export interface WarehouseTarget {
  good: string;
  /** Desired units to hold. */
  target: number;
  /** Units currently held. */
  balance: number;
}

/** A mission material the warehouse already holds stock of, as input to
 *  deciding whether it needs a haul trader this cycle. Supplied by the
 *  caller (fleet.ts), which cross-references MissionManager's outstanding
 *  requirements against the warehouse balance — the dispatcher only sees
 *  the result, not either source directly. */
export interface HaulTarget {
  good: string;
  /** The construction site waiting on this material. */
  targetWaypoint: string;
  /** Units the mission still needs. */
  needed: number;
  /** Units currently held in the warehouse. */
  balance: number;
}

/** A good flagged "buy for mission" on the curated warehouse list, with an
 *  active mission currently short of it. Unlike WarehouseTarget this isn't
 *  driven by a flat operator-set target — the target IS the mission's
 *  outstanding need, and there's usually no profitable resale route to
 *  derive buyAt/buyPrice from, so the caller (fleet.ts) sources them from
 *  the cheapest known market instead. */
export interface MissionBuyTarget {
  good: string;
  buyAt: string;
  buyPrice: number;
  /** Units the mission still needs. */
  needed: number;
  /** Units currently held in the warehouse. */
  balance: number;
}

/**
 * Centralized route dispatcher. The fleet's traders previously each picked their
 * own best route independently, which meant several traders could converge on
 * the same good (and saturate a single market, driving prices up and margins
 * down). This dispatcher computes every profitable route once and hands each
 * trader a DISTINCT assignment, so no two traders run the same good at once.
 *
 * The operator can override any trader's assignment from the UI; manual
 * overrides are respected until the operator clears them.
 *
 * This is deliberately the coordinator for warehousing later: once we hold
 * inventory, the dispatcher is where we decide "who hauls what, from where".
 */
export class RouteDispatcher {
  private assignments = new Map<string, TraderAssignment>();
  private manual = new Map<string, TraderAssignment>();
  /** The ranked route list from the last recompute, used to serve live claims. */
  private routes: DispatchRoute[] = [];
  private lastComputed = 0;

  /** Routes a single trader should fly, honoring a manual override if set. */
  assignmentFor(shipSymbol: string): TraderAssignment | undefined {
    return this.manual.get(shipSymbol) ?? this.assignments.get(shipSymbol);
  }

  list(): TraderAssignment[] {
    const ships = new Set([...this.assignments.keys(), ...this.manual.keys()]);
    const out: TraderAssignment[] = [];
    for (const s of ships) {
      const a = this.manual.get(s) ?? this.assignments.get(s);
      if (a) out.push(a);
    }
    return out;
  }

  /** Assign a specific route to a trader. Pass undefined to clear an override. */
  setManual(shipSymbol: string, assignment: TraderAssignment | undefined): void {
    if (assignment) {
      this.manual.set(shipSymbol, { ...assignment, source: "manual" });
    } else {
      this.manual.delete(shipSymbol);
    }
  }

  isManual(shipSymbol: string): boolean {
    return this.manual.has(shipSymbol);
  }

  /** The ranked routes the dispatcher is currently allocating from. */
  routeList(): DispatchRoute[] {
    return this.routes;
  }

  private toAssignment(shipSymbol: string, route: DispatchRoute): TraderAssignment {
    return {
      shipSymbol,
      good: route.good,
      role: "direct",
      buyAt: route.buyAt,
      sellAt: route.sellAt,
      buyPrice: route.buyPrice,
      sellPrice: route.sellPrice,
      profitPerTrip: route.profitPerTrip,
      source: "auto",
    };
  }

  /** `route` only needs to look like a buy leg — a full DispatchRoute
   *  qualifies, but so does a synthetic one built from the cheapest known
   *  market for a mission-buy good that has no profitable resale route at all. */
  private toBuyAssignment(
    shipSymbol: string,
    route: { good: string; buyAt: string; buyPrice: number; profitPerTrip: number },
    missionBuy = false,
  ): TraderAssignment {
    return {
      shipSymbol,
      good: route.good,
      role: "buy",
      buyAt: route.buyAt,
      buyPrice: route.buyPrice,
      profitPerTrip: route.profitPerTrip,
      source: "auto",
      ...(missionBuy ? { missionBuy: true } : {}),
    };
  }

  private toSellAssignment(shipSymbol: string, route: DispatchRoute): TraderAssignment {
    return {
      shipSymbol,
      good: route.good,
      role: "sell",
      sellAt: route.sellAt,
      sellPrice: route.sellPrice,
      profitPerTrip: route.profitPerTrip,
      source: "auto",
    };
  }

  /** `sellAt` is repurposed as "delivery destination" for a haul assignment —
   *  a construction site rather than a market — so TraderAgent's rendezvous
   *  step (fly to warehouse, withdraw, fly to `sellAt`) needs no role-specific
   *  field of its own. */
  private toHaulAssignment(shipSymbol: string, good: string, targetWaypoint: string, priority: number): TraderAssignment {
    return {
      shipSymbol,
      good,
      role: "haul",
      sellAt: targetWaypoint,
      profitPerTrip: priority,
      source: "auto",
    };
  }

  /** Goods spoken for by someone other than `shipSymbol`. */
  private takenGoods(shipSymbol?: string): Set<string> {
    const taken = new Set<string>();
    for (const [s, a] of this.assignments) if (s !== shipSymbol) taken.add(a.good);
    for (const [s, a] of this.manual) if (s !== shipSymbol) taken.add(a.good);
    return taken;
  }

  /**
   * Take the best unclaimed route for a trader, right now.
   *
   * This is the fix for route convergence. Previously a trader whose assignment
   * was unviable fell back to picking its own best good from its own price
   * table, and the only thing stopping two traders from picking the same good
   * was a reservation set derived from cargo already in holds — a lagging
   * signal, so two traders inside their own `findRoute` at the same time could
   * (and did) both take the same good. Claiming goes through here instead:
   * the whole select-and-record is one synchronous call, so no other trader's
   * loop can interleave between "is it free?" and "it's mine".
   *
   * `accept` lets the caller reject a route it can't actually fly (unknown
   * market, no margin at its own prices) without giving up the claim attempt —
   * the next-best route is tried in the same synchronous pass.
   */
  claim(shipSymbol: string, accept?: (route: DispatchRoute) => boolean): TraderAssignment | undefined {
    const manual = this.manual.get(shipSymbol);
    if (manual) return manual;
    const taken = this.takenGoods(shipSymbol);
    const route = this.routes.find((r) => !taken.has(r.good) && (accept ? accept(r) : true));
    if (!route) {
      // Nothing left to fly: drop the stale assignment so the good is freed for
      // a fleetmate and this trader goes price-hunting instead.
      this.assignments.delete(shipSymbol);
      return undefined;
    }
    const assignment = this.toAssignment(shipSymbol, route);
    this.assignments.set(shipSymbol, assignment);
    return assignment;
  }

  /** Give up a claim (ship scrapped, role changed, route abandoned). */
  release(shipSymbol: string): void {
    this.assignments.delete(shipSymbol);
  }

  /**
   * Recompute assignments from a ranked route list for the given traders.
   * Bigger holds get first pick. Manual overrides are preserved and reserve
   * their good in every role. Throttled to once/minute so the coordinator
   * doesn't churn assignments on every 2s tick.
   *
   * A trader that is `busy` — mid-haul, cargo in the hold — keeps the
   * assignment it is already flying, whatever its role. Reassigning it would
   * strand the cargo it bought for the old route, and the churn meant
   * assignments never settled.
   *
   * `warehouseTargets` is how a good gets split into buy/sell roles instead
   * of one trader running it end to end: pass a good's desired vs. current
   * warehouse balance and, once it's off-target, one trader gets sent to
   * buy into the warehouse (or sell out of it) instead of the direct round
   * trip. A good with no entry here — every good, until a caller actually
   * supplies targets — behaves exactly as before: one trader, direct route,
   * no two traders on the same good. This is what keeps tracer 2 inert: the
   * live coordinator doesn't pass targets yet, so nothing about today's
   * behavior changes until a future tracer wires real ones in.
   *
   * `haulTargets` is the same idea for mission supply: a good the warehouse
   * already holds stock of, that a construction site still needs, gets a
   * "haul" trader instead of sitting in the warehouse unused.
   *
   * `missionBuyTargets` closes the other half of mission supply: a good
   * flagged "buy for mission" with an active mission actually short of it
   * gets a "buy" trader sourced from the cheapest known market — the only
   * "buy" pathway allowed to acquire a good the trader's protectedGoods
   * would otherwise refuse (see TraderAssignment.missionBuy).
   */
  recompute(
    routes: DispatchRoute[],
    traders: { shipSymbol: string; capacity: number; busy?: boolean }[],
    warehouseTargets: WarehouseTarget[] = [],
    haulTargets: HaulTarget[] = [],
    missionBuyTargets: MissionBuyTarget[] = [],
  ): void {
    const now = Date.now();
    // Unconditional throttle. This used to also require a non-empty assignment
    // map, which meant the one case that produces no assignments — no fresh
    // intel, so no routes — recomputed on every 2s tick, running a full
    // window-function scan over the snapshot table each time.
    if (now - this.lastComputed < 60_000) return;
    this.lastComputed = now;
    this.routes = routes;

    const sorted = [...traders].sort((a, b) => b.capacity - a.capacity);
    const usedKeys = new Set<string>();
    const next = new Map<string, TraderAssignment>();

    /** Direct reserves the whole good; buy/sell/haul reserve just their
     *  side, so e.g. a buy trader and a sell trader can hold the same good
     *  at once. */
    const keyFor = (a: { good: string; role: TraderRole }): string =>
      a.role === "buy" || a.role === "sell" || a.role === "haul" ? `${a.good}:${a.role}` : a.good;

    // Reserve every key a manual override could touch — the operator's good
    // is off-limits to auto-assignment in any role, not just the one they set.
    for (const a of this.manual.values()) {
      usedKeys.add(a.good);
      usedKeys.add(`${a.good}:buy`);
      usedKeys.add(`${a.good}:sell`);
      usedKeys.add(`${a.good}:haul`);
    }

    // Carry forward every busy trader's current assignment, whatever its role.
    for (const t of sorted) {
      if (!t.busy || this.manual.has(t.shipSymbol)) continue;
      const current = this.assignments.get(t.shipSymbol);
      if (!current) continue;
      const key = keyFor(current);
      if (usedKeys.has(key)) continue;
      usedKeys.add(key);
      next.set(t.shipSymbol, current);
    }

    // Build this cycle's work list: one item per good with no warehouse
    // target (direct — today's only case), and one per targeted good that's
    // currently off-target (buy if under, sell if over; a good sitting right
    // at target needs nobody). Routes arrive pre-ranked by profit per trip,
    // so keeping only the first (best) route per good and re-sorting the
    // combined list preserves "most valuable opportunity first" across both
    // kinds of work.
    const targetsByGood = new Map(warehouseTargets.map((t) => [t.good, t]));
    const seenGood = new Set<string>();
    const work: { key: string; make: (shipSymbol: string) => TraderAssignment; profitPerTrip: number }[] = [];
    for (const route of routes) {
      if (seenGood.has(route.good)) continue;
      seenGood.add(route.good);
      const target = targetsByGood.get(route.good);
      if (!target) {
        work.push({ key: route.good, make: (s) => this.toAssignment(s, route), profitPerTrip: route.profitPerTrip });
      } else if (target.balance < target.target) {
        work.push({ key: `${route.good}:buy`, make: (s) => this.toBuyAssignment(s, route), profitPerTrip: route.profitPerTrip });
      } else if (target.balance > target.target) {
        work.push({ key: `${route.good}:sell`, make: (s) => this.toSellAssignment(s, route), profitPerTrip: route.profitPerTrip });
      }
      // balance === target: on target, no trader needed for it this cycle.
    }
    // Haul work is independent of the routes list — it's driven entirely by
    // what the warehouse already holds against what a mission still needs.
    // Priority is a simple proxy (bigger deliveries rank higher); it isn't
    // pretending to be a real profit figure the way route-derived items are.
    const seenHaulGood = new Set<string>();
    for (const h of haulTargets) {
      if (seenHaulGood.has(h.good)) continue; // one hauler per good per cycle, even if 2 missions need it
      seenHaulGood.add(h.good);
      const amount = Math.min(h.balance, h.needed);
      if (amount <= 0) continue;
      work.push({ key: `${h.good}:haul`, make: (s) => this.toHaulAssignment(s, h.good, h.targetWaypoint, amount * 50), profitPerTrip: amount * 50 });
    }
    // Mission-buy work shares the same `${good}:buy` key as a curated
    // warehousing buy — deliberately: a good should only ever appear in one
    // of the two lists, but if it somehow ended up in both, they should
    // compete for the one trader slot rather than double-assign it.
    const seenMissionBuyGood = new Set<string>();
    for (const b of missionBuyTargets) {
      if (seenMissionBuyGood.has(b.good)) continue; // one buyer per good per cycle, even if 2 missions need it
      seenMissionBuyGood.add(b.good);
      const shortfall = b.needed - b.balance;
      if (shortfall <= 0) continue; // warehouse already has enough for what's needed
      const priority = shortfall * 50;
      work.push({ key: `${b.good}:buy`, make: (s) => this.toBuyAssignment(s, { good: b.good, buyAt: b.buyAt, buyPrice: b.buyPrice, profitPerTrip: priority }, true), profitPerTrip: priority });
    }
    work.sort((a, b) => b.profitPerTrip - a.profitPerTrip);

    for (const t of sorted) {
      const manual = this.manual.get(t.shipSymbol);
      if (manual) {
        next.set(t.shipSymbol, manual);
        continue;
      }
      if (next.has(t.shipSymbol)) continue;
      const item = work.find((w) => !usedKeys.has(w.key));
      if (!item) continue;
      usedKeys.add(item.key);
      next.set(t.shipSymbol, item.make(t.shipSymbol));
    }
    this.assignments = next;
  }
}
