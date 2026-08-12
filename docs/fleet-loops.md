# Fleet Loops: How the Engine Actually Works

This document explains the four autonomous loops that drive the fleet, where each
one lives in the code, and how they interact. It was written to pin down exactly
what's happening so we can reason about the conflicts (route convergence, stale
intel, dispatcher churn). Section 6 records the convergence bug and its fix.

---

## 0. The cast of characters

| Thing | File | What it is |
|---|---|---|
| `FleetManager` | `src/engine/fleet.ts` | The coordinator. Owns every ship, assigns roles, runs the dispatcher, buys/scraps ships, rescues stranded ships. |
| `TraderAgent` | `src/engine/trader.ts` | A cargo-capable ship that buys low / sells high. |
| `ShipAgent` | `src/engine/agent.ts` | The generic agent used for miners, surveyors, and tour shuttles. |
| `RouteDispatcher` | `src/engine/dispatcher.ts` | Centralized route allocation: hands each trader a distinct good. |
| `Store` | `src/engine/store.ts` | SQLite persistence: market snapshots, ledger, shipyard inventory, doctrine, buckets. |
| `GalaxyAtlas` | `src/engine/galaxy.ts` | Known systems, waypoint positions, jump-gate connections. |

---

## 1. The coordinator loop (`FleetManager.tick`)

**Code:** `src/engine/fleet.ts:1461` (`tick`), driven by `run` at `src/engine/fleet.ts:1773`.

Every **2 seconds** the coordinator does one pass:

1. Refresh the credit balance (`getMyAgent`).
2. Fulfill/accept contracts.
3. **Recompute dispatcher assignments** (`dispatcher.recompute(computeDispatchRoutes(), traders)` at `fleet.ts:1477`).
4. Maybe buy a ship (`maybeBuyShip`), maybe buy a scout (`maybeBuyScout`).
5. Auto-explore connected systems (`autoExplore`).
6. Rescue stranded ships (`rescueStranded`).
7. Tick missions.

The coordinator does **not** move ships itself — it only decides policy. Each ship
runs its own loop (below) and reads the coordinator's decisions (assignments,
suspension flags, manual dispatch) on every tick.

---

## 2. The trader loop (`TraderAgent.tick` / `runLoop`)

**Code:** `runLoop` at `src/engine/trader.ts:700`, `tick` at `src/engine/trader.ts:534`.

Each trader runs an independent `while` loop. One iteration:

1. **Refresh** the ship from the API.
2. If **manually dispatched**, hold at the waypoint until released.
3. **Rebuild the price table** from the store's *fresh* snapshots (`loadSnapshots`).
4. **Clear leftover cargo** — sell anything in the hold at the best same-system
   market (including the current route good), dock first, respect the loss floor.
5. **Find a route** (`findRoute`):
   - **First** try the dispatcher's assigned route for this ship — good *and*
     both markets. If the ship can fly it at its own prices (`viableRoute`),
     take it.
   - **Otherwise claim one**: ask the dispatcher for the best route no fleetmate
     holds (`claim`). This is a single synchronous call, so two traders deciding
     at the same moment cannot both walk away with the same good.
   - **No dispatcher wired at all** (standalone trader, tests): free choice —
     pick the most profitable good, skipping `protectedGoods` (mission goods)
     and `reservedGoods`.
6. **Buy**: navigate to the buy market, dock, re-verify the **live** buy price
   (reject if the margin evaporated — `deadRoutes` remembers it for this tick),
   size the purchase against **live** credits, buy.
7. **Sell**: navigate to the sell market, dock, check the live sell price against
   the loss floor, sell.
8. If **no route** is profitable: fly to a market to refresh prices
   ("discovering prices") — prefers the markets of the route it held at the top
   of the tick, then any known market.

If a tick makes no progress, the loop sleeps 30s; on error it sleeps 10s.

**Key property:** the trader's price table is rebuilt from the store's fresh
snapshots every tick, but the **buy/sell decision uses live API prices** at the
market.

---

## 3. The tour loop (`ShipAgent.tourScout`)

**Code:** `tourScout` at `src/engine/agent.ts:940`, driven by `tourLoop`/`runLoop` at `agent.ts:1105`.

Tour shuttles (FRAME_SHUTTLE) exist to keep **price intel fresh** — market prices
are only visible when a ship is docked at the market, so someone has to visit.

One iteration:

1. Refresh the ship.
2. If manually dispatched, hold.
3. Get the target list: `marketTourTargets()` + `shipyardTourTargets()`
   (`fleet.ts:1062`, `fleet.ts:1073`).
4. **Pick the nearest reachable target** (within fuel capacity) — not the next in
   rotation, so a shuttle at the edge of its range doesn't keep failing on
   distant markets.
5. Fly, dock, record the market (`recordMarket` → `recordMarketSnapshot`) and/or
   shipyard inventory.

**Sector split:** each shuttle gets a distinct slice of the market list
(`sectorTourTargets`, `fleet.ts:1089`) so shuttles spread out instead of
clustering on the same nearest market.

---

## 4. The dispatcher (`RouteDispatcher`)

**Code:** `src/engine/dispatcher.ts` (whole file), invoked from `fleet.ts:1477`.

The dispatcher is the **centralized route allocator** — the thing that's supposed
to stop all traders from converging on the same good.

1. `computeDispatchRoutes()` reads every buy→sell pair from the store inside
   the `snapshotMaxAgeMin` window (`tradeLegs`), computes profit per trip
   (gross − one-way fuel), keeps profitable ones, sorts best-first.
2. `recompute()` assigns each trader a **distinct good**:
   - Sorted by hold size (biggest first).
   - No two traders share a good.
   - Manual overrides (from the UI) are preserved and their goods reserved.
   - A **busy** trader (cargo in the hold) keeps the route it is already hauling.
   - **Throttled to once per minute**, unconditionally.
3. `claim()` serves traders between recomputes: a trader with no usable
   assignment takes the best route nobody else holds, synchronously.
4. Each trader reads its assignment via `assignedRoute()` — wired once in
   `FleetManager.traderOptions`.

**API + UI:** `GET/POST /api/dispatch` (`server/index.ts:210/218`) exposes the
routes and assignments; the Markets tab has a Dispatch pane to view and override.

---

## 5. How the pieces interact (the data flow)

```
shuttles tour markets ──► store.market_snapshots (fresh prices)
                              │
        dispatcher (every 60s)│  computeDispatchRoutes() → tradeLegs()
                              ▼
                    assignments (good per trader)
                              │
        traders (every tick)  ▼
              findRoute() → assigned route first, else claim() an unheld one
                              │
                    buy at buyAt → sell at sellAt
                              │
                    recordLedger (SELL/PURCHASE) ──► store
```

---

## 6. Why traders converged, and what fixed it

All six of these are fixed. They're kept here because they're the same bug
wearing different hats: **two parts of the system reasoning from different
data, or deciding without telling each other.**

1. **Stale intel → no assignments → free-choice convergence.** *(root cause)*
   `computeDispatchRoutes()` only produced routes from **fresh** snapshots
   (90-min window), but the traders read `latestMarketSnapshots()` — **no age
   filter at all**. When the buy-side markets aged out (shuttles couldn't reach
   them), the dispatcher returned **zero routes → zero assignments** while every
   trader still saw those markets. So they all fell into free choice, ran the
   same deterministic scoring function over the same stale table with nothing
   reserved, and independently picked the *same* best good (observed:
   AMMUNITION, then EQUIPMENT).

   **Fixed:** one freshness window, `snapshotMaxAgeMin` in the doctrine, read by
   `Store.freshMarketSnapshots()` (traders) and `Store.tradeLegs()` (dispatcher).
   The trader's in-memory price table is now **rebuilt** each tick instead of
   merged into, so a price that has aged out of the store can't live on in a
   ship's memory; prices it read live at a market are re-applied on top and age
   out on the same clock.

2. **Free choice was a read-modify-write race.**
   `reservedGoods` reflected cargo *already in holds* plus existing assignments
   — a lagging signal. Two traders could both be inside `findRoute()`, both see
   a good as free, and both take it. No amount of widening the reservation set
   fixes that; the check and the take have to be one operation.

   **Fixed:** traders no longer pick for themselves. `RouteDispatcher.claim()`
   selects and records in one synchronous call, so no other trader's loop can
   interleave between "is it free?" and "it's mine". Free choice survives only
   for a trader with no dispatcher wired, which can't collide with anyone.

3. **Assignment was advisory.**
   The trader used only `assigned.good` and re-derived its own buy/sell pair
   from its own price table, so the leg it flew wasn't the leg the dispatcher
   priced — and two traders on different goods could still end up bidding at the
   same waypoint.

   **Fixed:** an assignment now carries both markets, and the trader flies them
   (`viableRoute`). If it can't, it releases and claims something else.

4. **Dispatcher reassigned busy traders.**
   `recompute()` rebuilt assignments for **all** traders every minute, whether
   mid-route or not, so a trader hauling EQUIPMENT could be switched to CLOTHING
   with the EQUIPMENT still in its hold. Assignments churned and never settled.

   **Fixed:** a trader with cargo in the hold is `busy`, and keeps the route it
   bought that cargo for.

5. **The throttle had it backwards.**
   `recompute()` skipped its once-a-minute throttle whenever the assignment map
   was empty — which is precisely the failure state above. So the one case that
   produced nothing useful ran a full window-function scan over the snapshot
   table on **every 2s tick**.

   **Fixed:** the throttle is unconditional.

6. **Round-trip vs one-way fuel.**
   The dispatcher originally priced routes with round-trip fuel while the trader
   used one-way, so the dispatcher said "no profitable routes" while the traders
   found plenty. Fixed in the dispatcher — but `/api/markets` kept its own
   round-trip copy of the model *and* read its freshness window from an env var,
   so the Markets tab showed the operator a different route list than the fleet
   was flying.

   **Fixed:** `/api/markets` now serves `fleet.computeDispatchRoutes()` — the
   same list, ranked the same way.

### Still open

- **One trader per good is the exclusivity key.** It's deliberately conservative:
  two ships on one route bid against each other and spike the price. But
  `tradeVolume` is both the per-trade cap *and* the market's volatility
  indicator, so the rule is too strict on a high-volume market (which could
  absorb a second hauler) and too permissive on a low-volume one (where even one
  ship moves the price). Relaxing the key to `(good, buyAt)` or a per-market
  unit budget is the next step **if** the trader:route ratio shows throughput is
  actually binding.
- **`supply` is stored and never used**, and `activity` isn't captured at all.
  Both are direct signals of how much a market can absorb.

---

## 7. Where each flow lives (quick reference)

| Flow | Entry point | File:line |
|---|---|---|
| Coordinator tick | `FleetManager.tick` | `src/engine/fleet.ts:1461` |
| Coordinator run loop | `FleetManager.run` | `src/engine/fleet.ts:1773` |
| Trader tick | `TraderAgent.tick` | `src/engine/trader.ts:534` |
| Trader run loop | `TraderAgent.runLoop` | `src/engine/trader.ts:700` |
| Trader route selection | `TraderAgent.findRoute` | `src/engine/trader.ts:375` |
| Route viability check | `TraderAgent.viableRoute` | `src/engine/trader.ts:395` |
| Atomic route claim | `RouteDispatcher.claim` | `src/engine/dispatcher.ts:119` |
| Freshness window | `snapshotMaxAgeMin` | `src/engine/doctrine.ts` |
| Fresh snapshots (store) | `Store.freshMarketSnapshots` | `src/engine/store.ts:526` |
| Trader option wiring | `FleetManager.traderOptions` | `src/engine/fleet.ts:264` |
| Trader price refresh fallback | `tick` tail | `src/engine/trader.ts:675` |
| Tour loop | `ShipAgent.tourScout` | `src/engine/agent.ts:940` |
| Surveyor loop | `ShipAgent.surveyScout` | `src/engine/agent.ts:872` |
| Dispatcher | `RouteDispatcher` | `src/engine/dispatcher.ts` |
| Dispatcher recompute call | `FleetManager.tick` | `src/engine/fleet.ts:1477` |
| Route computation | `FleetManager.computeDispatchRoutes` | `src/engine/fleet.ts:304` |
| Reserved goods (safety net) | `FleetManager.reservedTradeGoods` | `src/engine/fleet.ts:286` |
| Market tour targets | `FleetManager.marketTourTargets` | `src/engine/fleet.ts:1062` |
| Shipyard tour targets | `FleetManager.shipyardTourTargets` | `src/engine/fleet.ts:1073` |
| Sector split | `FleetManager.sectorTourTargets` | `src/engine/fleet.ts:1089` |
| Market snapshots (store) | `Store.recordMarket` | `src/engine/store.ts:219` |
| Latest snapshots (store) | `Store.latestMarketSnapshots` | `src/engine/store.ts:507` |
| Buy→sell legs (store) | `Store.tradeLegs` | `src/engine/store.ts:587` |
| Dispatch API | `GET/POST /api/dispatch` | `src/server/index.ts:210/218` |
