import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type WaypointPos } from "../src/engine/trader.js";
import { RouteDispatcher, type DispatchRoute } from "../src/engine/dispatcher.js";
import { GalaxyAtlas } from "../src/engine/galaxy.js";
import type { components } from "../src/core/client.js";

type Ship = components["schemas"]["Ship"];

function makeShip(overrides: Partial<Ship> = {}): Ship {
  return {
    symbol: "TEST-1",
    registration: { name: "Test", factionSymbol: "COSMIC", role: "EXCAVATOR" },
    nav: {
      systemSymbol: "X1-A",
      waypointSymbol: "X1-A-A1",
      route: { destination: { symbol: "X1-A-A1", type: "PLANET", systemSymbol: "X1-A", x: 0, y: 0 }, origin: { symbol: "X1-A-A1", type: "PLANET", systemSymbol: "X1-A", x: 0, y: 0 }, departureTime: new Date().toISOString(), arrival: new Date(Date.now() - 1000).toISOString() },
      status: "DOCKED",
      flightMode: "CRUISE",
    },
    crew: { current: 1, required: 1, capacity: 1, rotation: "STRICT", morale: 100, wages: 0 },
    fuel: { current: 100, capacity: 100 },
    frame: { symbol: "FRAME_PROBE", name: "Probe", description: "", condition: 1, integrity: 1, quality: 1, moduleSlots: 1, mountingPoints: 1, fuelCapacity: 100, requirements: { power: 1, crew: 1 } },
    reactor: { symbol: "REACTOR_SOLAR_I", name: "Solar", description: "", condition: 1, integrity: 1, quality: 1, powerOutput: 1, requirements: { power: 0, crew: 0 } },
    engine: { symbol: "ENGINE_IMPULSE_DRIVE_I", name: "Impulse", description: "", condition: 1, integrity: 1, quality: 1, speed: 10, requirements: { power: 1, crew: 0 } },
    cooldown: { shipSymbol: "TEST-1", totalSeconds: 0, remainingSeconds: 0, expiration: new Date().toISOString() },
    modules: [],
    mounts: [],
    cargo: { capacity: 40, units: 0, inventory: [] },
    ...overrides,
  };
}

function makeAtlas(): GalaxyAtlas {
  const atlas = new GalaxyAtlas({} as any);
  const mk = (sys: string, gates: { symbol: string; connections: string[] }[]) => ({
    symbol: sys,
    waypoints: gates.map((g) => ({ symbol: g.symbol, x: 0, y: 0, type: "JUMP_GATE", traits: [] })) as any,
    jumpGates: gates,
    markets: [],
  });
  (atlas as any).systems.set("X1-A", mk("X1-A", [{ symbol: "X1-A-G1", connections: ["X1-B-G1"] }]));
  (atlas as any).systems.set("X1-B", mk("X1-B", [{ symbol: "X1-B-G1", connections: ["X1-A-G1"] }]));
  return atlas;
}

describe("TraderAgent cross-system navigation", () => {
  it("jumps to a waypoint in another system via the jump gate", async () => {
    const calls: string[] = [];
    const api = {
      getShip: async () => ship,
      orbitShip: async () => { calls.push("orbit"); return { nav: {} }; },
      navigateShip: async (s: string, wp: string) => { calls.push(`navigate:${wp}`); return { nav: { waypointSymbol: wp, systemSymbol: "X1-A", status: "IN_ORBIT", route: { arrival: new Date(Date.now() - 1000).toISOString() } }, fuel: { current: 80, capacity: 100 } }; },
      jumpShip: async (s: string, wp: string) => { calls.push(`jump:${wp}`); return { nav: { systemSymbol: "X1-B", waypointSymbol: wp, status: "IN_ORBIT", route: {} }, cooldown: {}, transaction: { totalPrice: 500 }, agent: {} }; },
      dockShip: async () => ({ nav: {} }),
      getMarket: async () => ({ tradeGoods: [], imports: [], exports: [], exchange: [] }),
    };
    let ship = makeShip();
    const trader = new TraderAgent(ship, { api: api as any, atlas: makeAtlas() });
    const positions: WaypointPos[] = [
      { symbol: "X1-A-A1", x: 0, y: 0 },
      { symbol: "X1-A-G1", x: 10, y: 10 },
    ];
    trader.withWorld(positions);

    await trader.dispatchTo("X1-B-B1");
    assert.ok(calls.some((c) => c === "jump:X1-B-B1"), `expected jump call, got ${calls}`);
  });
});

describe("TraderAgent route selection", () => {
  // Two markets, three goods. IRON is the fat one — the good every trader
  // independently picked before route claims existed.
  const snapshots = [
    { waypointSymbol: "X1-A-A1", goodSymbol: "IRON", purchasePrice: 10, sellPrice: 12, tradeVolume: 20 },
    { waypointSymbol: "X1-A-A2", goodSymbol: "IRON", purchasePrice: 90, sellPrice: 80, tradeVolume: 20 },
    { waypointSymbol: "X1-A-A1", goodSymbol: "GOLD", purchasePrice: 20, sellPrice: 22, tradeVolume: 20 },
    { waypointSymbol: "X1-A-A2", goodSymbol: "GOLD", purchasePrice: 70, sellPrice: 60, tradeVolume: 20 },
    { waypointSymbol: "X1-A-A1", goodSymbol: "FUEL", purchasePrice: 1, sellPrice: 1, tradeVolume: 100 },
  ];
  const positions: WaypointPos[] = [
    { symbol: "X1-A-A1", x: 0, y: 0 },
    { symbol: "X1-A-A2", x: 1, y: 0 },
  ];
  const dispatchRoutes: DispatchRoute[] = [
    { good: "IRON", buyAt: "X1-A-A1", buySystem: "X1-A", buyPrice: 10, sellAt: "X1-A-A2", sellSystem: "X1-A", sellPrice: 80, volume: 20, distance: 1, fuelUnits: 1, fuelCost: 1, profitPerTrip: 1399, ageMinutes: 1 },
    { good: "GOLD", buyAt: "X1-A-A1", buySystem: "X1-A", buyPrice: 20, sellAt: "X1-A-A2", sellSystem: "X1-A", sellPrice: 60, volume: 20, distance: 1, fuelUnits: 1, fuelCost: 1, profitPerTrip: 799, ageMinutes: 1 },
  ];

  const makeTrader = (symbol: string, dispatcher: RouteDispatcher) => {
    const t = new TraderAgent(makeShip({ symbol }), {
      api: {} as any,
      log: () => {},
      getMarketSnapshots: () => snapshots,
      assignedRoute: () => dispatcher.assignmentFor(symbol),
      claimRoute: (accept) => dispatcher.claim(symbol, (r) => accept(r)),
      releaseRoute: () => dispatcher.release(symbol),
      getCredits: () => 1_000_000,
    }).withWorld(positions);
    (t as any).loadSnapshots();
    return t;
  };

  it("two traders on one dispatcher never take the same good", () => {
    const dispatcher = new RouteDispatcher();
    dispatcher.recompute(dispatchRoutes, []);
    const a = makeTrader("SHIP-A", dispatcher);
    const b = makeTrader("SHIP-B", dispatcher);

    // Neither has an assignment yet, so both claim — the exact situation that
    // used to put the whole fleet on IRON.
    const routeA = (a as any).findRoute();
    const routeB = (b as any).findRoute();
    assert.equal(routeA.good, "IRON", "first to ask gets the best route");
    assert.equal(routeB.good, "GOLD", "second gets the next one, not IRON");
  });

  it("flies the dispatcher's markets, not its own re-derived pair", () => {
    const dispatcher = new RouteDispatcher();
    dispatcher.recompute(dispatchRoutes, []);
    const t = makeTrader("SHIP-A", dispatcher);
    dispatcher.setManual("SHIP-A", { shipSymbol: "SHIP-A", good: "GOLD", buyAt: "X1-A-A1", sellAt: "X1-A-A2", buyPrice: 20, sellPrice: 60, profitPerTrip: 799, source: "manual" });
    const route = (t as any).findRoute();
    assert.equal(route.good, "GOLD");
    assert.equal(route.buyAt, "X1-A-A1");
    assert.equal(route.sellAt, "X1-A-A2");
  });

  it("takes no route at all when the dispatcher has none", () => {
    const dispatcher = new RouteDispatcher();
    dispatcher.recompute([], []);
    const t = makeTrader("SHIP-A", dispatcher);
    // The old free-choice fallback would have found IRON in the price table
    // here — and so would every other trader, at the same moment.
    assert.equal((t as any).findRoute(), undefined);
  });

  it("still picks for itself when no dispatcher is wired", () => {
    const t = new TraderAgent(makeShip({ symbol: "SOLO" }), {
      api: {} as any,
      log: () => {},
      getMarketSnapshots: () => snapshots,
      getCredits: () => 1_000_000,
    }).withWorld(positions);
    (t as any).loadSnapshots();
    assert.equal((t as any).findRoute().good, "IRON");
  });

  it("forgets prices that have aged past the intel window", () => {
    const t = new TraderAgent(makeShip({ symbol: "SOLO" }), {
      api: {} as any,
      log: () => {},
      getMarketSnapshots: () => snapshots,
      getCredits: () => 1_000_000,
    }).withWorld(positions);
    (t as any).loadSnapshots();
    assert.ok((t as any).priceTable.get("X1-A-A1"));
    // The store's fresh view drops the markets; the trader's table must drop
    // them too, rather than trading on a remembered copy the dispatcher can no
    // longer see.
    (t as any).getMarketSnapshots = () => [];
    (t as any).loadSnapshots();
    assert.equal((t as any).priceTable.size, 0);
    assert.equal((t as any).findRoute(), undefined);
  });
});
