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
    dispatcher.setManual("SHIP-A", { shipSymbol: "SHIP-A", good: "GOLD", role: "direct", buyAt: "X1-A-A1", sellAt: "X1-A-A2", buyPrice: 20, sellPrice: 60, profitPerTrip: 799, source: "manual" });
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

describe("TraderAgent warehouse roles", () => {
  const positions: WaypointPos[] = [
    { symbol: "X1-A-A1", x: 0, y: 0 },
    { symbol: "X1-A-A2", x: 1, y: 0 },
  ];

  /** A minimal, stateful SpaceTradersAPI stand-in for one ship. Tracks its
   *  own nav/cargo so navigate/dock/buy/sell/transfer calls compose into a
   *  believable sequence, without simulating real transit time. */
  function makeMock(thisSymbol: string, startAt: string) {
    let nav = { waypointSymbol: startAt, systemSymbol: "X1-A", status: "DOCKED" as string, route: { arrival: new Date(Date.now() - 1000).toISOString() } };
    let cargo: { capacity: number; units: number; inventory: { symbol: string; units: number }[] } = { capacity: 40, units: 0, inventory: [] };
    const fuel = { current: 100, capacity: 100 };
    const calls: string[] = [];
    const markets: Record<string, Record<string, { purchasePrice: number; sellPrice: number; tradeVolume: number }>> = {};
    const snapshot = () => ({
      symbol: thisSymbol,
      nav: { ...nav },
      fuel: { ...fuel },
      cargo: { capacity: cargo.capacity, units: cargo.units, inventory: cargo.inventory.map((i) => ({ ...i })) },
    });
    const api = {
      getShip: async () => snapshot(),
      orbitShip: async () => {
        nav = { ...nav, status: "IN_ORBIT" };
        return { nav };
      },
      dockShip: async () => {
        nav = { ...nav, status: "DOCKED" };
        return { nav };
      },
      navigateShip: async (_s: string, wp: string) => {
        calls.push(`navigate:${wp}`);
        nav = { waypointSymbol: wp, systemSymbol: "X1-A", status: "IN_ORBIT", route: { arrival: new Date(Date.now() - 1000).toISOString() } };
        return { nav, fuel };
      },
      getMarket: async (_sys: string, wp: string) => {
        const goods = markets[wp] ?? {};
        return { tradeGoods: Object.entries(goods).map(([symbol, g]) => ({ symbol, ...g })), imports: [], exports: [], exchange: [] };
      },
      getMyAgent: async () => ({ credits: 1_000_000 }),
      refuelShip: async () => ({ fuel: { current: 100, capacity: 100 }, transaction: { totalPrice: 0 } }),
      purchaseCargo: async (_s: string, tradeSymbol: string, units: number) => {
        calls.push(`purchase:${tradeSymbol}:${units}`);
        const price = markets[nav.waypointSymbol]?.[tradeSymbol]?.purchasePrice ?? 10;
        const existing = cargo.inventory.find((i) => i.symbol === tradeSymbol);
        if (existing) existing.units += units;
        else cargo.inventory.push({ symbol: tradeSymbol, units });
        cargo = { ...cargo, units: cargo.inventory.reduce((s, i) => s + i.units, 0) };
        return { cargo: snapshot().cargo, transaction: { pricePerUnit: price, totalPrice: price * units } };
      },
      sellCargo: async (_s: string, tradeSymbol: string, units: number) => {
        calls.push(`sell:${tradeSymbol}:${units}`);
        const price = markets[nav.waypointSymbol]?.[tradeSymbol]?.sellPrice ?? 20;
        cargo.inventory = cargo.inventory.filter((i) => i.symbol !== tradeSymbol);
        cargo = { ...cargo, units: cargo.inventory.reduce((s, i) => s + i.units, 0) };
        return { cargo: snapshot().cargo, transaction: { pricePerUnit: price, totalPrice: price * units } };
      },
      transferCargo: async (fromShip: string, tradeSymbol: string, units: number, toShip: string) => {
        calls.push(`transfer:${fromShip}->${toShip}:${tradeSymbol}:${units}`);
        // Only this mock's own ship's side of the transfer is modeled — the
        // counterparty (warehouse ship or buyer) lives in a different agent
        // the trader code never inspects directly.
        if (fromShip === thisSymbol) {
          const existing = cargo.inventory.find((i) => i.symbol === tradeSymbol);
          if (existing) existing.units -= units;
          cargo.inventory = cargo.inventory.filter((i) => i.units > 0);
          cargo = { ...cargo, units: cargo.inventory.reduce((s, i) => s + i.units, 0) };
        } else if (toShip === thisSymbol) {
          const existing = cargo.inventory.find((i) => i.symbol === tradeSymbol);
          if (existing) existing.units += units;
          else cargo.inventory.push({ symbol: tradeSymbol, units });
          cargo = { ...cargo, units: cargo.inventory.reduce((s, i) => s + i.units, 0) };
        }
        return { cargo: snapshot().cargo };
      },
      jettisonCargo: async (_s: string, tradeSymbol: string, units: number) => {
        cargo.inventory = cargo.inventory.filter((i) => i.symbol !== tradeSymbol);
        cargo = { ...cargo, units: 0 };
        return { cargo: snapshot().cargo };
      },
      supplyConstruction: async (_sys: string, wp: string, _s: string, tradeSymbol: string, units: number) => {
        calls.push(`supply:${wp}:${tradeSymbol}:${units}`);
        cargo.inventory = cargo.inventory.filter((i) => i.symbol !== tradeSymbol);
        cargo = { ...cargo, units: cargo.inventory.reduce((s, i) => s + i.units, 0) };
        return { construction: { symbol: wp, materials: [], isComplete: false }, cargo: snapshot().cargo };
      },
    };
    return { api, calls, markets, snapshot };
  }

  it("runBuy buys at the assigned market and deposits into the warehouse ship", async () => {
    const { api, calls, markets, snapshot } = makeMock("BUYER-1", "X1-A-A1");
    markets["X1-A-A1"] = { IRON: { purchasePrice: 10, sellPrice: 12, tradeVolume: 50 } };
    const deposits: { good: string; units: number; price: number; shipSymbol: string }[] = [];
    const t = new TraderAgent(snapshot() as any, {
      api: api as any,
      log: () => {},
      getMarketSnapshots: () => [{ waypointSymbol: "X1-A-A1", goodSymbol: "IRON", purchasePrice: 10, sellPrice: 12, tradeVolume: 50 }],
      getWarehouseShip: () => ({ shipSymbol: "WH-1", waypointSymbol: "X1-A-A2" }),
      warehouseDeposit: (good, units, price, shipSymbol) => deposits.push({ good, units, price, shipSymbol }),
      getCredits: () => 1_000_000,
    }).withWorld(positions);
    (t as any).loadSnapshots();

    const assignment = { shipSymbol: "BUYER-1", good: "IRON", role: "buy" as const, buyAt: "X1-A-A1", buyPrice: 10, profitPerTrip: 100, source: "auto" as const };
    const result = await (t as any).runBuy(assignment);

    assert.equal(result, true);
    assert.ok(calls.some((c) => c === "navigate:X1-A-A2"), `expected a navigate to the warehouse waypoint, got ${calls}`);
    assert.ok(calls.some((c) => c.startsWith("transfer:BUYER-1->WH-1:IRON:")), `expected a transfer into the warehouse ship, got ${calls}`);
    assert.deepEqual(deposits, [{ good: "IRON", units: 40, price: 10, shipSymbol: "BUYER-1" }]);
  });

  it("runBuy falls back to direct arbitrage when no warehouse ship is designated", async () => {
    const { api, calls, markets, snapshot } = makeMock("BUYER-1", "X1-A-A1");
    markets["X1-A-A1"] = { IRON: { purchasePrice: 10, sellPrice: 12, tradeVolume: 50 } };
    markets["X1-A-A2"] = { IRON: { purchasePrice: 90, sellPrice: 80, tradeVolume: 50 } };
    const t = new TraderAgent(snapshot() as any, {
      api: api as any,
      log: () => {},
      getMarketSnapshots: () => [
        { waypointSymbol: "X1-A-A1", goodSymbol: "IRON", purchasePrice: 10, sellPrice: 12, tradeVolume: 50 },
        { waypointSymbol: "X1-A-A2", goodSymbol: "IRON", purchasePrice: 90, sellPrice: 80, tradeVolume: 50 },
      ],
      getCredits: () => 1_000_000,
    }).withWorld(positions);
    (t as any).loadSnapshots();

    const assignment = { shipSymbol: "BUYER-1", good: "IRON", role: "buy" as const, buyAt: "X1-A-A1", buyPrice: 10, profitPerTrip: 100, source: "auto" as const };
    const result = await (t as any).runBuy(assignment);

    // No warehouse ship designated: falls through to the free-choice direct
    // pipeline instead of leaving the buy assignment stranded.
    assert.equal(result, true);
    assert.ok(!calls.some((c) => c.startsWith("transfer:")), "should never attempt a warehouse transfer with no warehouse ship");
    assert.ok(calls.some((c) => c.startsWith("sell:IRON:")), "the direct fallback should complete a full round trip");
  });

  it("runSell withdraws from the warehouse ship as the sender, then sells", async () => {
    const { api, calls, markets, snapshot } = makeMock("SELLER-1", "X1-A-A2");
    markets["X1-A-A2"] = { IRON: { purchasePrice: 10, sellPrice: 80, tradeVolume: 50 } };
    let withdrawUnits = 0;
    const t = new TraderAgent(snapshot() as any, {
      api: api as any,
      log: () => {},
      getMarketSnapshots: () => [{ waypointSymbol: "X1-A-A2", goodSymbol: "IRON", purchasePrice: 10, sellPrice: 80, tradeVolume: 50 }],
      getWarehouseShip: () => ({ shipSymbol: "WH-1", waypointSymbol: "X1-A-A1" }),
      warehouseBalance: (good) => (good === "IRON" ? 30 : 0),
      warehouseWithdraw: (good, units) => {
        withdrawUnits = units;
        return { units, avgCost: 8 };
      },
      getCredits: () => 1_000_000,
    }).withWorld(positions);
    (t as any).loadSnapshots();

    const assignment = { shipSymbol: "SELLER-1", good: "IRON", role: "sell" as const, sellAt: "X1-A-A2", sellPrice: 80, profitPerTrip: 100, source: "auto" as const };
    const result = await (t as any).runSell(assignment);

    assert.equal(result, true);
    assert.equal(withdrawUnits, 30);
    assert.ok(calls.some((c) => c.startsWith("transfer:WH-1->SELLER-1:IRON:")), `expected the warehouse ship to be the sender, got ${calls}`);
    assert.ok(calls.some((c) => c === "sell:IRON:30"), `expected a sell of the withdrawn units, got ${calls}`);
  });

  it("runSell holds cargo already withdrawn when the live price doesn't clear the warehouse margin floor", async () => {
    const { api, calls, markets, snapshot } = makeMock("SELLER-1", "X1-A-A2");
    markets["X1-A-A2"] = { IRON: { purchasePrice: 10, sellPrice: 80, tradeVolume: 50 } };
    const t = new TraderAgent(snapshot() as any, {
      api: api as any,
      log: () => {},
      getMarketSnapshots: () => [{ waypointSymbol: "X1-A-A2", goodSymbol: "IRON", purchasePrice: 10, sellPrice: 80, tradeVolume: 50 }],
      getWarehouseShip: () => ({ shipSymbol: "WH-1", waypointSymbol: "X1-A-A1" }),
      warehouseBalance: (good) => (good === "IRON" ? 30 : 0),
      warehouseWithdraw: (good, units) => ({ units, avgCost: 8 }),
      // 80c live sell only clears the 8c cost basis by 72c — demand more than that.
      warehouseMinMargin: () => 1_000,
      getCredits: () => 1_000_000,
    }).withWorld(positions);
    (t as any).loadSnapshots();

    const assignment = { shipSymbol: "SELLER-1", good: "IRON", role: "sell" as const, sellAt: "X1-A-A2", sellPrice: 80, profitPerTrip: 100, source: "auto" as const };
    const result = await (t as any).runSell(assignment);

    assert.equal(result, true, "still consumed the tick (withdrew), just held instead of selling at a thin margin");
    assert.ok(calls.some((c) => c.startsWith("transfer:WH-1->SELLER-1:IRON:")), "withdrawal still happens before the margin check");
    assert.ok(!calls.some((c) => c.startsWith("sell:")), "must not sell below the warehouse margin floor");
  });

  it("runSell defers when the warehouse holds none of the good", async () => {
    const { api, calls, snapshot } = makeMock("SELLER-1", "X1-A-A2");
    const t = new TraderAgent(snapshot() as any, {
      api: api as any,
      log: () => {},
      getMarketSnapshots: () => [],
      getWarehouseShip: () => ({ shipSymbol: "WH-1", waypointSymbol: "X1-A-A1" }),
      warehouseBalance: () => 0,
      getCredits: () => 1_000_000,
    }).withWorld(positions);
    (t as any).loadSnapshots();

    const assignment = { shipSymbol: "SELLER-1", good: "IRON", role: "sell" as const, sellAt: "X1-A-A2", sellPrice: 80, profitPerTrip: 100, source: "auto" as const };
    const result = await (t as any).runSell(assignment);

    assert.equal(result, false, "nothing to withdraw and no known market to refresh prices at");
    assert.ok(!calls.some((c) => c.startsWith("transfer:")));
  });

  it("runHaul withdraws from the warehouse ship and delivers to the construction site", async () => {
    const { api, calls, snapshot } = makeMock("HAULER-1", "X1-A-I59");
    let withdrawUnits = 0;
    const t = new TraderAgent(snapshot() as any, {
      api: api as any,
      log: () => {},
      getMarketSnapshots: () => [],
      getWarehouseShip: () => ({ shipSymbol: "WH-1", waypointSymbol: "X1-A-A1" }),
      warehouseBalance: (good) => (good === "FAB_MATS" ? 30 : 0),
      warehouseWithdraw: (good, units) => {
        withdrawUnits = units;
        return { units, avgCost: 61 };
      },
      getCredits: () => 1_000_000,
    }).withWorld(positions);
    (t as any).loadSnapshots();

    const assignment = { shipSymbol: "HAULER-1", good: "FAB_MATS", role: "haul" as const, sellAt: "X1-A-I59", profitPerTrip: 2500, source: "auto" as const };
    const result = await (t as any).runHaul(assignment);

    assert.equal(result, true);
    assert.equal(withdrawUnits, 30);
    assert.ok(calls.some((c) => c.startsWith("transfer:WH-1->HAULER-1:FAB_MATS:")), `expected the warehouse ship to be the sender, got ${calls}`);
    assert.ok(calls.some((c) => c === "supply:X1-A-I59:FAB_MATS:30"), `expected a delivery to the construction site, got ${calls}`);
    // Not a sale: no loss-floor/margin gate should ever hold delivered cargo back.
    assert.ok(!calls.some((c) => c.startsWith("sell:")));
  });

  it("runHaul falls back to direct arbitrage when no warehouse ship is designated", async () => {
    const { calls, markets, snapshot, api } = makeMock("HAULER-1", "X1-A-A1");
    markets["X1-A-A1"] = { IRON: { purchasePrice: 10, sellPrice: 12, tradeVolume: 50 } };
    markets["X1-A-A2"] = { IRON: { purchasePrice: 90, sellPrice: 80, tradeVolume: 50 } };
    const t = new TraderAgent(snapshot() as any, {
      api: api as any,
      log: () => {},
      getMarketSnapshots: () => [
        { waypointSymbol: "X1-A-A1", goodSymbol: "IRON", purchasePrice: 10, sellPrice: 12, tradeVolume: 50 },
        { waypointSymbol: "X1-A-A2", goodSymbol: "IRON", purchasePrice: 90, sellPrice: 80, tradeVolume: 50 },
      ],
      getCredits: () => 1_000_000,
    }).withWorld(positions);
    (t as any).loadSnapshots();

    const assignment = { shipSymbol: "HAULER-1", good: "FAB_MATS", role: "haul" as const, sellAt: "X1-A-I59", profitPerTrip: 2500, source: "auto" as const };
    const result = await (t as any).runHaul(assignment);

    assert.equal(result, true);
    assert.ok(!calls.some((c) => c.startsWith("supply:")), "should never attempt a delivery with no warehouse ship");
    assert.ok(calls.some((c) => c.startsWith("sell:IRON:")), "the direct fallback should complete a full round trip instead");
  });

  it("runHaul defers when the warehouse holds none of the good", async () => {
    const { api, calls, snapshot } = makeMock("HAULER-1", "X1-A-I59");
    const t = new TraderAgent(snapshot() as any, {
      api: api as any,
      log: () => {},
      getMarketSnapshots: () => [],
      getWarehouseShip: () => ({ shipSymbol: "WH-1", waypointSymbol: "X1-A-A1" }),
      warehouseBalance: () => 0,
      getCredits: () => 1_000_000,
    }).withWorld(positions);
    (t as any).loadSnapshots();

    const assignment = { shipSymbol: "HAULER-1", good: "FAB_MATS", role: "haul" as const, sellAt: "X1-A-I59", profitPerTrip: 2500, source: "auto" as const };
    const result = await (t as any).runHaul(assignment);

    assert.equal(result, false);
    assert.ok(!calls.some((c) => c.startsWith("transfer:")));
  });

  it("tick() dispatches to runHaul for a haul-role assignment", async () => {
    const { api, snapshot } = makeMock("HAULER-1", "X1-A-I59");
    let delivered = 0;
    const t = new TraderAgent(snapshot() as any, {
      api: api as any,
      log: () => {},
      getMarketSnapshots: () => [],
      assignedRoute: () => ({ shipSymbol: "HAULER-1", good: "FAB_MATS", role: "haul", sellAt: "X1-A-I59", profitPerTrip: 2500, source: "auto" }),
      getWarehouseShip: () => ({ shipSymbol: "WH-1", waypointSymbol: "X1-A-A1" }),
      warehouseBalance: () => 30,
      warehouseWithdraw: (good, units) => {
        delivered = units;
        return { units, avgCost: 61 };
      },
      getCredits: () => 1_000_000,
    }).withWorld(positions);

    const result = await t.tick();
    assert.equal(result, true);
    assert.equal(delivered, 30);
  });

  it("tick() dispatches to runBuy for a buy-role assignment", async () => {
    const { api, markets, snapshot } = makeMock("BUYER-1", "X1-A-A1");
    markets["X1-A-A1"] = { IRON: { purchasePrice: 10, sellPrice: 12, tradeVolume: 50 } };
    const deposits: unknown[] = [];
    const t = new TraderAgent(snapshot() as any, {
      api: api as any,
      log: () => {},
      getMarketSnapshots: () => [{ waypointSymbol: "X1-A-A1", goodSymbol: "IRON", purchasePrice: 10, sellPrice: 12, tradeVolume: 50 }],
      assignedRoute: () => ({ shipSymbol: "BUYER-1", good: "IRON", role: "buy", buyAt: "X1-A-A1", buyPrice: 10, profitPerTrip: 100, source: "auto" }),
      getWarehouseShip: () => ({ shipSymbol: "WH-1", waypointSymbol: "X1-A-A2" }),
      warehouseDeposit: (...args) => deposits.push(args),
      getCredits: () => 1_000_000,
    }).withWorld(positions);

    const result = await t.tick();
    assert.equal(result, true);
    assert.equal(deposits.length, 1);
  });
});
