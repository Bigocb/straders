# SpaceTraders: Gameplay & API Coverage Report

Research compiled from the SpaceTraders docs (docs.spacetraders.io game concepts,
API guide, README/roadmap) and the official OpenAPI spec
(`SpaceTradersAPI/api-docs`), compared against our engine (`src/engine/`,
`src/core/client.ts`, `src/server/`, `public/index.html`).

Sources:
- https://docs.spacetraders.io/game-concepts/* (agents, factions, systems, navigation, extraction, outfitting, maintenance, crew & morale, exploration, markets)
- https://github.com/SpaceTradersAPI/api-docs (OpenAPI spec, models, roadmap)
- Local: `src/core/client.ts` (API surface), `src/engine/*` (what we actually use)

---

## 1. API endpoints: what exists vs. what we use

The full spec has **62 endpoints**. Our client implements **38**. Missing:

### Unused endpoints (not in our client at all)

| Endpoint | What it does | Worth adding? |
|---|---|---|
| `POST /my/ships/{sym}/siphon` | Extract gas from a gas giant (SiphonDrone hulls) | **Yes** — new income stream, cheap drone hulls |
| `GET/POST /my/ships/{sym}/repair` | Preview cost + repair ship at a shipyard | **Yes** — ships degrade over time (condition) |
| `GET/POST /my/ships/{sym}/nav` | Set flight mode (DRIFT/STEALTH/CRUISE/BURN) + read nav | **Yes** — BURN speeds long hauls; DRIFT saves fuel |
| `POST /my/ships/{sym}/scan/ships` | Scan nearby player/derelict ships | Later (PvP/scavenge not released) |
| `POST /my/ships/{sym}/scan/systems` | Reveal nearby systems without charting | Later |
| `POST /my/ships/{sym}/scan/waypoints` | Reveal nearby waypoints + traits | **Maybe** — we already chart via scout |
| `POST /my/ships/{sym}/negotiate/contract` | Buy a faction contract on the spot | **Yes** — contract income beyond acceptBest |
| `POST /my/ships/{sym}/warp` | Warp within a system (needs warp drive) | Later |
| `GET /market/supply-chain` | Global market supply/demand overview | Later (analytics) |
| `GET /agents`, `GET /agents/{sym}` | Leaderboard / other agents | Later (PvP) |
| `GET /factions`, `GET /factions/{sym}` | List factions, traits, recruiting status | **Maybe** — we hardcode COSMIC at register |
| `GET /my/ships/{sym}/modules` / `mounts` | Read-only module/mount lists | Already covered by Ship payload |
| `POST /register` | Register new agent | We do this in `auth.ts` already |

### Endpoints we call but could use more carefully

| Endpoint | Current usage | Gap |
|---|---|---|
| `GET /my/ships` | `getMyShips(20, 1)` — **hardcoded page 1** in 3 places (`fleet.ts:157`, `fleet.ts:675`, `cli/index.ts:146`) | **Bug**: with >20 ships we silently lose ships. Need pagination loop (like `getAllSystemWaypoints`) |
| `GET /my/contracts` | `limit: 20`, no pagination | Same risk at 20+ contracts (unlikely but trivial to fix) |
| `GET /systems/{sys}/waypoints` | Paginated correctly via `getAllSystemWaypoints` | OK |
| `POST /my/ships/{sym}/refuel` | Uses `{units, fromCargo}` | OK — matches spec |
| `POST /my/ships/{sym}/scrap` | Correct | OK |
| `POST /my/ships/{sym}/survey` | Used by surveyor scouts | OK — but surveys **expire**; we don't track/purge expiry in the pool (see §5) |

---

## 2. Game concepts we have NOT progressed to

### 2.1 Crew and morale (concept page: crew-morale)
Ships have `crew: { current, required, capacity, rotation, morale, wages }`.
- Crew **wages are paid when a ship docks** at a civilized waypoint — a real ongoing
  expense we never model.
- `rotation` (STRICT/RELAXED) trades performance vs morale; morale affects
  accident probability and condition loss.
- **We don't touch any of this.** No crew management, no wage tracking, no morale
  effects. `SHIP_COMMAND_FRIGATE` requires crew — we fly it crewed but ignore
  wages and morale.
- **Gap**: add wage accounting to the ledger; expose crew/morale in the UI;
  optionally add a doctrine toggle for rotation.

### 2.2 Maintenance, condition & integrity (concept page: maintenance)
- Components have `condition` (repairable) and `integrity` (permanent wear).
- Condition degrades via **negative events** (ShipConditionEvent: hull strikes,
  coolant leaks, etc.) — ships get slower/less efficient as condition drops.
- **We never check `condition` and never repair.** `repairShip` is not in the
  client. Our engines/frames read `condition: 100` in the mock (`server/index.ts:357`)
  but the live ship payloads carry real condition we ignore.
- **Gap**: add a repair pass — when docked at a shipyard, if any component
  condition < threshold, `GET` repair cost and repair (from the Repairs bucket).

### 2.3 Siphoning (extraction concept: gas giants)
- `MOUNT_GAS_SIPHON_I/II/III` + `SHIP_SIPHON_DRONE` + `POST /siphon` extract
  gas (LIQUID_HYDROGEN, LIQUID_NITROGEN, AMMONIA_ICE) from gas giants — no
  mining laser, no cargo, no survey needed.
- **We own `SHIP_SIPHON_DRONE` hulls are available at C43** (seen in shipyard
  inventory) but never buy or use them.
- **Gap**: add a `siphoner` role (like miners but at GAS_GIANT waypoints),
  buy siphon drones when minerTarget is met.

### 2.4 Refining
- We DO refine (`refine()` in client, used in `agent.ts:755` with REFINE_RECIPES).
- But: it's gated behind `hasSurveyor()` — only surveyor-mounted miners refine.
  `SHIP_REFINING_FREIGHTER` hulls exist and we never buy them. Fine for now, but
  a dedicated refinery ship would earn more than refining inside mining loops.

### 2.5 Flight modes (navigation concept)
- DRIFT (50% fuel, 150% travel), CRUISE (default), BURN (200% fuel, 50% time),
  STEALTH (no fuel savings; hides from scans).
- **We never set flight mode.** Long empty return hops (trader going back to
  buyAt) are prime BURN candidates; short hops could DRIFT.
- **Gap**: set BURN on the loaded leg of long routes; DRIFT on empty repositioning.

### 2.6 Warp
- `MODULE_WARP_DRIVE_I/II/III` allow in-system warping for fuel, no navigation.
- We never buy warp drives. Lower priority than flight modes.

### 2.7 Scans (exploration concept)
- Charting: we do this (`chartShip` in scout). OK.
- Ship/system/waypoint scans: unused. Mostly PvP/derelict — defer.

### 2.8 Market mechanics we under-use

#### Supply & Activity
- `MarketTradeGood` carries `supply` (SCARCE…ABUNDANT) and `activity`
  (WEAK…RESTRICTED). We store `supply` in `market_snapshots` but **never read it
  for decisions**, and **`activity` is dropped entirely** (not in `MarketRow`).
- These are direct signals: SCARCE supply on a sell market = price will rise;
  ABUNDANT on a buy market = cheap. The fleet-loops doc already flags this as
  "still open".
- **Gap**: store `activity`; use supply/activity in route scoring (e.g. prefer
  routes whose sell market has SCARCE supply / STRONG activity).

#### Transactions & market history
- `Market.transactions` (recent trades at a market) — we don't store them.
  Would reveal what other players are buying/selling. Defer.

#### Growing markets
- The docs describe markets whose supply/activity evolve. We snapshot prices
  but don't track supply *trends* over time.

### 2.9 Factions
- We register with COSMIC and never look at factions again.
- `Faction.isRecruiting`, traits, and `POST /negotiate/contract` are unused.
- **Gap**: on `acceptBest()` empty, have a trader negotiate a contract at a
  faction HQ. Faction contracts also pay **reputation** — but see §3.

### 2.10 Contracts
- We accept, deliver, fulfill. Good.
- Missing: `negotiate/contract` (above); contract **type** awareness
  (TRANSPORT/OTHER) is unused; we don't track reputation earned.
- Contracts list is fetched with `limit: 20` once — fine at this scale.

---

## 3. Things we may be doing incorrectly

### 3.1 `getMyShips` pagination — real bug
`getMyShips(20, 1)` in three places. The spec returns `{data, meta}` with
`meta.total`. Once we pass 20 ships (we're at 16 and buying), we lose ships from
role assignment, auto-buy accounting, and the UI. Fix: paginate like
`getAllSystemWaypoints`.

### 3.2 Survey expiry is not tracked
`Survey` has `expiration`. `createAndPickSurvey` and `SurveyPool` don't seem to
purge expired surveys; a miner could fly to a field whose survey expired and the
`extract/survey` call fails (we saw "survey pending cooldown" patterns). We
handled this loosely with retries, but expired surveys should be dropped from
the pool immediately.

### 3.3 `extract/survey` vs `extract`
We use surveys when available; fine. But `createSurvey` costs a cooldown and
survey slots; for non-surveyor miners we correctly fall back to plain `extract`.

### 3.4 Purchase volume cap
Spec: "The maximum amount of units of a good that can be purchased in a single
transaction" — this is `tradeVolume`. Our traders use `tradeVolume` as the cap,
which is right. But our dispatcher exclusivity ("one trader per good") is
flagged in the fleet-loops doc as too strict for high-volume markets — a real
design issue, not an API misuse.

### 3.5 Ship role/registration mismatch
We assign roles ourselves (miner/trader/tour) but the API also returns
`registration.role` (COMMAND, HAULER, TRANSPORT, SATELLITE, etc.). We mostly
ignore the API role except for SATELLITE detection. Not wrong, but the API role
is a useful cross-check (e.g. we promoted a COMMAND frigate to trader — the API
agrees it's COMMAND).

### 3.6 Cooldown handling
We poll `getShipCooldown` and `waitCooldown`. Spec returns `Cooldown` with
`totalSeconds/remainingSeconds/expiration`. We use it — OK.

### 3.7 Rate limits
Spec allows a burst then a 1 req/sec limit. Our client backs off on 429 with
`retry-after` — correct. But we hammer markets in parallel (traders + shuttles +
dispatcher all call `/market`), which is why we see constant 429s. The
**dispatcher now shares one freshness window** (good), but the shuttles and
traders still hit the same markets independently. Could coalesce.

### 3.8 Fuel: `refuel` from cargo
We pass `fromCargo` — matches spec. Good.

### 3.9 Agent model
Our `Agent` in schema.d.ts may predate `reputation` — the live API Agent model
has no reputation field per the current spec (checked `Agent.json`), so no gap
there. Faction reputation is tracked server-side per faction; the client spec
doesn't expose it in Agent.

---

## 4. Gameplay options we haven't explored at all

From the roadmap (README):
- **Scavenge derelict ships** — not released yet (roadmap). Nothing to do.
- **Bounty hunting / piracy (PvP)** — not released. Nothing to do.
- **Webhooks** — roadmap; would be nice for notifications but not available.
- **Envoys / rumors** — roadmap. Not available.
- **Artifacts** — roadmap. Not available.

From the current API (all live today):
- **Siphoning** (gas extraction) — live, we don't do it. Biggest new income.
- **Ship repairs** — live, we ignore ship condition entirely.
- **Crew management** — live, we ignore wages/morale.
- **Flight modes** — live, we never toggle them.
- **Contract negotiation** — live, we only take what's offered.
- **Shipyard module/mount market data** — we record shipyard *ship* stock but
  the `modules`/`mounts` catalogs (which we DO store in `module_catalog`) aren't
  surfaced in the UI decisions (no outfitting logic buys upgrades automatically).

---

## 5. Recommendations (priority order)

1. **Fix `getMyShips` pagination** (bug, quick).
2. **Store `activity` in market snapshots**; use supply+activity in dispatcher
   route scoring (unlocks smarter trading; doc already flags it).
3. **Flight modes**: BURN on long loaded legs, DRIFT on empty returns (big
   time/fuel win, one client method + nav patch).
4. **Siphoner role**: buy `SHIP_SIPHON_DRONE`, extract gas at GAS_GIANT
   waypoints (new income stream; we already see the hull in shipyards).
5. **Repair pass**: when docked at a shipyard, repair components below a
   condition threshold, funded from the Repairs bucket.
6. **Crew accounting**: ledger crew wages on docking; surface crew/morale in UI.
7. **Survey expiry**: drop expired surveys from the pool immediately.
8. **Contract negotiation**: fallback income when no contract is offered.
9. Later: scans, warp, faction reputation UI, supply-chain analytics.

---

## 6. Appendix: full endpoint diff

**We have (38):** `/` status, register (via auth.ts), my/agent, my/contracts(+3),
my/ships(+20: cargo, chart, cooldown, dock, extract, extract/survey, jettison,
jump, modules/install+remove, mounts/install+remove, navigate, orbit, purchase,
refine, refuel, scrap, sell, survey, transfer), systems(+8: list, get, waypoints,
waypoint, construction(+supply), jump-gate, market, shipyard), factions/{sym}.

**Missing (24):** agents(+2), factions (list), market/supply-chain, my/ships/
{nav (PATCH flight mode), negotiate/contract, repair, scan/ships, scan/systems,
scan/waypoints, siphon, warp, modules (GET), mounts (GET)}.
