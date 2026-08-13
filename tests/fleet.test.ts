import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FleetManager } from "../src/engine/fleet.js";
import { Store } from "../src/engine/store.js";

function tempDb(): string {
  return `/tmp/opencode/startraders-fleet-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

/** A minimal stand-in for the agent classes FleetManager holds in its role maps. */
function makeFakeAgent(symbol: string, waypointSymbol: string, cargoCapacity = 40, cargoUnits = 0) {
  let nav = { status: "DOCKED", waypointSymbol, systemSymbol: waypointSymbol.slice(0, waypointSymbol.lastIndexOf("-")) };
  let manual = false;
  let pinned: string | undefined;
  return {
    symbol,
    getShip: () => ({ symbol, nav, cargo: { capacity: cargoCapacity, units: cargoUnits, inventory: [] } }),
    isManual: () => manual,
    isSuspended: () => false,
    dispatchTo: async (wp: string) => {
      nav = { ...nav, waypointSymbol: wp };
      manual = true;
    },
    release: () => {
      manual = false;
      pinned = undefined;
    },
    suspend: () => {},
    resume: () => {},
    stop: () => {},
    pinnedField: () => pinned,
    mineAt: (wp: string) => {
      pinned = wp;
    },
    unpinMining: () => {
      pinned = undefined;
    },
  };
}

function makeFleet(agents: ReturnType<typeof makeFakeAgent>[], store?: Store) {
  const fleet = new FleetManager({
    api: {
      getShip: async (s: string) => agents.find((a) => a.symbol === s)!.getShip(),
    } as any,
    store,
  });
  for (const a of agents) (fleet as any).traders.set(a.symbol, a);
  return fleet;
}

describe("FleetManager warehouse ship", () => {
  it("designates a ship and parks it via dispatchTo", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([agent]);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    assert.deepEqual(fleet.getWarehouseShip(), { shipSymbol: "SHIP-1", waypointSymbol: "X1-A-A2" });
    assert.equal(agent.getShip().nav.waypointSymbol, "X1-A-A2");
    assert.equal(agent.isManual(), true);
  });

  it("refuses a ship with no cargo hold", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1", 0);
    const fleet = makeFleet([agent]);
    await assert.rejects(() => fleet.designateWarehouseShip("SHIP-1", "X1-A-A2"), /cargo hold/);
    assert.equal(fleet.getWarehouseShip(), undefined);
  });

  it("refuses a ship not under fleet control", async () => {
    const fleet = makeFleet([]);
    await assert.rejects(() => fleet.designateWarehouseShip("GHOST-1", "X1-A-A2"), /not under fleet control/);
  });

  it("re-designating releases the previous warehouse ship", async () => {
    const a = makeFakeAgent("SHIP-1", "X1-A-A1");
    const b = makeFakeAgent("SHIP-2", "X1-A-A1");
    const fleet = makeFleet([a, b]);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    await fleet.designateWarehouseShip("SHIP-2", "X1-A-A3");
    assert.deepEqual(fleet.getWarehouseShip(), { shipSymbol: "SHIP-2", waypointSymbol: "X1-A-A3" });
    assert.equal(a.isManual(), false, "the old warehouse ship must be handed back to auto duty");
  });

  it("releaseWarehouseShip clears the designation and releases the ship", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([agent]);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    fleet.releaseWarehouseShip();
    assert.equal(fleet.getWarehouseShip(), undefined);
    assert.equal(agent.isManual(), false);
  });

  it("releaseWarehouseShip is a no-op when nothing is designated", () => {
    const fleet = makeFleet([]);
    assert.doesNotThrow(() => fleet.releaseWarehouseShip());
  });

  it("scrapping the warehouse ship clears the designation", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([agent]);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    (fleet as any).removeShip("SHIP-1");
    assert.equal(fleet.getWarehouseShip(), undefined);
  });

  it("getShipStatuses reports the warehouse ship once, tagged as warehouse", async () => {
    const a = makeFakeAgent("SHIP-1", "X1-A-A1");
    const b = makeFakeAgent("SHIP-2", "X1-A-A1");
    const fleet = makeFleet([a, b]);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    const statuses = fleet.getShipStatuses();
    const forShip1 = statuses.filter((s) => s.symbol === "SHIP-1");
    assert.equal(forShip1.length, 1, "the warehouse ship must not appear twice");
    assert.equal(forShip1[0]?.role, "warehouse");
    const forShip2 = statuses.filter((s) => s.symbol === "SHIP-2");
    assert.equal(forShip2.length, 1);
    assert.equal(forShip2[0]?.role, "trader");
  });
});

describe("FleetManager restart persistence", () => {
  it("holdShip persists the hold, so a restart doesn't lose it", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(tempDb());
    const fleet = makeFleet([agent], store);
    await fleet.holdShip("SHIP-1");
    const raw = store.getFleetFlag("shipManualState");
    assert.ok(raw);
    assert.deepEqual(JSON.parse(raw!), { "SHIP-1": { holdWaypoint: "X1-A-A1" } });
  });

  it("releaseShip clears the persisted hold", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(tempDb());
    const fleet = makeFleet([agent], store);
    await fleet.holdShip("SHIP-1");
    fleet.releaseShip("SHIP-1");
    assert.equal(store.getFleetFlag("shipManualState"), undefined);
  });

  it("mineAt persists the pin independently of any hold on the same ship", () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    (fleet as any).miners.set("SHIP-1", agent);
    fleet.mineAt("SHIP-1", "X1-A-E5");
    const raw = store.getFleetFlag("shipManualState");
    assert.deepEqual(JSON.parse(raw!), { "SHIP-1": { minePin: "X1-A-E5" } });
  });

  it("unpinMining clears only the pin, not a coexisting hold", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    (fleet as any).miners.set("SHIP-1", agent);
    fleet.mineAt("SHIP-1", "X1-A-E5");
    // holdShip goes through controlledAgent, which only looks at
    // miners/traders/surveyors/tours/scouts/siphoners — SHIP-1 is already a
    // registered miner above, so this reaches the same agent.
    await fleet.holdShip("SHIP-1");
    fleet.unpinMining("SHIP-1");
    const raw = store.getFleetFlag("shipManualState");
    assert.deepEqual(JSON.parse(raw!), { "SHIP-1": { holdWaypoint: "X1-A-A1" } });
  });

  it("designateWarehouseShip persists the binding; releaseWarehouseShip clears it", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(tempDb());
    const fleet = makeFleet([agent], store);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    assert.deepEqual(JSON.parse(store.getFleetFlag("warehouseShip")!), { shipSymbol: "SHIP-1", waypointSymbol: "X1-A-A2" });
    fleet.releaseWarehouseShip();
    assert.equal(store.getFleetFlag("warehouseShip"), undefined);
  });

  it("scrapping a ship drops its persisted hold/pin, warehouse binding, and dispatch override", async () => {
    const agent = makeFakeAgent("SHIP-1", "X1-A-A1");
    const store = new Store(tempDb());
    const fleet = makeFleet([agent], store);
    await fleet.designateWarehouseShip("SHIP-1", "X1-A-A2");
    fleet.setManualDispatch("SHIP-1", {
      shipSymbol: "SHIP-1", good: "IRON", role: "direct", buyAt: "X1-A-A1", sellAt: "X1-A-A2",
      buyPrice: 10, sellPrice: 20, profitPerTrip: 100, source: "manual",
    });
    (fleet as any).removeShip("SHIP-1");
    assert.equal(store.getFleetFlag("warehouseShip"), undefined);
    assert.equal(store.getFleetFlag("shipManualState"), undefined);
    assert.equal(store.getFleetFlag("dispatchManual"), undefined);
  });

  it("setManualDispatch persists the override and updates the live assignment together", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    const assignment = {
      shipSymbol: "SHIP-1", good: "IRON", role: "direct" as const, buyAt: "X1-A-A1", sellAt: "X1-A-A2",
      buyPrice: 10, sellPrice: 20, profitPerTrip: 100, source: "auto" as const,
    };
    fleet.setManualDispatch("SHIP-1", assignment);
    assert.equal(fleet.dispatcher.assignmentFor("SHIP-1")?.good, "IRON");
    assert.equal(fleet.dispatcher.assignmentFor("SHIP-1")?.source, "manual", "setManualDispatch always tags the assignment manual");
    const persisted = JSON.parse(store.getFleetFlag("dispatchManual")!);
    assert.equal(persisted["SHIP-1"].good, "IRON");

    fleet.setManualDispatch("SHIP-1", undefined);
    assert.equal(fleet.dispatcher.assignmentFor("SHIP-1"), undefined);
    assert.equal(store.getFleetFlag("dispatchManual"), undefined);
  });

  it("setPaused persists the halt state, and a fresh FleetManager on the same store restores it immediately", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    assert.equal(fleet.isPaused(), false, "starts unpaused by default");
    fleet.setPaused(true);
    assert.equal(store.getFleetFlag("paused"), "true");

    // No init() call needed — restoring paused state happens synchronously in
    // the constructor, so a halted fleet never has a window of running
    // unhalted while a restart's async init() is still in flight.
    const restarted = makeFleet([], store);
    assert.equal(restarted.isPaused(), true, "a restart must come back halted, not silently resume");

    restarted.setPaused(false);
    const restartedAgain = makeFleet([], store);
    assert.equal(restartedAgain.isPaused(), false);
  });
});

const sampleRoutes = [
  { good: "IRON", buyAt: "X1-A-A1", buySystem: "X1-A", buyPrice: 10, sellAt: "X1-A-A2", sellSystem: "X1-A", sellPrice: 20, volume: 20, distance: 1, fuelUnits: 1, fuelCost: 1, profitPerTrip: 100, ageMinutes: 1 },
  { good: "GOLD", buyAt: "X1-A-A1", buySystem: "X1-A", buyPrice: 5, sellAt: "X1-A-A2", sellSystem: "X1-A", sellPrice: 15, volume: 20, distance: 1, fuelUnits: 1, fuelCost: 1, profitPerTrip: 50, ageMinutes: 1 },
];

describe("FleetManager warehouse targets", () => {
  it("produces no targets while warehousing is disabled (the default)", () => {
    const store = new Store(tempDb());
    store.setWarehouseTarget("IRON", 300, false);
    const fleet = makeFleet([], store);
    const targets = (fleet as any).computeWarehouseTargets(sampleRoutes);
    assert.deepEqual(targets, []);
  });

  it("produces no targets when the curated list is empty, even though warehousing is enabled", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { enabled: true });
    const targets = (fleet as any).computeWarehouseTargets(sampleRoutes);
    assert.deepEqual(targets, [], "only goods an operator explicitly added are ever warehoused");
  });

  it("only a curated good with a real route gets a target — uncurated goods stay direct", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { enabled: true });
    fleet.doctrine.set("warehouseMax", { value: 200, enabled: true });
    store.setWarehouseTarget("IRON", 300, false);
    // GOLD has a real route but was never added to the curated list.
    store.warehouseDeposit("IRON", 50, 10, undefined, "buy");

    const targets = (fleet as any).computeWarehouseTargets(sampleRoutes) as { good: string; target: number; balance: number }[];

    assert.deepEqual(targets.map((t) => t.good), ["IRON"]);
    assert.equal(targets[0]!.target, 200, "target is capped by warehouseMax even though the curated target is set higher");
    assert.equal(targets[0]!.balance, 50);
  });

  it("a curated good with no real route right now is skipped this cycle", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { enabled: true });
    store.setWarehouseTarget("SILVER", 100, false); // not in sampleRoutes

    const targets = (fleet as any).computeWarehouseTargets(sampleRoutes);
    assert.deepEqual(targets, []);
  });

  it("a good flagged forMission is excluded — it goes through computeMissionBuyTargets instead", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { enabled: true });
    store.setWarehouseTarget("IRON", 300, true);

    const targets = (fleet as any).computeWarehouseTargets(sampleRoutes);
    assert.deepEqual(targets, []);
  });

  it("disabling warehouseMax removes the cap", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { enabled: true });
    fleet.doctrine.set("warehouseMax", { value: 200, enabled: false });
    store.setWarehouseTarget("IRON", 300, false);

    const targets = (fleet as any).computeWarehouseTargets(sampleRoutes) as { good: string; target: number; balance: number }[];

    assert.equal(targets[0]!.target, 300);
  });
});

describe("FleetManager haul targets", () => {
  it("produces no haul targets while warehousing is disabled (the default)", async () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);
    store.warehouseDeposit("FAB_MATS", 30, 61, undefined, "adjust");

    assert.deepEqual((fleet as any).computeHaulTargets(), []);
  });

  it("once enabled, a mission-needed good the warehouse holds becomes a haul target", async () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { value: 300, enabled: true });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);
    store.warehouseDeposit("FAB_MATS", 30, 61, undefined, "adjust");

    const targets = (fleet as any).computeHaulTargets();

    assert.deepEqual(targets, [{ good: "FAB_MATS", targetWaypoint: "X1-A-I59", needed: 80, balance: 30 }]);
  });

  it("no haul target when the warehouse holds none of the needed good", async () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { value: 300, enabled: true });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);

    assert.deepEqual((fleet as any).computeHaulTargets(), []);
  });

  it("no haul target for a material that's already fully supplied", async () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { value: 300, enabled: true });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 100 }]);
    store.warehouseDeposit("FAB_MATS", 30, 61, undefined, "adjust");

    assert.deepEqual((fleet as any).computeHaulTargets(), []);
  });

  it("a paused mission produces no haul target", async () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { value: 300, enabled: true });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);
    store.warehouseDeposit("FAB_MATS", 30, 61, undefined, "adjust");
    fleet.missions.pause("X1-A-I59");

    assert.deepEqual((fleet as any).computeHaulTargets(), []);
  });
});

describe("FleetManager mission buy targets", () => {
  it("produces no mission-buy targets while warehousing is disabled (the default)", async () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    store.setWarehouseTarget("FAB_MATS", 0, true);
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-D46", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "HIGH", purchasePrice: 61, sellPrice: 55, tradeVolume: 40 });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);

    assert.deepEqual((fleet as any).computeMissionBuyTargets(), []);
  });

  it("produces no mission-buy targets when nothing is flagged forMission", async () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { enabled: true });
    store.setWarehouseTarget("FAB_MATS", 100, false); // curated, but not flagged for mission buying
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-D46", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "HIGH", purchasePrice: 61, sellPrice: 55, tradeVolume: 40 });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);

    assert.deepEqual((fleet as any).computeMissionBuyTargets(), []);
  });

  it("a good flagged forMission with an active mission short of it sources the cheapest known market", async () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { enabled: true });
    store.setWarehouseTarget("FAB_MATS", 0, true);
    // Two markets sell it — the cheaper one should win.
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-D46", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "HIGH", purchasePrice: 61, sellPrice: 55, tradeVolume: 40 });
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-E12", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "MODERATE", purchasePrice: 70, sellPrice: 60, tradeVolume: 30 });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);

    const targets = (fleet as any).computeMissionBuyTargets();

    assert.deepEqual(targets, [{ good: "FAB_MATS", buyAt: "X1-A-D46", buyPrice: 61, needed: 80, balance: 0 }]);
  });

  it("a good with no known market yet produces no mission-buy target", async () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { enabled: true });
    store.setWarehouseTarget("FAB_MATS", 0, true);
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);

    assert.deepEqual((fleet as any).computeMissionBuyTargets(), []);
  });

  it("a material that's already fully supplied produces no mission-buy target", async () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { enabled: true });
    store.setWarehouseTarget("FAB_MATS", 0, true);
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-D46", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "HIGH", purchasePrice: 61, sellPrice: 55, tradeVolume: 40 });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 100 }]);

    assert.deepEqual((fleet as any).computeMissionBuyTargets(), []);
  });

  it("a paused mission produces no mission-buy target", async () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { enabled: true });
    store.setWarehouseTarget("FAB_MATS", 0, true);
    store.recordMarket({ systemSymbol: "X1-A", waypointSymbol: "X1-A-D46", goodSymbol: "FAB_MATS", type: "EXPORT", supply: "HIGH", purchasePrice: 61, sellPrice: 55, tradeVolume: 40 });
    await fleet.missions.startConstruction("X1-A-I59", [{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 20 }]);
    fleet.missions.pause("X1-A-I59");

    assert.deepEqual((fleet as any).computeMissionBuyTargets(), []);
  });
});

describe("FleetManager warehouse target list", () => {
  it("starts empty", () => {
    const fleet = makeFleet([], new Store(tempDb()));
    assert.deepEqual(fleet.warehouseTargetList(), []);
  });

  it("setWarehouseTarget adds a good, removeWarehouseTarget drops it", () => {
    const fleet = makeFleet([], new Store(tempDb()));
    fleet.setWarehouseTarget("IRON_ORE", 100, false);
    fleet.setWarehouseTarget("FAB_MATS", 50, true);
    assert.deepEqual(fleet.warehouseTargetList(), [
      { goodSymbol: "FAB_MATS", target: 50, forMission: true },
      { goodSymbol: "IRON_ORE", target: 100, forMission: false },
    ]);
    fleet.removeWarehouseTarget("IRON_ORE");
    assert.deepEqual(fleet.warehouseTargetList(), [{ goodSymbol: "FAB_MATS", target: 50, forMission: true }]);
  });

  it("rejects a non-positive target", () => {
    const fleet = makeFleet([], new Store(tempDb()));
    assert.throws(() => fleet.setWarehouseTarget("IRON_ORE", 0, false), /positive/);
    assert.throws(() => fleet.setWarehouseTarget("IRON_ORE", -5, false), /positive/);
  });

  it("throws with no store attached", () => {
    const fleet = makeFleet([]);
    assert.throws(() => fleet.setWarehouseTarget("IRON_ORE", 100, false), /store not available/);
  });

  it("removeWarehouseTarget with no store attached is a safe no-op", () => {
    const fleet = makeFleet([]);
    assert.doesNotThrow(() => fleet.removeWarehouseTarget("IRON_ORE"));
  });
});

describe("FleetManager dispatcherTraders", () => {
  it("excludes the warehouse ship so it can never lock a good away from a real trader", async () => {
    const warehouse = makeFakeAgent("WH-1", "X1-A-A1");
    const trader = makeFakeAgent("SHIP-1", "X1-A-A1");
    const fleet = makeFleet([warehouse, trader]);
    await fleet.designateWarehouseShip("WH-1", "X1-A-A2");

    const eligible = (fleet as any).dispatcherTraders() as { shipSymbol: string }[];

    assert.deepEqual(eligible.map((t) => t.shipSymbol), ["SHIP-1"]);
  });

  it("marks a trader busy when it's holding cargo", () => {
    const trader = makeFakeAgent("SHIP-1", "X1-A-A1", 40, 12);
    const fleet = makeFleet([trader]);

    const eligible = (fleet as any).dispatcherTraders() as { shipSymbol: string; busy: boolean }[];

    assert.equal(eligible[0]?.busy, true);
  });
});

describe("FleetManager warehouse API surface", () => {
  it("warehouseGoods and warehouseValue reflect the store", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    store.warehouseDeposit("IRON", 40, 10, undefined, "buy");

    assert.deepEqual(fleet.warehouseGoods(), [{ goodSymbol: "IRON", units: 40, avgCost: 10, value: 400 }]);
    assert.equal(fleet.warehouseValue(), 400);
  });

  it("warehouseGoods/Value are empty with no store attached", () => {
    const fleet = makeFleet([]);
    assert.deepEqual(fleet.warehouseGoods(), []);
    assert.equal(fleet.warehouseValue(), 0);
  });

  it("adjustWarehouse deposit and withdraw update the store and are tagged 'adjust'", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);

    const deposited = fleet.adjustWarehouse("IRON", 40, "deposit", 10);
    assert.deepEqual(deposited, { units: 40, avgCost: 10 });

    const withdrawn = fleet.adjustWarehouse("IRON", 15, "withdraw", 0);
    assert.deepEqual(withdrawn, { units: 15, avgCost: 10 });
    assert.equal(fleet.warehouseGoods().find((g) => g.goodSymbol === "IRON")?.units, 25);

    const ledger = fleet.warehouseLedger(10);
    assert.ok(ledger.every((row) => row.reason === "adjust"), `expected every ledger row tagged "adjust", got ${JSON.stringify(ledger)}`);
  });

  it("adjustWarehouse withdraw clamps to what's actually held, same as the store", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.adjustWarehouse("IRON", 10, "deposit", 5);

    const withdrawn = fleet.adjustWarehouse("IRON", 999, "withdraw", 0);

    assert.equal(withdrawn.units, 10);
  });

  it("adjustWarehouse throws with no store attached", () => {
    const fleet = makeFleet([]);
    assert.throws(() => fleet.adjustWarehouse("IRON", 10, "deposit", 5), /store not available/);
  });
});
