/**
 * Bridge triage: the queue of situations a human might beat the engine's
 * default on, ranked by cost of inaction. Extracted as a pure function (out
 * of the /api/bridge route handler) so the ranking and the "who counts as
 * idle" rule are unit-testable without a running server or database.
 */

export interface ShipStatusLike {
  symbol: string;
  role: string;
}

export interface StrandedLike {
  symbol: string;
  waypointSymbol: string;
  reason?: string;
}

export interface EarningLike {
  shipSymbol: string;
  net: number;
}

export interface ContractLike {
  id: string;
  terms?: {
    deadline?: string;
    payment?: { onFulfilled?: number };
    deliver?: { tradeSymbol: string; unitsRequired: number; unitsFulfilled: number }[];
  };
}

export interface TriageItem {
  id: string;
  severity: 1 | 2 | 3;
  title: string;
  detail: string;
  costPerHour: number;
  shipSymbol?: string;
  engineWillAct: string | null;
  actions: { label: string; kind: string; body?: Record<string, unknown> }[];
}

/**
 * Roles that earn nothing by design — they generate surveys or refresh
 * market/shipyard intel for the rest of the fleet rather than booking
 * credits themselves. Flagging one as "earning nothing" would be noise, not
 * a real triage item.
 */
export const SUPPORT_ROLES: ReadonlySet<string> = new Set(["surveyor", "tour", "keeper"]);

export function buildTriage(input: {
  ships: ShipStatusLike[];
  stranded: StrandedLike[];
  /** Net credits in the current (short) window — used to decide who's idle. */
  earnings: EarningLike[];
  /**
   * Net credits in a longer, prior window (e.g. 24h), used to estimate what
   * an idle ship would normally be making. This MUST be a different window
   * than `earnings`: a ship idle for the current window has 0 net in that
   * window by definition, so estimating its own rate from the same data it
   * was flagged idle by is circular — every idle ship would collapse to the
   * same fleet-wide fallback number. Optional; falls back to `earnings` for
   * callers (tests, mainly) that don't have a longer baseline handy.
   */
  historicalRates?: EarningLike[];
  contracts: ContractLike[];
  /** Injectable for tests; defaults to the real clock. */
  now?: number;
}): { triage: TriageItem[]; forgone: number } {
  const now = input.now ?? Date.now();
  const roleOf = new Map(input.ships.map((s) => [s.symbol, s.role]));
  const rateSource = input.historicalRates ?? input.earnings;

  // Opportunity cost is estimated per ship, preferring specific evidence over
  // general: (1) the ship's own historical rate, (2) the median rate of ships
  // sharing its role — a trader and a surveyor should never be priced the
  // same — (3) the fleet-wide median, (4) a flat fallback if nothing earned
  // anything yet.
  const ownRate = new Map(rateSource.filter((s) => s.net > 0).map((s) => [s.shipSymbol, s.net]));
  const byRole = new Map<string, number[]>();
  for (const s of rateSource) {
    if (s.net <= 0) continue;
    const role = roleOf.get(s.shipSymbol);
    if (!role) continue;
    (byRole.get(role) ?? byRole.set(role, []).get(role)!).push(s.net);
  }
  const median = (nums: number[]) => {
    const sorted = [...nums].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  };
  const roleMedian = new Map([...byRole.entries()].map(([role, nums]) => [role, median(nums)]));
  const fleetMedian = median([...ownRate.values()]);

  const estimateCost = (symbol: string, role?: string): number => {
    const own = ownRate.get(symbol);
    if (own) return own;
    const forRole = role ? roleMedian.get(role) : undefined;
    if (forRole) return forRole;
    return fleetMedian || 500;
  };

  const earningSymbols = new Set(input.earnings.filter((s) => s.net > 0).map((s) => s.shipSymbol));
  const strandedSymbols = new Set(input.stranded.map((s) => s.symbol));
  const idle = input.ships.filter(
    (s) => !earningSymbols.has(s.symbol) && !strandedSymbols.has(s.symbol) && !SUPPORT_ROLES.has(s.role),
  );

  const triage: TriageItem[] = [];

  for (const s of input.stranded) {
    triage.push({
      id: `stranded:${s.symbol}`,
      severity: 1,
      title: `${s.symbol} stranded`,
      detail: s.reason ?? `No fuel at ${s.waypointSymbol}.`,
      costPerHour: -Math.round(estimateCost(s.symbol, roleOf.get(s.symbol))),
      shipSymbol: s.symbol,
      engineWillAct: "Fuel tender dispatches automatically",
      actions: [
        { label: "Refuel now", kind: "refuel", body: { shipSymbol: s.symbol } },
        { label: "Take manual control", kind: "hold", body: { shipSymbol: s.symbol } },
      ],
    });
  }

  for (const s of idle) {
    triage.push({
      id: `idle:${s.symbol}`,
      severity: s.role === "idle" ? 2 : 3,
      title: `${s.symbol} earning nothing`,
      detail: s.role === "idle"
        ? "No role assigned — this hull has no cargo hold and no mining mount."
        : `Assigned as ${s.role} but has not booked a credit in the last hour.`,
      costPerHour: -Math.round(estimateCost(s.symbol, s.role)),
      shipSymbol: s.symbol,
      engineWillAct: s.role === "idle" ? null : "Engine will re-plan on its next tick",
      actions: [{ label: "Ship details", kind: "details", body: { shipSymbol: s.symbol } }],
    });
  }

  for (const c of input.contracts) {
    const deliver = c.terms?.deliver?.[0];
    if (!deliver) continue;
    const left = deliver.unitsRequired - deliver.unitsFulfilled;
    if (left <= 0) continue;
    if (!c.terms?.deadline) continue;
    const hours = (new Date(c.terms.deadline).getTime() - now) / 3600_000;
    if (hours > 12 || hours < 0) continue;
    triage.push({
      id: `contract:${c.id}`,
      severity: hours < 4 ? 1 : 2,
      title: "Contract deadline approaching",
      detail: `${deliver.tradeSymbol} ${deliver.unitsFulfilled}/${deliver.unitsRequired} with ${hours.toFixed(1)}h left.`,
      costPerHour: -Math.round((c.terms.payment?.onFulfilled ?? 0) / Math.max(1, hours)),
      engineWillAct: "Contract pipeline delivers when a carrier has the goods",
      actions: [],
    });
  }

  triage.sort((a, b) => a.severity - b.severity || a.costPerHour - b.costPerHour);
  const forgone = triage.reduce((sum, t) => sum + t.costPerHour, 0);
  return { triage, forgone };
}
