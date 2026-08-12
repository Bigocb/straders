import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";

const routes: DispatchRoute[] = [
  { good: "IRON", buyAt: "X1-A-A1", buySystem: "X1-A", buyPrice: 10, sellAt: "X1-A-A2", sellSystem: "X1-A", sellPrice: 60, volume: 20, distance: 10, fuelUnits: 20, fuelCost: 100, profitPerTrip: 1000, ageMinutes: 5 },
  { good: "GOLD", buyAt: "X1-A-A1", buySystem: "X1-A", buyPrice: 20, sellAt: "X1-A-A3", sellSystem: "X1-A", sellPrice: 50, volume: 10, distance: 10, fuelUnits: 20, fuelCost: 100, profitPerTrip: 300, ageMinutes: 5 },
  { good: "COAL", buyAt: "X1-A-A1", buySystem: "X1-A", buyPrice: 5, sellAt: "X1-A-A4", sellSystem: "X1-A", sellPrice: 25, volume: 30, distance: 10, fuelUnits: 20, fuelCost: 100, profitPerTrip: 600, ageMinutes: 5 },
];

describe("RouteDispatcher", () => {
  it("assigns a distinct good to each trader, no two share a good", () => {
    const d = new RouteDispatcher();
    d.recompute(routes, [
      { shipSymbol: "SHIP-A", capacity: 80 },
      { shipSymbol: "SHIP-B", capacity: 60 },
      { shipSymbol: "SHIP-C", capacity: 40 },
    ]);
    const a = d.assignmentFor("SHIP-A")!;
    const b = d.assignmentFor("SHIP-B")!;
    const c = d.assignmentFor("SHIP-C")!;
    assert.equal(a.good, "IRON", "biggest hold gets the most profitable route");
    const goods = new Set([a.good, b.good, c.good]);
    assert.equal(goods.size, 3, "all three traders get different goods");
  });

  it("honors a manual override and reserves its good from auto-assignment", () => {
    const d = new RouteDispatcher();
    d.setManual("SHIP-A", { shipSymbol: "SHIP-A", good: "GOLD", buyAt: "X1-A-A1", sellAt: "X1-A-A3", buyPrice: 20, sellPrice: 50, profitPerTrip: 300, source: "manual" });
    d.recompute(routes, [
      { shipSymbol: "SHIP-A", capacity: 80 },
      { shipSymbol: "SHIP-B", capacity: 60 },
      { shipSymbol: "SHIP-C", capacity: 40 },
    ]);
    assert.equal(d.assignmentFor("SHIP-A")!.good, "GOLD");
    assert.equal(d.assignmentFor("SHIP-A")!.source, "manual");
    // SHIP-B and SHIP-C must not get GOLD.
    assert.notEqual(d.assignmentFor("SHIP-B")!.good, "GOLD");
    assert.notEqual(d.assignmentFor("SHIP-C")!.good, "GOLD");
    assert.equal(d.isManual("SHIP-A"), true);
  });

  it("clearing a manual override restores auto assignment", () => {
    const d = new RouteDispatcher();
    d.setManual("SHIP-A", { shipSymbol: "SHIP-A", good: "GOLD", buyAt: "X1-A-A1", sellAt: "X1-A-A3", buyPrice: 20, sellPrice: 50, profitPerTrip: 300, source: "manual" });
    d.setManual("SHIP-A", undefined);
    d.recompute(routes, [{ shipSymbol: "SHIP-A", capacity: 80 }]);
    assert.equal(d.isManual("SHIP-A"), false);
    assert.equal(d.assignmentFor("SHIP-A")!.source, "auto");
  });
});
