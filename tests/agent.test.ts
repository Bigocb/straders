import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ShipAgent, type WaypointPos } from "../src/engine/agent.js";
import type { components } from "../src/core/client.js";

type Ship = components["schemas"]["Ship"];

function makeShip(overrides: Partial<Ship> = {}): Ship {
  return {
    symbol: "MINER-1",
    registration: { name: "Test", factionSymbol: "COSMIC", role: "EXCAVATOR" },
    nav: {
      systemSymbol: "X1-A",
      waypointSymbol: "X1-A-M1",
      route: { destination: { symbol: "X1-A-M1", type: "PLANET", systemSymbol: "X1-A", x: 0, y: 0 }, origin: { symbol: "X1-A-M1", type: "PLANET", systemSymbol: "X1-A", x: 0, y: 0 }, departureTime: new Date().toISOString(), arrival: new Date(Date.now() - 1000).toISOString() },
      status: "DOCKED",
      flightMode: "CRUISE",
    },
    crew: { current: 1, required: 1, capacity: 1, rotation: "STRICT", morale: 100, wages: 0 },
    fuel: { current: 100, capacity: 100 },
    frame: { symbol: "FRAME_MINER", name: "Miner", description: "", condition: 1, integrity: 1, quality: 1, moduleSlots: 1, mountingPoints: 1, fuelCapacity: 100, requirements: { power: 1, crew: 1 } },
    reactor: { symbol: "REACTOR_SOLAR_I", name: "Solar", description: "", condition: 1, integrity: 1, quality: 1, powerOutput: 1, requirements: { power: 0, crew: 0 } },
    engine: { symbol: "ENGINE_IMPULSE_DRIVE_I", name: "Impulse", description: "", condition: 1, integrity: 1, quality: 1, speed: 10, requirements: { power: 1, crew: 0 } },
    cooldown: { shipSymbol: "MINER-1", totalSeconds: 0, remainingSeconds: 0, expiration: new Date().toISOString() },
    modules: [],
    mounts: [{ symbol: "MOUNT_MINING_LASER_I", name: "Laser", description: "", strength: 10, requirements: { power: 1, crew: 0 } } as any],
    cargo: { capacity: 40, units: 0, inventory: [] },
    ...overrides,
  };
}

// Two asteroid fields at different distances from the ship's market waypoint,
// so "nearest" and "pinned" disagree — that's what proves the pin wins.
const positions: WaypointPos[] = [
  { symbol: "X1-A-M1", x: 0, y: 0, type: "PLANET" },
  { symbol: "X1-A-NEAR", x: 5, y: 0, type: "ASTEROID_FIELD" },
  { symbol: "X1-A-FAR", x: 50, y: 0, type: "ASTEROID_FIELD" },
];

describe("ShipAgent mining pin", () => {
  it("picks the nearest field by default", () => {
    const agent = new ShipAgent(makeShip(), { api: {} as any, log: () => {} }).withWorld(positions, []);
    assert.equal((agent as any).pickMiningTarget().symbol, "X1-A-NEAR");
  });

  it("a pin overrides the nearest-field choice", () => {
    const agent = new ShipAgent(makeShip(), { api: {} as any, log: () => {} }).withWorld(positions, []);
    agent.mineAt("X1-A-FAR");
    assert.equal(agent.pinnedField(), "X1-A-FAR");
    assert.equal((agent as any).pickMiningTarget().symbol, "X1-A-FAR");
  });

  it("unpinning hands the choice back", () => {
    const agent = new ShipAgent(makeShip(), { api: {} as any, log: () => {} }).withWorld(positions, []);
    agent.mineAt("X1-A-FAR");
    agent.unpinMining();
    assert.equal(agent.pinnedField(), undefined);
    assert.equal((agent as any).pickMiningTarget().symbol, "X1-A-NEAR");
  });

  it("a pin to an unknown waypoint falls back instead of stranding the pick", () => {
    const agent = new ShipAgent(makeShip(), { api: {} as any, log: () => {} }).withWorld(positions, []);
    agent.mineAt("X1-A-NOWHERE");
    assert.equal((agent as any).pickMiningTarget().symbol, "X1-A-NEAR");
  });

  it("release() also clears the pin, so a returned ship picks for itself again", () => {
    const agent = new ShipAgent(makeShip(), { api: {} as any, log: () => {} }).withWorld(positions, []);
    agent.mineAt("X1-A-FAR");
    agent.release();
    assert.equal(agent.pinnedField(), undefined);
  });
});
