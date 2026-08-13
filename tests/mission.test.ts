import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MissionManager } from "../src/engine/mission.js";

function makeApi(materials: { tradeSymbol: string; required: number; fulfilled: number }[]) {
  return {
    getConstruction: async () => ({ isComplete: false, materials }),
  } as any;
}

describe("MissionManager.assignCarrier", () => {
  it("suspends the chosen ship and records it as the carrier", async () => {
    const suspended: string[] = [];
    const resumed: string[] = [];
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]),
      suspend: (s) => suspended.push(s),
      resume: (s) => resumed.push(s),
    });
    await mgr.startConstruction("X1-A-I1");
    mgr.assignCarrier("X1-A-I1", "SHIP-1");
    assert.equal(mgr.list().find((m) => m.targetWaypoint === "X1-A-I1")?.assignedShip, "SHIP-1");
    assert.deepEqual(suspended, ["SHIP-1"]);
    assert.deepEqual(resumed, []);
  });

  it("releases the previous carrier back to autonomy when reassigned", async () => {
    const suspended: string[] = [];
    const resumed: string[] = [];
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]),
      suspend: (s) => suspended.push(s),
      resume: (s) => resumed.push(s),
    });
    await mgr.startConstruction("X1-A-I1");
    mgr.assignCarrier("X1-A-I1", "SHIP-1");
    mgr.assignCarrier("X1-A-I1", "SHIP-2");
    assert.equal(mgr.list().find((m) => m.targetWaypoint === "X1-A-I1")?.assignedShip, "SHIP-2");
    assert.deepEqual(suspended, ["SHIP-1", "SHIP-2"]);
    assert.deepEqual(resumed, ["SHIP-1"], "the old carrier is handed back, not left suspended forever");
  });

  it("reassigning to the same ship already carrying it is a no-op", async () => {
    const suspended: string[] = [];
    const resumed: string[] = [];
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]),
      suspend: (s) => suspended.push(s),
      resume: (s) => resumed.push(s),
    });
    await mgr.startConstruction("X1-A-I1");
    mgr.assignCarrier("X1-A-I1", "SHIP-1");
    mgr.assignCarrier("X1-A-I1", "SHIP-1");
    assert.deepEqual(suspended, ["SHIP-1"], "no redundant suspend/resume cycle");
    assert.deepEqual(resumed, []);
  });

  it("throws for a mission that doesn't exist", async () => {
    const mgr = new MissionManager({ api: makeApi([]) });
    assert.throws(() => mgr.assignCarrier("X1-A-NOWHERE", "SHIP-1"), /no active mission/);
  });

  it("assigning a carrier to a paused mission does not restart its sourcing state or spend", async () => {
    const suspended: string[] = [];
    const mgr = new MissionManager({
      api: makeApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]),
      suspend: (s) => suspended.push(s),
      resume: () => {},
    });
    await mgr.startConstruction("X1-A-I1");
    mgr.pause("X1-A-I1");
    mgr.assignCarrier("X1-A-I1", "SHIP-1");
    assert.equal(mgr.list().find((m) => m.targetWaypoint === "X1-A-I1")?.assignedShip, "SHIP-1");
    // Still suspended immediately (the ship is committed) even though the
    // mission itself won't step while paused.
    assert.deepEqual(suspended, ["SHIP-1"]);
  });
});

/** Counts getConstruction calls so per-tick API cost can be observed. */
function makeCountingApi(materials: { tradeSymbol: string; required: number; fulfilled: number }[]) {
  const calls = { getConstruction: 0 };
  const api = {
    getConstruction: async () => {
      calls.getConstruction += 1;
      return { isComplete: false, materials };
    },
  } as any;
  return { api, calls };
}

describe("MissionManager API cost per tick", () => {
  it("a paused mission does not re-read its site on every tick", async () => {
    // Pausing a mission used to give back no API budget at all: the paused
    // branch reconciled against the live construction site on every 2s
    // coordinator tick, which is 0.5 req/s of a 2 req/s budget per mission.
    const { api, calls } = makeCountingApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]);
    const mgr = new MissionManager({ api });
    await mgr.startConstruction("X1-A-I1");
    const afterStart = calls.getConstruction;

    mgr.pause("X1-A-I1");
    for (let i = 0; i < 20; i += 1) await mgr.tick();

    const reconciles = calls.getConstruction - afterStart;
    assert.ok(
      reconciles <= 1,
      `20 back-to-back ticks of a paused mission should reconcile at most once, got ${reconciles}`,
    );
  });

  it("an active mission in backoff does not re-read its site either", async () => {
    // The retryAt backoff used to be checked *after* getConstruction, so it
    // never prevented the request it exists to prevent.
    const { api, calls } = makeCountingApi([{ tradeSymbol: "FAB_MATS", required: 100, fulfilled: 0 }]);
    const mgr = new MissionManager({
      api,
      // No known buyers and no discovery: step() sets a retry backoff and returns.
      listBuyers: () => [],
      discoverBuyers: async () => [],
    });
    await mgr.startConstruction("X1-A-I1");

    await mgr.tick(); // first tick: reads the site, finds no buyer, sets retryAt
    const afterFirst = calls.getConstruction;
    for (let i = 0; i < 20; i += 1) await mgr.tick();

    assert.equal(
      calls.getConstruction,
      afterFirst,
      "while backing off, a mission must cost zero API calls",
    );
  });
});
