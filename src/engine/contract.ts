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

/** How long a fetched contract list stays good for. Contracts change on the
 *  order of minutes (accept, deliver, fulfill), and every one of those changes
 *  goes through this class, so the cache can be invalidated exactly rather than
 *  waited out. */
const CONTRACT_TTL_MS = 30_000;

/** Manages the agent's contracts: accept, track, deliver, fulfill. */
export class ContractManager {
  /** Contracts the operator declined: never auto-accepted, still listed. */
  private declined = new Set<string>();
  /**
   * The last fetched contract list.
   *
   * Without this, every caller of `listActive()` hit the API — and the
   * coordinator calls it twice per 2s tick (`fulfillCompleted` then
   * `acceptBest`), for the same payload, forever. That alone was 1 req/s of a
   * 2 req/s budget: half the fleet's entire API allowance spent re-reading a
   * list that changes a few times an hour.
   */
  private cache?: { at: number; contracts: Contract[] };

  constructor(private readonly api: SpaceTradersAPI) {}

  /** The raw contract list, served from cache when fresh. */
  private async fetchContracts(): Promise<Contract[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CONTRACT_TTL_MS) return this.cache.contracts;
    const contracts = await this.api.getContracts();
    this.cache = { at: now, contracts };
    return contracts;
  }

  /** Drop the cache after any call that changes contract state server-side. */
  private invalidate(): void {
    this.cache = undefined;
  }

  /** Mark a contract as declined so the fleet never auto-accepts it. */
  decline(contractId: string): void {
    this.declined.add(contractId);
  }

  /** Undo a decline (the contract becomes auto-acceptable again). */
  undecline(contractId: string): void {
    this.declined.delete(contractId);
  }

  isDeclined(contractId: string): boolean {
    return this.declined.has(contractId);
  }

  listDeclined(): string[] {
    return [...this.declined];
  }

  async listActive(): Promise<Contract[]> {
    const all = await this.fetchContracts();
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
    const unaccepted = active.filter((c) => !c.accepted && !this.declined.has(c.id));
    if (unaccepted.length === 0) return undefined;
    unaccepted.sort(
      (a, b) =>
        b.terms.payment.onAccepted +
        b.terms.payment.onFulfilled -
        (a.terms.payment.onAccepted + a.terms.payment.onFulfilled),
    );
    const best = unaccepted[0]!;
    await this.api.acceptContract(best.id);
    this.invalidate();
    return best;
  }

  /** Accept a specific contract by id. */
  async acceptById(contractId: string): Promise<Contract> {
    const active = await this.listActive();
    const contract = active.find((c) => c.id === contractId);
    if (!contract) throw new Error(`contract ${contractId} not found or expired`);
    if (contract.accepted) return contract;
    await this.api.acceptContract(contractId);
    this.invalidate();
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
        this.invalidate();
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
        this.invalidate();
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
        this.invalidate();
      }
    }
  }

  /** Does this agent have any deliverable requiring the given good? */
  async wantsGood(tradeSymbol: string): Promise<boolean> {
    const deliveries = await this.outstandingDeliveries();
    return deliveries.some((d) => d.tradeSymbol === tradeSymbol);
  }
}
