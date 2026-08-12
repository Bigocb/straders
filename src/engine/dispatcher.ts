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

  /**
   * Recompute distinct assignments from a ranked route list for the given
   * traders. Bigger holds get first pick; no two traders share a good. Manual
   * overrides are preserved and their goods reserved. Throttled to once/minute
   * so the coordinator doesn't churn assignments on every 2s tick.
   */
  recompute(routes: DispatchRoute[], traders: { shipSymbol: string; capacity: number }[]): void {
    const now = Date.now();
    if (now - this.lastComputed < 60_000 && this.assignments.size > 0) return;
    this.lastComputed = now;

    const sorted = [...traders].sort((a, b) => b.capacity - a.capacity);
    const usedGoods = new Set<string>();
    const next = new Map<string, TraderAssignment>();

    // Reserve goods held by manual overrides first.
    for (const a of this.manual.values()) usedGoods.add(a.good);

    for (const t of sorted) {
      const manual = this.manual.get(t.shipSymbol);
      if (manual) {
        next.set(t.shipSymbol, manual);
        continue;
      }
      const route = routes.find((r) => !usedGoods.has(r.good));
      if (!route) continue;
      usedGoods.add(route.good);
      next.set(t.shipSymbol, {
        shipSymbol: t.shipSymbol,
        good: route.good,
        buyAt: route.buyAt,
        sellAt: route.sellAt,
        buyPrice: route.buyPrice,
        sellPrice: route.sellPrice,
        profitPerTrip: route.profitPerTrip,
        source: "auto",
      });
    }
    this.assignments = next;
  }
}
