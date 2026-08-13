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
    },
    suspend: () => {},
    resume: () => {},
    stop: () => {},
    pinnedField: () => undefined,
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

const sampleRoutes = [
  { good: "IRON", buyAt: "X1-A-A1", buySystem: "X1-A", buyPrice: 10, sellAt: "X1-A-A2", sellSystem: "X1-A", sellPrice: 20, volume: 20, distance: 1, fuelUnits: 1, fuelCost: 1, profitPerTrip: 100, ageMinutes: 1 },
  { good: "GOLD", buyAt: "X1-A-A1", buySystem: "X1-A", buyPrice: 5, sellAt: "X1-A-A2", sellSystem: "X1-A", sellPrice: 15, volume: 20, distance: 1, fuelUnits: 1, fuelCost: 1, profitPerTrip: 50, ageMinutes: 1 },
];

describe("FleetManager warehouse targets", () => {
  it("produces no targets while warehousing is disabled (the default)", () => {
    const fleet = makeFleet([], new Store(tempDb()));
    const targets = (fleet as any).computeWarehouseTargets(sampleRoutes);
    assert.deepEqual(targets, []);
  });

  it("once enabled, targets every routed good, capped by warehouseMax", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { value: 300, enabled: true });
    fleet.doctrine.set("warehouseMax", { value: 200, enabled: true });
    store.warehouseDeposit("IRON", 50, 10, undefined, "buy");

    const targets = (fleet as any).computeWarehouseTargets(sampleRoutes) as { good: string; target: number; balance: number }[];

    assert.deepEqual(new Set(targets.map((t) => t.good)), new Set(["IRON", "GOLD"]));
    const iron = targets.find((t) => t.good === "IRON")!;
    assert.equal(iron.target, 200, "target is capped by warehouseMax even though warehouseTarget is set higher");
    assert.equal(iron.balance, 50);
    const gold = targets.find((t) => t.good === "GOLD")!;
    assert.equal(gold.balance, 0);
  });

  it("disabling warehouseMax removes the cap", () => {
    const store = new Store(tempDb());
    const fleet = makeFleet([], store);
    fleet.doctrine.set("warehouseTarget", { value: 300, enabled: true });
    fleet.doctrine.set("warehouseMax", { value: 200, enabled: false });

    const targets = (fleet as any).computeWarehouseTargets(sampleRoutes) as { good: string; target: number; balance: number }[];

    assert.ok(targets.every((t) => t.target === 300));
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
