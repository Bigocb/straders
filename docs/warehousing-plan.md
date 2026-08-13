# Warehousing: Implementation Plan

A design for adding a **warehouse** to the fleet — a place to hold inventory
between trades so the fleet can buy low, store, and sell high without needing a
ship to be in the right place at the right time. This builds directly on the
centralized **RouteDispatcher** and the half-built **buckets** system.

---

## 1. Why warehouse?

Today the fleet is a set of point-to-point traders: each `TraderAgent` buys at a
cheap market, flies to an expensive market, sells, and repeats. This has three
structural limits:

1. **No inventory buffer.** A trader can only hold what its cargo bay fits. If a
   market is cheap *now* but the sell market is far, the trader either makes a
   thin one-way trip or skips it. There's no way to accumulate a good when it's
   cheap and release it when it's dear.
2. **Route convergence.** Without a buffer, the dispatcher can only hand each
   trader a *distinct good* — it can't let two traders work the same good in
   different phases (one buying, one selling) because there's nowhere to stage
   the cargo.
3. **No demand smoothing.** The fleet can't hold a good for a contract or a
   construction mission (e.g. the jump gate at X1-BY69-I59 needs FAB_MATS /
   ADVANCED_CIRCUITRY) unless a ship happens to be carrying it.

A warehouse decouples **buying** from **selling**: a "buyer" ship fills the
warehouse when prices are low; a "seller" ship drains it when prices are high.
The dispatcher coordinates who does which, per good.

---

## 2. What a warehouse is (data model + a real ship)

> **Revised after tracer 1/2.** The original draft of this section called the
> warehouse "virtual — a set of rows in SQLite, not a physical waypoint" and
> left it at that. That's wrong in a way that matters: SpaceTraders has no
> "leave cargo at a waypoint" mechanic. The only way cargo moves between ships
> is `POST /my/ships/{shipSymbol}/transfer`, which requires **both ships
> docked at the same waypoint at the same time**. A buy-ship depositing and a
> different sell-ship withdrawing later, with nothing physically holding the
> cargo in between, isn't something the API can do.
>
> The resolution: **the warehouse is a real ship.** One hull, parked
> permanently at a chosen hub waypoint, with real cargo capacity. Buy-ships
> fly there and transfer cargo *in*; sell-ships fly there and transfer cargo
> *out*, then carry it on to wherever they're actually selling. The SQLite
> tables below are still exactly right — `units`/`avgCost` are the
> bookkeeping *on top of* that ship's real hold, not a substitute for it. The
> ledger's `delta` now only gets written once a real `transferCargo` call has
> actually moved the goods.

### The warehouse ship

- One ship, designated (not a new hull type — any ship with meaningful cargo
  capacity can serve; a Light Hauler is the natural pick once the fleet has
  one).
- Held permanently at one waypoint via the existing manual-dispatch/hold
  mechanism (`TraderAgent.dispatchTo` + hold) — it never mines, trades, or
  scouts. This reuses machinery that already exists rather than inventing a
  new stationary-ship role.
- The waypoint should be picked for centrality (near the market cluster the
  fleet already trades in), since every buy/sell-role trip now has an *extra
  leg* to/from the warehouse that a direct trade doesn't pay — see §9.
- The fleet tracks which ship symbol is the warehouse and where it's parked,
  so buy/sell-role traders know where to rendezvous.

### New table: `warehouse`

```sql
CREATE TABLE IF NOT EXISTS warehouse (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goodSymbol TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  avgCost REAL NOT NULL DEFAULT 0,      -- weighted average cost basis
  updatedAt TEXT NOT NULL,
  UNIQUE(goodSymbol)
);
```

- One row per good the fleet holds.
- `avgCost` is the weighted-average cost basis (recomputed on each deposit).
- `units` is the total held.

### New table: `warehouse_ledger`

```sql
CREATE TABLE IF NOT EXISTS warehouse_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  goodSymbol TEXT NOT NULL,
  delta INTEGER NOT NULL,               -- +deposit / -withdraw
  price REAL NOT NULL,
  shipSymbol TEXT,
  reason TEXT NOT NULL                  -- "buy", "sell", "mission", "adjust"
);
```

Every deposit/withdrawal is auditable.

### Store methods (in `src/engine/store.ts`) — done in tracer 1

- `warehouseBalance(good): number`
- `warehouseAll(): { goodSymbol, units, avgCost, value }[]`
- `warehouseDeposit(good, units, price, shipSymbol, reason)` — updates units +
  weighted avgCost, writes a ledger row. **Called only after
  `api.transferCargo` into the warehouse ship has actually succeeded** — the
  ledger records what happened, it doesn't cause it to happen.
- `warehouseWithdraw(good, units, price, shipSymbol, reason)` — decrements units
  (clamped at 0), writes a ledger row, returns the actual units removed and
  their cost basis. Same ordering: call this **after** the real
  `transferCargo` out of the warehouse ship succeeds, not instead of it.
- `warehouseValue(): number` — total `units * avgCost` (for the UI / buckets).

---

## 3. How the dispatcher changes

The dispatcher (`src/engine/dispatcher.ts`) currently assigns each trader a
**distinct good** to buy→sell directly. With a warehouse, it assigns **roles**
per good instead:

### New assignment shape

```ts
interface TraderAssignment {
  shipSymbol: string;
  good: string;
  role: "buy" | "sell" | "haul";   // NEW
  buyAt?: string;                  // for buy/haul
  sellAt?: string;                 // for sell/haul
  ...
}
```

- **buy** — fly to the cheap market, buy, deposit into the warehouse.
- **sell** — withdraw from the warehouse, fly to the dear market, sell.
- **haul** — (later) move goods between warehouse and a mission/construction site.

### Allocation logic (`recompute`)

1. For each good, compute a **target inventory** (see §4) and the current
   warehouse balance.
2. If balance < target → assign a **buy** trader to that good.
3. If balance > target → assign a **sell** trader to that good.
4. If balance ≈ target → no trader on that good (or a haul trader for missions).
5. Two traders can now work the **same good** — one buying, one selling — because
   the warehouse is the staging point. This removes the "distinct good" hard
   constraint that caused convergence.

### Only assign idle traders

Fix the known churn bug: `recompute` should skip traders that are mid-route
(holding cargo or in transit). Only **idle** traders get a new assignment. This
is a prerequisite for warehousing to work at all.

---

## 4. Target inventory (how much to hold)

A per-good target prevents the warehouse from hoarding everything or holding
nothing. Two sources:

### Doctrine rules (in `src/engine/doctrine.ts`)

Add rules the operator can tune from the Doctrine tab:

- `warehouseTarget` — default units to hold per good (e.g. 100).
- `warehouseMax` — hard cap per good (e.g. 500).
- `warehouseMinMargin` — only sell from the warehouse when the live sell price
  clears the cost basis by this margin (reuses the existing `marginFloor` idea).

### Dynamic per-good targets

For mission/construction goods (FAB_MATS, ADVANCED_CIRCUITRY, QUANTUM_STABILIZERS),
the target is set by the mission's remaining requirement, not a flat number. The
`MissionManager` already tracks these (`src/engine/mission.ts`); the dispatcher
reads the outstanding need and sets the target accordingly.

---

## 5. The trader changes

`TraderAgent` (`src/engine/trader.ts`) needs to understand its new `role`. Each
role now has an extra leg to/from the warehouse ship's waypoint — see §2 for
why that's unavoidable.

### role = "buy"

- Navigate to `buyAt`, dock, verify live price (existing logic).
- Buy up to `min(cargo, maxUnits)` (`maxUnits` is the room left to the good's
  target, computed by the dispatcher at assignment time — see §3).
- Navigate to the **warehouse ship's waypoint**, dock alongside it.
- `api.transferCargo(thisShip, good, units, warehouseShipSymbol)` — the real
  handoff. Only on success:
- `warehouseDeposit(good, units, price, thisShip, "buy")` — the bookkeeping.
- Return to idle → dispatcher reassigns.

### role = "sell"

- Navigate to the **warehouse ship's waypoint** first (empty-handed).
- Ask the warehouse ship to hand over cargo: `api.transferCargo(warehouseShipSymbol, good, units, thisShip)`
  — the warehouse ship is the sender here, so this call is made *as* the
  warehouse ship, not the sell-role trader. `units` is capped by whatever the
  warehouse ship's cargo hold can safely give up right now.
- On success, `warehouseWithdraw(good, units, price, thisShip, "sell")` —
  bookkeeping follows the real transfer, same ordering as buy.
- Navigate to `sellAt`, dock, verify live sell price clears `avgCost + margin`
  (the ledger row's actual cost basis, not the assignment's stale snapshot).
- Sell. Return to idle.

### role = "haul" (later)

- Same rendezvous-and-withdraw as "sell", but the destination is a mission's
  construction waypoint instead of a market.

### Refactor note

The current `tick()` (trader.ts:439) is a single buy→sell pipeline. Warehousing
splits it into two independent pipelines (buy→deposit, withdraw→sell). The
cleanest approach is to extract the buy and sell halves into methods and have
`tick()` dispatch on `role`:

```ts
async tick() {
  const a = this.assignedRoute?.();
  if (a?.role === "buy")  return this.runBuy(a);
  if (a?.role === "sell") return this.runSell(a);
  return this.runArbitrage(); // legacy direct buy→sell, or idle
}
```

---

## 6. The buckets tie-in

The half-built **buckets** system (`src/engine/store.ts:116`, `buckets` +
`bucket_ledger` tables; `getBuckets`/`setBucket`/`adjustBucketBalance` at
store.ts:675/691/709) is the natural funding source for warehousing:

- **Purchasing** bucket funds warehouse deposits (buying inventory).
- **Capital** bucket stays the floor.
- Warehouse value (`units * avgCost`) can be surfaced as a bucket balance or a
  separate line in the UI.

The warehouse and buckets both persist in SQLite, so they survive restarts.

---

## 7. API + UI

### API (`src/server/index.ts`)

- `GET /api/warehouse` — `{ goods: [{ goodSymbol, units, avgCost, value }], totalValue }`.
- `POST /api/warehouse/adjust` — manual deposit/withdraw (operator override).
- Extend `GET /api/dispatch` to include each trader's `role` (buy/sell/haul).

### UI (Markets tab, `public/index.html`)

- New **Warehouse** pane: per-good units, avg cost, value, and a target bar.
- Extend the **Dispatch** pane to show each trader's role, not just the good.
- Doctrine tab gets the new `warehouseTarget` / `warehouseMax` / `warehouseMinMargin`
  sliders.

---

## 8. Rollout order (tracer bullets)

1. **Store layer** — done. `warehouse` + `warehouse_ledger` tables and the
   five store methods. 8 unit tests on deposit/withdraw/avgCost.
2. **Dispatcher roles** — done. `role` on `TraderAssignment`; `recompute`
   assigns buy/sell per good against target inventory, exclusivity keyed on
   `(good, role)` so a buy-trader and a sell-trader can hold one good at
   once; busy traders carry forward whatever role they're mid-haul on (the
   churn-bug prerequisite — already fixed by the unrelated convergence work,
   confirmed still true here). Inert in the live coordinator until a caller
   actually supplies targets.
3. **The warehouse ship** *(new — inserted after discovering §2's original
   "virtual, no physical ship" framing doesn't work)* — designate one ship,
   hold it at a chosen waypoint via the existing manual-dispatch mechanism,
   and expose its symbol + waypoint to the rest of the fleet. Nothing
   transfers cargo yet; this just makes "where do I rendezvous" answerable.
4. **Trader split** — done. `TraderAgent.tick()` now dispatches on
   `assignedRoute().role`: `runBuy` buys at the assigned market and
   transfers into the warehouse ship; `runSell` transfers out of the
   warehouse ship (as the warehouse ship — it's the sender) and sells at
   the assigned market. Both fall back to the legacy direct-arbitrage path
   (`runArbitrage`) when there's no warehouse ship to rendezvous with, or
   the leg isn't otherwise flyable — resolving the §9 open question about
   an unreachable warehouse ship. `AssignedRoute` is gone; `TraderOptions`
   now passes the dispatcher's `TraderAssignment` straight through, with a
   private `asDirectLeg` narrow for the direct/claim path only. Still inert
   live: `recompute()` isn't given warehouse targets yet (tracer 5), so the
   dispatcher only ever emits "direct" assignments in the running fleet —
   `runBuy`/`runSell` are fully tested but never exercised outside tests
   until tracer 5 lands.
5. **Doctrine targets** — done. Three new rules (`warehouseTarget`,
   `warehouseMax`, `warehouseMinMargin`); `warehouseTarget`'s own `enabled`
   flag is the master switch for the whole feature — **off by default**,
   same opt-in precedent as `sensorScanIntervalMin`. `FleetManager.tick()`
   computes a `WarehouseTarget` per routed good (flat target, capped by
   `warehouseMax`) only when enabled, and passes it into
   `dispatcher.recompute()`; disabled, it passes `[]` and behavior is
   unchanged from before tracer 2. `warehouseMinMargin` gates `runSell`
   directly — it won't sell out of the warehouse until the live price
   clears the cost basis by that much, on top of the existing loss floor.
   Also fixed a bug this surfaced: the warehouse ship was still sitting in
   `traders` and eligible for a dispatcher assignment it could never act
   on (permanently manual-held), which would have let it lock a good away
   from a real trader — it's now excluded via `dispatcherTraders()`.
6. **API + UI** — warehouse pane, dispatch roles, doctrine sliders.
7. **Mission hauling** (stretch) — `role = "haul"` to feed construction sites.

Each step is independently shippable and testable; the fleet keeps trading
throughout because the legacy arbitrage path remains until roles are live.

---

## 9. Risks / open questions

- **No physical storage in SpaceTraders — resolved, not avoided.** ~~The
  warehouse is virtual~~. It's a real ship (§2); `transferCargo` requires
  both parties docked at the same waypoint, which is why tracer 3 became
  "designate a warehouse ship" before "extract runBuy/runSell" could be
  written correctly.
- **The extra leg costs real fuel and time.** A buy-role trip is now
  `buyAt → warehouse waypoint` instead of `buyAt → sellAt`; a sell-role trip
  is `warehouse waypoint → sellAt`. Neither is the direct-route distance the
  dispatcher's `profitPerTrip` currently models — that number still assumes
  one continuous `buyAt → sellAt` hop. Until the profit math accounts for
  the warehouse detour, a warehoused good can look more profitable on the
  dashboard than it actually nets. Picking a central warehouse waypoint
  minimizes this; it doesn't eliminate it.
- **The warehouse ship's own cargo capacity is a real constraint.** It can
  only receive as much as it has free hold for, and can only hand out what
  it's actually carrying. A busy warehouse (many buy-traders converging on
  deposit at once) can queue or reject transfers — tracer 4 needs to size
  the ship or throttle deposits against this.
- **Cost basis drift.** Weighted-average `avgCost` is simple but can drift if the
  fleet buys at very different prices. Consider FIFO if it matters later.
- **Dispatcher churn.** Fixed — busy traders carry forward their assignment
  (§8, tracer 2), which was the prerequisite this risk originally named.
- **Stale intel.** Warehousing amplifies the stale-snapshot problem — the
  dispatcher needs fresh prices to decide buy vs sell. The tour/sector fixes
  (already in `docs/fleet-loops.md`) are a prerequisite.
- **Where is the warehouse "located"?** Resolved by §2 — it's wherever the
  warehouse ship is parked. Still global (one ship, one pool); per-system
  warehousing would mean multiple warehouse ships and a `systemSymbol`
  column, not attempted here.
- **What if the warehouse ship can't be reached, or gets scrapped?**
  Resolved in tracer 4. `runBuy`/`runSell` fall through to direct arbitrage
  whenever `getWarehouseShip()` returns undefined (none designated, or
  `removeShip` cleared it after a scrap) or the leg fails a viability check
  — same as any other unviable assignment. A failed rendezvous mid-leg
  (transfer call throws) leaves the cargo in the trader's hold; the next
  tick's leftover sweep clears it to the open market rather than stranding
  it.

---

## 10. References

- Dispatcher: `src/engine/dispatcher.ts` (roles to be added)
- Trader loop: `src/engine/trader.ts:439` (`tick`), `:319` (`findRoute`)
- Coordinator: `src/engine/fleet.ts:1477` (`tick`), `:1493` (dispatcher call)
- Store: `src/engine/store.ts:116` (buckets), `:567` (`tradeLegs`), `:675` (buckets methods)
- Doctrine: `src/engine/doctrine.ts` (add warehouse rules)
- Missions: `src/engine/mission.ts` (construction needs → haul targets)
- API: `src/server/index.ts:210` (`/api/dispatch`)
- UI: `public/index.html` (Markets tab)
- Loop overview: `docs/fleet-loops.md`
