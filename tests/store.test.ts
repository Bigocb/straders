import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/engine/store.js";

function tempDb(): string {
  return `/tmp/opencode/startraders-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("Store", () => {
  it("records market snapshots and computes best trades", () => {
    const store = new Store(tempDb());
    const now = new Date().toISOString();
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", goodSymbol: "IRON", type: "EXPORT", supply: "MODERATE", purchasePrice: 20, sellPrice: 22, tradeVolume: 40 });
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A2", goodSymbol: "IRON", type: "IMPORT", supply: "LIMITED", purchasePrice: 35, sellPrice: 31, tradeVolume: 25 });
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A3", goodSymbol: "COPPER", type: "EXCHANGE", supply: "ABUNDANT", purchasePrice: 100, sellPrice: 95, tradeVolume: 12 });

    const trades = store.bestTrades();
    assert.equal(trades.length, 1);
    const iron = trades[0]!;
    assert.equal(iron.goodSymbol, "IRON");
    assert.equal(iron.cheapestMarket, "X1-A-A1");
    assert.equal(iron.expensiveMarket, "X1-A-A2");
    assert.equal(iron.lowestPurchasePrice, 20);
    assert.equal(iron.highestSellPrice, 31);
    assert.equal(iron.spread, 11);
    store.close();
  });

  it("records ledger entries and returns totals", () => {
    const store = new Store(tempDb());
    store.recordLedger({ timestamp: new Date().toISOString(), shipSymbol: "S1", waypointSymbol: "X1-A-A1", type: "PURCHASE", tradeSymbol: "IRON", units: 10, pricePerUnit: 20, total: 200 });
    store.recordLedger({ timestamp: new Date().toISOString(), shipSymbol: "S1", waypointSymbol: "X1-A-A2", type: "SELL", tradeSymbol: "IRON", units: 10, pricePerUnit: 30, total: 300 });
    store.recordLedger({ timestamp: new Date().toISOString(), shipSymbol: "S1", waypointSymbol: "X1-A-A1", type: "REFUEL", units: 20, total: 40 });

    const totals = store.ledgerTotals();
    assert.equal(totals.buys, 200);
    assert.equal(totals.sells, 300);
    assert.equal(totals.credits, 100);
    store.close();
  });

  it("keeps latest snapshot per waypoint per good", () => {
    const store = new Store(tempDb());
    const t1 = new Date(Date.now() - 1000).toISOString();
    const t2 = new Date().toISOString();
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", goodSymbol: "IRON", type: "EXPORT", supply: "MODERATE", purchasePrice: 20, sellPrice: 22, tradeVolume: 40 });
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", goodSymbol: "IRON", type: "EXPORT", supply: "ABUNDANT", purchasePrice: 25, sellPrice: 28, tradeVolume: 50 });

    const latest = store.latestMarketSnapshots();
    assert.equal(latest.length, 1);
    const snap = latest[0]!;
    assert.equal(snap.purchasePrice, 25);
    store.close();
  });

  it("drops snapshots older than the freshness window", () => {
    const store = new Store(tempDb());
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", goodSymbol: "IRON", type: "EXPORT", supply: "MODERATE", purchasePrice: 20, sellPrice: 22, tradeVolume: 40 });
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A2", goodSymbol: "GOLD", type: "EXPORT", supply: "MODERATE", purchasePrice: 30, sellPrice: 33, tradeVolume: 10 });
    // Age the GOLD reading out past the window.
    (store as any).db
      .prepare(`UPDATE market_snapshots SET timestamp = ? WHERE goodSymbol = 'GOLD'`)
      .run(new Date(Date.now() - 120 * 60_000).toISOString());

    assert.equal(store.latestMarketSnapshots().length, 2, "the unfiltered view still has both");
    const fresh = store.freshMarketSnapshots(90);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]!.goodSymbol, "IRON");
    // Same window the dispatcher's leg query uses, so the two agree on which
    // markets exist.
    assert.equal(store.freshMarketSnapshots(180).length, 2);
    store.close();
  });

  it("records and retrieves activity feed", () => {
    const store = new Store(tempDb());
    store.recordActivity({ timestamp: new Date().toISOString(), shipSymbol: "S1", kind: "sell", detail: "sold ore", credits: 100 });
    const activity = store.recentActivity(10);
    assert.equal(activity.length, 1);
    const first = activity[0]!;
    assert.equal(first.kind, "sell");
    assert.equal(first.credits, 100);
    store.close();
  });
});

describe("Store warehouse", () => {
  it("starts every good at zero, no deposit required first", () => {
    const store = new Store(tempDb());
    assert.equal(store.warehouseBalance("FAB_MATS"), 0);
    assert.deepEqual(store.warehouseAll(), []);
    assert.equal(store.warehouseValue(), 0);
    store.close();
  });

  it("deposit computes the weighted-average cost over old + new holding", () => {
    const store = new Store(tempDb());
    store.warehouseDeposit("FAB_MATS", 100, 50, "AG-1", "buy");
    store.warehouseDeposit("FAB_MATS", 50, 80, "AG-2", "buy");
    // (100*50 + 50*80) / 150 = 9000/150 = 60
    assert.equal(store.warehouseBalance("FAB_MATS"), 150);
    const row = store.warehouseAll().find((r) => r.goodSymbol === "FAB_MATS")!;
    assert.equal(row.avgCost, 60);
    assert.equal(row.value, 150 * 60);
    store.close();
  });

  it("withdrawing changes units but never the cost basis", () => {
    const store = new Store(tempDb());
    store.warehouseDeposit("FAB_MATS", 100, 50, "AG-1", "buy");
    const res = store.warehouseWithdraw("FAB_MATS", 40, 90, "AG-2", "sell");
    assert.deepEqual(res, { units: 40, avgCost: 50 });
    assert.equal(store.warehouseBalance("FAB_MATS"), 60);
    // avgCost of what remains is still 50 — draining doesn't move the basis,
    // only a deposit at a different price does.
    assert.equal(store.warehouseAll().find((r) => r.goodSymbol === "FAB_MATS")!.avgCost, 50);
    store.close();
  });

  it("clamps a withdrawal to what's actually held, instead of going negative", () => {
    const store = new Store(tempDb());
    store.warehouseDeposit("FAB_MATS", 30, 50, "AG-1", "buy");
    const res = store.warehouseWithdraw("FAB_MATS", 100, 90, "AG-2", "sell");
    assert.deepEqual(res, { units: 30, avgCost: 50 }, "returns what actually came out, not the request");
    assert.equal(store.warehouseBalance("FAB_MATS"), 0);
    store.close();
  });

  it("withdrawing a good the warehouse has never held returns zero units without throwing", () => {
    const store = new Store(tempDb());
    const res = store.warehouseWithdraw("NEVER_SEEN", 10, 1, undefined, "sell");
    assert.deepEqual(res, { units: 0, avgCost: 0 });
    store.close();
  });

  it("warehouseAll and warehouseValue only count goods still held", () => {
    const store = new Store(tempDb());
    store.warehouseDeposit("FAB_MATS", 100, 50, "AG-1", "buy");
    store.warehouseDeposit("ADVANCED_CIRCUITRY", 20, 200, "AG-2", "buy");
    assert.equal(store.warehouseValue(), 100 * 50 + 20 * 200);
    store.warehouseWithdraw("FAB_MATS", 100, 60, "AG-3", "sell");
    // Drained to zero: gone from the list (nothing to show), balance still
    // reads 0 rather than throwing, and it no longer counts toward value.
    assert.equal(store.warehouseAll().some((r) => r.goodSymbol === "FAB_MATS"), false);
    assert.equal(store.warehouseBalance("FAB_MATS"), 0);
    assert.equal(store.warehouseValue(), 20 * 200);
    store.close();
  });

  it("records every deposit and withdrawal in the ledger, newest first", () => {
    const store = new Store(tempDb());
    store.warehouseDeposit("FAB_MATS", 100, 50, "AG-1", "buy");
    store.warehouseWithdraw("FAB_MATS", 40, 90, "AG-2", "sell");
    const ledger = store.warehouseLedger();
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0]!.reason, "sell");
    assert.equal(ledger[0]!.delta, -40);
    assert.equal(ledger[0]!.shipSymbol, "AG-2");
    assert.equal(ledger[1]!.reason, "buy");
    assert.equal(ledger[1]!.delta, 100);
    store.close();
  });

  it("rejects a non-positive deposit or withdrawal instead of silently no-op'ing", () => {
    const store = new Store(tempDb());
    assert.throws(() => store.warehouseDeposit("FAB_MATS", 0, 50, "AG-1", "buy"));
    assert.throws(() => store.warehouseDeposit("FAB_MATS", -5, 50, "AG-1", "buy"));
    assert.throws(() => store.warehouseWithdraw("FAB_MATS", 0, 50, "AG-1", "sell"));
    store.close();
  });
});

describe("Store warehouse targets", () => {
  it("starts with no curated goods", () => {
    const store = new Store(tempDb());
    assert.deepEqual(store.warehouseTargetList(), []);
    store.close();
  });

  it("adds and lists curated goods, sorted by good symbol", () => {
    const store = new Store(tempDb());
    store.setWarehouseTarget("IRON_ORE", 100, false);
    store.setWarehouseTarget("FAB_MATS", 200, true);
    assert.deepEqual(store.warehouseTargetList(), [
      { goodSymbol: "FAB_MATS", target: 200, forMission: true },
      { goodSymbol: "IRON_ORE", target: 100, forMission: false },
    ]);
    store.close();
  });

  it("updating an existing good's target replaces it rather than duplicating", () => {
    const store = new Store(tempDb());
    store.setWarehouseTarget("IRON_ORE", 100, false);
    store.setWarehouseTarget("IRON_ORE", 250, true);
    assert.deepEqual(store.warehouseTargetList(), [{ goodSymbol: "IRON_ORE", target: 250, forMission: true }]);
    store.close();
  });

  it("removing a good drops it from the list", () => {
    const store = new Store(tempDb());
    store.setWarehouseTarget("IRON_ORE", 100, false);
    store.setWarehouseTarget("FAB_MATS", 200, true);
    store.removeWarehouseTarget("IRON_ORE");
    assert.deepEqual(store.warehouseTargetList(), [{ goodSymbol: "FAB_MATS", target: 200, forMission: true }]);
    store.close();
  });

  it("removing a good not on the list is a no-op, not an error", () => {
    const store = new Store(tempDb());
    assert.doesNotThrow(() => store.removeWarehouseTarget("GHOST"));
    store.close();
  });
});
