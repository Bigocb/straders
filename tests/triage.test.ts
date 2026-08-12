import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTriage } from "../src/engine/triage.js";

const NOW = Date.parse("2026-08-12T12:00:00Z");
const hoursFromNow = (h: number) => new Date(NOW + h * 3600_000).toISOString();

describe("buildTriage", () => {
  it("never flags a surveyor or a tour ship as earning nothing", () => {
    const { triage } = buildTriage({
      ships: [
        { symbol: "S1", role: "surveyor" },
        { symbol: "S2", role: "tour" },
      ],
      stranded: [],
      earnings: [],
      contracts: [],
      now: NOW,
    });
    assert.equal(triage.length, 0, "surveyor/tour roles earn nothing by design and must not appear in triage");
  });

  it("still flags a genuinely idle ship with no role", () => {
    const { triage } = buildTriage({
      ships: [{ symbol: "S1", role: "idle" }],
      stranded: [],
      earnings: [],
      contracts: [],
      now: NOW,
    });
    assert.equal(triage.length, 1);
    assert.equal(triage[0]!.id, "idle:S1");
    assert.match(triage[0]!.detail, /No role assigned/);
    assert.equal(triage[0]!.engineWillAct, null);
  });

  it("flags a miner/trader that has not earned in the window, distinct from a role-less idle hull", () => {
    const { triage } = buildTriage({
      ships: [{ symbol: "S1", role: "miner" }],
      stranded: [],
      earnings: [],
      contracts: [],
      now: NOW,
    });
    assert.equal(triage.length, 1);
    assert.equal(triage[0]!.severity, 3, "a role-holding ship earning nothing ranks below a truly idle one");
    assert.match(triage[0]!.detail, /Assigned as miner/);
    assert.equal(triage[0]!.engineWillAct, "Engine will re-plan on its next tick");
  });

  it("does not flag a ship that earned this window", () => {
    const { triage } = buildTriage({
      ships: [{ symbol: "S1", role: "miner" }],
      stranded: [],
      earnings: [{ shipSymbol: "S1", net: 500 }],
      contracts: [],
      now: NOW,
    });
    assert.equal(triage.length, 0);
  });

  it("ranks stranded ships first regardless of cost, and sorts by cost within a severity", () => {
    const { triage } = buildTriage({
      ships: [{ symbol: "S3", role: "idle" }],
      stranded: [{ symbol: "S1", waypointSymbol: "X1-A-A1" }],
      earnings: [{ shipSymbol: "S2", net: 1000 }],
      contracts: [],
      now: NOW,
    });
    assert.equal(triage[0]!.id, "stranded:S1");
    assert.equal(triage[0]!.severity, 1);
    assert.equal(triage[1]!.id, "idle:S3");
  });

  it("uses the median of positive earners as the opportunity cost, not an average skewed by one big earner", () => {
    const { triage } = buildTriage({
      ships: [{ symbol: "S4", role: "idle" }],
      stranded: [],
      earnings: [
        { shipSymbol: "S1", net: 100 },
        { shipSymbol: "S2", net: 200 },
        { shipSymbol: "S3", net: 10_000 },
      ],
      contracts: [],
      now: NOW,
    });
    // sorted earners: [100, 200, 10000] -> median index 1 -> 200
    assert.equal(triage[0]!.costPerHour, -200);
  });

  it("falls back to a flat 500 stranded cost when there is no earner to take a median from", () => {
    const { triage } = buildTriage({
      ships: [],
      stranded: [{ symbol: "S1", waypointSymbol: "X1-A-A1", reason: "0 fuel" }],
      earnings: [],
      contracts: [],
      now: NOW,
    });
    assert.equal(triage[0]!.costPerHour, -500);
    assert.equal(triage[0]!.detail, "0 fuel");
  });

  it("surfaces a contract only inside its 0-12h deadline window, with unfulfilled units left", () => {
    const contract = (deadlineHours: number, fulfilled = 34) => ({
      id: "c1",
      terms: {
        deadline: hoursFromNow(deadlineHours),
        payment: { onFulfilled: 90_000 },
        deliver: [{ tradeSymbol: "IRON_ORE", unitsRequired: 100, unitsFulfilled: fulfilled }],
      },
    });

    assert.equal(buildTriage({ ships: [], stranded: [], earnings: [], contracts: [contract(3.4)], now: NOW }).triage.length, 1, "inside window");
    assert.equal(buildTriage({ ships: [], stranded: [], earnings: [], contracts: [contract(20)], now: NOW }).triage.length, 0, "too far out");
    assert.equal(buildTriage({ ships: [], stranded: [], earnings: [], contracts: [contract(-1)], now: NOW }).triage.length, 0, "already past deadline");
    assert.equal(buildTriage({ ships: [], stranded: [], earnings: [], contracts: [contract(3.4, 100)], now: NOW }).triage.length, 0, "already fulfilled");
  });

  it("gives a near-deadline contract higher severity than a distant one", () => {
    const near = { id: "c1", terms: { deadline: hoursFromNow(2), payment: { onFulfilled: 1000 }, deliver: [{ tradeSymbol: "X", unitsRequired: 10, unitsFulfilled: 1 }] } };
    const far = { id: "c2", terms: { deadline: hoursFromNow(10), payment: { onFulfilled: 1000 }, deliver: [{ tradeSymbol: "X", unitsRequired: 10, unitsFulfilled: 1 }] } };
    const { triage } = buildTriage({ ships: [], stranded: [], earnings: [], contracts: [far, near], now: NOW });
    assert.equal(triage[0]!.id, "contract:c1", "the 2h-out contract sorts before the 10h-out one despite input order");
    assert.equal(triage[0]!.severity, 1);
    assert.equal(triage[1]!.severity, 2);
  });

  it("ignores a contract with no deadline rather than crashing on an invalid date", () => {
    const contract = { id: "c1", terms: { payment: { onFulfilled: 1000 }, deliver: [{ tradeSymbol: "X", unitsRequired: 10, unitsFulfilled: 1 }] } };
    const { triage } = buildTriage({ ships: [], stranded: [], earnings: [], contracts: [contract], now: NOW });
    assert.equal(triage.length, 0);
  });

  it("sums costPerHour across the queue into forgone", () => {
    const { forgone } = buildTriage({
      ships: [{ symbol: "S1", role: "idle" }],
      stranded: [{ symbol: "S2", waypointSymbol: "X1-A-A1" }],
      earnings: [{ shipSymbol: "S3", net: 300 }],
      contracts: [],
      now: NOW,
    });
    // stranded: -300 (median), idle: -300 (median) => -600
    assert.equal(forgone, -600);
  });

  describe("cost-of-inaction estimation (not a single blanket number)", () => {
    it("prefers a ship's OWN historical rate over any fleet-wide fallback", () => {
      const { triage } = buildTriage({
        ships: [
          { symbol: "TRADER-1", role: "trader" },
          { symbol: "TRADER-2", role: "trader" },
        ],
        stranded: [],
        earnings: [], // both idle right now, by definition net=0 in this window
        historicalRates: [
          { shipSymbol: "TRADER-1", net: 6000 }, // this trader normally earns a lot
          { shipSymbol: "TRADER-2", net: 400 },  // this one barely earns anything
        ],
        contracts: [],
        now: NOW,
      });
      const t1 = triage.find((t) => t.id === "idle:TRADER-1")!;
      const t2 = triage.find((t) => t.id === "idle:TRADER-2")!;
      assert.equal(t1.costPerHour, -6000);
      assert.equal(t2.costPerHour, -400);
      assert.notEqual(
        t1.costPerHour, t2.costPerHour,
        "two ships with different track records must not be priced identically",
      );
    });

    it("does NOT use the current (idle) window as its own rate — that would always be 0 and collapse to the fallback", () => {
      const { triage } = buildTriage({
        ships: [{ symbol: "S1", role: "trader" }],
        stranded: [],
        // S1 earned 0 in the current window (that's WHY it's flagged), but
        // historically makes 3000/hr. The estimate must reflect the latter.
        earnings: [{ shipSymbol: "S1", net: 0 }],
        historicalRates: [{ shipSymbol: "S1", net: 3000 }],
        contracts: [],
        now: NOW,
      });
      assert.equal(triage[0]!.costPerHour, -3000);
    });

    it("falls back to the ROLE's median, not the whole fleet's, when a ship has no history of its own", () => {
      const { triage } = buildTriage({
        ships: [
          { symbol: "MINER-1", role: "miner" }, // has history
          { symbol: "MINER-2", role: "miner" }, // no history — new ship
          { symbol: "TRADER-1", role: "trader" }, // has history, much higher rate
        ],
        stranded: [],
        earnings: [],
        historicalRates: [
          { shipSymbol: "MINER-1", net: 500 },
          { shipSymbol: "TRADER-1", net: 8000 },
        ],
        contracts: [],
        now: NOW,
      });
      const minerNoHistory = triage.find((t) => t.id === "idle:MINER-2")!;
      // Should land on the miner-role median (500), not a fleet median dragged
      // up by the trader's 8000, and not the same number as the trader.
      assert.equal(minerNoHistory.costPerHour, -500);
      const traderCost = triage.find((t) => t.id === "idle:TRADER-1");
      assert.notEqual(minerNoHistory.costPerHour, traderCost?.costPerHour);
    });

    it("gives a stranded ship its own rate too, not the same flat number as every other stranded ship", () => {
      const { triage } = buildTriage({
        ships: [
          { symbol: "S1", role: "trader" },
          { symbol: "S2", role: "trader" },
        ],
        stranded: [
          { symbol: "S1", waypointSymbol: "X1-A-A1" },
          { symbol: "S2", waypointSymbol: "X1-A-A2" },
        ],
        earnings: [],
        historicalRates: [
          { shipSymbol: "S1", net: 5000 },
          { shipSymbol: "S2", net: 900 },
        ],
        contracts: [],
        now: NOW,
      });
      const c1 = triage.find((t) => t.id === "stranded:S1")!.costPerHour;
      const c2 = triage.find((t) => t.id === "stranded:S2")!.costPerHour;
      assert.equal(c1, -5000);
      assert.equal(c2, -900);
      assert.notEqual(c1, c2);
    });

    it("still falls back to the fleet median when historicalRates is omitted entirely", () => {
      // Backward-compatible path for callers without a longer baseline.
      // sorted [700, 900], the existing (unchanged) tie-break picks index
      // floor(n/2) = the upper of the two middle values -> 900.
      const { triage } = buildTriage({
        ships: [{ symbol: "S1", role: "trader" }],
        stranded: [],
        earnings: [
          { shipSymbol: "OTHER-1", net: 700 },
          { shipSymbol: "OTHER-2", net: 900 },
        ],
        contracts: [],
        now: NOW,
      });
      assert.equal(triage[0]!.costPerHour, -900);
    });
  });
});
