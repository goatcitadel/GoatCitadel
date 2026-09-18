import {
  assertWorkerCellEgressAllowed,
  type CanonicalEgressAuthority,
  type WorkerCellEgressConfig,
} from "@goatcitadel/policy-engine";
import {
  snapshotRemoteWorkerCellCapacityAdmission,
  snapshotRemoteWorkerCellCapacityAuthority,
  type RemoteWorkerCellCapacityInventoryAdmissionInput,
  type RemoteWorkerCellCapacityInventoryRecord,
  type RemoteWorkerCellCapacityAdmissionInput,
  type RemoteWorkerCellCapacityAdmissionResult,
  type RemoteWorkerCellCapacityAdmissionRepository,
  type RemoteWorkerCellCapacityAuthority,
  type RemoteWorkerCellKey,
  type RemoteWorkerCellProfileInput,
  type RemoteWorkerCellProfileOutcome,
  type RemoteWorkerCellRecord,
  type RemoteWorkerCellRepository,
} from "@goatcitadel/storage";
import type { Awaitable, AwaitableOwnerMethods } from "./remote-worker-owner-port.js";
import { admitWorkerCellInventory, readWorkerCellInventory } from "./remote-worker-cell-inventory-service.js";

/**
 * HX-505 remote-worker cell service (production-dark).
 *
 * The thin orchestrator that composes committed assignment authority, the cell
 * state owner, the capacity-pressure contract, and the kernel-isolated egress
 * policy through INJECTED dependencies only. It never touches the Gateway
 * composition root, routes, startup, or Ops. Every port is mandatory with no
 * permissive default; resource pressure REJECTS or QUARANTINES new work and
 * never deletes live canonical state or evidence to improve a metric.
 */

export interface WorkerCellAssignmentAuthorityPort {
  /** Throws unless the assignment generation is a committed, active authority. */
  assertGenerationActive(key: RemoteWorkerCellKey): Awaitable<void>;
}

type RemoteWorkerCellRepositoryMethod = "profileOrReplay";

export type RemoteWorkerCellRepositoryPort = AwaitableOwnerMethods<
  RemoteWorkerCellRepository,
  RemoteWorkerCellRepositoryMethod
>;

export interface RemoteWorkerCellServiceDeps {
  readonly repository: RemoteWorkerCellRepositoryPort;
  readonly assignmentAuthority: WorkerCellAssignmentAuthorityPort;
  readonly capacityAdmission: AwaitableOwnerMethods<RemoteWorkerCellCapacityAdmissionRepository, "admit" | "readForAssignment" | "admitInventory" | "readInventory">;
}

export type WorkerCellCapacityAdmissionInput = RemoteWorkerCellCapacityAdmissionInput;
export type WorkerCellCapacityAdmissionResult = RemoteWorkerCellCapacityAdmissionResult;

export class RemoteWorkerCellService {
  public constructor(private readonly deps: RemoteWorkerCellServiceDeps) {}

  /** Boundary 2: only a committed, active assignment generation may seat an immutable cell. */
  public async profileCell(input: RemoteWorkerCellProfileInput): Promise<RemoteWorkerCellProfileOutcome> {
    await this.deps.assignmentAuthority.assertGenerationActive({
      registryWorkspaceId: input.profile.registryWorkspaceId,
      assignmentId: input.profile.assignmentId,
      assignmentGeneration: input.profile.assignmentGeneration,
    });
    return await this.deps.repository.profileOrReplay(input);
  }

  public async readCapacitySnapshot(input: RemoteWorkerCellCapacityAuthority): Promise<RemoteWorkerCellRecord> {
    return await this.deps.capacityAdmission.readForAssignment(snapshotRemoteWorkerCellCapacityAuthority(input));
  }

  /** Boundary 7: the protected storage owner evaluates and records admission in
   * one transaction. A preflight callback cannot substitute for that authority. */
  public async evaluateCapacityAdmission(
    input: WorkerCellCapacityAdmissionInput,
  ): Promise<WorkerCellCapacityAdmissionResult> {
    return await this.deps.capacityAdmission.admit(snapshotRemoteWorkerCellCapacityAdmission(input));
  }

  /** Complete declared inventory uses the same protected transaction owner. */
  public async admitCapacityInventory(input: RemoteWorkerCellCapacityInventoryAdmissionInput): Promise<WorkerCellCapacityAdmissionResult> {
    return await admitWorkerCellInventory(this.deps, input);
  }

  public async readCapacityInventory(input: RemoteWorkerCellCapacityAuthority & { readonly capacityRevision: number }): Promise<RemoteWorkerCellCapacityInventoryRecord | null> {
    return await readWorkerCellInventory(this.deps, input);
  }

  /** Kernel-isolated egress: only a policy-admitted exact authority is permitted. */
  public assertWorkerEgressAllowed(target: string, config: WorkerCellEgressConfig): CanonicalEgressAuthority {
    return assertWorkerCellEgressAllowed(target, config);
  }
}
