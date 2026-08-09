import {
  evaluateRemoteWorkerCellCapacityPressure,
  remoteWorkerCellCapacityFootprintSha256,
  type RemoteWorkerCellCapacityFootprint,
  type RemoteWorkerCellCapacityPressureDecision,
  type RemoteWorkerCellCapacityReservation,
} from "@goatcitadel/contracts";
import {
  assertWorkerCellEgressAllowed,
  type CanonicalEgressAuthority,
  type WorkerCellEgressConfig,
} from "@goatcitadel/policy-engine";
import type {
  RemoteWorkerCellKey,
  RemoteWorkerCellProfileInput,
  RemoteWorkerCellProfileOutcome,
  RemoteWorkerCellRecord,
  RemoteWorkerCellRepository,
} from "@goatcitadel/storage";
import type { Awaitable, AwaitableOwnerMethods } from "./remote-worker-owner-port.js";

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

type RemoteWorkerCellRepositoryMethod = "profileOrReplay" | "getCell" | "recordCapacityHighWater";

export type RemoteWorkerCellRepositoryPort = AwaitableOwnerMethods<
  RemoteWorkerCellRepository,
  RemoteWorkerCellRepositoryMethod
>;

export interface RemoteWorkerCellServiceDeps {
  readonly repository: RemoteWorkerCellRepositoryPort;
  readonly assignmentAuthority: WorkerCellAssignmentAuthorityPort;
}

export interface WorkerCellCapacityAdmissionInput extends RemoteWorkerCellKey {
  readonly footprint: RemoteWorkerCellCapacityFootprint;
  readonly reservation: RemoteWorkerCellCapacityReservation;
  readonly incomingBytes: number;
  readonly peakDiskBytes: number;
  readonly peakMemoryBytes: number;
  readonly peakFileCount: number;
  readonly peakProcessCount: number;
  readonly rawOutputBytes: number;
  readonly now: string;
}

export interface WorkerCellCapacityAdmissionResult {
  readonly decision: RemoteWorkerCellCapacityPressureDecision;
  readonly reason: string;
  readonly cell: RemoteWorkerCellRecord;
}

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

  /**
   * Boundary 7: evaluate resource pressure and record the high-water truth. An
   * accept records the footprint; a reject leaves canonical state untouched; a
   * quarantine counts the unrecoverable bytes. No branch ever deletes canonical
   * state or evidence to improve a metric.
   */
  public async evaluateCapacityAdmission(
    input: WorkerCellCapacityAdmissionInput,
  ): Promise<WorkerCellCapacityAdmissionResult> {
    const key = keyOf(input);
    const existing = await this.deps.repository.getCell(key);
    if (!existing) throw new Error("Remote worker cell not found for capacity admission.");
    const pressure = evaluateRemoteWorkerCellCapacityPressure({
      footprint: input.footprint,
      reservation: input.reservation,
      incomingBytes: input.incomingBytes,
    });
    const footprintSha256 = remoteWorkerCellCapacityFootprintSha256(input.footprint);
    if (pressure.decision === "reject") {
      // Reject new work; canonical state and evidence are untouched.
      return { decision: "reject", reason: pressure.reason, cell: existing };
    }
    const quarantineBytes =
      pressure.decision === "quarantine"
        ? existing.quarantineRetainedBytes + input.footprint.quarantineEvidenceBytes
        : existing.quarantineRetainedBytes;
    const cell = await this.deps.repository.recordCapacityHighWater({
      ...key,
      footprint: input.footprint,
      peakDiskBytes: input.peakDiskBytes,
      peakMemoryBytes: input.peakMemoryBytes,
      peakFileCount: input.peakFileCount,
      peakProcessCount: input.peakProcessCount,
      rawOutputBytes: input.rawOutputBytes,
      failedCleanupRetainedBytes: existing.failedCleanupRetainedBytes + input.footprint.failedCleanupBytes,
      quarantineRetainedBytes: quarantineBytes,
      detailSha256: footprintSha256,
      now: input.now,
    });
    return { decision: pressure.decision, reason: pressure.reason, cell };
  }

  /** Kernel-isolated egress: only a policy-admitted exact authority is permitted. */
  public assertWorkerEgressAllowed(target: string, config: WorkerCellEgressConfig): CanonicalEgressAuthority {
    return assertWorkerCellEgressAllowed(target, config);
  }
}

function keyOf(value: RemoteWorkerCellKey): RemoteWorkerCellKey {
  return {
    registryWorkspaceId: value.registryWorkspaceId,
    assignmentId: value.assignmentId,
    assignmentGeneration: value.assignmentGeneration,
  };
}
