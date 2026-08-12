import type { components } from "../core/client.js";

export type ShipyardShip = components["schemas"]["ShipyardShip"];

export interface ShipScore {
  type: string;
  frameSymbol: string;
  purchasePrice: number;
  yardSymbol: string;
  score: number;
  cargoPerCredit: number;
  fuelCapacity: number;
  moduleSlots: number;
  mountingPoints: number;
  role: "miner" | "trader" | "probe";
  reason: string;
}

function shipCargoCapacity(ship: ShipyardShip): number {
  // Cargo modules add 30 units each; base frame has no cargo. Sum module cargo slots.
  const moduleCargo = ship.modules.reduce((sum, m) => sum + ((m.capacity ?? 0) as number), 0);
  return moduleCargo;
}

/** Score available ships at shipyards by utility per credit spent.
 *  Heavier weight on cargo capacity for haulers, fuel + mounts for miners. */
export function scoreShips(
  ships: { ship: ShipyardShip; yardSymbol: string }[],
  budget: number,
): ShipScore[] {
  const scored = ships
    .filter((s) => s.ship.purchasePrice > 0 && s.ship.purchasePrice <= budget)
    .map((s) => {
      const cargo = shipCargoCapacity(s.ship);
      const fuel = s.ship.frame.fuelCapacity;
      const speed = s.ship.engine.speed;
      const price = s.ship.purchasePrice;
      const type = s.ship.type;
      const cargoPerCredit = cargo / price;
      const moduleSlots = s.ship.frame.moduleSlots;
      const mountingPoints = s.ship.frame.mountingPoints;

      let role: ShipScore["role"] = "probe";
      let score = cargoPerCredit * 1000 + (fuel / price) * 50;
      let reason = "general utility";

      if (type.includes("MINING")) {
        role = "miner";
        score = cargoPerCredit * 600 + (fuel / price) * 200 + mountingPoints * 15 + speed;
        reason = "mining: values fuel range, mount points, and cargo";
      } else if (type.includes("HAULER") || cargo >= 40) {
        role = "trader";
        score = cargoPerCredit * 1500 + speed * 5 + moduleSlots * 2;
        reason = "hauling: maximizes cargo per credit";
      }

      return {
        type,
        frameSymbol: s.ship.frame.symbol,
        purchasePrice: price,
        yardSymbol: s.yardSymbol,
        score: Math.round(score * 100) / 100,
        cargoPerCredit: Math.round(cargoPerCredit * 10000) / 10,
        fuelCapacity: fuel,
        moduleSlots,
        mountingPoints,
        role,
        reason,
      };
    });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
