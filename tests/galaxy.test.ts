import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GalaxyAtlas } from "../src/engine/galaxy.js";
import type { MarketSnapshot } from "../src/engine/market.js";

function makeKnown(systemSymbol: string, gates: { symbol: string; connections: string[] }[], extraWps?: { symbol: string; x: number; y: number; type?: string; traits?: string[] }[]) {
  return {
    symbol: systemSymbol,
    waypoints: [
      ...gates.map((g) => ({ symbol: g.symbol, x: 0, y: 0, type: "JUMP_GATE", traits: [] } as any)),
      ...(extraWps ?? []).map((w) => ({ ...w, x: w.x ?? 0, y: w.y ?? 0, type: w.type ?? "PLANET", traits: (w.traits ?? []).map((t) => ({ symbol: t })) } as any)),
    ],
    jumpGates: gates,
    markets: [] as MarketSnapshot[],
  };
}

describe("GalaxyAtlas", () => {
  it("tracks connected systems from jump gates", async () => {
    const atlas = new GalaxyAtlas({} as any);
    (atlas as any).systems.set("X1-A", makeKnown("X1-A", [{ symbol: "X1-A-G1", connections: ["X1-B-G1", "X1-C-G1"] }]));
    (atlas as any).systems.set("X1-B", makeKnown("X1-B", [{ symbol: "X1-B-G1", connections: ["X1-A-G1"] }]));
    (atlas as any).systems.set("X1-C", makeKnown("X1-C", [{ symbol: "X1-C-G1", connections: ["X1-A-G1"] }]));

    const connected = atlas.connectedSystems("X1-A").sort();
    assert.deepEqual(connected, ["X1-B", "X1-C"]);
    assert.deepEqual(atlas.gatesTo("X1-A", "X1-B"), ["X1-A-G1"]);
    assert.deepEqual(atlas.gatesTo("X1-A", "X1-D"), []);
  });

  it("lists jump connections", async () => {
    const atlas = new GalaxyAtlas({} as any);
    (atlas as any).systems.set("X1-A", makeKnown("X1-A", [{ symbol: "X1-A-G1", connections: ["X1-B-G1"] }]));
    (atlas as any).systems.set("X1-B", makeKnown("X1-B", [{ symbol: "X1-B-G1", connections: ["X1-A-G1"] }]));

    const cons = atlas.jumpConnections();
    assert.equal(cons.length, 2);
    const pair = cons.find((c) => c.from === "X1-A-G1")!;
    assert.equal(pair.from, "X1-A-G1");
    assert.equal(pair.to, "X1-B-G1");
  });

  it("exposes all positions across known systems", async () => {
    const atlas = new GalaxyAtlas({} as any);
    (atlas as any).systems.set("X1-A", makeKnown("X1-A", [{ symbol: "X1-A-G1", connections: [] }], [{ symbol: "X1-A-W1", x: 10, y: 20 }]));
    (atlas as any).systems.set("X1-B", makeKnown("X1-B", [{ symbol: "X1-B-G1", connections: [] }], [{ symbol: "X1-B-W1", x: 5, y: 15 }]));

    const positions = atlas.allPositions();
    assert.equal(positions.length, 4);
    const w1 = positions.find((p) => p.symbol === "X1-A-W1");
    assert.ok(w1);
    assert.equal(w1!.systemSymbol, "X1-A");
    assert.equal(w1!.x, 10);
  });
});
