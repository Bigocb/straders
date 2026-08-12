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

## 2. What a warehouse is (data model)

A warehouse is a **virtual inventory** — a set of rows in SQLite, not a physical
waypoint. (SpaceTraders has no player-owned storage; we model it ourselves.)

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

### Store methods (in `src/engine/store.ts`)

- `warehouseBalance(good): number`
- `warehouseAll(): { goodSymbol, units, avgCost }[]`
- `warehouseDeposit(good, units, price, shipSymbol, reason)` — updates units +
  weighted avgCost, writes a ledger row.
- `warehouseWithdraw(good, units, price, shipSymbol, reason)` — decrements units
  (clamped at 0), writes a ledger row.
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

`TraderAgent` (`src/engine/trader.ts`) needs to understand its new `role`:

### role = "buy"

- Navigate to `buyAt`, dock, verify live price (existing logic).
- Buy up to `min(cargo, target - warehouseBalance)`.
- **Deposit** into the warehouse (`warehouseDeposit`) instead of flying to sell.
- Return to idle → dispatcher reassigns.

### role = "sell"

- **Withdraw** from the warehouse (`warehouseWithdraw`) up to cargo capacity.
- Navigate to `sellAt`, dock, verify live sell price clears `avgCost + margin`.
- Sell. Return to idle.

### role = "haul" (later)

- Withdraw from warehouse, fly to mission/construction waypoint, deliver.

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

1. **Store layer** — add `warehouse` + `warehouse_ledger` tables and the four
   store methods. Unit-test deposit/withdraw/avgCost.
2. **Dispatcher roles** — add `role` to `TraderAssignment`; make `recompute`
   assign buy/sell per good against target inventory; **only assign idle
   traders** (fixes the churn bug).
3. **Trader split** — extract `runBuy` / `runSell`; wire `tick()` to dispatch on
   role. Keep the legacy arbitrage path as a fallback.
4. **Doctrine targets** — add the three warehouse rules; wire the dispatcher to
   read them.
5. **API + UI** — warehouse pane, dispatch roles, doctrine sliders.
6. **Mission hauling** (stretch) — `role = "haul"` to feed construction sites.

Each step is independently shippable and testable; the fleet keeps trading
throughout because the legacy arbitrage path remains until roles are live.

---

## 9. Risks / open questions

- **No physical storage in SpaceTraders.** The warehouse is virtual; a ship must
  still physically carry goods to/from markets. The warehouse is a *planning*
  layer, not a teleport.
- **Cost basis drift.** Weighted-average `avgCost` is simple but can drift if the
  fleet buys at very different prices. Consider FIFO if it matters later.
- **Dispatcher churn.** Must fix "only assign idle traders" first, or the
  warehouse will thrash as assignments flip every minute.
- **Stale intel.** Warehousing amplifies the stale-snapshot problem — the
  dispatcher needs fresh prices to decide buy vs sell. The tour/sector fixes
  (already in `docs/fleet-loops.md`) are a prerequisite.
- **Where is the warehouse "located"?** For now it's global (one virtual pool).
  If we later want per-system warehouses, add a `systemSymbol` column.

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
