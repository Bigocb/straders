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
    d.setManual("SHIP-A", { shipSymbol: "SHIP-A", good: "GOLD", role: "direct", buyAt: "X1-A-A1", sellAt: "X1-A-A3", buyPrice: 20, sellPrice: 50, profitPerTrip: 300, source: "manual" });
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
    d.setManual("SHIP-A", { shipSymbol: "SHIP-A", good: "GOLD", role: "direct", buyAt: "X1-A-A1", sellAt: "X1-A-A3", buyPrice: 20, sellPrice: 50, profitPerTrip: 300, source: "manual" });
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
      d.setManual("SHIP-A", { shipSymbol: "SHIP-A", good: "GOLD", role: "direct", buyAt: "X1-A-A1", sellAt: "X1-A-A3", buyPrice: 20, sellPrice: 50, profitPerTrip: 300, source: "manual" });
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

describe("RouteDispatcher warehouse roles", () => {
  it("with no warehouse targets, every good is still assigned direct — today's behavior, unchanged", () => {
    const d = new RouteDispatcher();
    d.recompute(routes, [
      { shipSymbol: "SHIP-A", capacity: 80 },
      { shipSymbol: "SHIP-B", capacity: 60 },
    ]);
    assert.equal(d.assignmentFor("SHIP-A")!.role, "direct");
    assert.equal(d.assignmentFor("SHIP-B")!.role, "direct");
  });

  it("a good under its warehouse target gets a buy trader, buy-side fields only", () => {
    const d = new RouteDispatcher();
    d.recompute(routes, [{ shipSymbol: "SHIP-A", capacity: 80 }], [{ good: "IRON", target: 500, balance: 100 }]);
    const a = d.assignmentFor("SHIP-A")!;
    assert.equal(a.role, "buy");
    assert.equal(a.good, "IRON");
    assert.equal(a.buyAt, "X1-A-A1");
    assert.equal(a.buyPrice, 10);
    assert.equal(a.sellAt, undefined, "a buy assignment has no sell leg of its own");
    assert.equal(a.sellPrice, undefined);
  });

  it("a good over its warehouse target gets a sell trader, sell-side fields only", () => {
    const d = new RouteDispatcher();
    d.recompute(routes, [{ shipSymbol: "SHIP-A", capacity: 80 }], [{ good: "IRON", target: 500, balance: 900 }]);
    const a = d.assignmentFor("SHIP-A")!;
    assert.equal(a.role, "sell");
    assert.equal(a.good, "IRON");
    assert.equal(a.sellAt, "X1-A-A2");
    assert.equal(a.sellPrice, 60);
    assert.equal(a.buyAt, undefined, "a sell assignment has no buy leg of its own");
    assert.equal(a.buyPrice, undefined);
  });

  it("a good sitting right at its target gets no trader — not buy, not sell", () => {
    const d = new RouteDispatcher();
    d.recompute(routes, [{ shipSymbol: "SHIP-A", capacity: 80 }], [{ good: "IRON", target: 500, balance: 500 }]);
    // IRON is on-target and skipped; SHIP-A falls through to the next best
    // untargeted good instead of sitting idle.
    const a = d.assignmentFor("SHIP-A")!;
    assert.notEqual(a.good, "IRON");
    assert.equal(a.role, "direct");
  });

  it("a busy buy trader and a fresh sell trader can hold the same good at once", () => {
    const d = new RouteDispatcher();
    const fabRoute: DispatchRoute[] = [
      { good: "FAB_MATS", buyAt: "X1-A-D46", buySystem: "X1-A", buyPrice: 61, sellAt: "X1-A-I59", sellSystem: "X1-A", sellPrice: 140, volume: 40, distance: 15, fuelUnits: 15, fuelCost: 1080, profitPerTrip: 2080, ageMinutes: 2 },
    ];

    // Cycle 1: FAB_MATS is well under target. SHIP-A, idle, claims the buy side.
    d.recompute(fabRoute, [{ shipSymbol: "SHIP-A", capacity: 40 }], [{ good: "FAB_MATS", target: 500, balance: 100 }]);
    assert.equal(d.assignmentFor("SHIP-A")!.role, "buy");

    // Cycle 2: SHIP-A is now busy — still flying with that purchase, hasn't
    // deposited yet — but other deposits already pushed the balance over
    // target. SHIP-B is idle and should pick up the sell side of the SAME
    // good, without evicting SHIP-A's still-in-flight buy.
    (d as any).lastComputed = 0;
    d.recompute(
      fabRoute,
      [
        { shipSymbol: "SHIP-A", capacity: 40, busy: true },
        { shipSymbol: "SHIP-B", capacity: 40 },
      ],
      [{ good: "FAB_MATS", target: 500, balance: 520 }],
    );
    const a = d.assignmentFor("SHIP-A")!;
    const b = d.assignmentFor("SHIP-B")!;
    assert.equal(a.role, "buy", "busy buyer keeps its in-flight assignment");
    assert.equal(a.good, "FAB_MATS");
    assert.equal(b.role, "sell", "idle ship takes the sell side of the same good");
    assert.equal(b.good, "FAB_MATS");
  });

  it("a manual override on a good blocks auto buy AND sell roles for it, not just the good's default role", () => {
    const d = new RouteDispatcher();
    d.setManual("SHIP-A", { shipSymbol: "SHIP-A", good: "IRON", role: "direct", buyAt: "X1-A-A1", sellAt: "X1-A-A2", buyPrice: 10, sellPrice: 60, profitPerTrip: 1000, source: "manual" });
    d.recompute(
      routes,
      [
        { shipSymbol: "SHIP-A", capacity: 80 },
        { shipSymbol: "SHIP-B", capacity: 60 },
      ],
      [{ good: "IRON", target: 500, balance: 900 }], // would otherwise assign a "sell" to SHIP-B
    );
    assert.equal(d.assignmentFor("SHIP-A")!.good, "IRON");
    assert.notEqual(d.assignmentFor("SHIP-B")!.good, "IRON", "the operator's pin reserves IRON in every role, not just direct");
  });
});

describe("RouteDispatcher haul roles", () => {
  it("with no haul targets, nobody gets a haul assignment — today's behavior, unchanged", () => {
    const d = new RouteDispatcher();
    d.recompute(routes, [{ shipSymbol: "SHIP-A", capacity: 80 }]);
    assert.notEqual(d.assignmentFor("SHIP-A")!.role, "haul");
  });

  it("a good the warehouse holds and a mission needs gets a haul trader to the construction site", () => {
    const d = new RouteDispatcher();
    d.recompute(routes, [{ shipSymbol: "SHIP-A", capacity: 80 }], [], [
      { good: "FAB_MATS", targetWaypoint: "X1-A-I59", needed: 200, balance: 50 },
    ]);
    const a = d.assignmentFor("SHIP-A")!;
    assert.equal(a.role, "haul");
    assert.equal(a.good, "FAB_MATS");
    assert.equal(a.sellAt, "X1-A-I59", "the construction waypoint travels in sellAt");
    assert.equal(a.buyAt, undefined);
  });

  it("a haul trader and a direct trader can run different goods at once", () => {
    const d = new RouteDispatcher();
    d.recompute(routes, [
      { shipSymbol: "SHIP-A", capacity: 80 },
      { shipSymbol: "SHIP-B", capacity: 60 },
    ], [], [
      { good: "FAB_MATS", targetWaypoint: "X1-A-I59", needed: 200, balance: 50 },
    ]);
    // FAB_MATS isn't in the routes list at all, so this is purely additive
    // work — it must not crowd out IRON going to a direct trader.
    const goods = [d.assignmentFor("SHIP-A")!.good, d.assignmentFor("SHIP-B")!.good];
    assert.ok(goods.includes("FAB_MATS"));
    assert.ok(goods.includes("IRON"));
  });

  it("a haul trader and a buy trader can hold the same good at once", () => {
    const d = new RouteDispatcher();
    const fabRoute: DispatchRoute[] = [
      { good: "FAB_MATS", buyAt: "X1-A-D46", buySystem: "X1-A", buyPrice: 61, sellAt: "X1-A-C3", sellSystem: "X1-A", sellPrice: 140, volume: 40, distance: 15, fuelUnits: 15, fuelCost: 1080, profitPerTrip: 2080, ageMinutes: 2 },
    ];
    d.recompute(
      fabRoute,
      [
        { shipSymbol: "SHIP-A", capacity: 40 },
        { shipSymbol: "SHIP-B", capacity: 40 },
      ],
      [{ good: "FAB_MATS", target: 500, balance: 100 }],
      [{ good: "FAB_MATS", targetWaypoint: "X1-A-I59", needed: 200, balance: 50 }],
    );
    const a = d.assignmentFor("SHIP-A")!;
    const b = d.assignmentFor("SHIP-B")!;
    assert.equal(new Set([a.role, b.role]).size, 2, "one buys into the warehouse, the other hauls out of it");
    assert.ok([a.role, b.role].includes("buy"));
    assert.ok([a.role, b.role].includes("haul"));
  });

  it("zero warehouse stock means no haul assignment even when the mission needs it", () => {
    const d = new RouteDispatcher();
    d.recompute(routes, [{ shipSymbol: "SHIP-A", capacity: 80 }], [], [
      { good: "FAB_MATS", targetWaypoint: "X1-A-I59", needed: 200, balance: 0 },
    ]);
    assert.notEqual(d.assignmentFor("SHIP-A")!.role, "haul");
  });

  it("a manual override on a good blocks auto haul too, not just direct/buy/sell", () => {
    const d = new RouteDispatcher();
    d.setManual("SHIP-A", { shipSymbol: "SHIP-A", good: "FAB_MATS", role: "direct", buyAt: "X1-A-D46", sellAt: "X1-A-C3", buyPrice: 61, sellPrice: 140, profitPerTrip: 2080, source: "manual" });
    d.recompute(
      routes,
      [
        { shipSymbol: "SHIP-A", capacity: 80 },
        { shipSymbol: "SHIP-B", capacity: 60 },
      ],
      [],
      [{ good: "FAB_MATS", targetWaypoint: "X1-A-I59", needed: 200, balance: 50 }],
    );
    assert.notEqual(d.assignmentFor("SHIP-B")!.good, "FAB_MATS", "the operator's pin reserves FAB_MATS in every role, including haul");
  });
});
