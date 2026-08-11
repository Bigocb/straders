import type { SpaceTradersAPI } from "../core/client.js";
import type { components } from "../core/client.js";

export type Contract = components["schemas"]["Contract"];
export type ContractDeliverGood = components["schemas"]["ContractDeliverGood"];

/** Active delivery requirement of a contract. */
export interface Deliverable {
  contractId: string;
  tradeSymbol: string;
  unitsRequired: number;
  unitsFulfilled: number;
  destinationSymbol: string;
  deadline: string;
}

/** Manages the agent's contracts: accept, track, deliver, fulfill. */
export class ContractManager {
  constructor(private readonly api: SpaceTradersAPI) {}

  async listActive(): Promise<Contract[]> {
    const all = await this.api.getContracts();
    const now = Date.now();
    return all.filter((c) => {
      if (c.fulfilled) return false;
      if (c.accepted) return new Date(c.terms.deadline).getTime() > now;
      return !c.deadlineToAccept || new Date(c.deadlineToAccept).getTime() > now;
    });
  }

  /** Accept the most valuable unaccepted contract, if any. */
  async acceptBest(): Promise<Contract | undefined> {
    const active = await this.listActive();
    const unaccepted = active.filter((c) => !c.accepted);
    if (unaccepted.length === 0) return undefined;
    unaccepted.sort(
      (a, b) =>
        b.terms.payment.onAccepted +
        b.terms.payment.onFulfilled -
        (a.terms.payment.onAccepted + a.terms.payment.onFulfilled),
    );
    const best = unaccepted[0]!;
    await this.api.acceptContract(best.id);
    return best;
  }

  /** Accept a specific contract by id. */
  async acceptById(contractId: string): Promise<Contract> {
    const active = await this.listActive();
    const contract = active.find((c) => c.id === contractId);
    if (!contract) throw new Error(`contract ${contractId} not found or expired`);
    if (contract.accepted) return contract;
    await this.api.acceptContract(contractId);
    return { ...contract, accepted: true };
  }

  /** Deliveries still outstanding across all accepted contracts. */
  async outstandingDeliveries(): Promise<Deliverable[]> {
    const accepted = (await this.listActive()).filter((c) => c.accepted);
    const out: Deliverable[] = [];
    for (const c of accepted) {
      for (const d of c.terms.deliver ?? []) {
        if (d.unitsRequired - d.unitsFulfilled > 0) {
          out.push({
            contractId: c.id,
            tradeSymbol: d.tradeSymbol,
            unitsRequired: d.unitsRequired,
            unitsFulfilled: d.unitsFulfilled,
            destinationSymbol: d.destinationSymbol,
            deadline: c.terms.deadline,
          });
        }
      }
    }
    return out;
  }

  /** Deliver cargo from a ship at a destination to any outstanding contract. */
  async deliverFromShip(shipSymbol: string): Promise<void> {
    const deliveries = await this.outstandingDeliveries();
    for (const d of deliveries) {
      try {
        await this.api.deliverContract(d.contractId, shipSymbol, d.tradeSymbol, d.unitsRequired - d.unitsFulfilled);
      } catch {
        // ship may not carry this good; skip
      }
    }
  }

  /**
   * Route a ship that holds contract goods: navigate to the delivery target
   * and deliver everything it can.
   * Returns: `true` if delivered, a destination symbol to fly to, or falsy if nothing to do.
   */
  async deliverVia(ship: components["schemas"]["Ship"]): Promise<true | string | null> {
    const deliveries = await this.outstandingDeliveries();
    const carried = new Set<string>(ship.cargo.inventory.map((i) => i.symbol));
    const relevant = deliveries.filter((d) => carried.has(d.tradeSymbol));
    if (relevant.length === 0) return null;

    for (const d of relevant) {
      if (ship.nav.waypointSymbol !== d.destinationSymbol) {
        return d.destinationSymbol;
      }
    }
    // We're at the destination: deliver as much as we carry.
    const cargo = await this.api.getShipCargo(ship.symbol);
    for (const item of cargo.inventory) {
      const del = deliveries.find((d) => d.tradeSymbol === item.symbol);
      if (!del) continue;
      const toDeliver = Math.min(item.units, del.unitsRequired - del.unitsFulfilled);
      if (toDeliver > 0) {
        await this.api.deliverContract(del.contractId, ship.symbol, item.symbol, toDeliver);
      }
    }
    return true;
  }

  /** Fulfill any accepted contracts that are complete. */
  async fulfillCompleted(): Promise<void> {
    const accepted = (await this.listActive()).filter((c) => c.accepted);
    for (const c of accepted) {
      const done = (c.terms.deliver ?? []).every((d) => d.unitsFulfilled >= d.unitsRequired);
      if (done) {
        await this.api.fulfillContract(c.id);
      }
    }
  }

  /** Does this agent have any deliverable requiring the given good? */
  async wantsGood(tradeSymbol: string): Promise<boolean> {
    const deliveries = await this.outstandingDeliveries();
    return deliveries.some((d) => d.tradeSymbol === tradeSymbol);
  }
}
