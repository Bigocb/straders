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
    return DEFAULTS.map((d) => {
      const override = this.cache.get(d.key);
      return override ? { ...d, value: override.value, enabled: override.enabled } : { ...d };
    });
  }

  /**
   * The effective value of a rule. A disabled rule falls back to `whenOff`,
   * which is what "turn this rule off" means for the engine — not zero, but the
   * unconstrained behaviour.
   */
  value(key: string, whenOff?: number): number {
    const base = DEFAULTS.find((d) => d.key === key);
    if (!base) throw new Error(`unknown doctrine rule: ${key}`);
    const override = this.cache.get(key);
    const enabled = override?.enabled ?? base.enabled;
    if (!enabled && whenOff !== undefined) return whenOff;
    return override?.value ?? base.value;
  }

  isEnabled(key: string): boolean {
    const base = DEFAULTS.find((d) => d.key === key);
    return this.cache.get(key)?.enabled ?? base?.enabled ?? false;
  }

  /** Update one rule. Values are clamped to the rule's declared bounds. */
  set(key: string, patch: { value?: number; enabled?: boolean }): DoctrineRule {
    const base = DEFAULTS.find((d) => d.key === key);
    if (!base) throw new Error(`unknown doctrine rule: ${key}`);
    const current = this.list().find((r) => r.key === key)!;
    const value = patch.value === undefined
      ? current.value
      : Math.min(base.max, Math.max(base.min, patch.value));
    const enabled = patch.enabled === undefined ? current.enabled : patch.enabled;
    this.cache.set(key, { value, enabled });
    this.store?.setDoctrine(key, value, enabled);
    return { ...base, value, enabled };
  }
}

export const DOCTRINE_DEFAULTS = DEFAULTS;
