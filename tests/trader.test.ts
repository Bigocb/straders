import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraderAgent, type WaypointPos } from "../src/engine/trader.js";
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
