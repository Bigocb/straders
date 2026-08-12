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
