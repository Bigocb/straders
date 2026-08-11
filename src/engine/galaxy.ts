import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";
import type { MarketSnapshot } from "./market.js";

export type Waypoint = components["schemas"]["Waypoint"];
export type JumpGate = components["schemas"]["JumpGate"];
export type System = components["schemas"]["System"];
export type ShipyardShip = components["schemas"]["ShipyardShip"];

export interface KnownSystem {
  symbol: string;
  waypoints: Waypoint[];
  jumpGates: JumpGate[];
  markets: MarketSnapshot[];
  shipyards: { symbol: string; ships: ShipyardShip[]; modificationsFee: number }[];
}
/** Multi-system atlas: caches waypoints, jump gates, and foreign markets. */
export class GalaxyAtlas {
  private readonly api: SpaceTradersAPI;
  private readonly systems = new Map<string, KnownSystem>();
  private readonly jumps = new Map<string, string>(); // gate symbol -> system symbol

  constructor(api: SpaceTradersAPI) {
    this.api = api;
  }

  async loadSystem(systemSymbol: string): Promise<KnownSystem> {
    if (this.systems.has(systemSymbol)) return this.systems.get(systemSymbol)!;
    const system = await this.api.getSystem(systemSymbol);
    const waypoints = await this.api.getAllSystemWaypoints(systemSymbol);
    const known: KnownSystem = { symbol: systemSymbol, waypoints, jumpGates: [], markets: [], shipyards: [] };
    this.systems.set(systemSymbol, known);
    for (const w of waypoints) {
      if (w.type === "JUMP_GATE") this.jumps.set(w.symbol, systemSymbol);
    }
    return known;
  }

  getSystem(symbol: string): KnownSystem | undefined {
    return this.systems.get(symbol);
  }

  listSystems(): KnownSystem[] {
    return [...this.systems.values()];
  }

  /** Discover jump gates and their connected gates in a known system. */
  async scanJumpGates(systemSymbol: string): Promise<JumpGate[]> {
    const known = await this.loadSystem(systemSymbol);
    const gates = known.waypoints.filter((w) => w.type === "JUMP_GATE");
    const results: JumpGate[] = [];
    for (const gate of gates) {
      try {
        const jg = await this.api.getJumpGate(systemSymbol, gate.symbol);
        results.push(jg);
        for (const connected of jg.connections) {
          const connectedSystem = connected.slice(0, connected.lastIndexOf("-"));
          await this.loadSystem(connectedSystem);
        }
      } catch (err) {
        // waypoint may not be a jump gate or unreachable
      }
    }
    known.jumpGates = results;
    return results;
  }

  /** Return systems reachable from `systemSymbol` via known jump gates. */
  connectedSystems(systemSymbol: string): string[] {
    const known = this.systems.get(systemSymbol);
    if (!known) return [];
    const connected = new Set<string>();
    for (const jg of known.jumpGates) {
      for (const c of jg.connections) {
        const sys = c.slice(0, c.lastIndexOf("-"));
        if (sys !== systemSymbol) connected.add(sys);
      }
    }
    return [...connected];
  }

  /** Return all jump gate connections as pairs of waypoint symbols. */
  jumpConnections(): { from: string; to: string }[] {
    const out: { from: string; to: string }[] = [];
    for (const sys of this.systems.values()) {
      for (const jg of sys.jumpGates) {
        for (const c of jg.connections) out.push({ from: jg.symbol, to: c });
      }
    }
    return out;
  }

  /** Find jump gates in `fromSystem` that connect to `toSystem`. */
  gatesTo(fromSystem: string, toSystem: string): string[] {
    const known = this.systems.get(fromSystem);
    if (!known) return [];
    const out: string[] = [];
    for (const jg of known.jumpGates) {
      if (jg.connections.some((c) => c.startsWith(toSystem + "-"))) out.push(jg.symbol);
    }
    return out;
  }

  /** Fetch markets in a system and cache them as snapshots. */
  async surveyMarkets(systemSymbol: string, store?: {
    recordModuleCatalog: (systemSymbol: string, waypointSymbol: string, items: { symbol: string; name: string; category: string; purchasePrice: number }[], kind: "module" | "mount") => void;
  }): Promise<MarketSnapshot[]> {
    const known = await this.loadSystem(systemSymbol);
    const markets: MarketSnapshot[] = [];
    for (const w of known.waypoints.filter((w) => w.traits.some((t) => t.symbol === "MARKETPLACE"))) {
      try {
        const market = await this.api.getMarket(systemSymbol, w.symbol);
        const snapshot: MarketSnapshot = {
          symbol: w.symbol,
          systemSymbol,
          tradeGoods: {},
          imports: (market.imports ?? []).map((g) => g.symbol),
          exports: (market.exports ?? []).map((g) => g.symbol),
          exchange: (market.exchange ?? []).map((g) => g.symbol),
          fetchedAt: new Date().toISOString(),
        };
        const moduleGoods: { symbol: string; name: string; category: string; purchasePrice: number }[] = [];
        const mountGoods: { symbol: string; name: string; category: string; purchasePrice: number }[] = [];
        for (const g of market.tradeGoods ?? []) {
          snapshot.tradeGoods[g.symbol] = g;
          if (g.symbol.startsWith("MODULE_")) {
            moduleGoods.push({ symbol: g.symbol, name: g.symbol, category: g.type, purchasePrice: g.purchasePrice });
          } else if (g.symbol.startsWith("MOUNT_")) {
            mountGoods.push({ symbol: g.symbol, name: g.symbol, category: g.type, purchasePrice: g.purchasePrice });
          }
        }
        markets.push(snapshot);
        if (store) {
          if (moduleGoods.length) store.recordModuleCatalog(systemSymbol, w.symbol, moduleGoods, "module");
          if (mountGoods.length) store.recordModuleCatalog(systemSymbol, w.symbol, mountGoods, "mount");
        }
      } catch (err) {
        // market may be un-scanned
      }
    }
    known.markets = markets;
    return markets;
  }

  /** Fetch shipyards in a system and cache inventory. */
  async surveyShipyards(systemSymbol: string, store?: {
    recordShipyardInventory: (systemSymbol: string, waypointSymbol: string, ships: ShipyardShip[]) => void;
  }): Promise<{ symbol: string; ships: ShipyardShip[]; modificationsFee: number }[]> {
    const known = await this.loadSystem(systemSymbol);
    const shipyards: { symbol: string; ships: ShipyardShip[]; modificationsFee: number }[] = [];
    for (const w of known.waypoints.filter((w) => w.traits.some((t) => t.symbol === "SHIPYARD"))) {
      try {
        const yard = await this.api.getShipyard(systemSymbol, w.symbol);
        const entry = { symbol: w.symbol, ships: yard.ships ?? [], modificationsFee: yard.modificationsFee ?? 0 };
        shipyards.push(entry);
        if (store) store.recordShipyardInventory(systemSymbol, w.symbol, entry.ships);
      } catch (err) {
        // shipyard may be un-scanned
      }
    }
    known.shipyards = shipyards;
    return shipyards;
  }

  /** Return all cached waypoint positions across known systems. */
  allPositions(): { symbol: string; x: number; y: number; type?: components["schemas"]["WaypointType"]; systemSymbol: string }[] {
    const out: { symbol: string; x: number; y: number; type?: components["schemas"]["WaypointType"]; systemSymbol: string }[] = [];
    for (const sys of this.systems.values()) {
      for (const w of sys.waypoints) {
        out.push({ symbol: w.symbol, x: w.x, y: w.y, type: w.type, systemSymbol: sys.symbol });
      }
    }
    return out;
  }
}
