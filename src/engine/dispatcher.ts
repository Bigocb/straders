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

export interface TraderAssignment {
  shipSymbol: string;
  good: string;
  buyAt: string;
  sellAt: string;
  buyPrice: number;
  sellPrice: number;
  profitPerTrip: number;
  /** "auto" (allocated) or "manual" (operator override). */
  source: "auto" | "manual";
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
      buyAt: route.buyAt,
      sellAt: route.sellAt,
      buyPrice: route.buyPrice,
      sellPrice: route.sellPrice,
      profitPerTrip: route.profitPerTrip,
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
   * Recompute distinct assignments from a ranked route list for the given
   * traders. Bigger holds get first pick; no two traders share a good. Manual
   * overrides are preserved and their goods reserved. Throttled to once/minute
   * so the coordinator doesn't churn assignments on every 2s tick.
   *
   * A trader that is `busy` — mid-haul, cargo in the hold — keeps the
   * assignment it is already flying. Reassigning it would strand the cargo it
   * bought for the old route, and the churn meant assignments never settled.
   */
  recompute(
    routes: DispatchRoute[],
    traders: { shipSymbol: string; capacity: number; busy?: boolean }[],
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
    const usedGoods = new Set<string>();
    const next = new Map<string, TraderAssignment>();

    // Reserve goods held by manual overrides first.
    for (const a of this.manual.values()) usedGoods.add(a.good);

    // Then carry forward every busy trader's current route, so a ship holding
    // cargo keeps the assignment it bought that cargo for.
    for (const t of sorted) {
      if (!t.busy || this.manual.has(t.shipSymbol)) continue;
      const current = this.assignments.get(t.shipSymbol);
      if (!current || usedGoods.has(current.good)) continue;
      usedGoods.add(current.good);
      next.set(t.shipSymbol, current);
    }

    for (const t of sorted) {
      const manual = this.manual.get(t.shipSymbol);
      if (manual) {
        next.set(t.shipSymbol, manual);
        continue;
      }
      if (next.has(t.shipSymbol)) continue;
      const route = routes.find((r) => !usedGoods.has(r.good));
      if (!route) continue;
      usedGoods.add(route.good);
      next.set(t.shipSymbol, this.toAssignment(t.shipSymbol, route));
    }
    this.assignments = next;
  }
}
