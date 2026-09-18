import type { RemoteWorkerCellCapacityExchange, RemoteWorkerCellObjectInventoryExchange } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerCellObjectInventoryPagesStore, type RemoteWorkerCellObjectInventoryPageAssignmentInput } from "./remote-worker-cell-object-inventory-pages-store.js";
export type { RemoteWorkerCellObjectInventoryPageAssignmentInput } from "./remote-worker-cell-object-inventory-pages-store.js";
import { RemoteWorkerCellCapacityStore, type RemoteWorkerCellCapacityAssignmentInput, type RemoteWorkerCellObjectInventoryAssignmentInput } from "./remote-worker-cell-capacity-store.js";
export type { RemoteWorkerCellCapacityAssignmentInput, RemoteWorkerCellObjectInventoryAssignmentInput } from "./remote-worker-cell-capacity-store.js";

/** Separate mounted-tree stream with shared transactional assignment and cell fences. */
export class RemoteWorkerCellCapacityRepository {
  private readonly store: RemoteWorkerCellCapacityStore;
  private readonly pages: RemoteWorkerCellObjectInventoryPagesStore;
  public constructor(db: DatabaseClient) { this.store = new RemoteWorkerCellCapacityStore(db); this.pages = new RemoteWorkerCellObjectInventoryPagesStore(db); }
  public exchangeInventoryPageWithAssignment(input: RemoteWorkerCellObjectInventoryPageAssignmentInput) { return this.pages.exchange(input); }
  public exchangeWithAssignment(input: RemoteWorkerCellCapacityAssignmentInput): RemoteWorkerCellCapacityExchange {
    return this.store.exchange(input, "mounted");
  }
  public exchangeInventoryWithAssignment(input: RemoteWorkerCellObjectInventoryAssignmentInput): RemoteWorkerCellObjectInventoryExchange {
    return this.store.exchange(input, "inventory");
  }
}
