# Engineering review

A review of the fleet engine, server and command centre, carried out against
commit `1e8da27`. Status reflects the current head of
`claude/space-traders-assessment-t1d5aq`.

Baseline at time of review: `npm run typecheck` clean, `npm test` 22/22 passing.

| | |
| --- | --- |
| **Open — critical** | 0 |
| **Open** | 12 |
| **Fixed on this branch** | 11 |

---

## Open — correctness

### Stale prices drive live trades

`TraderAgent.loadSnapshots()` (`src/engine/trader.ts:323`) seeds its price table
from `store.latestMarketSnapshots()`, which has no age bound — a six-hour-old
snapshot ranks equally with one from a minute ago. `findRoute()` picks from that
table, then `tick()` navigates to `buyAt` and purchases without re-reading the
market on arrival. SpaceTraders prices move on every trade, including your own.

**Fix:** add a max-age filter to `loadSnapshots`, and re-verify the spread after
docking at `buyAt` before committing the purchase.

### No price-impact modelling

`volume = min(buy.volume, sell.volume, cargo, affordable)` and profit is
`margin * volume` at the flat quoted price (`trader.ts:281`, and the same in
`agent.ts:533`). Buying a full `tradeVolume` in one transaction moves the price
against you, so realised profit sits systematically below predicted.

**Fix:** apply a haircut factor, or split large buys across ticks.

### `TraderAgent.navigateTo` has no fuel pre-check

`ShipAgent.navigateTo` (`agent.ts:202`) checks `fuel.current < need` and bails
with a "stranded?" log. The trader's equivalent (`trader.ts:172`) calls
`navigateShip` and lets it throw into a 10-second backoff. `findRoute` also never
checks whether the ship can reach `buyAt` from where it currently is.

This is likely *why* the fuel-tender rescue machinery exists. Fixing the
pre-check upstream would make that code load-bearing for far fewer situations.

### `bestTrades()` ranks by margin %, ignoring distance and volume

`store.ts:484` takes `MIN(purchasePrice)` and `MAX(sellPrice)` per good
independently across every known market, with no fuel cost between the two
waypoints and no volume weighting. `crossSystem` is computed but only flagged,
never excluded.

This feeds both the dashboard's "best routes" **and** the co-pilot's
`get_best_trades` tool, so the UI and the AI advisor both recommend routes that
may be 400 fuel apart for 3 units of volume.

**Fix:** rank by estimated profit per round trip, net of fuel.

---

## Open — performance and scale

### The database grows without bound

`market_snapshots` gains a row per good per dock, forever. There is no pruning,
no retention and no `VACUUM` anywhere in `store.ts`. Both
`latestMarketSnapshots()` and `bestTrades()` run a `ROW_NUMBER()` window scan
over the *entire* table, and the dashboard polls `/api/intel` every 10 seconds.

After a few days this goes from milliseconds to seconds — and `better-sqlite3` is
synchronous, so it blocks the event loop that is also running the fleet.

**Fix:** a retention sweep, or maintain a `market_latest` upsert table on write.
The `unique_key` pattern already used for `shipyard_inventory` is the model.

### Dashboard polling has no backpressure

Nine `setInterval` timers, no `visibilitychange` pause, no ETag/304. A
backgrounded tab keeps polling at full rate. The 3-second activity feed is the
obvious first candidate for SSE — the server already holds a single shared
`FleetState`.

---

## Open — frontend

### Partial HTML escaping

36 `innerHTML` assignments against 17 `escapeHtml`/`escapeAttr` uses. The room
focus panel and mission list escape correctly; the older renderers (feed,
markets, shipyard intel, ship details) still interpolate raw. Not exploitable
while all data originates from the SpaceTraders API and the engine itself, but
worth closing on a publicly reachable URL — the activity `detail` field is the
one most worth hardening.

### Google Fonts is a render-blocking third-party request

`public/index.html` links three families from `fonts.googleapis.com` on every
load. Confirmed load-bearing: when the request is blocked, the UI silently falls
back to generic monospace and sans-serif. Self-hosting removes it.

---

## Open — architecture

### Two independent writers against one account

`game/autoload/api.gd` reads `.st-token` and issues navigate/dock/extract/
purchase/sell straight to `api.spacetraders.io`, with its own 2 req/s bucket
(`api.gd:52`), while the Node engine runs its own limiter against the same cap.
Run both and you are at 4 req/s against a 2 req/s limit — you will eat 429s, and
the Node client's retry will amplify the burst rather than damp it. Worse, both
can command the same ship with no shared view of intent.

**Decide what the Godot client is.** If it's a *viewer*, point it at the Node
server's `/api/*` endpoints — it inherits the shared limiter, the SQLite intel
and the fleet's role assignments for free. If it's a *commander*, the Node server
must become the single writer and Godot must go through it.

---

## Open — dead code

| Item | Location | Note |
| --- | --- | --- |
| `NarrativeWriter` never called | `engine/narrative.ts:112` | Fully implemented LLM captain's log with token-saving cache. `/api/narrative` calls the templated `generateLog` fallback instead, so the log is always the template. README Phase 7 describes the unwired version. Highest value-per-effort item here. |
| `wantTrader` dead branch | `engine/fleet.ts:269` | `const wantTrader = false;` then `if (… && !wantTrader)` — always true. |
| `maxCargoCapacity` unused | `engine/fleet.ts:99,153` | Assigned in `init()`, never read. |
| `Client.withToken()` unused | `core/client.ts:82` | Also constructs a **fresh rate limiter**, so if anything ever calls it the allowed request rate silently doubles past the API cap. |

---

## Fixed on this branch

All verified by a browser smoke test (40 checks) driving the real page against a
mock backend, plus `typecheck` and the existing 22 unit tests.

| Finding | Commit |
| --- | --- |
| Per-ship "stop"/"resume" buttons POSTed to `/api/fleet/pause` and `/api/fleet/resume`, which ignore the body and halt the **entire fleet**. Added `FleetManager.holdShip` + `POST /api/fleet/hold`. | `f7c7ad6` |
| Recovery zone branched on `status.blocked`, a field `getShipStatuses` never returned, so it could never render. Now joined from the `stranded` array. | `f7c7ad6` |
| Room filters used `ship.registration.role`, so a promoted COMMAND frigate showed in Ops and surveyor/tour/idle ships appeared in **no room at all**. Now keyed on the engine's role, with Ops as a catch-all. | `f7c7ad6` |
| Five containers (`fleet`, `contracts`, `missions`, `markets`, `loadout`) were referenced by JS but absent from the markup. `renderMissions` threw a `TypeError` every 10s, swallowed by a `catch`. Contract-accept and mission controls had **no reachable UI**. | `f7c7ad6` |
| Intel and Command rooms were shells whose elements were never referenced by any code. | `f7c7ad6` |
| Stranded banner was appended to `#map-wrap` and hidden by `display:none` outside the map room. | `f7c7ad6` |
| `/api/loadout` refreshed on a blind 30s timer, triggering a live shipyard sweep across every known system and competing with the engine for the rate limit — to render into a null container. Now refreshes only while its room is open. | `f7c7ad6` |
| Mining room's "Force Survey" called `/api/fleet/explore`, which jumps the ship to another system. Label did not match behaviour. | `f7c7ad6` |
| 1100px breakpoint mapped to a `map` grid area that no longer existed, so `main` was never placed. `100vh` → `100dvh`. | `f7c7ad6`, `25a293d` |
| Dead `.ship` CSS (~88 lines), orphaned `idleReasonFor`, and a duplicate `loadIntel` declaration whose first copy could never run. | `25a293d` |
| **No authentication on the command centre** — every `/api/*` route now sits behind `ST_DASHBOARD_TOKEN`, checked via a shared-secret middleware (`src/server/auth.ts`). The dashboard gates itself behind a login screen when the server requires a token, and skips it silently when unset (local/dev). Deliberately a single shared secret, not per-operator accounts — see `docs/multi-tenant-plan.md` for that. | `PENDING` |

---

## Suggested order

1. Auth in front of the mutating endpoints.
2. Wire `NarrativeWriter` — it is already written.
3. Snapshot max-age + re-verify the spread before purchase.
4. Rank `bestTrades` by profit per trip, net of fuel.
5. Retention on `market_snapshots`.
6. Decide what the Godot client is, and route it accordingly.
