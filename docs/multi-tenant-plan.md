# Bring-Your-Own-Key: Design & Implementation Plan

A plan for letting anyone run their own fleet against their own SpaceTraders
account through this dashboard — on their own machine, or on a server you host
for many people at once — instead of the current setup, where the token comes
from a `.env` file and the whole deployment is one person's fleet.

This is a plan, not a build. Nothing here is implemented yet except Phase 0,
which shipped as the prerequisite for all of it.

---

## The good news first

Before designing anything, it's worth checking how much of the engine already
assumes "exactly one fleet." Looking at the actual constructors:

```ts
new Client({ token, baseUrl, ... })              // token is a constructor arg
new Store(dbPath)                                 // dbPath is a constructor arg
new FleetManager({ api, store, ... })              // api/store are injected
new MissionManager({ api, store, ... })            // same
new ChatAgent({ ... })                             // same
new FleetState()                                   // plain object, no globals
```

**None of the engine core — `Client`, `Store`, `FleetManager`,
`MissionManager`, `ChatAgent`, `FleetState`, `RouteDispatcher`, `GalaxyAtlas`
— reaches for a global singleton or a module-level env var read.** Every
dependency is passed in at construction. This was presumably never done *for*
multi-tenancy, but it means the object model is already shaped right for it.

The parts that assume "exactly one" are all in the **orchestration layer**,
and there are exactly four of them:

| What | File | The assumption |
|---|---|---|
| Boot sequence | `src/cli/index.ts` | Reads env vars once, constructs one of everything, runs one engine loop, starts one server |
| Route handlers | `src/server/index.ts` | `startServer(opts)` closes over one `{state, store, fleet, chat}` bundle for every route |
| Token storage | `src/core/auth.ts` | One flat file (`.st-token`) or one env var (`ST_TOKEN`) |
| Discord relay | `src/engine/discord.ts` | `getDiscord()` is a lazily-constructed module-level singleton |

That's the entire blast radius of "make this multi-tenant." Everything below
is about redesigning those four things — not the engine.

---

## Two deployment shapes, one design

You described two cases: someone running this on their own machine, and you
hosting it for a bunch of people. They're the same problem at different
scale, and the design below serves both — the only difference is how many
tenant slots the `TenantRegistry` (below) ever has active at once.

| | Self-hosted | Hosted |
|---|---|---|
| Processes | 1 | 1 (to start) |
| Tenants per process | 1 | N |
| Who enters a key | The operator, once, on first run | Any visitor, on signup |
| Data isolation | N/A (only one tenant) | Required |
| Idle/lifecycle management | N/A | Required at scale |

Building the hosted version *is* building the self-hosted version with a
tenant count of 1. There's no reason to build them separately.

---

## Phase 0 — done: the shared-secret gate

Just shipped (`5ab59b0`): every `/api/*` route sits behind one operator
token (`ST_DASHBOARD_TOKEN`), and the dashboard shows a login screen that
takes it, stores it in `localStorage`, and attaches it to every request via
an overridden `window.fetch`.

This isn't multi-tenant — it's one shared password for one fleet, which is
exactly what the current single-tenant deployment needs. But it's the
**exact UI shape** the real thing needs too: a gate screen, a token field, a
validate-then-store flow, a 401 handler that re-shows the gate. Phase A
below reuses this component; it just changes what the token *means* and what
validates it.

---

## Phase A — bring your own SpaceTraders key (self-hosted, single tenant)

**Goal:** remove the requirement to hand-edit `.env`/`.st-token` before first
run. The operator opens the dashboard, pastes their SpaceTraders **agent**
token (or registers a new one), and the fleet boots from there. Still one
process, one fleet — this is a friction fix, not an architecture change.

### What changes

1. **Engine boot becomes lazy, not startup-time.** Today,
   `src/cli/index.ts` reads the token, constructs `FleetManager`, and calls
   `.run()` before the server even starts listening. That has to split:
   the server starts immediately (so the setup screen has somewhere to
   load from), and the engine boots on first successful connect instead.

2. **New setup screen**, reusing the Phase 0 gate component. If
   `getToken()` returns nothing on boot, the server starts in "unconfigured"
   mode: `/api/*` returns 503 except a new `POST /api/setup/connect`.
   The frontend shows the connect screen instead of the login screen
   (same component, different copy and different endpoint).

3. **`POST /api/setup/connect`**: accepts either an existing agent token or
   `{ agentSymbol, accountToken, faction }` to register a new one (this
   already exists as CLI logic in `registerAgent()` — just needs an HTTP
   entry point). Validates via `GET /my/agent`, calls `saveToken()`, then
   constructs and starts the `FleetManager` for the first time. From here
   the process behaves exactly as it does today.

4. **`ST_DASHBOARD_TOKEN` still applies on top of this**, unchanged — it's
   an orthogonal "who's allowed to touch this dashboard at all" gate, not a
   replacement for it. A self-hoster on their own LAN might not bother
   setting it; someone exposing their instance to the internet still should.

### Effort

Small. No schema changes, no new tables. The engine boot sequence moves
from "always, at process start" to "once, on first successful connect,"
and stays that way for the rest of the process's life. A few days including
the setup-screen UI.

---

## Phase B — hosted multi-tenancy

**Goal:** one process, one deployment, serving N independent fleets — each
tenant's own SpaceTraders agent, own ships, own dashboard view, own
everything, with no tenant able to see or affect another's.

### The one decision that keeps this small: per-tenant SQLite files, not per-tenant rows

The schema in `src/engine/store.ts` has ten tables and zero tenant-scoping
columns. The obvious-looking fix is adding a `tenant_id` column to every
table and an `AND tenant_id = ?` clause to every one of `Store`'s ~30 query
methods. **Don't do that.** It touches every query in the file, it's the
kind of change that's easy to get one clause wrong in, and a forgotten
`WHERE` clause is a cross-tenant data leak, not a bug report.

Instead: **`Store` already takes a `dbPath` in its constructor.** Give each
tenant their own SQLite file:

```
.st-data/
  control.db                    ← new: the tenant registry itself
  tenants/
    <tenantId>/
      startraders.db            ← existing schema, completely unchanged
```

Isolation becomes "these are different files on disk," which is isolation
you don't have to audit query-by-query. `Store`'s code doesn't change at
all. This is the single highest-leverage decision in this whole plan.

The tradeoff: `market_snapshots`, `shipyard_inventory`, and `module_catalog`
hold **public galaxy data** — the same markets and prices for everyone on
the same server reset — and per-tenant files mean every tenant's shuttles
independently rediscover the same markets. That's wasted API calls and
wasted shuttle-hours, duplicated per tenant. Accept this for v1 — it costs
nothing to isolation and nothing to correctness, just some redundant
legwork. If it matters later, those three tables (only those three — they're
the only ones with no per-agent data in them) can move to a shared read-only
galaxy DB that every tenant's engine reads from and writes to. Don't build
that until the duplication actually shows up as a cost worth solving.

### New control-plane table (`control.db`)

```sql
CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,        -- random id, not the agent symbol (symbols can be reused across resets)
  agent_symbol  TEXT NOT NULL,
  token_enc     BLOB NOT NULL,           -- AES-256-GCM, see below
  token_iv      BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  discord_webhook_enc BLOB,              -- moves Discord off the module-level singleton
  discord_webhook_iv  BLOB
);
CREATE UNIQUE INDEX idx_tenants_symbol ON tenants (agent_symbol);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,        -- random, goes in the cookie
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
```

One extra table, one extra file. Nothing in `src/engine/` needs to know this
exists.

### Auth: the SpaceTraders token *is* the credential

No separate password, no email/OAuth — the agent token already proves you
control that fleet (SpaceTraders itself is the identity provider). Login
flow:

1. User pastes their agent token into the gate screen (same component as
   Phase 0/A again).
2. Server calls `GET /my/agent` with it. If that succeeds, the symbol in
   the response *is* the tenant identity.
3. Look up or create a `tenants` row. Encrypt the token
   (`crypto.createCipheriv("aes-256-gcm", masterKey, iv)`, `masterKey` from
   a new `ST_SESSION_SECRET` env var — Node's built-in `crypto`, matching
   how `src/server/auth.ts` already avoided pulling in a dependency for
   Phase 0).
4. Create a `sessions` row, set an httpOnly signed cookie with the session
   id. No JWT library needed — HMAC-sign the cookie value with the same
   master key, the same pattern `createAuthMiddleware` already uses for the
   dashboard token.
5. A new `resolveTenant` middleware reads the cookie, looks up the session,
   attaches `req.tenant` (the running `TenantWorker`, below) before any
   route handler runs.

**Registering a new agent** (no token yet) reuses the same
`registerAgent()` flow as Phase A, just with the account-token field also on
the gate screen.

**Token rotation**: SpaceTraders lets an agent regenerate its token, which
invalidates the one you've stored. Dashboard needs a "reconnect" action —
same as initial connect, just overwrites the stored `token_enc` for an
existing tenant instead of creating a new row.

### Runtime: the `TenantRegistry`

```ts
interface TenantWorker {
  id: string;
  api: SpaceTradersAPI;
  store: Store;
  state: FleetState;
  fleet: FleetManager;
  chat?: ChatAgent;
  discord?: DiscordRelay;
}

class TenantRegistry {
  private active = new Map<string, TenantWorker>();
  async getOrStart(tenantId: string): Promise<TenantWorker> { ... }
  async stop(tenantId: string): Promise<void> { ... }
}
```

`getOrStart` decrypts the stored token, constructs `Client` → `Store`
(pointed at that tenant's own file) → `FleetManager` → calls `.run()`, and
caches the bundle. This is exactly what `src/cli/index.ts` does today for
the one global fleet — it just becomes a function instead of the top of
`main()`.

**Lifecycle — important nuance:** this product's whole point is a fleet that
plays itself while you're not watching. Don't idle-shutdown a tenant's
engine because their dashboard tab is closed — that would defeat the
premise. Once a tenant's `TenantWorker` starts, it keeps running until the
process restarts or the operator explicitly stops it. Capacity management
is about **how many tenants a given host is willing to run concurrently**
(a signup cap, or a waitlist), not about pausing active ones. On process
restart, re-hydrate every row in `tenants` back into a running
`TenantWorker` — one tenant failing to boot (bad cached token, transient
API error) must not block the others; log it and mark that tenant degraded
rather than crashing the loop.

### The real scaling risk: `better-sqlite3` is synchronous

`better-sqlite3` blocks the Node event loop for the duration of every query
— by design, that's how it gets its performance. With one tenant, that's
fine: sub-millisecond queries, nobody's waiting. With N tenants sharing one
process, tenant B's dashboard request stalls for however long tenant A's
market-snapshot write takes, because they're on the same event loop.

Two honest options, and a clear recommendation on sequencing:

- **Start single-process, multi-instance-in-thread.** Multiple
  `FleetManager`s just co-resident in one Node process, as designed above.
  Simplest possible v1, ships fast, and for a small number of hosted
  tenants (rough guess: under ~15–20, each with a handful of ships) the
  blocking windows are small enough not to matter in practice. **Build
  this first.**
- **Move to one `worker_threads.Worker` per active tenant** if and when
  it does matter. Each worker runs its own `Client`+`Store`+`FleetManager`
  in total isolation — genuinely separate event loops, so one tenant's DB
  write can never stall another's dashboard load. `worker_threads` is
  Node stdlib, no new dependency, and the unit of work (one tenant's
  `{api, store, fleet}`) is already exactly the right shape to hand to a
  worker unchanged. The main process becomes a thin router: resolve
  tenant → `worker.postMessage()` the request → relay the response. This
  is a bigger lift (a real IPC boundary between the HTTP layer and the
  engine) — don't build it speculatively. Build it when a specific host's
  tenant count actually demonstrates the blocking cost.

### Server routing

Every route handler in `src/server/index.ts` currently reads `opts.fleet`
and `opts.store` — the one global bundle passed into `startServer`. Under
multi-tenancy those become `req.tenant.fleet` / `req.tenant.store`, resolved
by the `resolveTenant` middleware before the route runs. The route bodies
themselves barely change — swap the closed-over `opts.X` for the
per-request `req.tenant.X` and the existing logic (all ~40 endpoints) is
otherwise untouched, because none of it ever assumed anything about *which*
fleet it was looking at.

### Discord and the co-pilot: two different cost/abuse shapes

- **Discord** is free to make per-tenant — it's already a user-supplied
  webhook URL (`POST /api/discord`), it just needs to live in the `tenants`
  row instead of a module singleton, and `getDiscord()` becomes
  `tenant.discord`.
- **The co-pilot is not free** — it spends `ST_LLM_API_KEY`, which is
  *your* key if you're hosting this for others. Letting any visitor who
  signs up burn your LLM budget is a real cost and abuse vector, and asking
  a casual visitor to also bring their own LLM key is a lot of friction for
  a nice-to-have feature. Recommendation: co-pilot **off by default per
  tenant**, with a hard per-tenant request/token cap if you choose to fund
  it for everyone — don't ship it wide open on day one of hosted mode.

### Migration for the existing deployment

`star.cloutier.work` is a real, already-running single-tenant instance —
whatever ships here needs to absorb it without data loss, not start it over:

1. `.st-data/startraders.db` → becomes tenant #1's file, moved as-is to
   `.st-data/tenants/<new-id>/startraders.db`. No schema migration inside
   it — the per-tenant schema is byte-for-byte what exists today.
2. `.st-token` → one row inserted into the new `tenants` table (encrypt it
   with the new `ST_SESSION_SECRET`, one-time script).
3. `ST_DASHBOARD_TOKEN` (Phase 0) doesn't go away — keep it as a distinct
   **operator/admin** gate (e.g. for a future admin view listing all
   tenants), separate from individual tenant login. Two different
   questions — "is this dashboard reachable at all" vs. "which fleet am I
   looking at" — stay two different mechanisms.

---

## Sequencing and rough sizing

| Phase | Scope | Size | Depends on |
|---|---|---|---|
| 0 | Shared dashboard secret | Done | — |
| A | Bring-your-own-key, single tenant | Small (days) | Phase 0's gate UI |
| B-lite | Hosted, multi-instance in one process, per-tenant SQLite files | Medium (a week+) | Phase A's connect/validate flow |
| B-full | Worker-thread isolation, admin tooling, token rotation UI, abuse limits | Large | B-lite running in production, and evidence it needs it |

Each phase is a complete, shippable thing on its own — this isn't a plan
that only pays off at the end.

## Explicit non-goals (for now)

- **Billing/payments.** Not designed here at all.
- **Horizontal scaling** across multiple machines/load balancers. Single-box
  multi-tenant is the v1 target; the `TenantRegistry` design doesn't block a
  later move to "route tenant X to host Y," but nothing here builds it.
- **OAuth/social login.** The SpaceTraders token already is the credential;
  adding a separate identity system on top would be solving a problem this
  product doesn't have.
- **Teams / shared fleet access.** One login owns one fleet in this design.
  Multiple humans sharing control of one fleet is a different, later
  feature (would need real per-user accounts distinct from the tenant/fleet
  identity, which this plan deliberately conflates for simplicity).
