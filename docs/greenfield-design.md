# Greenfield: Target Architecture

A ground-up design for the fleet engine, using the current feature set as the
spec. Nothing here removes a capability — warehousing, dispatch, missions,
keepers, doctrine, per-ship manual control and the dashboard all survive intact.
What changes is the substrate they sit on.

Companion document: [`greenfield-migration.md`](greenfield-migration.md) — how to
get from here to there without losing the fleet. **Read this one for *what*, that
one for *how* and *in what order*.**

---

## 1. The problem this solves

The engine works. The problem is not any individual subsystem — it's that each
one arrived with its own private way of laying claim to a ship, and none of them
can see the others.

There are **eight independent mechanisms** that can direct a ship today:

| Mechanism | Lives in | Shape |
| --- | --- | --- |
| Role maps | `fleet.ts` | 8 separate `Map`s (miners, traders, surveyors, tours, keepers, scouts, siphoners, idle) |
| Operator hold | agent instance | `manualGoal` / `manualWaypoint` |
| Suspend | agent instance | `suspended` boolean |
| Route assignment | `RouteDispatcher` | `assignments` + `manual` maps |
| Warehouse ship | `fleet.ts` | single field |
| Mission carrier | `MissionManager` | `assignedShip` |
| Keeper station | `fleet.ts` | `keeperMarkets` map |
| Mining pin | agent instance | `pinnedMiningTarget` |

Answering "is this trader available?" means consulting six of these and hoping.
Nothing enforces mutual exclusion; it's maintained by hand at each call site.

Almost every bug in the audit is a collision between two rows of that table:

- A trader suspended for a mission still holds its dispatcher route reservation,
  locking that good away from the whole fleet for hours.
- `RouteDispatcher.recompute()` and `RouteDispatcher.claim()` both write the
  assignment map using *different* definitions of "taken".
- `clearLeftoverCargo()` liquidates cargo without knowing whether it was bought
  for resale, for the warehouse, or for a construction site.
- `setPaused()` gates the coordinator but not the ship loops, because ship loops
  are not something the coordinator owns.

These are not independent defects to be fixed one at a time. They are the same
defect — **no single source of truth for who controls a ship and why** — showing
up in four places.

### Non-goals

- Changing game strategy. Route ranking, margin floors, keeper placement and
  mission sourcing logic all carry over unchanged.
- Changing the dashboard's HTTP contract. Every `/api/*` response keeps its
  current shape; new fields are additive.
- Multi-agent or multi-tenant support (see `multi-tenant-plan.md`).
- Replacing SQLite or introducing a message broker. `better-sqlite3` is
  synchronous and in-process, which is exactly right for this workload.

---

## 2. Five pillars

Each is independently adoptable. Together they make the collision class above
structurally impossible rather than merely fixed.

### Pillar 1 — One ship, one owner

A single `ShipRegistry` becomes the only thing permitted to say who controls a
ship. Every subsystem asks it; no subsystem keeps its own map.

```ts
type Owner = "operator" | "mission" | "warehouse" | "keeper" | "auto";

type ShipRole =
  | "miner" | "trader" | "surveyor" | "tour"
  | "keeper" | "scout" | "siphoner" | "warehouse" | "idle";

type Intent =
  | { kind: "idle" }
  | { kind: "hold";      waypoint: string }
  | { kind: "mine";      field?: string }
  | { kind: "trade";     assignment: TraderAssignment }
  | { kind: "keep";      market: string }
  | { kind: "carry";     missionWaypoint: string }
  | { kind: "warehouse"; waypoint: string };

interface Claim {
  shipSymbol: string;
  owner: Owner;
  role: ShipRole;
  intent: Intent;
  since: string;         // ISO
}
```

**Precedence.** Owners form a strict order:

```
operator  >  mission  >  warehouse  >  keeper  >  auto
```

A higher-precedence owner may preempt a lower one. Equal or lower may not — the
claim call fails and the caller handles it. This encodes rules that are currently
implicit and inconsistently applied: an operator Hold beats everything; a mission
may take an auto-trading ship but not an operator-held one; the auto-dispatcher
may never touch a mission carrier.

**Claiming is a compare-and-swap.** There is no path that mutates ownership
without going through it:

```ts
claim(shipSymbol, owner, role, intent, opts?: { preempt?: boolean }): Claim | undefined
release(shipSymbol, owner): void        // no-op unless `owner` currently holds it
ownerOf(shipSymbol): Claim              // never undefined — see invariant 1
available(forOwner: Owner): string[]    // ships this owner could legally claim
```

`available()` is the single function that replaces the ad-hoc availability checks
scattered through `pickMissionCarrier`, `maybeAssignKeepers` and
`dispatcherTraders`. Each of those currently applies a *different* and incomplete
set of filters, which is finding A5.

**Persistence.** One table, written on every claim change:

```sql
CREATE TABLE IF NOT EXISTS ship_claims (
  shipSymbol TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  role       TEXT NOT NULL,
  intent     TEXT NOT NULL,       -- JSON
  since      TEXT NOT NULL
);
```

This subsumes `fleet_state`, the `shipManualState` and `warehouseShip` flags
added in the persistence commit, and `dispatchManual` — those were four separate
answers to one question.

**Replaces:** all eight rows of the table in §1.

---

### Pillar 2 — Cargo carries its intent

Cargo is currently anonymous: units in a hold, with no record of why they were
acquired. `clearLeftoverCargo()` therefore treats every hold as a mistake to
liquidate — selling warehouse stock below its margin floor, and *jettisoning*
mission materials when the local market won't buy them.

Give every ship a persisted manifest:

```sql
CREATE TABLE IF NOT EXISTS ship_manifest (
  shipSymbol TEXT NOT NULL,
  goodSymbol TEXT NOT NULL,
  units      INTEGER NOT NULL,
  costBasis  REAL NOT NULL,
  basisKind  TEXT NOT NULL,      -- 'actual' | 'estimated'
  intent     TEXT NOT NULL,      -- see below
  acquiredAt TEXT NOT NULL,
  PRIMARY KEY (shipSymbol, goodSymbol)
);
```

```ts
type CargoIntent =
  | "resale"             // ordinary arbitrage — the sweeper may act on this
  | "warehouse-deposit"  // bound for the warehouse ship
  | "mission-delivery"   // bound for a construction site
  | "held-position";     // deliberately held for margin
```

**The rules that follow from it:**

1. The sweeper may only touch `resale`. Everything else is someone's plan.
2. Cost basis is written at acquisition and survives restart, so both
   `maxLossPct` and `warehouseMinMargin` hold across a bounce. Today
   `heldCost` is an in-memory `Map` and an empty one disables loss protection
   entirely (finding A3).
3. A good's intent may only be *downgraded* to `resale` explicitly — by the
   operator, or by a documented fallback (e.g. warehouse rendezvous failed N
   times) that logs the downgrade. Never silently.

**One good per ship, one intent.** The API models cargo per good, so a
split-intent good cannot be reconciled against real cargo unambiguously. If a
ship acquires a good it already holds under a different intent, the manifest
merges to the **higher-priority** intent (`mission-delivery` >
`warehouse-deposit` > `held-position` > `resale`) and logs it.

**Reconciliation.** On each ship refresh, compare manifest against
`ship.cargo.inventory`:

- Units in cargo with no manifest row (transferred in, salvaged, or a restart
  that predates the manifest) get intent `resale` and an **estimated** basis
  taken from the fleet ledger's volume-weighted average purchase price for that
  good. The `ledger` table already has every purchase we've ever made, so this is
  a real number, not a guess — and it keeps loss protection working rather than
  deadlocking on unknown basis.
- Manifest rows with no matching cargo are dropped (sold, transferred, jettisoned
  outside our knowledge).

This reconciliation is also what fixes the warehouse books drifting from the
warehouse ship's real hold (finding A6) — the same routine, run against the
warehouse ship, trues up the `warehouse` table.

**Replaces:** `heldCost`, the untyped `clearLeftoverCargo` sweep, and the
implicit assumption that warehouse bookkeeping matches physical cargo.

---

### Pillar 3 — One scheduler holding one budget

Today there are N+1 independent `while (running)` loops — one per ship plus the
coordinator — each with private `sleep()` calls, all racing for a shared
`RateLimiter(2, 30)` that none of them can see. The consequences:

- The coordinator's fixed 2s cadence consumes ~1.5 req/s of a 2 req/s ceiling
  before any ship acts (finding B1). Ships are starved by construction.
- Rate limiting surfaces as a 429 in whichever unlucky call happens to hit the
  wall, not as a scheduling decision.
- `setPaused` cannot stop the ships, because nothing owns them collectively
  (finding A1).

Replace the loops with a single priority work queue and a runner that owns the
budget.

```ts
type Priority = 0 | 1 | 2 | 3 | 4;
// 0 rescue · 1 mission · 2 trade · 3 survey/keeper · 4 telemetry

interface Task {
  id: string;
  shipSymbol?: string;
  priority: Priority;
  estimatedCalls: number;      // API cost, for budgeting
  earliestRunAt: number;       // cooldowns, backoff, travel ETA
  run(ctx: EngineContext): Promise<TaskResult>;
}

interface TaskResult {
  next?: Task;                 // the follow-up step, if any
  actualCalls: number;         // trues up the budget estimate
}
```

Agents stop being loops and become **task producers**: `nextTask(): Task |
undefined`. The mechanical shape of each agent's logic is unchanged — a tick
becomes a task, a `sleep(30_000)` becomes `earliestRunAt: now + 30_000`.

**The runner:**

```
loop:
  budget = limiter.availableTokens()
  ready  = tasks.filter(t => t.earliestRunAt <= now)
                .filter(t => paused ? t.priority === 0 : true)
                .sort(by priority, then earliestRunAt)
  for task of ready:
    if task.estimatedCalls > budget: continue    // leave budget for higher priority
    dispatch(task); budget -= task.estimatedCalls
```

**What this buys, concretely:**

- **Halt becomes correct by construction.** Pausing stops dispatch of everything
  except priority 0. There is no second place where ships keep moving, because
  there is no second place. Rescue keeps running while halted, which is the
  behaviour you actually want and the opposite of today's.
- **Budget is observable.** The runner knows what it spent and on what. That is
  directly renderable — see §4.
- **Starvation becomes a policy choice.** When telemetry and trading compete, the
  higher priority wins deterministically instead of by luck of timing.

**Replaces:** every `runLoop` / `surveyLoop` / `tourLoop` / `keeperLoop`, the
coordinator's fixed 2s tick, and the scattered `sleep()` calls.

---

### Pillar 4 — Persisted state machine per ship

Give each ship an explicit lifecycle, written to SQLite on every transition:

```
idle → assigned → travelling → docked → transacting → returning → idle
```

```sql
CREATE TABLE IF NOT EXISTS ship_state (
  shipSymbol TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  target     TEXT,                -- waypoint this state is heading toward
  step       TEXT,                -- sub-step within the state, JSON
  updatedAt  TEXT NOT NULL
);
```

Restart **replays the state machine** rather than reconstructing intent from
where a ship happens to be sitting. This generalises the persistence work already
merged: that commit persisted four specific things (holds, mine pins, warehouse
binding, dispatch overrides) because each had been individually lost. This
removes the category.

It also makes "what is this ship doing right now" a single field rather than an
inference, which is what the dashboard currently has to guess at.

---

### Pillar 5 — Split the read model from the engine

`latestMarketSnapshots()` runs a `ROW_NUMBER() OVER (PARTITION BY ...)` across the
entire `market_snapshots` table, from ~15 call sites, several of them per
dashboard poll. There is no retention policy on any append-only table. Keepers
snapshot every five minutes, per market, per good, forever — so this degrades
monotonically with uptime.

**Projection table, maintained on write:**

```sql
CREATE TABLE IF NOT EXISTS market_latest (
  waypointSymbol TEXT NOT NULL,
  goodSymbol     TEXT NOT NULL,
  systemSymbol   TEXT NOT NULL,
  type           TEXT NOT NULL,
  supply         TEXT NOT NULL,
  purchasePrice  REAL NOT NULL,
  sellPrice      REAL NOT NULL,
  tradeVolume    INTEGER NOT NULL,
  timestamp      TEXT NOT NULL,
  PRIMARY KEY (waypointSymbol, goodSymbol)
);
CREATE INDEX IF NOT EXISTS idx_latest_good ON market_latest (goodSymbol);
```

`recordMarket()` upserts here as well as appending to `market_snapshots`. Every
"what's the current price" read becomes an indexed lookup; `market_snapshots`
stays as the history table that feeds the price chart, and gets a retention job
alongside `ledger`, `activity`, `warehouse_ledger` and `chat_messages`.

Retention is a doctrine rule (`historyRetentionDays`, default 30) so it's
operator-tunable like everything else.

---

## 3. Invariants

These are the point of the whole exercise. Each is mechanically checkable, and
each becomes a test — that is what makes the design enforceable rather than
aspirational.

1. **Every ship has exactly one claim row, always.** No ship is unowned; `auto`
   is an owner, not an absence.
2. **A subsystem may only command a ship whose claim it holds.** Enforced in the
   command path, not by convention.
3. **Manifest units never exceed actual cargo units**, per ship per good.
4. **Cargo may only be sold through a path matching its intent.** The sweeper
   touches `resale` only.
5. **No cargo is sold below its cost-basis floor** unless the operator explicitly
   forces it. Unknown basis resolves to the ledger-derived estimate, never to
   "no floor".
6. **Scheduled API cost per second never exceeds the configured ceiling.**
7. **While paused, only priority-0 tasks dispatch.** Rescue runs; nothing else
   does.
8. **A good is reserved by at most one claim** across all roles, under one shared
   reservation function used by both the periodic recompute and live claims.

Invariants 1, 2 and 8 kill the eight-owners problem. 3–5 kill the cargo problem.
6–7 kill the budget and Halt problems.

---

## 4. What the dashboard gains

Worth stating plainly, because the last several changes have been backend and
this one is too: the greenfield is mostly engine work, but it unlocks UI that
**cannot be built today** because the data doesn't exist in one place.

| New UI | Why it's impossible today |
| --- | --- |
| "Owned by: mission I59 · carrying FAB_MATS" on every ship card | Ownership is inferred from six structures that disagree |
| Live API budget gauge — what the fleet spent and on what | Nothing tracks or attributes API spend |
| Cargo intent per ship: "12u IRON_ORE → warehouse" | Cargo has no intent |
| A Halt that visibly stops everything | Halt doesn't stop the ships |
| Correct state after restart, with no "no ship designated" flicker | Partially fixed; Pillar 4 finishes it |
| "Why is this ship idle?" — a real answer | The reason is never recorded |

The budget gauge in particular turns the single most confusing property of the
system ("why is the fleet sluggish?") into something the operator can see.

---

## 5. What stays exactly as it is

Worth being explicit, because a rewrite invites scope creep:

- **Doctrine.** The best-designed part of the system. Live-read, persisted,
  operator-tunable, with `whenOff` fallbacks. Carries over untouched; the new
  subsystems read it the same way.
- **Route ranking.** Profit-per-trip net of fuel, the misleading-margin
  correction, the shared freshness window. Unchanged.
- **Warehouse semantics.** A real ship, parked, with weighted-average cost basis
  and a curated per-good target list. Unchanged — Pillar 2 only makes its
  bookkeeping honest.
- **Mission sourcing.** Cheapest-known-market lookup, background discovery,
  carrier reachability checks. Unchanged.
- **The HTTP contract.** All `/api/*` responses keep their shape. New fields are
  additive so the dashboard keeps working mid-migration.
- **SQLite + `better-sqlite3`.** Synchronous, in-process, already the right call.

---

## 6. Cost, honestly

This is a large change to a system that currently works and is flying a live
fleet with real credits.

- Pillars 1, 2 and 5 are tractable — new structures alongside existing ones, with
  a dual-write period. Each is a few days of careful work.
- **Pillar 3 is the expensive one.** Converting seven agent classes from loops to
  task producers touches every behaviour in the engine. It is mechanical rather
  than subtle, but it is broad, and it is where a rewrite would most plausibly
  lose behaviour that nobody remembered was load-bearing.
- Pillar 4 is small once 1 and 3 exist, and awkward before them.

The strong recommendation is **not** to do this as a big-bang rewrite. The
migration document lays out a strangler-fig sequence where each stage ships to
`main` independently, keeps the fleet flying, and is revertable on its own. The
first stage is four small fixes that buy back most of the API budget and remove
the Halt hazard — worth doing whether or not the rest ever happens.

→ [`greenfield-migration.md`](greenfield-migration.md)
