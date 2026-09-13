import {
  canonicalJsonString,
  evaluateRemoteWorkerCellCapacityPressure,
  normalizeRemoteWorkerCellCapacityFootprint,
  normalizeRemoteWorkerCellCapacityReservation,
  remoteWorkerCellCapacityFootprintSha256,
  remoteWorkerCellCapacityFootprintTotalBytes,
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
  /** Expected immutable reservation; the caller cannot replace the stored limits. */
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
    // Retain the observation before any asynchronous authority/repository call.
    const observation = Object.freeze({
      ...input,
      footprint: normalizeRemoteWorkerCellCapacityFootprint(input.footprint),
      reservation: normalizeRemoteWorkerCellCapacityReservation(input.reservation),
    });
    const key = keyOf(observation);
    await this.deps.assignmentAuthority.assertGenerationActive(key);
    const existing = await this.deps.repository.getCell(key);
    if (!existing) throw new Error("Remote worker cell not found for capacity admission.");
    if (canonicalJsonString(observation.reservation) !== canonicalJsonString(existing.capacity)) {
      throw new Error("Remote worker cell immutable capacity reservation differs from the observation.");
    }
    // These are absolute observed footprints, not deltas. A repeated scan must
    // neither add retained bytes twice nor erase unreconciled canonical bytes.
    const footprint = normalizeRemoteWorkerCellCapacityFootprint({
      ...observation.footprint,
      failedCleanupBytes: Math.max(observation.footprint.failedCleanupBytes, existing.failedCleanupRetainedBytes),
      quarantineEvidenceBytes: Math.max(
        observation.footprint.quarantineEvidenceBytes,
        existing.quarantineRetainedBytes,
      ),
    });
    const pressure = evaluateRemoteWorkerCellCapacityPressure({
      footprint,
      reservation: existing.capacity,
      incomingBytes: observation.incomingBytes,
    });
    const footprintSha256 = remoteWorkerCellCapacityFootprintSha256(footprint);
    if (pressure.decision === "reject") {
      // Reject new work; canonical state and evidence are untouched.
      return { decision: "reject", reason: pressure.reason, cell: existing };
    }
    await this.deps.assignmentAuthority.assertGenerationActive(key);
    const cell = await this.deps.repository.recordCapacityHighWater({
      ...key,
      expectedCapacityRevision: existing.capacityRevision,
      expectedCleanupRevision: existing.cleanupRevision,
      footprint,
      peakDiskBytes: Math.max(observation.peakDiskBytes, remoteWorkerCellCapacityFootprintTotalBytes(footprint)),
      peakMemoryBytes: observation.peakMemoryBytes,
      peakFileCount: observation.peakFileCount,
      peakProcessCount: observation.peakProcessCount,
      rawOutputBytes: observation.rawOutputBytes,
      failedCleanupRetainedBytes: footprint.failedCleanupBytes,
      quarantineRetainedBytes: footprint.quarantineEvidenceBytes,
      detailSha256: footprintSha256,
      now: observation.now,
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
