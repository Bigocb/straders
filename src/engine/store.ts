import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { components } from "../core/client.js";

export interface LedgerEntry {
  timestamp: string;
  shipSymbol: string;
  waypointSymbol: string;
  type: "PURCHASE" | "SELL" | "REFUEL" | "SHIP" | "OTHER";
  tradeSymbol?: string;
  units?: number;
  pricePerUnit?: number;
  total: number;
}

export interface MarketRow {
  systemSymbol: string;
  waypointSymbol: string;
  goodSymbol: string;
  type: string;
  supply: string;
  purchasePrice: number;
  sellPrice: number;
  tradeVolume: number;
  timestamp: string;
}

export interface PricePoint {
  waypointSymbol: string;
  goodSymbol: string;
  sellPrice: number;
  timestamp: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  shipSymbol TEXT NOT NULL,
  waypointSymbol TEXT NOT NULL,
  type TEXT NOT NULL,
  tradeSymbol TEXT,
  units INTEGER,
  pricePerUnit REAL,
  total REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger (timestamp);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waypointSymbol TEXT NOT NULL,
  goodSymbol TEXT NOT NULL,
  type TEXT NOT NULL,
  supply TEXT NOT NULL,
  purchasePrice REAL NOT NULL,
  sellPrice REAL NOT NULL,
  tradeVolume INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  systemSymbol TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_snap_waypoint_good ON market_snapshots (waypointSymbol, goodSymbol);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON market_snapshots (timestamp);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  shipSymbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  credits INTEGER
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity (timestamp);

CREATE TABLE IF NOT EXISTS shipyard_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  systemSymbol TEXT NOT NULL,
  waypointSymbol TEXT NOT NULL,
  shipType TEXT,
  shipTypeName TEXT,
  purchasePrice INTEGER,
  fuelCapacity INTEGER,
  cargoCapacity INTEGER,
  moduleSlots INTEGER,
  mountingPoints INTEGER,
  frameSymbol TEXT,
  unique_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_shipyard_waypoint ON shipyard_inventory (waypointSymbol);
CREATE INDEX IF NOT EXISTS idx_shipyard_system ON shipyard_inventory (systemSymbol);

CREATE TABLE IF NOT EXISTS module_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  systemSymbol TEXT NOT NULL,
  waypointSymbol TEXT NOT NULL,
  moduleSymbol TEXT,
  mountSymbol TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  purchasePrice INTEGER NOT NULL,
  unique_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_module_waypoint ON module_catalog (waypointSymbol);
CREATE INDEX IF NOT EXISTS idx_module_symbol ON module_catalog (moduleSymbol, mountSymbol);
CREATE INDEX IF NOT EXISTS idx_module_system ON module_catalog (systemSymbol);

CREATE TABLE IF NOT EXISTS doctrine (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS buckets (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  target REAL NOT NULL,
  pct REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  balance REAL NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bucket_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  bucket TEXT NOT NULL,
  delta REAL NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bucket_ledger_ts ON bucket_ledger (timestamp);

CREATE TABLE IF NOT EXISTS warehouse (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goodSymbol TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  avgCost REAL NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL,
  UNIQUE(goodSymbol)
);

CREATE TABLE IF NOT EXISTS warehouse_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  goodSymbol TEXT NOT NULL,
  delta INTEGER NOT NULL,
  price REAL NOT NULL,
  shipSymbol TEXT,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warehouse_ledger_ts ON warehouse_ledger (timestamp);
CREATE INDEX IF NOT EXISTS idx_warehouse_ledger_good ON warehouse_ledger (goodSymbol);

CREATE INDEX IF NOT EXISTS idx_ledger_ship_ts ON ledger (shipSymbol, timestamp);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_call_id TEXT,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_ts ON chat_messages (timestamp);

CREATE TABLE IF NOT EXISTS missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  target_system TEXT NOT NULL,
  target_waypoint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  assigned_ship TEXT,
  materials TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_missions_status ON missions (status);
CREATE INDEX IF NOT EXISTS idx_missions_target ON missions (target_waypoint);
`;

export interface ActivityEntry {
  timestamp: string;
  shipSymbol: string;
  kind: string;
  detail: string;
  credits?: number;
}

/** Persistent store for trade ledger and market price history. Powers the analytics phases. */
export class Store {
  private readonly db: Database.Database;

  constructor(dbPath?: string) {
    const file = dbPath ?? process.env.ST_DB ?? resolve(process.cwd(), ".st-data/startraders.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info(market_snapshots)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "systemSymbol")) {
      this.db.exec("ALTER TABLE market_snapshots ADD COLUMN systemSymbol TEXT NOT NULL DEFAULT ''");
    }
    const missionCols = this.db.prepare("PRAGMA table_info(missions)").all() as { name: string }[];
    if (!missionCols.some((c) => c.name === "paused")) {
      this.db.exec("ALTER TABLE missions ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
    }
    const yardCols = this.db.prepare("PRAGMA table_info(shipyard_inventory)").all() as { name: string }[];
    if (!yardCols.some((c) => c.name === "frameSymbol")) {
      this.db.exec("ALTER TABLE shipyard_inventory ADD COLUMN frameSymbol TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_snap_system_waypoint_good ON market_snapshots (systemSymbol, waypointSymbol, goodSymbol)");
    this.db.exec(SCHEMA);
  }

  recordLedger(entry: LedgerEntry): void {
    this.db
      .prepare(
        `INSERT INTO ledger (timestamp, shipSymbol, waypointSymbol, type, tradeSymbol, units, pricePerUnit, total)
         VALUES (@timestamp, @shipSymbol, @waypointSymbol, @type, @tradeSymbol, @units, @pricePerUnit, @total)`,
      )
      .run({
        timestamp: entry.timestamp,
        shipSymbol: entry.shipSymbol,
        waypointSymbol: entry.waypointSymbol,
        type: entry.type,
        tradeSymbol: entry.tradeSymbol ?? null,
        units: entry.units ?? null,
        pricePerUnit: entry.pricePerUnit ?? null,
        total: entry.total,
      });
  }

  recordMarket(m: Omit<MarketRow, "timestamp">): void {
    this.db
      .prepare(
        `INSERT INTO market_snapshots (systemSymbol, waypointSymbol, goodSymbol, type, supply, purchasePrice, sellPrice, tradeVolume, timestamp)
         VALUES (@systemSymbol, @waypointSymbol, @goodSymbol, @type, @supply, @purchasePrice, @sellPrice, @tradeVolume, @timestamp)`,
      )
      .run({ ...m, timestamp: new Date().toISOString() });
  }

  recordActivity(entry: ActivityEntry): void {
    this.db
      .prepare(
        `INSERT INTO activity (timestamp, shipSymbol, kind, detail, credits)
         VALUES (@timestamp, @shipSymbol, @kind, @detail, @credits)`,
      )
      .run({
        timestamp: entry.timestamp,
        shipSymbol: entry.shipSymbol,
        kind: entry.kind,
        detail: entry.detail,
        credits: entry.credits ?? null,
      });
  }

  recentActivity(limit = 50): ActivityEntry[] {
    return this.db
      .prepare(`SELECT timestamp, shipSymbol, kind, detail, credits FROM activity ORDER BY id DESC LIMIT ?`)
      .all(limit) as ActivityEntry[];
  }

  priceHistory(waypoint: string, good: string, since: string): PricePoint[] {
    return this.db
      .prepare(
        `SELECT waypointSymbol, goodSymbol, sellPrice, timestamp
         FROM market_snapshots
         WHERE waypointSymbol = ? AND goodSymbol = ? AND timestamp >= ?
         ORDER BY timestamp ASC`,
      )
      .all(waypoint, good, since) as PricePoint[];
  }

  /** Average/max/min sell price per minute across all markets for a good. */
  goodPriceHistory(good: string, since: string): { t: string; avg: number; min: number; max: number }[] {
    const rows = this.db
      .prepare(
        `SELECT
           substr(timestamp, 1, 16) AS t,
           ROUND(AVG(sellPrice), 1) AS avg,
           MIN(sellPrice) AS min,
           MAX(sellPrice) AS max
         FROM market_snapshots
         WHERE goodSymbol = ? AND timestamp >= ?
         GROUP BY t
         ORDER BY t ASC`,
      )
      .all(good, since) as { t: string; avg: number; min: number; max: number }[];
    return rows;
  }

  ledgerTotals(): { credits: number; buys: number; sells: number } {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type='SELL' THEN total ELSE 0 END),0) AS sells,
           COALESCE(SUM(CASE WHEN type='PURCHASE' THEN total ELSE 0 END),0) AS buys
         FROM ledger`,
      )
      .get() as { sells: number; buys: number };
    return { credits: row.sells - row.buys, buys: row.buys, sells: row.sells };
  }

  /** Record or update shipyard inventory for a waypoint. */
  recordShipyardInventory(
    systemSymbol: string,
    waypointSymbol: string,
    ships: components["schemas"]["ShipyardShip"][],
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO shipyard_inventory (timestamp, systemSymbol, waypointSymbol, shipType, shipTypeName, purchasePrice, fuelCapacity, cargoCapacity, moduleSlots, mountingPoints, frameSymbol, unique_key)
       VALUES (@timestamp, @systemSymbol, @waypointSymbol, @shipType, @shipTypeName, @purchasePrice, @fuelCapacity, @cargoCapacity, @moduleSlots, @mountingPoints, @frameSymbol, @unique_key)
       ON CONFLICT(unique_key) DO UPDATE SET
         timestamp=@timestamp, purchasePrice=@purchasePrice, fuelCapacity=@fuelCapacity, cargoCapacity=@cargoCapacity,
         moduleSlots=@moduleSlots, mountingPoints=@mountingPoints, frameSymbol=@frameSymbol`,
    );
    for (const s of ships) {
      const frame = s.frame ?? {};
      stmt.run({
        timestamp: new Date().toISOString(),
        systemSymbol,
        waypointSymbol,
        shipType: s.type,
        shipTypeName: s.name,
        purchasePrice: s.purchasePrice,
        fuelCapacity: frame.fuelCapacity ?? 0,
        cargoCapacity: (frame as any).cargoCapacity ?? 0,
        moduleSlots: (frame as any).moduleSlots ?? 0,
        mountingPoints: (frame as any).mountingPoints ?? 0,
        frameSymbol: (frame as any).symbol ?? null,
        unique_key: `${waypointSymbol}:${s.type}`,
      });
    }
  }

  /** Record or update module/mount catalog for a waypoint. */
  recordModuleCatalog(
    systemSymbol: string,
    waypointSymbol: string,
    items: { symbol: string; name: string; category: string; purchasePrice: number }[],
    kind: "module" | "mount",
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO module_catalog (timestamp, systemSymbol, waypointSymbol, moduleSymbol, mountSymbol, name, category, purchasePrice, unique_key)
       VALUES (@timestamp, @systemSymbol, @waypointSymbol, @moduleSymbol, @mountSymbol, @name, @category, @purchasePrice, @unique_key)
       ON CONFLICT(unique_key) DO UPDATE SET
         timestamp=@timestamp, purchasePrice=@purchasePrice, name=@name, category=@category`,
    );
    for (const i of items) {
      stmt.run({
        timestamp: new Date().toISOString(),
        systemSymbol,
        waypointSymbol,
        moduleSymbol: kind === "module" ? i.symbol : null,
        mountSymbol: kind === "mount" ? i.symbol : null,
        name: i.name,
        category: i.category,
        purchasePrice: i.purchasePrice,
        unique_key: `${waypointSymbol}:${kind}:${i.symbol}`,
      });
    }
  }

  /** Latest shipyard inventory across all known systems. */
  shipyardInventory(): {
    systemSymbol: string;
    waypointSymbol: string;
    shipType: string;
    shipTypeName: string;
    purchasePrice: number;
    fuelCapacity: number;
    cargoCapacity: number;
    moduleSlots: number;
    mountingPoints: number;
    frameSymbol: string;
    timestamp: string;
  }[] {
    return this.db
      .prepare(
        `WITH ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY unique_key ORDER BY timestamp DESC, id DESC) AS rn FROM shipyard_inventory)
         SELECT systemSymbol, waypointSymbol, shipType, shipTypeName, purchasePrice, fuelCapacity, cargoCapacity, moduleSlots, mountingPoints, frameSymbol, timestamp
         FROM ranked WHERE rn = 1 ORDER BY systemSymbol, waypointSymbol, purchasePrice`,
      )
      .all() as any[];
  }

  /** Latest module catalog. Optionally filter by symbol/category. */
  moduleCatalog(symbol?: string, category?: string): {
    systemSymbol: string;
    waypointSymbol: string;
    symbol: string;
    kind: "module" | "mount";
    name: string;
    category: string;
    purchasePrice: number;
    timestamp: string;
  }[] {
    const rows = this.db
      .prepare(
        `WITH ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY unique_key ORDER BY timestamp DESC, id DESC) AS rn FROM module_catalog)
         SELECT systemSymbol, waypointSymbol, moduleSymbol, mountSymbol, name, category, purchasePrice, timestamp
         FROM ranked WHERE rn = 1 ${symbol ? "AND (moduleSymbol = ? OR mountSymbol = ?)" : ""} ${category ? "AND category = ?" : ""}`,
      )
      .all(...(symbol ? [symbol, symbol] : []), ...(category ? [category] : [])) as any[];
    return rows.map((r) => ({
      systemSymbol: r.systemSymbol,
      waypointSymbol: r.waypointSymbol,
      symbol: r.moduleSymbol ?? r.mountSymbol,
      kind: r.moduleSymbol ? ("module" as const) : ("mount" as const),
      name: r.name,
      category: r.category,
      purchasePrice: r.purchasePrice,
      timestamp: r.timestamp,
    }));
  }

  close(): void {
    this.db.close();
  }

  /** Persist one chat message for the co-pilot. */
  recordChatMessage(msg: { role: string; content: string; toolCallId?: string }): void {
    this.db
      .prepare(
        `INSERT INTO chat_messages (role, content, tool_call_id, timestamp)
         VALUES (@role, @content, @toolCallId, @timestamp)`,
      )
      .run({
        role: msg.role,
        content: msg.content,
        toolCallId: msg.toolCallId ?? null,
        timestamp: new Date().toISOString(),
      });
  }

  /** Recent co-pilot chat history, oldest first. */
  chatHistory(limit = 50): { role: string; content: string; toolCallId: string | null; timestamp: string }[] {
    return this.db
      .prepare(
        `SELECT role, content, tool_call_id AS toolCallId, timestamp
         FROM chat_messages ORDER BY id DESC LIMIT ?`,
      )
      .all(limit)
      .reverse() as any[];
  }

  /** Persist a mission record (upsert by target waypoint + kind). */
  recordMission(m: {
    kind: string;
    targetSystem: string;
    targetWaypoint: string;
    status: string;
    assignedShip?: string;
    materials: { tradeSymbol: string; required: number; fulfilled: number }[];
    paused?: boolean;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO missions (kind, target_system, target_waypoint, status, assigned_ship, materials, paused, created_at, updated_at)
         VALUES (@kind, @targetSystem, @targetWaypoint, @status, @assignedShip, @materials, @paused, @now, @now)
         ON CONFLICT(target_waypoint) DO UPDATE SET
           status=@status, assigned_ship=@assignedShip, materials=@materials, paused=@paused, updated_at=@now`,
      )
      .run({
        kind: m.kind,
        targetSystem: m.targetSystem,
        targetWaypoint: m.targetWaypoint,
        status: m.status,
        assignedShip: m.assignedShip ?? null,
        materials: JSON.stringify(m.materials),
        paused: m.paused ? 1 : 0,
        now,
      });
  }

  /** Latest mission records. */
  latestMissions(): {
    kind: "SUPPLY_CONSTRUCTION";
    targetSystem: string;
    targetWaypoint: string;
    status: "active" | "complete";
    assignedShip: string | null;
    materials: { tradeSymbol: string; required: number; fulfilled: number }[];
    paused: boolean;
    createdAt: string;
    updatedAt: string;
  }[] {
    return this.db
      .prepare(
        `WITH ranked AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY target_waypoint ORDER BY updated_at DESC) AS rn
           FROM missions
         )
         SELECT kind, target_system, target_waypoint, status, assigned_ship, materials, paused, created_at, updated_at
         FROM ranked WHERE rn = 1 ORDER BY updated_at DESC`,
      )
      .all()
      .map((r: any) => ({
        kind: r.kind as "SUPPLY_CONSTRUCTION",
        targetSystem: r.target_system,
        targetWaypoint: r.target_waypoint,
        status: r.status as "active" | "complete",
        assignedShip: r.assigned_ship,
        materials: JSON.parse(r.materials),
        paused: Boolean(r.paused),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  /** Mark a mission complete. */
  completeMission(targetWaypoint: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE missions SET status='complete', updated_at=? WHERE target_waypoint=?`)
      .run(now, targetWaypoint);
  }

  /** Return the most recent market snapshot per waypoint per good. */
  latestMarketSnapshots(): MarketRow[] {
    return this.db
      .prepare(
        `WITH ranked AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY waypointSymbol, goodSymbol ORDER BY timestamp DESC, id DESC) AS rn
           FROM market_snapshots
         )
         SELECT * FROM ranked WHERE rn = 1`,
      )
      .all() as MarketRow[];
  }

  /**
   * The most recent snapshot per waypoint per good, but only those seen within
   * `maxAgeMinutes`. This is the view the traders and the dispatcher both fly
   * by: when they read different windows they disagree about which routes
   * exist, and every trader falls back to picking the same "best" good off the
   * same stale table. Same window, same answer.
   */
  freshMarketSnapshots(maxAgeMinutes: number): MarketRow[] {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
    return this.db
      .prepare(
        `WITH ranked AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY waypointSymbol, goodSymbol ORDER BY timestamp DESC, id DESC) AS rn
           FROM market_snapshots
         )
         SELECT * FROM ranked WHERE rn = 1 AND timestamp >= ?`,
      )
      .all(cutoff) as MarketRow[];
  }

  /** Best buy/sell spread per trade good across known markets. Optionally scope to one system. */
  bestTrades(system?: string): {
    goodSymbol: string;
    lowestPurchasePrice: number;
    cheapestMarket: string;
    highestSellPrice: number;
    expensiveMarket: string;
    spread: number;
    profitMarginPct: number;
    crossSystem: boolean;
  }[] {
    return this.db
      .prepare(
        `WITH ranked AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY waypointSymbol, goodSymbol ORDER BY timestamp DESC, id DESC) AS rn
           FROM market_snapshots
           ${system ? "WHERE systemSymbol = ?" : ""}
         ), latest AS (
           SELECT * FROM ranked WHERE rn = 1
         )
         SELECT
           goodSymbol,
           MIN(purchasePrice) AS lowestPurchasePrice,
           MIN(CASE WHEN purchasePrice = minPurchase THEN waypointSymbol END) AS cheapestMarket,
           MAX(sellPrice) AS highestSellPrice,
           MAX(CASE WHEN sellPrice = maxSell THEN waypointSymbol END) AS expensiveMarket,
           MAX(sellPrice) - MIN(purchasePrice) AS spread,
           ROUND(((MAX(sellPrice) - MIN(purchasePrice)) / NULLIF(MIN(purchasePrice), 0)) * 100, 1) AS profitMarginPct,
           CASE WHEN MIN(systemSymbol) != MAX(systemSymbol) THEN 1 ELSE 0 END AS crossSystem
         FROM (
           SELECT *,
             MIN(purchasePrice) OVER (PARTITION BY goodSymbol) AS minPurchase,
             MAX(sellPrice) OVER (PARTITION BY goodSymbol) AS maxSell
           FROM latest
         )
         GROUP BY goodSymbol
         HAVING spread > 0
         ORDER BY profitMarginPct DESC`,
      )
      .all(...(system ? [system] : [])) as any[];
  }

  /**
   * Every buy→sell pair worth considering, as raw legs. Unlike `bestTrades`,
   * this does NOT collapse to one row per good and does not rank — the caller
   * ranks by profit per trip once it knows the distance between the waypoints,
   * which is the only ranking that reflects what a run actually earns.
   */
  tradeLegs(maxAgeMinutes = 90): {
    goodSymbol: string;
    buyAt: string;
    buySystem: string;
    buyPrice: number;
    sellAt: string;
    sellSystem: string;
    sellPrice: number;
    volume: number;
    stalestIso: string;
  }[] {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
    return this.db
      .prepare(
        `WITH ranked AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY waypointSymbol, goodSymbol ORDER BY timestamp DESC, id DESC) AS rn
           FROM market_snapshots
         ), latest AS (
           SELECT * FROM ranked WHERE rn = 1 AND timestamp >= ?
         )
         SELECT
           b.goodSymbol                      AS goodSymbol,
           b.waypointSymbol                  AS buyAt,
           b.systemSymbol                    AS buySystem,
           b.purchasePrice                   AS buyPrice,
           s.waypointSymbol                  AS sellAt,
           s.systemSymbol                    AS sellSystem,
           s.sellPrice                       AS sellPrice,
           MIN(b.tradeVolume, s.tradeVolume) AS volume,
           MIN(b.timestamp, s.timestamp)     AS stalestIso
         FROM latest b
         JOIN latest s
           ON s.goodSymbol = b.goodSymbol
          AND s.waypointSymbol != b.waypointSymbol
         WHERE s.sellPrice > b.purchasePrice
           AND b.purchasePrice > 0`,
      )
      .all(cutoff) as any[];
  }

  /**
   * Net credits per ship over a window. SELL is income; PURCHASE, REFUEL and
   * ship purchases are spend. Scrapping is recorded as type SHIP but returns
   * credits, so it is counted as income.
   */
  earningsByShip(sinceIso: string): { shipSymbol: string; earned: number; spent: number; net: number }[] {
    return this.db
      .prepare(
        `SELECT shipSymbol,
           COALESCE(SUM(CASE WHEN type='SELL' OR tradeSymbol='SCRAP' THEN total ELSE 0 END),0) AS earned,
           COALESCE(SUM(CASE WHEN type!='SELL' AND COALESCE(tradeSymbol,'')!='SCRAP' THEN total ELSE 0 END),0) AS spent
         FROM ledger
         WHERE timestamp >= ?
         GROUP BY shipSymbol`,
      )
      .all(sinceIso)
      .map((r: any) => ({ ...r, net: r.earned - r.spent }))
      .sort((a: any, b: any) => b.net - a.net);
  }

  /**
   * Net credits bucketed over time, for the rate readout and its sparkline.
   * Buckets are labelled by their start instant.
   */
  netSeries(sinceIso: string, bucketMinutes = 60): { t: string; net: number }[] {
    const rows = this.db
      .prepare(
        `SELECT timestamp,
           CASE WHEN type='SELL' OR tradeSymbol='SCRAP' THEN total ELSE -total END AS delta
         FROM ledger
         WHERE timestamp >= ?
         ORDER BY timestamp ASC`,
      )
      .all(sinceIso) as { timestamp: string; delta: number }[];

    const size = bucketMinutes * 60_000;
    const start = new Date(sinceIso).getTime();
    const buckets = new Map<number, number>();
    for (const r of rows) {
      const idx = Math.floor((new Date(r.timestamp).getTime() - start) / size);
      buckets.set(idx, (buckets.get(idx) ?? 0) + r.delta);
    }
    const last = Math.floor((Date.now() - start) / size);
    const out: { t: string; net: number }[] = [];
    for (let i = 0; i <= last; i += 1) {
      out.push({ t: new Date(start + i * size).toISOString(), net: Math.round(buckets.get(i) ?? 0) });
    }
    return out;
  }

  /** Persisted doctrine overrides. Absent keys fall back to code defaults. */
  getDoctrine(): { key: string; value: number; enabled: boolean }[] {
    return this.db
      .prepare(`SELECT key, value, enabled FROM doctrine`)
      .all()
      .map((r: any) => ({ key: r.key, value: r.value, enabled: !!r.enabled }));
  }

  setDoctrine(key: string, value: number, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO doctrine (key, value, enabled, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, enabled = excluded.enabled, updatedAt = excluded.updatedAt`,
      )
      .run(key, value, enabled ? 1 : 0, new Date().toISOString());
  }

  /** Persisted bucket rows. Absent keys fall back to code defaults. */
  getBuckets(): { key: string; name: string; description: string; target: number; pct: number; enabled: boolean; balance: number }[] {
    return this.db
      .prepare(`SELECT key, name, description, target, pct, enabled, balance FROM buckets`)
      .all()
      .map((r: any) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        target: r.target,
        pct: r.pct,
        enabled: !!r.enabled,
        balance: r.balance,
      }));
  }

  /** Upsert a bucket's config (target/pct/enabled). Balance is preserved. */
  setBucket(key: string, patch: { name?: string; description?: string; target?: number; pct?: number; enabled?: boolean }): void {
    const existing = this.db.prepare(`SELECT * FROM buckets WHERE key = ?`).get(key) as any;
    const name = patch.name ?? existing?.name ?? key;
    const description = patch.description ?? existing?.description ?? "";
    const target = patch.target ?? existing?.target ?? 0;
    const pct = patch.pct ?? existing?.pct ?? 0;
    const enabled = patch.enabled ?? (existing ? !!existing.enabled : true);
    const balance = existing?.balance ?? 0;
    this.db
      .prepare(
        `INSERT INTO buckets (key, name, description, target, pct, enabled, balance, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name, description = excluded.description,
           target = excluded.target, pct = excluded.pct, enabled = excluded.enabled, updatedAt = excluded.updatedAt`,
      )
      .run(key, name, description, target, pct, enabled ? 1 : 0, balance, new Date().toISOString());
  }

  /** Adjust a bucket's balance and record the movement in the bucket ledger. */
  adjustBucketBalance(key: string, delta: number, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO buckets (key, name, description, target, pct, enabled, balance, updatedAt) VALUES (?, '', '', 0, 0, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET balance = balance + excluded.balance, updatedAt = excluded.updatedAt`,
      )
      .run(key, delta, new Date().toISOString());
    this.db
      .prepare(`INSERT INTO bucket_ledger (timestamp, bucket, delta, reason) VALUES (?, ?, ?, ?)`)
      .run(new Date().toISOString(), key, delta, reason);
  }

  /** Recent bucket movements, newest first. */
  recentBucketLedger(limit = 50): { timestamp: string; bucket: string; delta: number; reason: string }[] {
    return this.db
      .prepare(`SELECT timestamp, bucket, delta, reason FROM bucket_ledger ORDER BY timestamp DESC LIMIT ?`)
      .all(limit)
      .map((r: any) => ({ timestamp: r.timestamp, bucket: r.bucket, delta: r.delta, reason: r.reason }));
  }

  /*
   * ── Warehouse ──────────────────────────────────────────────────────────
   * A virtual staging inventory (docs/warehousing-plan.md). SpaceTraders has
   * no player-owned storage, so this is a planning layer only — units here
   * represent cargo some ship is physically carrying on the way to or from a
   * deposit/withdrawal, not goods sitting anywhere real. It decouples buying
   * from selling: one trader can fill a good while another drains it, which
   * is what lets two traders work the same good without the dispatcher's
   * "one trader per good" rule being the only thing keeping them from
   * bidding against each other at the same market.
   */

  /** Units currently held of one good (0 if the warehouse has never seen it). */
  warehouseBalance(goodSymbol: string): number {
    const row = this.db.prepare(`SELECT units FROM warehouse WHERE goodSymbol = ?`).get(goodSymbol) as
      | { units: number }
      | undefined;
    return row?.units ?? 0;
  }

  /** Every good the warehouse holds, with cost basis and value at that basis. */
  warehouseAll(): { goodSymbol: string; units: number; avgCost: number; value: number }[] {
    return (
      this.db.prepare(`SELECT goodSymbol, units, avgCost FROM warehouse WHERE units > 0 ORDER BY goodSymbol`).all() as {
        goodSymbol: string;
        units: number;
        avgCost: number;
      }[]
    ).map((r) => ({ ...r, value: Math.round(r.units * r.avgCost) }));
  }

  /** Total value of everything held, at cost basis. */
  warehouseValue(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(units * avgCost), 0) AS v FROM warehouse`).get() as { v: number };
    return Math.round(row.v);
  }

  /**
   * Add units to the warehouse, recomputing the weighted-average cost basis
   * over the combined old + new holding. Returns the good's new total.
   */
  warehouseDeposit(goodSymbol: string, units: number, price: number, shipSymbol: string | undefined, reason: string): number {
    if (units <= 0) throw new Error(`warehouseDeposit: units must be positive (got ${units})`);
    const current = this.db.prepare(`SELECT units, avgCost FROM warehouse WHERE goodSymbol = ?`).get(goodSymbol) as
      | { units: number; avgCost: number }
      | undefined;
    const oldUnits = current?.units ?? 0;
    const oldCost = current?.avgCost ?? 0;
    const newUnits = oldUnits + units;
    const newAvgCost = (oldUnits * oldCost + units * price) / newUnits;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO warehouse (goodSymbol, units, avgCost, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(goodSymbol) DO UPDATE SET units = excluded.units, avgCost = excluded.avgCost, updatedAt = excluded.updatedAt`,
      )
      .run(goodSymbol, newUnits, newAvgCost, now);
    this.db
      .prepare(`INSERT INTO warehouse_ledger (timestamp, goodSymbol, delta, price, shipSymbol, reason) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(now, goodSymbol, units, price, shipSymbol ?? null, reason);
    return newUnits;
  }

  /**
   * Remove up to `units` from the warehouse, clamped to what's actually
   * held — a caller mid-tick can't be allowed to withdraw cargo that doesn't
   * exist, so the request is a ceiling, not a guarantee. Returns what
   * actually came out and the cost basis it carried: a seller needs the
   * basis to know whether the live price clears the margin floor.
   * Withdrawing never changes avgCost — only a deposit moves the cost basis;
   * draining the same-cost inventory down doesn't.
   */
  warehouseWithdraw(
    goodSymbol: string,
    units: number,
    price: number,
    shipSymbol: string | undefined,
    reason: string,
  ): { units: number; avgCost: number } {
    if (units <= 0) throw new Error(`warehouseWithdraw: units must be positive (got ${units})`);
    const current = this.db.prepare(`SELECT units, avgCost FROM warehouse WHERE goodSymbol = ?`).get(goodSymbol) as
      | { units: number; avgCost: number }
      | undefined;
    const held = current?.units ?? 0;
    const avgCost = current?.avgCost ?? 0;
    const actual = Math.min(units, held);
    if (actual <= 0) return { units: 0, avgCost };
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE warehouse SET units = units - ?, updatedAt = ? WHERE goodSymbol = ?`).run(actual, now, goodSymbol);
    this.db
      .prepare(`INSERT INTO warehouse_ledger (timestamp, goodSymbol, delta, price, shipSymbol, reason) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(now, goodSymbol, -actual, price, shipSymbol ?? null, reason);
    return { units: actual, avgCost };
  }

  /** Recent warehouse movements, newest first — the audit trail behind the balances. */
  warehouseLedger(limit = 50): { timestamp: string; goodSymbol: string; delta: number; price: number; shipSymbol: string | null; reason: string }[] {
    return this.db
      .prepare(`SELECT timestamp, goodSymbol, delta, price, shipSymbol, reason FROM warehouse_ledger ORDER BY timestamp DESC LIMIT ?`)
      .all(limit) as any[];
  }
}
