import {
  normalizeRemoteWorkerBudgetGrant,
  remoteWorkerInferenceCanonicalSha256,
  type RemoteWorkerBudgetBalance,
  type RemoteWorkerBudgetGrant,
  type RemoteWorkerBudgetGrantInput,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { RemoteWorkerOperatorAuditPort, RemoteWorkerRegistryStore } from "./remote-workers-route-service.js";

export type RemoteWorkerBudgetOperatorStore = Pick<
  AsyncStorage["remoteWorkerBudgets"],
  "createGrant" | "getGrant" | "listGrants" | "revokeGrant"
>;

/** Operator-only budget administration; reservations never mint their own grants. */
export class RemoteWorkerBudgetOperatorService {
  public constructor(
    private readonly budgets: RemoteWorkerBudgetOperatorStore,
    private readonly registry: RemoteWorkerRegistryStore,
    private readonly audit: RemoteWorkerOperatorAuditPort,
  ) {}

  public async create(input: RemoteWorkerBudgetGrantInput, actorId: string): Promise<RemoteWorkerBudgetGrant> {
    const grant = normalizeRemoteWorkerBudgetGrant(input);
    const worker = await this.registry.findWorkerRegistryEntry(grant.registryWorkspaceId, grant.workerId);
    if (!worker || worker.admission.workerGeneration !== grant.workerGeneration || worker.control) {
      throw new TypeError("Worker budget requires the current admitted worker generation.");
    }
    // Persist the authorization audit first. The immutable grant row is the post-commit receipt.
    await this.audit.append(
      "approvals",
      {
        event: "remote_worker.budget.authorized",
        ...grant,
        actorId,
      },
      { deliveryId: `remote-worker-budget:${remoteWorkerInferenceCanonicalSha256({ grant, actorId })}` },
    );
    return await this.budgets.createGrant(grant, actorId);
  }

  public async list(registryWorkspaceId: string, executionWorkspaceId: string): Promise<RemoteWorkerBudgetBalance[]> {
    return await this.budgets.listGrants(registryWorkspaceId, executionWorkspaceId);
  }

  public async revoke(input: {
    registryWorkspaceId: string;
    grantId: string;
    expectedRevision: number;
    actorId: string;
  }): Promise<RemoteWorkerBudgetGrant> {
    const grant = await this.budgets.getGrant(input.grantId);
    if (!grant || grant.registryWorkspaceId !== input.registryWorkspaceId)
      throw new TypeError("Worker budget scope mismatch.");
    await this.audit.append(
      "approvals",
      {
        event: "remote_worker.budget.revocation_requested",
        ...input,
      },
      { deliveryId: `remote-worker-budget-revoke:${remoteWorkerInferenceCanonicalSha256(input)}` },
    );
    return await this.budgets.revokeGrant(input.grantId, input.expectedRevision);
  }
}
