import type { components } from "../core/client.js";

export type ShipyardShip = components["schemas"]["ShipyardShip"];
export type ShipModule = components["schemas"]["ShipModule"];
export type ShipMount = components["schemas"]["ShipMount"];

export interface ModuleCatalogItem {
  symbol: ShipModule["symbol"];
  name: string;
  price: number;
  slots: number;
  cargo?: number;
  fuel?: number;
  range?: number;
}

export interface MountCatalogItem {
  symbol: ShipMount["symbol"];
  name: string;
  price: number;
  strength?: number;
  mining?: boolean;
}

/** Static catalog of modules and mounts available for outfitting.
 *  In a full implementation this would be fetched from shipyards / markets. */
export const MODULE_CATALOG: ModuleCatalogItem[] = [
  { symbol: "MODULE_CARGO_HOLD_I", name: "Cargo Hold I", price: 4_000, slots: 1, cargo: 30 },
  { symbol: "MODULE_CARGO_HOLD_II", name: "Cargo Hold II", price: 12_000, slots: 2, cargo: 60 },
  { symbol: "MODULE_CARGO_HOLD_III", name: "Cargo Hold III", price: 30_000, slots: 3, cargo: 90 },
  { symbol: "MODULE_FUEL_REFINERY_I", name: "Fuel Refinery", price: 6_000, slots: 1, fuel: 50 },
  { symbol: "MODULE_JUMP_DRIVE_I", name: "Jump Drive I", price: 20_000, slots: 1, range: 200 },
  { symbol: "MODULE_MINERAL_PROCESSOR_I", name: "Mineral Processor", price: 7_000, slots: 1 },
  { symbol: "MODULE_CREW_QUARTERS_I", name: "Crew Quarters", price: 1_800, slots: 1 },
];

export const MOUNT_CATALOG: MountCatalogItem[] = [
  { symbol: "MOUNT_MINING_LASER_I", name: "Mining Laser I", price: 2_500, strength: 10, mining: true },
  { symbol: "MOUNT_MINING_LASER_II", name: "Mining Laser II", price: 7_000, strength: 20, mining: true },
  { symbol: "MOUNT_MINING_LASER_III", name: "Mining Laser III", price: 18_000, strength: 35, mining: true },
  { symbol: "MOUNT_SURVEYOR_I", name: "Surveyor I", price: 1_500, strength: 5 },
  { symbol: "MOUNT_SENSOR_ARRAY_I", name: "Sensor Array I", price: 2_000, strength: 5 },
];

export interface LoadoutGenome {
  baseShip: ShipyardShip;
  modules: ModuleCatalogItem[];
  mounts: MountCatalogItem[];
}

export interface LoadoutScore {
  type: string;
  role: "miner" | "trader" | "probe";
  totalCost: number;
  cargoCapacity: number;
  fuelCapacity: number;
  speed: number;
  moduleSlotsUsed: number;
  mountingPointsUsed: number;
  miningStrength: number;
  score: number;
  fitness: {
    cargoPerCredit: number;
    fuelPerCredit: number;
    profitEstimate: number;
  };
  modules: string[];
  mounts: string[];
  reason: string;
}

function baseCargo(ship: ShipyardShip): number {
  return ship.modules.reduce((sum, m) => sum + ((m.capacity ?? 0) as number), 0);
}

function totalCargo(g: LoadoutGenome): number {
  return baseCargo(g.baseShip) + g.modules.reduce((sum, m) => sum + (m.cargo ?? 0), 0);
}

function totalFuel(ship: ShipyardShip, modules: ModuleCatalogItem[]): number {
  return (ship.frame?.fuelCapacity ?? 0) + modules.reduce((sum, m) => sum + (m.fuel ?? 0), 0);
}

function totalCost(g: LoadoutGenome): number {
  return (
    g.baseShip.purchasePrice +
    g.modules.reduce((sum, m) => sum + m.price, 0) +
    g.mounts.reduce((sum, m) => sum + m.price, 0)
  );
}

function miningStrength(mounts: MountCatalogItem[]): number {
  return mounts.filter((m) => m.mining).reduce((sum, m) => sum + (m.strength ?? 0), 0);
}

function hasMiningLaser(mounts: MountCatalogItem[]): boolean {
  return mounts.some((m) => m.mining);
}

/** Multi-objective fitness: cargo, fuel range, and estimated arbitrage profit per credit. */
function evaluate(g: LoadoutGenome, avgTradeMargin: number, avgTripFuel: number): LoadoutScore {
  const cost = totalCost(g);
  const cargo = totalCargo(g);
  const fuel = totalFuel(g.baseShip, g.modules);
  const speed = g.baseShip.engine.speed;
  const mining = miningStrength(g.mounts);
  const isMiner = hasMiningLaser(g.mounts);
  const isTrader = cargo >= 40;

  const cargoPerCredit = cargo / cost;
  const fuelPerCredit = fuel / cost;
  // Estimated profit per tick = cargo * margin per unit - fuel cost for one typical trip.
  const fuelCost = avgTripFuel * 5; // rough fuel price
  const profitEstimate = Math.max(0, cargo * avgTradeMargin - fuelCost);

  let score = cargoPerCredit * 1000 + fuelPerCredit * 200 + (profitEstimate / cost) * 500;
  let role: LoadoutScore["role"] = "probe";
  let reason = "balanced utility";

  if (isMiner) {
    role = "miner";
    score = cargoPerCredit * 600 + fuelPerCredit * 400 + mining * 50 + (profitEstimate / cost) * 300;
    reason = `mining loadout: ${mining} laser strength`;
  } else if (isTrader) {
    role = "trader";
    score = cargoPerCredit * 1500 + speed * 5 + (profitEstimate / cost) * 800;
    reason = `hauling loadout: ${cargo} cargo capacity`;
  }

  return {
    type: g.baseShip.type,
    role,
    totalCost: cost,
    cargoCapacity: cargo,
    fuelCapacity: fuel,
    speed,
    moduleSlotsUsed: g.modules.reduce((sum, m) => sum + m.slots, 0),
    mountingPointsUsed: g.mounts.length,
    miningStrength: mining,
    score: Math.round(score * 100) / 100,
    fitness: {
      cargoPerCredit: Math.round(cargoPerCredit * 10000) / 10,
      fuelPerCredit: Math.round(fuelPerCredit * 10000) / 10,
      profitEstimate: Math.round(profitEstimate),
    },
    modules: g.modules.map((m) => m.symbol),
    mounts: g.mounts.map((m) => m.symbol),
    reason,
  };
}

function randomModule(): ModuleCatalogItem {
  return MODULE_CATALOG[Math.floor(Math.random() * MODULE_CATALOG.length)]!;
}

function randomMount(): MountCatalogItem {
  return MOUNT_CATALOG[Math.floor(Math.random() * MOUNT_CATALOG.length)]!;
}

function randomGenome(baseShip: ShipyardShip): LoadoutGenome {
  const maxModules = baseShip.frame.moduleSlots ?? 0;
  const maxMounts = baseShip.frame.mountingPoints ?? 0;
  const modules: ModuleCatalogItem[] = [];
  let slots = 0;
  while (slots < maxModules) {
    const m = randomModule();
    if (slots + m.slots <= maxModules) {
      modules.push(m);
      slots += m.slots;
    } else break;
  }
  const mounts: MountCatalogItem[] = [];
  while (mounts.length < maxMounts) {
    mounts.push(randomMount());
  }
  return { baseShip, modules, mounts };
}

function mutate(g: LoadoutGenome): LoadoutGenome {
  const maxModules = g.baseShip.frame.moduleSlots ?? 0;
  const maxMounts = g.baseShip.frame.mountingPoints ?? 0;
  const modules = [...g.modules];
  const mounts = [...g.mounts];
  if (Math.random() < 0.5 && modules.length > 0) {
    modules.splice(Math.floor(Math.random() * modules.length), 1);
  }
  if (Math.random() < 0.5) {
    let slots = modules.reduce((sum, m) => sum + m.slots, 0);
    const m = randomModule();
    if (slots + m.slots <= maxModules) modules.push(m);
  }
  if (Math.random() < 0.5 && mounts.length > 0) {
    mounts.splice(Math.floor(Math.random() * mounts.length), 1);
  }
  if (Math.random() < 0.5) {
    const m = randomMount();
    if (mounts.length < maxMounts) mounts.push(m);
  }
  return { baseShip: g.baseShip, modules, mounts };
}

function crossover(a: LoadoutGenome, b: LoadoutGenome): LoadoutGenome {
  return {
    baseShip: a.baseShip,
    modules: Math.random() < 0.5 ? a.modules : b.modules,
    mounts: Math.random() < 0.5 ? a.mounts : b.mounts,
  };
}

/** Run a genetic algorithm over ship + module + mount combinations.
 *  avgTradeMargin and avgTripFuel are rough constants from observed market data. */
export function optimizeLoadouts(
  baseShips: ShipyardShip[],
  budget: number,
  options: { population?: number; generations?: number; avgTradeMargin?: number; avgTripFuel?: number } = {},
): LoadoutScore[] {
  const populationSize = options.population ?? 40;
  const generations = options.generations ?? 30;
  const avgTradeMargin = options.avgTradeMargin ?? 25;
  const avgTripFuel = options.avgTripFuel ?? 30;

    const available = baseShips.filter((s) => s.purchasePrice > 0 && s.purchasePrice <= budget);
    if (available.length === 0) return [];

    let population: LoadoutGenome[] = [];
    for (let i = 0; i < populationSize; i++) {
        const ship = available[Math.floor(Math.random() * available.length)]!;
        population.push(randomGenome(ship));
    }

    for (let gen = 0; gen < generations; gen++) {
        const scored = population.map((g) => ({ g, score: evaluate(g, avgTradeMargin, avgTripFuel).score }));
        scored.sort((a, b) => b.score - a.score);
        const survivors = scored.slice(0, Math.ceil(populationSize / 2)).map((s) => s.g);
        const next: LoadoutGenome[] = [...survivors];
        let attempts = 0;
        while (next.length < populationSize && attempts < populationSize * 200) {
            attempts += 1;
            const parentA = survivors[Math.floor(Math.random() * survivors.length)]!;
            const parentB = survivors[Math.floor(Math.random() * survivors.length)]!;
            let child = crossover(parentA, parentB);
            if (Math.random() < 0.3) child = mutate(child);
            // Keep within budget.
            if (totalCost(child) <= budget) next.push(child);
        }
        if (next.length === 0) break;
        population = next;
    }

  const results = population.map((g) => evaluate(g, avgTradeMargin, avgTripFuel));
  results.sort((a, b) => b.score - a.score);

  // Deduplicate by type+modules+mounts.
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.type}|${r.modules.sort().join(",")}|${r.mounts.sort().join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
