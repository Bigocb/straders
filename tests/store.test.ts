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
