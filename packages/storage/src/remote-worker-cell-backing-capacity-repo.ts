import type { RemoteWorkerCellBackingCapacityExchange } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerCellCapacityStore, type RemoteWorkerCellBackingCapacityAssignmentInput } from "./remote-worker-cell-capacity-store.js";
export type { RemoteWorkerCellBackingCapacityAssignmentInput } from "./remote-worker-cell-capacity-store.js";

/** Separate host VHDX/journal stream with shared transactional assignment and cell fences. */
export class RemoteWorkerCellBackingCapacityRepository {
  private readonly store: RemoteWorkerCellCapacityStore;
  public constructor(db: DatabaseClient) { this.store = new RemoteWorkerCellCapacityStore(db); }
  public exchangeWithAssignment(input: RemoteWorkerCellBackingCapacityAssignmentInput): RemoteWorkerCellBackingCapacityExchange {
    return this.store.exchange(input, "backing");
  }
}
