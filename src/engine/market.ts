import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";

export type TradeSymbol = components["schemas"]["TradeSymbol"];
export type Market = components["schemas"]["Market"];
export type MarketTradeGood = components["schemas"]["MarketTradeGood"];
export type WaypointType = components["schemas"]["WaypointType"];
export type Waypoint = components["schemas"]["Waypoint"];

export interface MarketSnapshot {
  symbol: string;
  systemSymbol: string;
  /** Keyed by trade good symbol. */
  tradeGoods: Record<string, MarketTradeGood>;
  /** Goods this market imports (visible remotely). */
  imports: string[];
  /** Goods this market exports (visible remotely). */
  exports: string[];
  /** Goods traded both ways (visible remotely). */
  exchange: string[];
  fetchedAt: string;
}

/** A discovered market together with the buy/sell prices for a good. */
export interface TradeOpportunity {
  good: string;
  buyAt: { waypoint: string; price: number; volume: number };
  sellAt: { waypoint: string; price: number; volume: number };
  /** Profit per unit, before travel/fuel costs. */
  marginPerUnit: number;
  /** Estimated units tradeable in a single run, capped by the smaller trade volume. */
  volume: number;
}

/** Market intelligence: find waypoints with markets/shipyards and profitable routes. */
export class MarketIntel {
  private readonly marketCache = new Map<string, MarketSnapshot>();

  constructor(private readonly api: SpaceTradersAPI) {}

  /** Fetch the full list of markets in a system, caching by system. */
  async getSystemMarkets(systemSymbol: string): Promise<MarketSnapshot[]> {
    const waypoints = await this.api.getAllSystemWaypoints(systemSymbol);
    const marketWaypoints = waypoints.filter((w) => w.traits.some((t) => t.symbol === "MARKETPLACE"));
    const snapshots: MarketSnapshot[] = [];
    for (const wp of marketWaypoints) {
      const market = await this.api.getMarket(systemSymbol, wp.symbol);
      const snapshot: MarketSnapshot = {
        symbol: wp.symbol,
        systemSymbol,
        tradeGoods: {},
        imports: (market.imports ?? []).map((g) => g.symbol),
        exports: (market.exports ?? []).map((g) => g.symbol),
        exchange: (market.exchange ?? []).map((g) => g.symbol),
        fetchedAt: new Date().toISOString(),
      };
      for (const g of market.tradeGoods ?? []) {
        snapshot.tradeGoods[g.symbol] = g;
      }
      snapshots.push(snapshot);
      this.marketCache.set(wp.symbol, snapshot);
    }
    return snapshots;
  }

  getCachedMarket(waypoint: string): MarketSnapshot | undefined {
    return this.marketCache.get(waypoint);
  }

  /** Find the best buy→sell opportunities across the given markets for mined goods. */
  findOpportunities(snapshots: MarketSnapshot[], goods: string[]): TradeOpportunity[] {
    const opps: TradeOpportunity[] = [];
    for (const good of goods) {
      const sellers: { waypoint: string; price: number; volume: number }[] = [];
      const buyers: { waypoint: string; price: number; volume: number }[] = [];
      for (const m of snapshots) {
        const g = m.tradeGoods[good];
        if (!g) continue;
        if (g.type === "EXPORT" || g.type === "EXCHANGE") {
          sellers.push({ waypoint: m.symbol, price: g.sellPrice, volume: g.tradeVolume });
        }
        if (g.type === "IMPORT" || g.type === "EXCHANGE") {
          buyers.push({ waypoint: m.symbol, price: g.purchasePrice, volume: g.tradeVolume });
        }
      }
      for (const sell of sellers) {
        for (const buy of buyers) {
          const margin = buy.price - sell.price;
          if (margin <= 0) continue;
          const volume = Math.min(sell.volume, buy.volume);
          if (volume <= 0) continue;
          opps.push({
            good,
            buyAt: sell,
            sellAt: buy,
            marginPerUnit: margin,
            volume,
          });
        }
      }
    }
    opps.sort((a, b) => b.marginPerUnit * Math.min(b.volume, 60) - a.marginPerUnit * Math.min(a.volume, 60));
    return opps;
  }

  /** Find the best sell price for a given good across markets. */
  bestSell(snapshots: MarketSnapshot[], good: string): { waypoint: string; price: number; volume: number } | undefined {
    let best: { waypoint: string; price: number; volume: number } | undefined;
    for (const m of snapshots) {
      const g = m.tradeGoods[good];
      if (!g) continue;
      if (g.type === "EXPORT" || g.type === "EXCHANGE") {
        if (!best || g.sellPrice > best.price) {
          best = { waypoint: m.symbol, price: g.sellPrice, volume: g.tradeVolume };
        }
      }
    }
    return best;
  }
}
