// Mock command-center backend: serves public/ plus stubbed /api routes so the
// dashboard can be driven end-to-end without a live SpaceTraders account.
import express from "express";
import { resolve } from "node:path";

const app = express();
app.use(express.json());

const wp = (n, x, y, type, traits = []) => ({ symbol: `X1-AA-${n}`, x, y, type, traits });
const waypoints = [
  wp("A1", 0, 0, "PLANET", ["MARKETPLACE", "SHIPYARD"]),
  wp("B2", 30, -20, "ASTEROID_FIELD", []),
  wp("C3", -40, 25, "PLANET", ["MARKETPLACE"]),
  wp("D4", 60, 60, "JUMP_GATE", []),
  wp("E5", -70, -55, "ASTEROID", []),
];

const ship = (sym, waypoint, status, fuel, cargo, role) => ({
  symbol: sym,
  registration: { role, name: sym },
  nav: { systemSymbol: "X1-AA", waypointSymbol: `X1-AA-${waypoint}`, status, route: { arrival: new Date(Date.now() + 60000).toISOString() } },
  fuel: { current: fuel[0], capacity: fuel[1] },
  cargo: { units: cargo[0], capacity: cargo[1], inventory: cargo[2] ?? [] },
  mounts: [], modules: [],
  frame: { symbol: "FRAME_MINER", name: "Miner" }, reactor: { symbol: "R", name: "R" }, engine: { symbol: "E", name: "E" },
});

const ships = [
  ship("AG-1", "B2", "IN_ORBIT", [40, 80], [12, 30, [{ symbol: "IRON_ORE", units: 12 }]], "EXCAVATOR"),
  ship("AG-2", "E5", "IN_ORBIT", [0, 80], [30, 30, [{ symbol: "COPPER_ORE", units: 30 }]], "EXCAVATOR"), // stranded
  ship("AG-3", "A1", "DOCKED", [70, 100], [0, 60], "COMMAND"),   // engine says trader
  ship("AG-4", "C3", "DOCKED", [55, 80], [0, 0], "SATELLITE"),   // engine says tour
  ship("AG-5", "D4", "IN_TRANSIT", [20, 80], [0, 40], "EXCAVATOR"), // engine says surveyor
  ship("AG-6", "A1", "DOCKED", [80, 80], [0, 0], "SATELLITE"),   // engine says idle -> ops catch-all
];

// Engine roles deliberately disagree with registration.role, which is the whole
// point of fix #3.
const roles = { "AG-1": "miner", "AG-2": "miner", "AG-3": "trader", "AG-4": "tour", "AG-5": "surveyor", "AG-6": "idle" };

app.get("/api/state", (_q, r) => r.json({
  agent: { symbol: "MOCK", credits: 412_500, shipCount: ships.length, headquarters: "X1-AA-A1" },
  ships,
  contracts: [{
    id: "c1", type: "PROCUREMENT", accepted: false,
    terms: { payment: { onAccepted: 5000, onFulfilled: 90000 }, deadline: new Date(Date.now() + 864e5).toISOString(),
      deliver: [{ tradeSymbol: "IRON_ORE", destinationSymbol: "X1-AA-A1", unitsRequired: 100, unitsFulfilled: 34 }] },
  }],
  systemSymbol: "X1-AA",
  waypoints,
  systems: [{ symbol: "X1-AA", waypoints, jumpGates: ["X1-AA-D4"] }],
  jumpConnections: [{ from: "X1-AA-D4", to: "X1-BB-D1" }],
  totals: { sells: 980_000, buys: 610_000 },
}));

app.get("/api/fleet/status", (_q, r) => r.json({
  paused: false,
  running: true,
  ships: ships.map((s) => ({ symbol: s.symbol, role: roles[s.symbol], status: s.nav.status, paused: s.symbol === "AG-3" })),
  stranded: [{ symbol: "AG-2", waypointSymbol: "X1-AA-E5", fuel: 0, reason: "0 fuel and not at a market" }],
}));

// A realistic-length feed: the ticker renders these with white-space:nowrap
// and no natural break point, which is exactly what forced the page-wide
// horizontal scrollbar before .view > * got min-width:0.
app.get("/api/activity", (_q, r) => r.json({ activity: [
  { timestamp: new Date().toISOString(), shipSymbol: "AG-1", kind: "extract", detail: "+3u IRON_ORE (12/30)", credits: null },
  { timestamp: new Date().toISOString(), shipSymbol: "AG-3", kind: "sell", detail: "20u CLOTHING @ 412c", credits: 8240 },
  { timestamp: new Date().toISOString(), shipSymbol: "AG-5", kind: "survey", detail: "surveyed X1-AA-B2 for GOLD_ORE, SILVER_ORE, PLATINUM_ORE deposits", credits: null },
  { timestamp: new Date().toISOString(), shipSymbol: "AG-2", kind: "navigate", detail: "en route X1-AA-E5 -> X1-AA-A1, arriving in 4m 12s", credits: null },
  { timestamp: new Date().toISOString(), shipSymbol: "AG-4", kind: "market", detail: "toured X1-AA-C3, recorded 14 goods including MODULE_CARGO_HOLD_II", credits: null },
  { timestamp: new Date().toISOString(), shipSymbol: "AG-1", kind: "refuel", detail: "refuelled to 80/80 at X1-AA-A1 shipyard fuel depot", credits: -612 },
  { timestamp: new Date().toISOString(), shipSymbol: "AG-3", kind: "buy", detail: "bought 40u CLOTHING @ 388c for the C3 arbitrage run", credits: -15520 },
]}));

app.get("/api/intel", (_q, r) => r.json({
  snapshots: [
    { systemSymbol: "X1-AA", waypointSymbol: "X1-AA-A1", goodSymbol: "IRON_ORE", type: "IMPORT", supply: "MODERATE", purchasePrice: 42, sellPrice: 38, tradeVolume: 60, timestamp: new Date().toISOString() },
    { systemSymbol: "X1-AA", waypointSymbol: "X1-AA-C3", goodSymbol: "IRON_ORE", type: "EXPORT", supply: "HIGH", purchasePrice: 18, sellPrice: 15, tradeVolume: 60, timestamp: new Date().toISOString() },
  ],
  bestTrades: [{ goodSymbol: "IRON_ORE", lowestPurchasePrice: 18, cheapestMarket: "X1-AA-C3", highestSellPrice: 38, expensiveMarket: "X1-AA-A1", spread: 20, profitMarginPct: 111.1, crossSystem: false }],
  shipyards: [{ systemSymbol: "X1-AA", waypointSymbol: "X1-AA-A1", shipType: "SHIP_MINING_DRONE", shipTypeName: "Mining Drone", purchasePrice: 78000, fuelCapacity: 0, cargoCapacity: 15, moduleSlots: 3, mountingPoints: 2, timestamp: new Date().toISOString() }],
  modules: [{ systemSymbol: "X1-AA", waypointSymbol: "X1-AA-A1", symbol: "MOUNT_MINING_LASER_II", kind: "mount", name: "Mining Laser II", category: "mount", purchasePrice: 22000, timestamp: new Date().toISOString() }],
}));

app.get("/api/missions", (_q, r) => r.json({ missions: [{
  kind: "SUPPLY_CONSTRUCTION", targetSystem: "X1-AA", targetWaypoint: "X1-AA-D4", status: "active",
  assignedShip: "AG-3", paused: false,
  materials: [{ tradeSymbol: "ADVANCED_CIRCUITRY", required: 1200, fulfilled: 480 }],
}]}));

// Flattened shape the Ops tab renders — distinct from the nested `terms.*`
// shape /api/state uses, matching what the real /api/contracts handler sends.
app.get("/api/contracts", (_q, r) => r.json({ contracts: [{
  id: "c1", type: "PROCUREMENT", factionSymbol: "COSMIC", accepted: false, fulfilled: false, declined: false,
  deadlineToAccept: new Date(Date.now() + 864e5).toISOString(), deadline: new Date(Date.now() + 2 * 864e5).toISOString(),
  onAccepted: 5000, onFulfilled: 90000,
  deliver: [{ tradeSymbol: "IRON_ORE", destinationSymbol: "X1-AA-A1", unitsRequired: 100, unitsFulfilled: 34 }],
}]}));

app.get("/api/narrative", (_q, r) => r.json({ log: "Quiet shift. The ore holds are filling and nobody has hit anything." }));
app.get("/api/goods", (_q, r) => r.json({ goods: ["IRON_ORE", "COPPER_ORE", "FUEL"] }));
app.get("/api/prices", (_q, r) => r.json({ points: Array.from({ length: 20 }, (_, i) => ({
  t: new Date(Date.now() - (20 - i) * 36e5).toISOString(), avg: 30 + Math.sin(i / 3) * 8, min: 22, max: 44,
}))}));
app.get("/api/loadout", (_q, r) => r.json({ scores: [
  { type: "SHIP_MINING_DRONE", role: "miner", score: 4.2, purchasePrice: 78000, cargoPerCredit: 0.19, fuelCapacity: 0, moduleSlots: 3, mountingPoints: 2, yardSymbol: "X1-AA-A1", reason: "best cargo per credit" },
]}));
app.get("/api/loadout/ga", (_q, r) => r.json({ candidates: [
  { type: "SHIP_LIGHT_HAULER", role: "trader", totalCost: 210000, cargoCapacity: 60, fuelCapacity: 400, score: 7.9 },
]}));
app.get("/api/chat/history", (_q, r) => r.json({ messages: [] }));
app.post("/api/chat", (req, res) => {
  posted.push({ path: "/api/chat", body: req.body });
  res.json({ reply: `mock co-pilot heard: ${req.body?.message ?? ""}` });
});
app.get("/api/systems", (_q, r) => r.json({ systems: ["X1-AA"], connections: [] }));

const posted = [];

// ── synthesis endpoints ──────────────────────────────────────
let doctrine = [
  { key:"cashFloor", name:"Cash floor", description:"Never let the balance fall below this when buying ships or modules.", value:20000, min:0, max:500000, step:5000, unit:"c", enabled:true, enforced:true },
  { key:"marginFloor", name:"Margin floor", description:"Ignore arbitrage routes whose per-unit margin is below this.", value:10, min:0, max:500, step:5, unit:"c", enabled:true, enforced:true },
  { key:"maxLossPct", name:"Loss floor", description:"Refuse to sell cargo below this much loss against its cost basis.", value:15, min:0, max:100, step:5, unit:"%", enabled:true, enforced:true },
  { key:"minerTarget", name:"Mining pressure", description:"Grow the drone fleet until this many miners are active.", value:4, min:0, max:20, step:1, unit:"", enabled:true, enforced:true },
  { key:"promoteAtMiners", name:"Trader promotion", description:"Promote the biggest-hold miner to trader once this many miners exist.", value:4, min:1, max:20, step:1, unit:"", enabled:true, enforced:true },
  { key:"shipBudget", name:"Purchase headroom", description:"Only consider buying a ship when credits exceed the cash floor by this much.", value:30000, min:0, max:500000, step:10000, unit:"c", enabled:false, enforced:true },
];

app.get("/api/bridge", (_q, r) => r.json({
  rate: 18200, prevRate: 15400, forgone: -2300,
  series: [4200, 8100, 6400, 11200, 9800, 14100, 15400, 18200],
  credits: 412500, shipCount: ships.length,
  totals: { sells: 980000, buys: 610000 },
  paused: false,
  earnings: [
    { shipSymbol: "AG-3", earned: 22100, spent: 15990, net: 6110 },
    { shipSymbol: "AG-1", earned: 3240, spent: 0, net: 3240 },
    { shipSymbol: "AG-5", earned: 410, spent: 0, net: 410 },
  ],
  stranded: [{ symbol: "AG-2", waypointSymbol: "X1-AA-E5", fuel: 0, reason: "0 fuel and not at a market" }],
  shipStatus: ships.map((s) => ({ symbol: s.symbol, role: roles[s.symbol], status: s.nav.status, paused: s.symbol === "AG-3" })),
  triage: [
    { id:"stranded:AG-2", severity:1, title:"AG-2 stranded", detail:"0 fuel and not at a market", costPerHour:-1400,
      shipSymbol:"AG-2", engineWillAct:"Fuel tender dispatches automatically",
      actions:[{label:"Refuel now",kind:"refuel",body:{shipSymbol:"AG-2"}},{label:"Take manual control",kind:"hold",body:{shipSymbol:"AG-2"}}] },
    { id:"contract:c1", severity:1, title:"Contract deadline approaching", detail:"IRON_ORE 34/100 with 3.4h left.",
      costPerHour:-900, engineWillAct:null, actions:[] },
    { id:"idle:AG-6", severity:2, title:"AG-6 earning nothing", detail:"No role assigned — this hull has no cargo hold and no mining mount.",
      costPerHour:-410, shipSymbol:"AG-6", engineWillAct:null,
      actions:[{label:"Ship details",kind:"details",body:{shipSymbol:"AG-6"}}] },
    // Deliberately a different cost than AG-6 above — proves the frontend
    // renders per-ship costs rather than one flat number for every
    // "earning nothing" card (a real bug: every idle ship used to get the
    // same fleet-median value regardless of what it normally earns).
    { id:"idle:AG-3", severity:3, title:"AG-3 earning nothing", detail:"Assigned as trader but has not booked a credit in the last hour.",
      costPerHour:-6110, shipSymbol:"AG-3", engineWillAct:"Engine will re-plan on its next tick",
      actions:[{label:"Ship details",kind:"details",body:{shipSymbol:"AG-3"}}] },
  ],
}));

app.get("/api/markets", (_q, r) => r.json({
  routes: [
    { goodSymbol:"CLOTHING", buyAt:"X1-AA-A1", buySystem:"X1-AA", buyPrice:388, sellAt:"X1-AA-C3", sellSystem:"X1-AA", sellPrice:502,
      volume:40, distance:12, fuelUnits:24, fuelCost:1728, marginPerUnit:114, marginPct:29.4, grossPerTrip:4560, profitPerTrip:2832, crossSystem:false, ageMinutes:2 },
    { goodSymbol:"MEDICINE", buyAt:"X1-RK-K12", buySystem:"X1-RK", buyPrice:221, sellAt:"X1-AA-A1", sellSystem:"X1-AA", sellPrice:282,
      volume:48, distance:31, fuelUnits:62, fuelCost:4464, marginPerUnit:61, marginPct:27.6, grossPerTrip:2928, profitPerTrip:1464, crossSystem:true, ageMinutes:134 },
    { goodSymbol:"IRON_ORE", buyAt:"X1-AA-C3", buySystem:"X1-AA", buyPrice:18, sellAt:"X1-AA-A1", sellSystem:"X1-AA", sellPrice:38,
      volume:3, distance:41, fuelUnits:82, fuelCost:5904, marginPerUnit:20, marginPct:111.1, grossPerTrip:60, profitPerTrip:12, crossSystem:false, ageMinutes:6 },
  ],
  snapshots: [
    { systemSymbol:"X1-AA", waypointSymbol:"X1-AA-A1", goodSymbol:"CLOTHING", type:"EXPORT", supply:"HIGH", purchasePrice:388, sellPrice:371, tradeVolume:60, timestamp:new Date().toISOString() },
    { systemSymbol:"X1-AA", waypointSymbol:"X1-AA-A1", goodSymbol:"IRON_ORE", type:"IMPORT", supply:"MODERATE", purchasePrice:42, sellPrice:38, tradeVolume:60, timestamp:new Date().toISOString() },
    { systemSymbol:"X1-AA", waypointSymbol:"X1-AA-C3", goodSymbol:"CLOTHING", type:"IMPORT", supply:"SCARCE", purchasePrice:519, sellPrice:502, tradeVolume:40, timestamp:new Date().toISOString() },
  ],
  shipyards: [{ systemSymbol:"X1-AA", waypointSymbol:"X1-AA-A1", shipType:"SHIP_MINING_DRONE", shipTypeName:"Mining Drone", purchasePrice:78000, fuelCapacity:0, cargoCapacity:15, moduleSlots:3, mountingPoints:2, timestamp:new Date().toISOString() }],
  modules: [{ systemSymbol:"X1-AA", waypointSymbol:"X1-AA-A1", symbol:"MOUNT_MINING_LASER_II", kind:"mount", name:"Mining Laser II", category:"mount", purchasePrice:22000, timestamp:new Date().toISOString() }],
}));

app.get("/api/dispatch", (_q, r) => r.json({
  routes: [
    { good: "IRON_ORE", buyAt: "X1-AA-C3", buySystem: "X1-AA", buyPrice: 18, sellAt: "X1-AA-A1", sellSystem: "X1-AA", sellPrice: 38,
      volume: 3, distance: 41, fuelUnits: 82, fuelCost: 5904, profitPerTrip: 12, ageMinutes: 6 },
  ],
  assignments: [
    { shipSymbol: "AG-1", good: "CLOTHING", role: "direct", buyAt: "X1-AA-A1", sellAt: "X1-AA-C3", buyPrice: 388, sellPrice: 502, profitPerTrip: 2832, source: "auto" },
    { shipSymbol: "AG-3", good: "IRON_ORE", role: "buy", buyAt: "X1-AA-C3", buyPrice: 18, profitPerTrip: 12, source: "auto" },
    { shipSymbol: "AG-4", good: "IRON_ORE", role: "sell", sellAt: "X1-AA-A1", sellPrice: 38, profitPerTrip: 12, source: "manual" },
  ],
}));

let warehouseTargets = [
  { goodSymbol: "IRON_ORE", target: 300, forMission: false },
];

app.get("/api/warehouse", (_q, r) => r.json({
  ship: { shipSymbol: "AG-5", waypointSymbol: "X1-AA-B2" },
  goods: [
    { goodSymbol: "IRON_ORE", units: 120, avgCost: 18, value: 2160 },
    { goodSymbol: "CLOTHING", units: 40, avgCost: 388, value: 15520 },
  ],
  totalValue: 17680,
  ledger: [],
  targets: warehouseTargets,
}));

app.post("/api/warehouse/targets", (req, res) => {
  const { good, target, forMission } = req.body ?? {};
  if (!good || !target || target <= 0) return res.status(400).json({ error: "bad target" });
  warehouseTargets = warehouseTargets.filter((t) => t.goodSymbol !== good);
  warehouseTargets.push({ goodSymbol: good, target, forMission: forMission === true });
  warehouseTargets.sort((a, b) => a.goodSymbol.localeCompare(b.goodSymbol));
  posted.push({ path: "/api/warehouse/targets", body: req.body });
  res.json({ ok: true, targets: warehouseTargets });
});
app.post("/api/warehouse/targets/remove", (req, res) => {
  const { good } = req.body ?? {};
  warehouseTargets = warehouseTargets.filter((t) => t.goodSymbol !== good);
  posted.push({ path: "/api/warehouse/targets/remove", body: req.body });
  res.json({ ok: true, targets: warehouseTargets });
});

app.get("/api/doctrine", (_q, r) => r.json({ rules: doctrine }));
app.post("/api/doctrine", (req, res) => {
  const { key, value, enabled } = req.body ?? {};
  const rule = doctrine.find((d) => d.key === key);
  if (!rule) return res.status(400).json({ error: "unknown rule" });
  if (value !== undefined) rule.value = Math.min(rule.max, Math.max(rule.min, value));
  if (enabled !== undefined) rule.enabled = enabled;
  posted.push({ path: "/api/doctrine", body: req.body });
  res.json({ ok: true, rule, rules: doctrine });
});

app.post("/api/*splat", (req, res) => {
  posted.push({ path: req.path, body: req.body });
  console.log("POST", req.path, JSON.stringify(req.body ?? {}));
  res.json({ ok: true, status: "DOCKED" });
});
app.get("/__posted", (_q, r) => r.json(posted));
app.post("/__reset", (_q, r) => {
  posted.length = 0;
  for (const d of doctrine) {
    const def = { cashFloor:[20000,true], marginFloor:[10,true], maxLossPct:[15,true],
                  minerTarget:[4,true], promoteAtMiners:[4,true], shipBudget:[30000,false] }[d.key];
    if (def) { d.value = def[0]; d.enabled = def[1]; }
  }
  r.json({ ok: true });
});

app.use(express.static(resolve(process.argv[2] ?? "public")));
const PORT = Number(process.env.UI_MOCK_PORT ?? 4173);
app.listen(PORT, () => console.log(`mock command center on http://127.0.0.1:${PORT}`));
