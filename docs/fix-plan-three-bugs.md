# Fix Plan: Three High-Priority Bugs

Targets (from the coverage report):
1. `getMyShips(20, 1)` hardcoded page 1 in 3 places — ships lost past 20
2. Survey expiry not tracked — expired surveys linger
3. Rate-limit pressure from parallel market polling

---

## 1. Fix `getMyShips` pagination

### Problem
`Client.getMyShips(limit, page)` already supports pagination
(`src/core/client.ts:198`), but every caller hardcodes `(20, 1)`:

- `src/engine/fleet.ts:157` — fleet init / role assignment
- `src/engine/fleet.ts:675` — hull counting in `maybeBuyShip`
- `src/cli/index.ts:146` — dashboard state refresh

The API returns `{ data: Ship[], meta: { total } }`. At 20+ ships, ships past
page 1 silently vanish from role assignment, cap counting, and the UI.

### Fix
1. Add a paginated helper to the client (mirroring
   `getAllSystemWaypoints`, `src/core/client.ts:245`):

   ```ts
   /** Fetch ALL owned ships, following pagination. */
   async getAllMyShips(): Promise<Ship[]> {
     const out: Ship[] = [];
     let page = 1;
     for (;;) {
       const batch = await this.getMyShips(20, page);
       out.push(...batch);
       if (batch.length < 20) break;
       page += 1;
     }
     return out;
   }
   ```

2. Replace the three call sites:
   - `fleet.ts:157` → `await this.api.getAllMyShips()`
   - `fleet.ts:675` → `await this.api.getAllMyShips()`
   - `cli/index.ts:146` → `await api.getAllMyShips()`

3. Add a regression test: mock client returns 2 pages (20 + 5), assert all 25
   ships come back (pattern exists in `tests/client.test.ts`).

### Verification
- `npx tsc --noEmit`, `npm test`
- With 16 ships today nothing changes; at 21+ the extra ships appear in role
  assignment and the UI.

---

## 2. Track survey expiry

### Problem
Two places hold surveys across time:

1. **`SurveyPool`** (`src/engine/survey.ts`) — already filters expired surveys
   on every read (`isExpired` in `pick`/`list`/`count`/`prune`, and on
   `record`). The pool itself is **fine**.

2. **`ShipAgent.mineAndRefine`** (`src/engine/agent.ts:738`) — holds ONE
   `survey` object for the whole mining loop (`while safety < 60`). Each
   `waitCooldown()` can take 60–70s, and surveys expire quickly. If a survey
   expires mid-loop:
   - `extractWithSurvey` fails with an error that does **not** match the
     `exhaust|expire|signature|invalid` regex (`agent.ts:803`), so we fall to
     `extract failed: ...` and `return` — the miner stalls for a tick instead
     of re-surveying. (The regex matches some messages, but expiry errors are
     not guaranteed to contain those words.)
   - Even when the regex matches, we re-pick/re-survey — but we never
     proactively check expiry **before** calling `extractWithSurvey`.

### Fix
1. Export the expiry check from `SurveyPool`:

   ```ts
   /** True if the survey has expired (public helper for loop code). */
   isExpired(s: Survey): boolean { return isExpired(s); }
   ```

2. In `mineAndRefine` (`agent.ts:785`), before each `extractWithSurvey` call:

   ```ts
   if (survey && this.surveyPool?.isExpired(survey)) {
     this.log("survey expired mid-run; re-picking");
     survey = this.hasSurveyor()
       ? await this.createAndPickSurvey()
       : this.surveyPool?.pick(this.ship.nav.waypointSymbol, (d) => Boolean(REFINE_RECIPES[d]));
     if (!survey) return;
   }
   ```

3. Widen the server-error regex at `agent.ts:803` to also match expiry wording
   (`expired|no longer valid|has expired`).

4. Add a unit test for `SurveyPool.isExpired` and for the pick-after-expiry
   behavior (construct a survey with `expiration` in the past, assert
   `pick` returns undefined and `isExpired` returns true).

### Verification
- `npm test`
- Watch logs: "survey expired mid-run" should appear instead of
  "extract failed" / stalls during long mining sessions.

---

## 3. Reduce rate-limit pressure from parallel market polling

### Problem
The API allows ~1 req/s sustained (burst then throttle). We hammer `/market`:

- `TraderAgent.liveBuyPrice` / `liveSellPrice` (`trader.ts:332/343`) — called
  on **every** buy/sell decision, by 6 traders, same waypoints.
- `TraderAgent.observeMarket` (`trader.ts:293`) — full market fetch + record.
- `ShipAgent.observeMarket` (`agent.ts:377`) — tour shuttles fetch every market
  they dock at.
- `FleetManager.recordMarketSnapshot` (`fleet.ts:371`) — every dock triggers a
  `getMarket`.
- `galaxy.surveyMarkets` — system-wide sweeps.

Result: 6 traders + 4 shuttles all fetch the **same** waypoint's market within
the same minute → constant 429s (visible in logs: "rate limited, backing off").

### Fix — shared market cache with in-flight dedupe
1. **New module** `src/engine/marketCache.ts`:

   ```ts
   interface CachedMarket { data: unknown; fetchedAt: number; }

   /** Shared in-memory market cache: one fetch per waypoint per TTL, deduped. */
   export class MarketCache {
     private cache = new Map<string, CachedMarket>();
     private inflight = new Map<string, Promise<unknown>>();
     constructor(private readonly ttlMs = 30_000) {}

     async get<T>(key: string, fetch: () => Promise<T>): Promise<T> {
       const hit = this.cache.get(key);
       if (hit && Date.now() - hit.fetchedAt < this.ttlMs) return hit.data as T;
       const pending = this.inflight.get(key);
       if (pending) return pending as Promise<T>;
       const p = fetch().then((data) => {
         this.cache.set(key, { data, fetchedAt: Date.now() });
         this.inflight.delete(key);
         return data;
       }).catch((e) => { this.inflight.delete(key); throw e; });
       this.inflight.set(key, p);
       return p;
     }
   }
   ```

2. **Wire it into the fleet** — one shared instance on `FleetManager` (like
   `dispatcher`), passed to traders/shuttles as a callback
   `getMarketCached: (system, waypoint) => Promise<Market>`.

3. **Use it in the intel paths** (TTL 30s is fine — prices move slowly):
   - `TraderAgent.observeMarket` → `getMarketCached`
   - `ShipAgent.observeMarket` → `getMarketCached`
   - `FleetManager.recordMarketSnapshot` → `getMarketCached`
   - `TraderAgent.liveBuyPrice` / `liveSellPrice` → keep **live** (no cache):
     these are the exact moment-of-trade prices and must not be stale. But the
     trader is docked at the market at that point, so it's 1 call per trade —
     cheap. Optionally use a **5s** TTL variant to collapse the rare
     double-fetch (leftover-clear + main buy on the same tick).

4. **Throttle `surveyMarkets`** (system-wide sweep in `galaxy.ts`) — already
   rate-limited by the client; leave as is.

### Verification
- `npm test`
- Grep logs: "rate limited" frequency should drop sharply.
- UI markets view still refreshes (TTL 30s < the 20s poll interval).

---

## Order of work

1. **§1 pagination** (15 min, isolated, testable).
2. **§2 survey expiry** (20 min, isolated, testable).
3. **§3 market cache** (45 min, touches trader/agent/fleet — the biggest
   surface, do last and re-run the full suite + watch logs).

Each lands independently; the fleet keeps trading throughout.
