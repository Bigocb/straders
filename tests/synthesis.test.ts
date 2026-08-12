import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/engine/store.js";
import { Doctrine, DOCTRINE_DEFAULTS } from "../src/engine/doctrine.js";

function tempDb(): string {
  return `/tmp/opencode/startraders-syn-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe("Store.tradeLegs", () => {
  it("returns directional buy→sell pairs without collapsing to one row per good", () => {
    const store = new Store(tempDb());
    // A1 sells cheap, A2 and A3 both buy dear.
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", goodSymbol: "IRON", type: "EXPORT", supply: "HIGH", purchasePrice: 10, sellPrice: 8, tradeVolume: 40 });
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A2", goodSymbol: "IRON", type: "IMPORT", supply: "SCARCE", purchasePrice: 60, sellPrice: 50, tradeVolume: 20 });
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A3", goodSymbol: "IRON", type: "IMPORT", supply: "LIMITED", purchasePrice: 40, sellPrice: 30, tradeVolume: 60 });

    const legs = store.tradeLegs();
    const fromA1 = legs.filter((l) => l.buyAt === "X1-A-A1");
    assert.equal(fromA1.length, 2, "both destinations survive as separate legs");
    // Volume is capped by the smaller side of the pair.
    const toA2 = fromA1.find((l) => l.sellAt === "X1-A-A2")!;
    assert.equal(toA2.volume, 20);
    assert.equal(toA2.sellPrice, 50);
    assert.equal(toA2.buyPrice, 10);
    store.close();
  });

  it("never returns a leg that loses money on the spread alone", () => {
    const store = new Store(tempDb());
    // For no leg to exist, the best sell price anywhere must still be below the
    // cheapest purchase price anywhere — otherwise some pair is genuinely
    // profitable, whichever way round the waypoints are listed.
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", goodSymbol: "GOLD", type: "EXPORT", supply: "HIGH", purchasePrice: 90, sellPrice: 30, tradeVolume: 10 });
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A2", goodSymbol: "GOLD", type: "IMPORT", supply: "ABUNDANT", purchasePrice: 100, sellPrice: 40, tradeVolume: 10 });
    assert.equal(store.tradeLegs().length, 0);
    store.close();
  });

  it("finds the leg regardless of which waypoint is listed first", () => {
    const store = new Store(tempDb());
    // A2 is cheap to buy from and A1 pays well — a real trade, even though A1
    // looks like the "expensive" market on a naive read.
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", goodSymbol: "GOLD", type: "IMPORT", supply: "SCARCE", purchasePrice: 90, sellPrice: 85, tradeVolume: 10 });
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A2", goodSymbol: "GOLD", type: "EXPORT", supply: "ABUNDANT", purchasePrice: 40, sellPrice: 30, tradeVolume: 10 });
    const legs = store.tradeLegs();
    assert.equal(legs.length, 1);
    assert.equal(legs[0]!.buyAt, "X1-A-A2");
    assert.equal(legs[0]!.sellAt, "X1-A-A1");
    assert.equal(legs[0]!.sellPrice - legs[0]!.buyPrice, 45);
    store.close();
  });

  it("excludes snapshots older than the freshness window", () => {
    const store = new Store(tempDb());
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A1", goodSymbol: "IRON", type: "EXPORT", supply: "HIGH", purchasePrice: 10, sellPrice: 8, tradeVolume: 40 });
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-A2", goodSymbol: "IRON", type: "IMPORT", supply: "SCARCE", purchasePrice: 60, sellPrice: 50, tradeVolume: 20 });
    assert.equal(store.tradeLegs(90).length, 1, "fresh snapshots are included");
    // A zero-minute window races the rows just written (same-millisecond
    // timestamps compare equal), so push the cutoff into the future to prove
    // the filter is applied at all rather than testing the clock.
    assert.equal(store.tradeLegs(-1).length, 0, "snapshots older than the cutoff are excluded");
    store.close();
  });
});

describe("Store.earningsByShip", () => {
  it("nets sells against spend, and counts scrap as income", () => {
    const store = new Store(tempDb());
    const t = new Date().toISOString();
    store.recordLedger({ timestamp: t, shipSymbol: "S1", waypointSymbol: "W", type: "SELL", total: 1000 });
    store.recordLedger({ timestamp: t, shipSymbol: "S1", waypointSymbol: "W", type: "PURCHASE", total: 400 });
    store.recordLedger({ timestamp: t, shipSymbol: "S1", waypointSymbol: "W", type: "REFUEL", total: 100 });
    // Ship purchase is spend; scrapping the same hull is income.
    store.recordLedger({ timestamp: t, shipSymbol: "S2", waypointSymbol: "W", type: "SHIP", tradeSymbol: "SHIP_PROBE", total: 5000 });
    store.recordLedger({ timestamp: t, shipSymbol: "S3", waypointSymbol: "W", type: "SHIP", tradeSymbol: "SCRAP", total: 2000 });

    const rows = store.earningsByShip(ago(60));
    const s1 = rows.find((r) => r.shipSymbol === "S1")!;
    assert.equal(s1.net, 500, "1000 earned − 400 − 100");
    assert.equal(rows.find((r) => r.shipSymbol === "S2")!.net, -5000, "buying a ship is spend");
    assert.equal(rows.find((r) => r.shipSymbol === "S3")!.net, 2000, "scrapping a ship is income");
    assert.equal(rows[0]!.shipSymbol, "S3", "sorted by net, best first");
    store.close();
  });

  it("ignores entries outside the window", () => {
    const store = new Store(tempDb());
    store.recordLedger({ timestamp: ago(600), shipSymbol: "S1", waypointSymbol: "W", type: "SELL", total: 9999 });
    assert.equal(store.earningsByShip(ago(60)).length, 0);
    store.close();
  });
});

describe("Store.netSeries", () => {
  it("buckets ledger deltas and always reaches the present", () => {
    const store = new Store(tempDb());
    store.recordLedger({ timestamp: ago(30), shipSymbol: "S1", waypointSymbol: "W", type: "SELL", total: 800 });
    store.recordLedger({ timestamp: ago(30), shipSymbol: "S1", waypointSymbol: "W", type: "PURCHASE", total: 300 });
    const series = store.netSeries(ago(180), 60);
    assert.ok(series.length >= 3, "one bucket per hour up to now");
    assert.equal(series.reduce((s, p) => s + p.net, 0), 500, "sells net against purchases");
    store.close();
  });
});

describe("Doctrine", () => {
  it("falls back to code defaults when nothing is stored", () => {
    const d = new Doctrine(new Store(tempDb()));
    assert.equal(d.value("cashFloor"), 20_000);
    assert.equal(d.value("maxLossPct"), 15);
    assert.equal(d.value("snapshotMaxAgeMin"), 90);
    assert.equal(d.list().length, DOCTRINE_DEFAULTS.length);
  });

  it("persists an override and survives a reload", () => {
    const store = new Store(tempDb());
    const d = new Doctrine(store);
    d.set("cashFloor", { value: 45_000 });
    assert.equal(d.value("cashFloor"), 45_000);
    // A fresh instance over the same store sees the stored value.
    assert.equal(new Doctrine(store).value("cashFloor"), 45_000);
  });

  it("clamps values to the rule's declared bounds", () => {
    const d = new Doctrine(new Store(tempDb()));
    assert.equal(d.set("maxLossPct", { value: 9_999 }).value, 100, "clamped to max");
    assert.equal(d.set("maxLossPct", { value: -50 }).value, 0, "clamped to min");
  });

  it("returns the unconstrained value when a rule is switched off", () => {
    const d = new Doctrine(new Store(tempDb()));
    d.set("marginFloor", { enabled: false });
    // Off means "do not constrain", not "constrain to zero-ish by accident".
    assert.equal(d.value("marginFloor", 0), 0);
    assert.equal(d.isEnabled("marginFloor"), false);
    // With no fallback supplied the configured number is still returned.
    assert.equal(d.value("marginFloor"), 10);
  });

  it("rejects unknown rules rather than silently storing them", () => {
    const d = new Doctrine(new Store(tempDb()));
    assert.throws(() => d.set("nonsense", { value: 1 }), /unknown doctrine rule/);
    assert.throws(() => d.value("nonsense"), /unknown doctrine rule/);
  });
});
