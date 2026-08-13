# Greenfield: Migration Guide

How to reach the architecture in [`greenfield-design.md`](greenfield-design.md)
without losing the fleet. Read that document first for *what* is being built and
*why*; this one is *how* and *in what order*.

---

## 1. Why not a big-bang rewrite

The temptation is real — the target architecture is cleaner than what's there,
and rewriting is more pleasant than migrating. Three reasons not to:

1. **The fleet is live.** It holds real credits, real cargo and a SQLite
   database with months of market history. A rewrite means a window where the
   fleet is either stopped or running unproven code against real assets.
2. **The behaviour is the spec, and it isn't all written down.** Eighteen
   thousand lines contain a lot of hard-won detail: the misleading-margin route
   correction, probes having zero fuel so they can only keeper their spawn
   shipyard, `transferCargo`'s body field naming the *receiving* ship, gates
   under construction being unjumpable, the shared freshness window that stops
   traders and the dispatcher disagreeing. Every one of those was a bug first.
   A rewrite rediscovers them the same way.
3. **There is a working test suite** — 172 unit tests and a full UI smoke suite.
   That is a migration safety net, not a rewrite safety net. It only holds value
   if the code it tests keeps existing while you change it.

The strangler-fig approach gets the same endpoint: build the new substrate
alongside the old, move one subsystem at a time, delete the old path once the
new one is proven. Each stage below ships to `main` on its own and is revertable
on its own.

### The core safety technique: dual-write, then parity-check

For Stages 1 and 3, don't switch reads over immediately. Instead:

1. **Dual-write.** Every existing mutation also writes the new structure. Old
   structure stays authoritative; nothing changes behaviourally.
2. **Parity-check.** Add an assertion (behind a `ST_PARITY_CHECK` env flag, and
   in tests unconditionally) that the new structure agrees with the old on every
   read. Run the fleet. Disagreements are logged, not thrown.
3. **Flip.** Once parity holds under real load, make the new structure
   authoritative and delete the old.

This is what makes each stage safe to ship: you get real-traffic validation of
the new structure before anything depends on it.

---

## 2. Stage 0 — Safety net

**Do this whether or not the rest happens.** No architecture change; four
independent fixes from the audit. Each is small, testable against the existing
suite, and individually revertable.

| Fix | Finding | Effort |
| --- | --- | --- |
| Cache agent credits + contract list (30–60s TTL); dedupe the double `listActive()` | B1 | ~2h |
| Move mission `retryAt` check above `getConstruction()`; slow the paused-mission reconcile to 30–60s | A7 | ~1h |
| Make Halt stop the ships; keep `rescueStranded()` running while halted | A1 | ~3h |
| Persist cost basis; unknown basis resolves to a ledger-derived estimate, never "no floor" | A3 | ~3h |
| Filter suspended + held traders out of `dispatcherTraders()`; release their claims | A5 | ~30m |

**Order matters.** Do B1 and A7 first — they give back roughly 90% of the
coordinator's API cost, so everything after runs against a fleet that isn't
starved, making every subsequent change easier to observe.

**On A1 specifically:** the interim fix is a `shouldRun()` predicate threaded
into each agent loop, checked at the top of `tick()`. That is a stopgap — Pillar 3
makes it structural. But it removes a live hazard now: today a halted fleet keeps
trading with rescue switched off, and the persistence commit made that state
survive restarts.

**Verify:** existing suite green; add a test asserting agents do not act while
paused, and one asserting rescue still does.

**Done when:** coordinator API cost is measurably ~0.2 req/s, Halt visibly stops
ships, restart no longer clears cost basis.

---

## 3. Stage 1 — ShipRegistry alongside

**Goal:** the registry exists, is written on every ownership change, and agrees
with the eight existing mechanisms. Nothing reads it authoritatively yet.

**Files:** new `src/engine/registry.ts`; `store.ts` (+`ship_claims` table);
`fleet.ts` (dual-write at each ownership mutation).

**Approach**

1. Build `ShipRegistry` with `claim` / `release` / `ownerOf` / `available` and
   the precedence order from the design doc. Pure logic, no I/O beyond the store
   — so it unit-tests cleanly in isolation.
2. Dual-write at each of the eight sites: `assignRole`, `holdShip`,
   `releaseShip`, `mineAt`, `unpinMining`, `designateWarehouseShip`,
   `releaseWarehouseShip`, `setManualDispatch`, `maybeAssignKeepers`,
   `suspendAgent` / `resumeAgent`, and `MissionManager`'s carrier assign/release.
3. Add `parityCheck()`: derives ownership from the old structures and compares to
   the registry, logging any disagreement.

**Verify:** unit tests for precedence and CAS semantics; run the live fleet with
`ST_PARITY_CHECK=1` for a day and confirm a clean log. Expect disagreements at
first — they are exactly the latent bugs this design targets, so investigate each
rather than papering over it.

**Revert:** delete the dual-write calls. The table becomes inert.

**Done when:** parity log is clean across a full day including at least one
mission, one keeper conversion and one operator hold.

---

## 4. Stage 2 — Registry becomes authoritative

**Goal:** ownership questions are answered only by the registry.

**Files:** `fleet.ts`, `dispatcher.ts`, `mission.ts`, `server/index.ts`.

**Approach**

1. Replace availability logic with `registry.available(owner)` in the three
   places that each currently do it differently: `pickMissionCarrier`,
   `maybeAssignKeepers`, `dispatcherTraders`. **This alone fixes A5** — the
   suspended/held-trader route lockout — because there is now one filter instead
   of three partial ones.
2. Make `MissionManager` claim its carrier through the registry rather than
   setting `assignedShip` and calling `suspend()`. Same for keeper stationing and
   warehouse designation.
3. Delete `suspended` and `manualGoal`/`manualWaypoint` *reads*. Keep the fields
   as private loop-control state for now; they stop being an ownership signal.
4. Role maps stay — they still decide which loop drives a ship. That coupling
   dies in Stage 5.
5. Unify the reservation function so `recompute()` and `claim()` share one
   definition of "taken" (**fixes A4**), and have `claim()` preserve its assigned
   role rather than defaulting to `direct`.

**Verify:** full suite; add tests for invariants 1, 2 and 8. Watch for a revenue
change after the A5 fix — a previously locked route becoming available should be
visible in the ledger.

**Revert:** larger than Stage 1 — revert the commit. Keep it a single commit for
that reason.

**Done when:** no subsystem reads ownership from anywhere but the registry.

---

## 5. Stage 3 — Cargo manifest

**Goal:** cargo carries intent and a persisted cost basis.

**Files:** new manifest module; `store.ts` (+`ship_manifest`); `trader.ts`;
`mission.ts`.

**Approach**

1. Add the table and a `Manifest` accessor with the merge rule and the
   ledger-derived estimate for unknown basis.
2. Dual-write: every acquisition path records intent —
   `runArbitrage` → `resale`, `runBuy` → `warehouse-deposit`,
   `runBuy` with `missionBuy` → `mission-delivery`,
   `runSell`/`runHaul` withdrawals → `held-position` / `mission-delivery`,
   `MissionManager`'s own purchases → `mission-delivery`.
3. Add reconciliation on ship refresh (both directions, per the design doc).
4. **Flip the sweeper last.** Once the manifest is populated and reconciling
   cleanly, gate `clearLeftoverCargo()` to `resale` only. This is the change that
   fixes A2 — and it is the one most likely to surface a ship that has been
   quietly relying on the sweeper to unstick itself, so ship it on its own and
   watch for holds that stop draining.
5. Run the same reconciliation against the warehouse ship to true up the
   `warehouse` table (**fixes A6**).

**Verify:** tests for invariants 3, 4, 5 — particularly "a sell-role trader
holding below the warehouse margin floor still holds it on the next tick", which
is the exact behaviour A2 breaks today.

**Done when:** a restart preserves cost basis, and warehouse-bound cargo survives
a failed rendezvous without being liquidated.

---

## 6. Stage 4 — Scheduler, one agent type

**Goal:** the runner exists and drives one agent type end to end. Everything else
still loops.

**Files:** new `src/engine/scheduler.ts`; `client.ts` (limiter moves into the
scheduler); `agent.ts` (keeper path only).

**Approach**

1. Build the runner: priority queue, budget accounting, pause gate. Unit-test it
   against a fake clock and a fake limiter — no network.
2. **Migrate keepers first.** They are stationary, single-purpose, and have the
   simplest loop (`keeperLoop` is ~30 lines), so they prove the shape with the
   least behavioural surface.
3. Run keepers on the scheduler while every other agent keeps its loop. Both
   share the same limiter, so the budget accounting is honest even mid-migration.

**Verify:** keeper snapshots keep arriving at the same cadence; budget telemetry
matches observed request rate.

**Done when:** keepers have no `while` loop and their API spend is attributed in
the scheduler's telemetry.

---

## 7. Stage 5 — All agents on the scheduler

**Goal:** delete every agent loop. Halt becomes structural.

**Files:** `agent.ts`, `trader.ts`, `scout.ts`, `siphoner.ts`, `fleet.ts`.

**Approach**

Migrate one agent type per commit, in ascending order of complexity:
**siphoner → scout → surveyor → tour → miner → trader**. The trader is last and
by far the largest — it has the warehouse buy/sell/haul roles, the arbitrage
path, and the leftover sweeper.

Per agent: `tick()` becomes `nextTask()`; each `sleep(n)` becomes
`earliestRunAt: now + n`; each `await` chain that previously ran inside one tick
either stays inside one task (if it's one logical step) or splits into
`TaskResult.next` (if it crosses a travel or cooldown boundary). Splitting at
travel boundaries is what lets the runner interleave ships properly.

The coordinator's own work — contracts, keeper assignment, ship purchase,
exploration, rescue, mission stepping — becomes a set of recurring priority-1/4
tasks rather than a fixed 2s tick.

**Verify:** the UI smoke suite is valuable here — it exercises the whole stack
through real HTTP. Add a soak test: run against the mock server for an hour and
assert no task starves (every ship acts at least once per N minutes).

**Done when:** no `while (this.running)` remains in the engine, and the Stage 0
`shouldRun()` stopgap can be deleted because pause is enforced at dispatch.

---

## 8. Stage 6 — State machine + restart replay

**Goal:** restart replays intent rather than inferring it.

**Files:** `store.ts` (+`ship_state`), the agent task producers, `fleet.ts` init.

Small once Stages 1 and 5 exist: the task producers already know their step, so
persisting it is a write on transition. `init()` stops reconstructing state from
ship position and instead resumes each ship's recorded state.

The four ad-hoc restorations added in the persistence commit (holds, mine pins,
warehouse binding, dispatch overrides) get deleted here — the registry plus the
state machine covers all four.

**Done when:** a restart mid-haul resumes the haul rather than re-planning it.

---

## 9. Stage 7 — Read model + retention

**Goal:** dashboard reads stop competing with the engine; performance stops
degrading with uptime.

**Files:** `store.ts`, `server/index.ts`.

1. Add `market_latest`; upsert in `recordMarket()`.
2. Backfill once from `market_snapshots`.
3. Repoint the ~15 `latestMarketSnapshots()` call sites. Keep the old method for
   the price-history chart, which genuinely wants history.
4. Add retention (`historyRetentionDays`, default 30) for `market_snapshots`,
   `ledger`, `activity`, `warehouse_ledger`, `chat_messages`. Run it as a low
   priority-4 scheduled task.

Independent of Stages 1–6 — it can be done at any point, including before them
if performance is biting.

**Done when:** `/api/markets` latency is flat as the DB grows.

---

## 10. Test strategy

The existing suite is the safety net. Extend it deliberately rather than
replacing it.

- **Keep every existing test passing at every stage.** A test that must change is
  a signal to stop and ask whether the behaviour change was intended. Two already
  changed under the curated-warehouse work — both were deliberate redesigns, and
  both were worth the pause.
- **Invariants become tests.** The eight invariants in the design doc are the
  acceptance criteria for the whole migration. Write them as tests during the
  stage that makes each one true.
- **Parity checks are temporary tests.** Delete them at the flip.
- **The UI smoke suite is the integration test.** It runs the real server against
  a mock API and exercises the whole stack. It caught three real bugs during the
  mobile work; it will catch more here.
- **Add a soak test at Stage 5.** Loop-to-scheduler is the stage where starvation
  bugs appear, and they only show up over time.

---

## 11. Sequencing summary

| Stage | Fixes | Ships independently | Risk |
| --- | --- | --- | --- |
| 0 · Safety net | B1 A7 A1 A3 A5 | Yes, 5 separate commits | Low |
| 1 · Registry alongside | — | Yes | Low — inert until Stage 2 |
| 2 · Registry authoritative | A4 A5 | Yes, one commit | Medium |
| 3 · Cargo manifest | A2 A3 A6 | Yes, sweeper flip separate | Medium |
| 4 · Scheduler, keepers only | — | Yes | Low |
| 5 · All agents scheduled | A1 B1 B4 | Per agent type | **High** |
| 6 · State machine | restart class | Yes | Low |
| 7 · Read model | B3 A8 | Yes, any time | Low |

**If you stop after Stage 0**, you have taken back most of your API budget,
removed the Halt hazard, and stopped losing money to missing cost basis on every
restart — for about a day and a half of work and near-zero risk.

**If you stop after Stage 3**, the four critical audit findings are all
structurally fixed and the eight-owners problem is gone. That is most of the
value of the greenfield for a fraction of the cost, and it leaves the engine in a
coherent state rather than half-migrated.

**Stage 5 is the commitment point.** Everything before it is additive and
revertable in isolation; Stage 5 deletes the loops. Do it only when Stages 1–3
have run clean against the live fleet for a while.
