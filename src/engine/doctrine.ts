import type { Store } from "./store.js";

/**
 * Fleet doctrine: the tunable policy the autonomous engine flies by.
 *
 * These values were previously hardcoded across the coordinator and the trader
 * (`minCashReserve: 20_000`, `maxLossPct: 15`, `miners.size >= 4`,
 * `margin <= 10`). Pulling them into one persisted place makes them the thing
 * the operator tunes, rather than constants only a code change can move.
 *
 * Everything here is read live on each use, so an edit takes effect on the next
 * tick without a restart.
 */

export interface DoctrineRule {
  /** Stable id, used as the settings key. */
  key: string;
  /** Short name for the UI. */
  name: string;
  /** One line explaining what the engine does with it. */
  description: string;
  value: number;
  /** Bounds and step for the UI control. */
  min: number;
  max: number;
  step: number;
  /** Suffix shown after the value (`c`, `%`, `` for a bare count). */
  unit: string;
  /** Whether the rule is currently applied. */
  enabled: boolean;
  /** False for rules that are defined but not yet enforced anywhere. */
  enforced: boolean;
}

const DEFAULTS: DoctrineRule[] = [
  {
    key: "cashFloor",
    name: "Cash floor",
    description: "Never let the balance fall below this when buying ships or modules.",
    value: 20_000, min: 0, max: 500_000, step: 5_000, unit: "c",
    enabled: true, enforced: true,
  },
  {
    key: "marginFloor",
    name: "Margin floor",
    description: "Ignore arbitrage routes whose per-unit margin is below this.",
    value: 10, min: 0, max: 500, step: 5, unit: "c",
    enabled: true, enforced: true,
  },
  {
    key: "maxLossPct",
    name: "Loss floor",
    description: "Refuse to sell cargo below this much loss against its cost basis.",
    value: 15, min: 0, max: 100, step: 5, unit: "%",
    enabled: true, enforced: true,
  },
  {
    key: "minerTarget",
    name: "Mining pressure",
    description: "Grow the drone fleet until this many miners are active.",
    value: 4, min: 0, max: 20, step: 1, unit: "",
    enabled: true, enforced: true,
  },
  {
    key: "promoteAtMiners",
    name: "Trader promotion",
    description: "Promote the biggest-hold miner to trader once this many miners exist.",
    value: 4, min: 1, max: 20, step: 1, unit: "",
    enabled: true, enforced: true,
  },
  {
    key: "shipBudget",
    name: "Purchase headroom",
    description: "Only consider buying a ship when credits exceed the cash floor by this much.",
    value: 30_000, min: 0, max: 500_000, step: 10_000, unit: "c",
    enabled: true, enforced: true,
  },
  {
    key: "snapshotMaxAgeMin",
    name: "Intel freshness",
    description: "Ignore market prices older than this. Both the dispatcher and the traders use it, so they always agree on which routes exist.",
    value: 90, min: 5, max: 1440, step: 15, unit: "m",
    enabled: true, enforced: true,
  },
];

/** Live, persisted doctrine. Reads are cheap; writes go straight to SQLite. */
export class Doctrine {
  private cache = new Map<string, { value: number; enabled: boolean }>();

  constructor(private readonly store?: Store) {
    this.reload();
  }

  reload(): void {
    this.cache.clear();
    for (const row of this.store?.getDoctrine() ?? []) {
      this.cache.set(row.key, { value: row.value, enabled: row.enabled });
    }
  }

  /** All rules, defaults merged with any stored overrides. */
  list(): DoctrineRule[] {
    const stored = this.store?.getDoctrine() ?? [];
    const dynamic = stored
      .filter((row) => !DEFAULTS.some((d) => d.key === row.key))
      .map((row) => this.dynamicRule(row.key, row.value, row.enabled));
    return [...DEFAULTS.map((d) => {
      const override = this.cache.get(d.key);
      return override ? { ...d, value: override.value, enabled: override.enabled } : { ...d };
    }), ...dynamic];
  }

  /** Build a rule for a ship-type cap (e.g. `shipCap:SHIP_LIGHT_HAULER`). */
  private dynamicRule(key: string, value: number, enabled: boolean): DoctrineRule {
    const type = key.startsWith("shipCap:") ? key.slice("shipCap:".length) : key;
    return {
      key,
      name: type.replace(/^SHIP_/, "").replace(/_/g, " ").toLowerCase(),
      description: `Fleet cap for ${type} — the auto-buyer stops buying this hull once the fleet has this many.`,
      value,
      min: 0, max: 20, step: 1, unit: "",
      enabled,
      enforced: true,
    };
  }

  /**
   * The effective value of a rule. A disabled rule falls back to `whenOff`,
   * which is what "turn this rule off" means for the engine — not zero, but the
   * unconstrained behaviour.
   */
  value(key: string, whenOff?: number): number {
    const base = DEFAULTS.find((d) => d.key === key);
    const override = this.cache.get(key);
    const enabled = override?.enabled ?? base?.enabled ?? true;
    if (!enabled && whenOff !== undefined) return whenOff;
    if (override) return override.value;
    if (base) return base.value;
    // Dynamic ship-cap rules default to a generous cap so a newly-seen hull
    // never blocks the auto-buyer until the operator tunes it.
    if (key.startsWith("shipCap:")) return 4;
    throw new Error(`unknown doctrine rule: ${key}`);
  }

  isEnabled(key: string): boolean {
    const base = DEFAULTS.find((d) => d.key === key);
    return this.cache.get(key)?.enabled ?? base?.enabled ?? true;
  }

  /** Register a ship type so the operator can cap it from the doctrine tab. */
  ensureShipTypeRule(type: string): void {
    if (!type) return;
    const key = `shipCap:${type}`;
    if (this.cache.has(key)) return;
    // Per-hull default caps: probes are useless scouts (0 fuel, can't move), so
    // the fleet never buys them unless the operator explicitly raises the cap.
    const defaultCap = type === "FRAME_PROBE" ? 0 : 4;
    this.cache.set(key, { value: defaultCap, enabled: true });
    this.store?.setDoctrine(key, defaultCap, true);
  }

  /** Update one rule. Values are clamped to the rule's declared bounds. */
  set(key: string, patch: { value?: number; enabled?: boolean }): DoctrineRule {
    const base = DEFAULTS.find((d) => d.key === key);
    if (!base && !key.startsWith("shipCap:")) throw new Error(`unknown doctrine rule: ${key}`);
    const current = this.list().find((r) => r.key === key)!;
    const min = base?.min ?? 0;
    const max = base?.max ?? 20;
    const value = patch.value === undefined
      ? current.value
      : Math.min(max, Math.max(min, patch.value));
    const enabled = patch.enabled === undefined ? current.enabled : patch.enabled;
    this.cache.set(key, { value, enabled });
    this.store?.setDoctrine(key, value, enabled);
    return { ...current, value, enabled };
  }
}

export const DOCTRINE_DEFAULTS = DEFAULTS;
