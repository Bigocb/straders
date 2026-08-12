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

  it("keeps a busy trader on the route it is already hauling", () => {
    const d = new RouteDispatcher();
    d.recompute(routes, [
      { shipSymbol: "SHIP-A", capacity: 80 },
      { shipSymbol: "SHIP-B", capacity: 60 },
    ]);
    const before = d.assignmentFor("SHIP-B")!.good;
    // A minute later the route list has re-ranked so SHIP-B's good is no longer
    // top — but SHIP-B is mid-haul with that cargo in the hold.
    (d as any).lastComputed = 0;
    const reranked = [...routes].reverse();
    d.recompute(reranked, [
      { shipSymbol: "SHIP-A", capacity: 80 },
      { shipSymbol: "SHIP-B", capacity: 60, busy: true },
    ]);
    assert.equal(d.assignmentFor("SHIP-B")!.good, before, "busy trader is not reassigned mid-trip");
    assert.notEqual(d.assignmentFor("SHIP-A")!.good, before, "and its good stays reserved");
  });

  describe("claim", () => {
    const seed = (d: RouteDispatcher) => {
      d.recompute(routes, []);
    };

    it("hands two traders different goods even when both claim at once", () => {
      const d = new RouteDispatcher();
      seed(d);
      // This is the convergence case: two traders evaluating routes with no
      // assignments in hand. Before the claim existed they each scanned the
      // same table and both picked IRON.
      const a = d.claim("SHIP-A")!;
      const b = d.claim("SHIP-B")!;
      assert.equal(a.good, "IRON", "first claimant takes the best route");
      assert.notEqual(b.good, a.good, "second claimant cannot take the same good");
    });

    it("skips routes the ship rejects and takes the next best", () => {
      const d = new RouteDispatcher();
      seed(d);
      // The list arrives pre-ranked from computeDispatchRoutes, so "next in the
      // list" is "next best".
      const claimed = d.claim("SHIP-A", (r) => r.good !== "IRON")!;
      assert.equal(claimed.good, routes[1]!.good);
    });

    it("drops the assignment when nothing is claimable, freeing the good", () => {
      const d = new RouteDispatcher();
      seed(d);
      d.claim("SHIP-A");
      assert.equal(d.assignmentFor("SHIP-A")!.good, "IRON");
      assert.equal(d.claim("SHIP-A", () => false), undefined);
      assert.equal(d.assignmentFor("SHIP-A"), undefined, "stale claim is released");
      assert.equal(d.claim("SHIP-B")!.good, "IRON", "so a fleetmate can take it");
    });

    it("re-claiming keeps the same route rather than churning", () => {
      const d = new RouteDispatcher();
      seed(d);
      assert.equal(d.claim("SHIP-A")!.good, "IRON");
      assert.equal(d.claim("SHIP-A")!.good, "IRON");
    });

    it("never overrides a manual assignment", () => {
      const d = new RouteDispatcher();
      seed(d);
      d.setManual("SHIP-A", { shipSymbol: "SHIP-A", good: "GOLD", buyAt: "X1-A-A1", sellAt: "X1-A-A3", buyPrice: 20, sellPrice: 50, profitPerTrip: 300, source: "manual" });
      assert.equal(d.claim("SHIP-A")!.good, "GOLD");
      assert.notEqual(d.claim("SHIP-B")!.good, "GOLD", "and the operator's good stays reserved");
    });

    it("hands out nothing when there are no routes, instead of a stale one", () => {
      const d = new RouteDispatcher();
      seed(d);
      d.claim("SHIP-A");
      (d as any).lastComputed = 0;
      d.recompute([], []);
      assert.equal(d.claim("SHIP-A"), undefined);
    });
  });

  it("throttles recompute even when it produced no assignments", () => {
    const d = new RouteDispatcher();
    // The empty-assignment case — no fresh intel — used to bypass the throttle
    // and rebuild on every 2s coordinator tick.
    d.recompute([], [{ shipSymbol: "SHIP-A", capacity: 80 }]);
    assert.equal(d.assignmentFor("SHIP-A"), undefined);
    d.recompute(routes, [{ shipSymbol: "SHIP-A", capacity: 80 }]);
    assert.equal(d.assignmentFor("SHIP-A"), undefined, "second call inside the minute is a no-op");
    assert.deepEqual(d.routeList(), [], "and the route list is not rebuilt either");
  });
});
