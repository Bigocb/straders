import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContractManager } from "../src/engine/contract.js";

function makeContract(over: Record<string, unknown> = {}) {
  return {
    id: "C1",
    accepted: false,
    fulfilled: false,
    deadlineToAccept: new Date(Date.now() + 3_600_000).toISOString(),
    terms: {
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
      payment: { onAccepted: 1_000, onFulfilled: 10_000 },
      deliver: [
        { tradeSymbol: "IRON_ORE", unitsRequired: 100, unitsFulfilled: 0, destinationSymbol: "X1-A-A1" },
      ],
    },
    ...over,
  };
}

/** Counts getContracts calls so the cache can be observed directly. */
function makeApi(contracts: unknown[] = [makeContract()]) {
  const calls = { getContracts: 0, accept: 0, fulfill: 0, deliver: 0 };
  const api = {
    getContracts: async () => {
      calls.getContracts += 1;
      return contracts;
    },
    acceptContract: async () => {
      calls.accept += 1;
      return {};
    },
    fulfillContract: async () => {
      calls.fulfill += 1;
      return {};
    },
    deliverContract: async () => {
      calls.deliver += 1;
      return {};
    },
    getShipCargo: async () => ({ inventory: [] }),
  } as any;
  return { api, calls };
}

describe("ContractManager caching", () => {
  it("fetches the contract list once, then serves repeats from cache", async () => {
    const { api, calls } = makeApi();
    const mgr = new ContractManager(api);
    await mgr.listActive();
    await mgr.listActive();
    await mgr.listActive();
    assert.equal(calls.getContracts, 1, "three reads of a slow-changing list must cost one API call");
  });

  it("the coordinator's fulfill-then-accept pair costs one call, not two", async () => {
    // This exact pair runs on every 2s coordinator tick. Uncached it was
    // 1 req/s — half the fleet's entire 2 req/s API budget — for one payload.
    const { api, calls } = makeApi([makeContract({ accepted: true })]);
    const mgr = new ContractManager(api);
    await mgr.fulfillCompleted();
    await mgr.acceptBest();
    assert.equal(calls.getContracts, 1);
  });

  it("accepting a contract invalidates the cache, so the next read is fresh", async () => {
    const { api, calls } = makeApi();
    const mgr = new ContractManager(api);
    await mgr.listActive();
    assert.equal(calls.getContracts, 1);
    await mgr.acceptBest();
    await mgr.listActive();
    assert.equal(calls.getContracts, 2, "state-changing calls must not leave a stale list behind");
  });

  it("fulfilling a contract invalidates the cache", async () => {
    const { api, calls } = makeApi([
      makeContract({
        accepted: true,
        terms: {
          deadline: new Date(Date.now() + 86_400_000).toISOString(),
          payment: { onAccepted: 1_000, onFulfilled: 10_000 },
          deliver: [{ tradeSymbol: "IRON_ORE", unitsRequired: 100, unitsFulfilled: 100, destinationSymbol: "X1-A-A1" }],
        },
      }),
    ]);
    const mgr = new ContractManager(api);
    await mgr.fulfillCompleted();
    assert.equal(calls.fulfill, 1, "a complete contract should be fulfilled");
    await mgr.listActive();
    assert.equal(calls.getContracts, 2, "the fulfill must have invalidated the cache");
  });

  it("delivering invalidates the cache so progress isn't read back stale", async () => {
    const { api, calls } = makeApi([makeContract({ accepted: true })]);
    const mgr = new ContractManager(api);
    await mgr.deliverFromShip("SHIP-1");
    assert.equal(calls.deliver, 1);
    await mgr.listActive();
    assert.equal(calls.getContracts, 2);
  });

  it("still filters out fulfilled and expired contracts when serving from cache", async () => {
    const { api } = makeApi([
      makeContract({ id: "DONE", fulfilled: true }),
      makeContract({ id: "EXPIRED", deadlineToAccept: new Date(Date.now() - 1_000).toISOString() }),
      makeContract({ id: "LIVE" }),
    ]);
    const mgr = new ContractManager(api);
    const first = await mgr.listActive();
    const second = await mgr.listActive(); // served from cache
    assert.deepEqual(first.map((c) => c.id), ["LIVE"]);
    assert.deepEqual(second.map((c) => c.id), ["LIVE"], "caching must not bypass the active-contract filter");
  });
});
