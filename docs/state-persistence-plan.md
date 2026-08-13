# State Persistence: Design & Implementation Plan

## 1. The problem

Every process restart loses a large slice of the fleet's *decisions*, even
though nothing about the universe changed. The symptom, as observed live:

- Restart the watcher (which `tsx watch` does on every file edit, and we do
  manually), and the keeper count resets from a converged `keeperCount` value
  down to 1–3, then crawls back **one ship per coordinator pass** (~1/min while
  the API rate-limits us). Scout and siphoner roles vanish entirely (the fleet
  "forgets" it bought them).
- The `paused` flag clears, so a fleet the operator deliberately halted goes
  back to spending credits.
- Manual/hold goals and dispatch overrides silently drop.

Whole-cloth re-derivation is *correct* but **expensive to converge**, and the
convergence itself issues API calls (shipyard scans, `getShip`) that add to the
rate-limit pressure we're constantly fighting.

### 1.1 What actually survives

SQLite tables in `src/engine/store.ts` (persist across restarts):

| Table | What it holds |
|---|---|
| `doctrine` | Operator-tuned rules (`keeperCount`, `shipCap:*`, …) |
| `market_snapshots` | Price intel the dispatcher and traders share |
| `shipyard_inventory` / `module_catalog` | Yard stock + mount availability |
| `ledger` / `activity` | Transaction and event history |
| `missions` | Construction-mission state (resumes "from prior state, PAUSED") |
| `buckets` / `bucket_ledger` | Capital buckets |
| `chat_messages` | Chat history |

### 1.2 What is in-memory only and lost

| State | Location | Cost of losing it |
|---|---|---|
| Role graph (`miners`, `traders`, `surveyors`, `scouts`, `siphoners`, `tours`, `keepers`) + `keeperMarkets` | `FleetManager` maps | Minutes of re-convergence + extra API calls |
| `paused` | `FleetManager.paused` | Silent, unwanted spending after a restart |
| Manual/hold goals, `pinnedMiningTarget`, per-ship overrides | `ShipAgent`/`ScoutAgent` | Operator intent discarded |
| Dispatcher route claims | `RouteDispatcher` | Recomputes fine (cheap, from persisted markets) |
| Survey pool | `SurveyPool` | Re-surveys |

**Positions are NOT lost.** Ship nav, cargo, fuel and cooldowns come live from
the API (`getShip`), and waypoints/markets re-survey or come from persisted
snapshots. We are losing *layered decisions*, not the ground truth — which is
exactly why re-derivation works but feels like a reset.

## 2. Design principle

**The SpaceTraders API is the source of truth for everything a ship *is*;
the engine is the source of truth for what a ship *does*.** Persist the
decisions only, keyed to the ship, and revalidate them against the API on
load. Do not persist anything that can be reliably re-read (nav, cargo, fuel —
re-fetching is always cheaper than storing or risking staleness).

Matching on `shipSymbol` is what makes this robust: if a ship was scrapped
while we were down, the persisted row is inert; the next registration pass
simply ignores it.

## 3. Data model

Two small tables, appended to `store.ts` (only as additive
`CREATE TABLE IF NOT EXISTS` — see §7 for the warehouse-agent overlap):

```sql
CREATE TABLE IF NOT EXISTS fleet_state (
  ship_symbol    TEXT PRIMARY KEY,
  role           TEXT NOT NULL,      -- miner|trader|surveyor|scout|tour|keeper|siphoner|idle
  keeper_market  TEXT,               -- non-null only for keepers
  note           TEXT,               -- human-readable station/role note
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_flags (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL               -- JSON scalar
);
```

`fleet_flags` holds tiny cross-ship toggles, starting with:

- `paused` → `true`/`false`

### 3.1 Store methods (in `src/engine/store.ts`)

Mirror the existing `getDoctrine`/`setDoctrine` shape:

- `getFleetState(): { shipSymbol: string; role: string; keeperMarket?: string; updatedAt: string }[]`
- `setFleetState(shipSymbol: string, role: string, keeperMarket?: string): void` (upsert)
- `removeFleetState(shipSymbol: string): void`
- `getFleetFlags(): Record<string, string>`
- `setFleetFlag(key: string, value: string): void`

## 4. Where we write

Writes happen **on change, never on tick** — the coordinator ticks every 2 s,
so a per-tick write would storm the DB. Every place a decision currently
changes:

| Hook | Where | What it writes |
|---|---|---|
| `assignRole()` | `src/engine/fleet.ts` | Every branch: role + keeper market (for parked keepers) |
| `maybeAssignKeepers()` | `src/engine/fleet.ts` | Converted ship → `keeper` + market; previous role row replaced |
| Scrap / removal paths | `fleet.ts` (scrap, keeper frees) | `removeFleetState(ship)` |
| `pause()` / `resume()` | `FleetManager` | `fleet_flags.paused` |
| Hold / dispatch-override setters | `FleetManager` / `ShipAgent` | Per-ship override row (v2, see §8) |
| Trader→miner promotion blocks in `init()` | `src/engine/fleet.ts` | The promote logic already mutates maps; also update the row |

The dispatcher, survey pool and trader mid-route progress are deliberately
**not** persisted: cargo routing is visible on the API's `Ship.cargo`, and a
restart's first `recompute` re-derives claims from persisted market snapshots.

## 5. Where we restore

In `FleetManager.init()`, after the existing registration loop
(`for ship of ships → assignRole`) but inside the same pass:

1. **Revalidate each persisted row.** `assignRole` already derives a natural
   role from mounts/frame/cargo; compare. If the persisted role is storable for
   the ship (e.g. `keeper` needs a probe/shuttle, `siphoner` needs a
   `MOUNT_GAS_SIPHON`, `scout` needs no cargo), apply the persisted role as an
   override — constructing the same agent class the natural branch would.
2. **Keepers restore immediately** from `keeper_market`, bypassing the
   one-per-pass convergence in `maybeAssignKeepers`. This alone removes the
   minutes-long keeper crawl after a restart.
3. **Flag ships whose persisted role no longer fits** (mount sold, ship
   upgraded): drop the row, let the natural `assignRole` decision stand, and
   log "restored role X for Y fell back to Z".
4. Apply `fleet_flags.paused` last.

Restore must be idempotent and must not issue a barrage of API calls — reuse
the `Ship` objects already fetched by `listAllShips()` in `init()`.

### 5.1 Explicit non-goal: hot-reload without loss

`tsx watch` will still restart the process on file edits; the fleet will still
re-`init()` every time. This plan makes restarts **cheap** (restore from a few
DB rows, no re-convergence), not invisible. If we later want edit-reload
without politics, that is a separate `tsx watch`/reload architecture decision
(hot module swap of single agents), not a persistence concern.

## 6. Rollout order

1. **Schema + store methods** (§3) — additive, no behavior change.
2. **Write hooks** (§4) — persist decisions as they happen; no restore yet, so
   it's observably inert after a restart even though rows exist.
3. **Restore + revalidate** (§5) — keepers and roles snap back on `init()`.
4. **`paused` flag** — halt state survives restarts (do we honor pause through
   a full cold boot? Decide: yes by default; the UI shows the flag).
5. **(v2)** Manual/hold/dispatch overrides — richer per-ship rows.

Acceptance test for 3: `kill` the watcher, note keeper/scout/siphoner counts,
restart, and require the counts to be identical **before the first**
`maybeAssignKeepers` pass (i.e. role restoration is synchronous with `init()`,
not convergent).

## 7. Coordination with the warehousing agent

The warehouse plan owns `trader.ts`, `dispatcher.ts`, and **adds tables to
`store.ts`**. To avoid stepping on it:

- Keep `fleet_state`/`fleet_flags` strictly **additive** `CREATE TABLE IF NOT
  EXISTS` blocks in `store.ts` — no alteration of existing tables.
- Put the new store methods next to the doctrine methods, matching their
  signatures so the merge is mechanical.
- Do **not** touch `trader.ts` or `dispatcher.ts`; role restoration for traders
  just re-creates a `TraderAgent` with the existing `traderOptions()` factory.
- If a shared-file merge feels risky, land the store helpers in a new
  `src/engine/fleetState.ts` that only *calls* `store` primitives, and have
  `store.ts` expose only the two `CREATE TABLE` clauses. Decide at review time.

## 8. Risks / open questions

- **Stale rows**: a persisted role is only as good as the API revalidation.
  We do a cheap mount/frame check on load; anything subtler (e.g. cargo-based
  trader promotion) re-runs `assignRole` logic. Acceptable.
- **Write frequency**: bounded to decision points, but `maybeAssignKeepers`
  and role transitions are bursts; use the existing sync SQLite writes (already
  the pattern for `setDoctrine`) and do not batch.
- **Pause on cold boot**: honoring `paused=true` after a full server restart
  means the operator must explicitly unpause — that is the desirable default;
  document it in the UI.
- **Survey pool**: deliberately left in-memory. If restarts outnumber survey
  lifetimes this becomes a bigger loss; revisit if surveys are a bottleneck.
- **Scout/siphoner persistence**: these roles were previously unrecoverable
  (nothing re-derived them). This doc fixes the *membership*; the
  purchases (`maybeBuyScout`, `maybeBuySiphoner`) already guard on "already have
  one", so a restart won't now double-buy them.

## 9. References

- Store tables: `src/engine/store.ts` (`doctrine`, `missions`, …)
- Role derivation: `FleetManager.assignRole()` — `src/engine/fleet.ts`
- Keeper convergence (one ship/pass): `maybeAssignKeepers()` — `src/engine/fleet.ts`
- Mission resume ("from prior state, PAUSED") proves the `missions` table path: `src/engine/mission.ts`
- Warehouse plan (shared-file caution): `docs/warehousing-plan.md` (§2 tables, §3 dispatcher, §7 API/UI)