import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MarketIntel, type MarketSnapshot } from "../src/engine/market.js";

function makeSnapshot(waypoint: string, goods: { symbol: string; type: "EXPORT" | "IMPORT" | "EXCHANGE"; purchasePrice: number; sellPrice: number; volume: number }[]): MarketSnapshot {
  const tradeGoods: MarketSnapshot["tradeGoods"] = {};
  for (const g of goods) {
    tradeGoods[g.symbol] = {
      symbol: g.symbol,
      type: g.type,
      tradeVolume: g.volume,
      supply: "MODERATE",
      purchasePrice: g.purchasePrice,
      sellPrice: g.sellPrice,
      activity: "MODERATE",
    } as any;
  }
  return {
    symbol: waypoint,
    systemSymbol: "X1-A",
    tradeGoods,
    imports: goods.filter((g) => g.type === "IMPORT").map((g) => g.symbol),
    exports: goods.filter((g) => g.type === "EXPORT").map((g) => g.symbol),
    exchange: goods.filter((g) => g.type === "EXCHANGE").map((g) => g.symbol),
    fetchedAt: new Date().toISOString(),
  };
}

const intel = new MarketIntel({} as any);

describe("MarketIntel.findOpportunities", () => {
  it("finds profitable buy-low sell-high routes", () => {
    const markets: MarketSnapshot[] = [
      makeSnapshot("X1-A-EXP", [{ symbol: "IRON", type: "EXPORT", purchasePrice: 18, sellPrice: 20, volume: 40 }]),
      makeSnapshot("X1-A-IMP", [{ symbol: "IRON", type: "IMPORT", purchasePrice: 32, sellPrice: 30, volume: 25 }]),
    ];
    const opps = intel.findOpportunities(markets, ["IRON"]);
    assert.equal(opps.length, 1);
    const first = opps[0]!;
    assert.equal(first.good, "IRON");
    assert.equal(first.buyAt.price, 20);
    assert.equal(first.sellAt.price, 32);
    assert.equal(first.marginPerUnit, 12);
    assert.equal(first.volume, 25);
  });

  it("skips routes with zero or negative margin", () => {
    const markets: MarketSnapshot[] = [
      makeSnapshot("X1-A-EXP", [{ symbol: "COPPER", type: "EXPORT", purchasePrice: 100, sellPrice: 100, volume: 10 }]),
      makeSnapshot("X1-A-IMP", [{ symbol: "COPPER", type: "IMPORT", purchasePrice: 90, sellPrice: 90, volume: 10 }]),
    ];
    const opps = intel.findOpportunities(markets, ["COPPER"]);
    assert.equal(opps.length, 0);
  });

  it("respects trade volume caps", () => {
    const markets: MarketSnapshot[] = [
      makeSnapshot("X1-A-EXP", [{ symbol: "QUARTZ", type: "EXPORT", purchasePrice: 10, sellPrice: 12, volume: 100 }]),
      makeSnapshot("X1-A-IMP", [{ symbol: "QUARTZ", type: "IMPORT", purchasePrice: 20, sellPrice: 18, volume: 5 }]),
    ];
    const opps = intel.findOpportunities(markets, ["QUARTZ"]);
    assert.equal(opps[0]!.volume, 5);
  });
});

describe("MarketIntel.bestSell", () => {
  it("picks the highest sell price for a good", () => {
    const markets: MarketSnapshot[] = [
      makeSnapshot("X1-A-1", [{ symbol: "GOLD", type: "EXPORT", purchasePrice: 100, sellPrice: 110, volume: 10 }]),
      makeSnapshot("X1-A-2", [{ symbol: "GOLD", type: "EXPORT", purchasePrice: 100, sellPrice: 130, volume: 8 }]),
    ];
    const best = intel.bestSell(markets, "GOLD");
    assert.ok(best);
    assert.equal(best!.waypoint, "X1-A-2");
    assert.equal(best!.price, 130);
  });

  it("returns undefined when no seller exists", () => {
    const markets: MarketSnapshot[] = [
      makeSnapshot("X1-A-1", [{ symbol: "GOLD", type: "IMPORT", purchasePrice: 100, sellPrice: 90, volume: 10 }]),
    ];
    const best = intel.bestSell(markets, "GOLD");
    assert.equal(best, undefined);
  });
});
