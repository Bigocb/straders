import type { components } from "../core/client.js";

export type Survey = components["schemas"]["Survey"];

const isExpired = (s: Survey): boolean => new Date(s.expiration).getTime() <= Date.now();

/**
 * Shared survey registry keyed by waypoint. Surveys are legal to reuse across
 * ships ("Multiple ships can use the same survey for extraction"), so a
 * dedicated surveyor scout deposits surveys here and the mining fleet consumes
 * them instead of each ship paying for its own surveyor mount.
 */
export class SurveyPool {
  private byWaypoint = new Map<string, Survey[]>();

  /** Store surveys for a waypoint, dropping expired ones. */
  record(waypoint: string, ...surveys: Survey[]): void {
    const existing = this.byWaypoint.get(waypoint) ?? [];
    const fresh = surveys.filter((s) => !isExpired(s));
    if (fresh.length === 0) return;
    this.byWaypoint.set(waypoint, [...existing, ...fresh]);
    this.prune(waypoint);
  }

  /** Best non-expired survey at a waypoint, preferring deposits that refine to a metal. */
  pick(
    waypoint: string,
    prefersRefinable: (depositSymbol: string) => boolean,
  ): Survey | undefined {
    const list = this.byWaypoint.get(waypoint);
    if (!list) return undefined;
    const usable = list.filter((s) => !isExpired(s));
    if (usable.length === 0) return undefined;
    const refinable = usable.filter((s) => s.deposits.some((d) => prefersRefinable(d.symbol)));
    const pool = refinable.length > 0 ? refinable : usable;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /** Remove a survey that the server reported as exhausted/invalid. */
  invalidate(waypoint: string, signature: string): void {
    const list = this.byWaypoint.get(waypoint);
    if (!list) return;
    this.byWaypoint.set(
      waypoint,
      list.filter((s) => s.signature !== signature),
    );
    this.prune(waypoint);
  }

  count(): number {
    let n = 0;
    for (const list of this.byWaypoint.values()) n += list.filter((s) => !isExpired(s)).length;
    return n;
  }

  /** All non-expired surveys, optionally filtered to one waypoint. */
  list(waypoint?: string): Survey[] {
    if (waypoint) {
      return (this.byWaypoint.get(waypoint) ?? []).filter((s) => !isExpired(s));
    }
    const out: Survey[] = [];
    for (const list of this.byWaypoint.values()) out.push(...list.filter((s) => !isExpired(s)));
    return out;
  }

  private prune(waypoint: string): void {
    const list = this.byWaypoint.get(waypoint);
    if (!list) return;
    const fresh = list.filter((s) => !isExpired(s));
    if (fresh.length === 0) this.byWaypoint.delete(waypoint);
    else this.byWaypoint.set(waypoint, fresh);
  }
}