# Fleet Loops: How the Engine Actually Works

This document explains the four autonomous loops that drive the fleet, where each
one lives in the code, and how they interact. It was written to pin down exactly
what's happening so we can reason about the conflicts (route convergence, stale
intel, dispatcher churn) before changing anything.

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

**Code:** `src/engine/fleet.ts:1477` (`tick`), driven by `run` at `src/engine/fleet.ts:1786`.

Every **2 seconds** the coordinator does one pass:

1. Refresh the credit balance (`getMyAgent`).
2. Fulfill/accept contracts.
3. **Recompute dispatcher assignments** (`dispatcher.recompute(computeDispatchRoutes(), traders)` at `fleet.ts:1493`).
4. Maybe buy a ship (`maybeBuyShip`), maybe buy a scout (`maybeBuyScout`).
5. Auto-explore connected systems (`autoExplore`).
6. Rescue stranded ships (`rescueStranded`).
7. Tick missions.

The coordinator does **not** move ships itself — it only decides policy. Each ship
runs its own loop (below) and reads the coordinator's decisions (assignments,
suspension flags, manual dispatch) on every tick.

---

## 2. The trader loop (`TraderAgent.tick` / `runLoop`)

**Code:** `runLoop` at `src/engine/trader.ts:602`, `tick` at `src/engine/trader.ts:439`.

Each trader runs an independent `while` loop. One iteration:

1. **Refresh** the ship from the API.
2. If **manually dispatched**, hold at the waypoint until released.
3. **Load snapshots** into its in-memory price table (`loadSnapshots`, `trader.ts:380`).
4. **Clear leftover cargo** — sell anything in the hold at the best same-system
   market (including the current route good), dock first, respect the loss floor.
5. **Find a route** (`findRoute`, `trader.ts:319`):
   - **First** try the dispatcher's assigned route for this ship (`assignedRoute`,
     `trader.ts:337`). If that good has a viable buy→sell pair in the price table,
     take it.
   - **Fallback**: free choice — pick the most profitable good, skipping
     `protectedGoods` (mission goods) and `reservedGoods` (goods other traders
     hold or are assigned).
6. **Buy**: navigate to the buy market, dock, re-verify the **live** buy price
   (reject if the margin evaporated — `deadRoutes` remembers it for this tick),
   size the purchase against **live** credits, buy.
7. **Sell**: navigate to the sell market, dock, check the live sell price against
   the loss floor, sell.
8. If **no route** is profitable: fly to a market to refresh prices
   ("discovering prices", `trader.ts:580`) — prefers the assigned route's own
   buy/sell markets, then any known market.

If a tick makes no progress, the loop sleeps 30s; on error it sleeps 10s.

**Key property:** the trader's price table is seeded from the store's snapshots
every tick, but the **buy/sell decision uses live API prices** at the market.

---

## 3. The tour loop (`ShipAgent.tourScout`)

**Code:** `tourScout` at `src/engine/agent.ts:940`, driven by `tourLoop`/`runLoop` at `agent.ts:1105`.

Tour shuttles (FRAME_SHUTTLE) exist to keep **price intel fresh** — market prices
are only visible when a ship is docked at the market, so someone has to visit.

One iteration:

1. Refresh the ship.
2. If manually dispatched, hold.
3. Get the target list: `marketTourTargets()` + `shipyardTourTargets()`
   (`fleet.ts:1078`, `fleet.ts:1089`).
4. **Pick the nearest reachable target** (within fuel capacity) — not the next in
   rotation, so a shuttle at the edge of its range doesn't keep failing on
   distant markets.
5. Fly, dock, record the market (`recordMarket` → `recordMarketSnapshot`) and/or
   shipyard inventory.

**Sector split:** each shuttle gets a distinct slice of the market list
(`sectorTourTargets`, `fleet.ts:1105`) so shuttles spread out instead of
clustering on the same nearest market.

---

## 4. The dispatcher (`RouteDispatcher`)

**Code:** `src/engine/dispatcher.ts` (whole file), invoked from `fleet.ts:1493`.

The dispatcher is the **centralized route allocator** — the thing that's supposed
to stop all traders from converging on the same good.

1. `computeDispatchRoutes()` (`fleet.ts:298`) reads every fresh buy→sell pair
   from the store (`tradeLegs`, `store.ts:567`), computes profit per trip
   (gross − one-way fuel), keeps profitable ones, sorts best-first.
2. `recompute()` (`dispatcher.ts:81`) assigns each trader a **distinct good**:
   - Sorted by hold size (biggest first).
   - No two traders share a good.
   - Manual overrides (from the UI) are preserved and their goods reserved.
   - **Throttled to once per minute.**
3. Each trader reads its assignment via `assignedRoute()` (`fleet.ts:191/232/485`).

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
              findRoute() → assigned good first, free choice fallback
                              │
                    buy at buyAt → sell at sellAt
                              │
                    recordLedger (SELL/PURCHASE) ──► store
```

---

## 6. Known conflicts (why traders converge)

1. **Stale intel → no assignments → free-choice convergence.**
   `computeDispatchRoutes()` only produces routes from **fresh** snapshots
   (90-min window). When the buy-side markets age out (shuttles can't reach
   them), the dispatcher returns **zero routes → zero assignments**. Every
   trader's `assignedRoute()` is then undefined, so they all fall into **free
   choice**, and `reservedGoods` has nothing to reserve. Result: all traders
   independently pick the same best good (observed: AMMUNITION, then EQUIPMENT).

2. **Dispatcher reassigns busy traders.**
   `recompute()` rebuilds assignments for **all** traders every minute, whether
   they're mid-route or not. A trader hauling EQUIPMENT can be reassigned to
   CLOTHING mid-trip. It finishes the current cargo (leftover-clear), then
   switches — so assignments churn and never stabilize.

3. **Free-choice fallback ignores assignments of others.**
   When a trader's own assignment is unviable, it free-picks — and until the
   `reservedGoods` fix, it could pick a good the dispatcher assigned to a
   fleetmate. (Fixed: `reservedTradeGoods` now includes other traders'
   assignments, `fleet.ts:280`.)

4. **Round-trip vs one-way fuel.**
   The dispatcher originally priced routes with round-trip fuel while the trader
   used one-way fuel, so the dispatcher said "no profitable routes" while the
   traders found plenty. (Fixed: dispatcher now matches the trader's one-way
   model, `fleet.ts:298`.)

---

## 7. Where each flow lives (quick reference)

| Flow | Entry point | File:line |
|---|---|---|
| Coordinator tick | `FleetManager.tick` | `src/engine/fleet.ts:1477` |
| Coordinator run loop | `FleetManager.run` | `src/engine/fleet.ts:1786` |
| Trader tick | `TraderAgent.tick` | `src/engine/trader.ts:439` |
| Trader run loop | `TraderAgent.runLoop` | `src/engine/trader.ts:602` |
| Trader route selection | `TraderAgent.findRoute` | `src/engine/trader.ts:319` |
| Trader price refresh fallback | `tick` tail | `src/engine/trader.ts:580` |
| Tour loop | `ShipAgent.tourScout` | `src/engine/agent.ts:940` |
| Surveyor loop | `ShipAgent.surveyScout` | `src/engine/agent.ts:872` |
| Dispatcher | `RouteDispatcher` | `src/engine/dispatcher.ts` |
| Dispatcher recompute call | `FleetManager.tick` | `src/engine/fleet.ts:1493` |
| Route computation | `FleetManager.computeDispatchRoutes` | `src/engine/fleet.ts:298` |
| Reserved goods (safety net) | `FleetManager.reservedTradeGoods` | `src/engine/fleet.ts:280` |
| Market tour targets | `FleetManager.marketTourTargets` | `src/engine/fleet.ts:1078` |
| Shipyard tour targets | `FleetManager.shipyardTourTargets` | `src/engine/fleet.ts:1089` |
| Sector split | `FleetManager.sectorTourTargets` | `src/engine/fleet.ts:1105` |
| Market snapshots (store) | `Store.recordMarket` | `src/engine/store.ts:219` |
| Latest snapshots (store) | `Store.latestMarketSnapshots` | `src/engine/store.ts:507` |
| Buy→sell legs (store) | `Store.tradeLegs` | `src/engine/store.ts:567` |
| Dispatch API | `GET/POST /api/dispatch` | `src/server/index.ts:210/218` |
