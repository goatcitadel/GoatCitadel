import {
  normalizeRemoteWorkerCellProvisioningPlan, readRemoteWorkerCellProvisioningCheckpoint,
  type RemoteWorkerCellProvisioningPlan, type RemoteWorkerCellProvisioningRecovery,
} from "@goatcitadel/contracts";
import type {
  RemoteWorkerCellKey, RemoteWorkerCellProvisioningRepository, RemoteWorkerCellProvisioningSnapshot,
} from "@goatcitadel/storage";
import type { WorkerCellAssignmentAuthorityPort } from "./remote-worker-cell-service.js";
import type { AwaitableOwnerMethods } from "./remote-worker-owner-port.js";

/** The native driver owns protected-parent custody and OS verification. It must
 * await each exact-record acknowledgement before the next native operation.
 * Recovery verifies recorded objects only and can never create or resume them. */
export interface NativeWorkerCellProvisioningPort {
  create(plan: RemoteWorkerCellProvisioningPlan, commitCheckpoint: (recordHex: string) => Promise<string>): Promise<void>;
  recover(input: RemoteWorkerCellProvisioningRecovery): Promise<readonly string[]>;
}
export interface RemoteWorkerCellProvisioningServiceDeps {
  readonly repository: AwaitableOwnerMethods<RemoteWorkerCellProvisioningRepository, "prepare" | "appendCheckpoint" | "getSnapshot">;
  readonly assignmentAuthority: WorkerCellAssignmentAuthorityPort;
  readonly native: NativeWorkerCellProvisioningPort;
}
export type RemoteWorkerCellProvisioningResult = {
  readonly status: "recorded" | "recovery_verified";
  readonly snapshot: RemoteWorkerCellProvisioningSnapshot;
} | {
  readonly status: "reconciliation_required";
  readonly reason: "no_anchor" | "checkpoint_mismatch" | "incomplete_journal" | "volume_verification_unavailable";
  readonly snapshot: RemoteWorkerCellProvisioningSnapshot;
};
export class RemoteWorkerCellProvisioningInterruptedError extends Error {
  public constructor(cause: unknown) {
    super("Native cell provisioning was interrupted; its retained plan and checkpoints require reconciliation.", { cause });
    this.name = "RemoteWorkerCellProvisioningInterruptedError";
  }
}

/** Coordinates canonical provisioning facts, without marking a platform ready,
 * launching a workload, granting volume privileges, or enabling a backend. */
export class RemoteWorkerCellProvisioningService {
  public constructor(private readonly deps: RemoteWorkerCellProvisioningServiceDeps) {}

  public async provision(
    input: Parameters<RemoteWorkerCellProvisioningRepository["prepare"]>[0],
  ): Promise<RemoteWorkerCellProvisioningResult> {
    const frozen = Object.freeze({ ...input, plan: normalizeRemoteWorkerCellProvisioningPlan(input.plan) });
    const key = keyOf(frozen);
    await this.deps.assignmentAuthority.assertGenerationActive(key);
    const prepared = await this.deps.repository.prepare(frozen);
    // Even an exact duplicate is recovery, never permission to create again.
    if (prepared.disposition === "replayed") return this.reconcile(key);
    let nextSequence = 1;
    let closed = false;
    let pending: Promise<string> | undefined;
    const commitCheckpoint = (recordHex: string): Promise<string> => {
      if (closed || pending) return Promise.reject(new Error("Native provisioning checkpoints must be serial and current."));
      pending = (async () => {
        const checkpoint = readRemoteWorkerCellProvisioningCheckpoint(recordHex);
        if (checkpoint.sequence !== nextSequence) throw new Error("Native provisioning checkpoint order changed.");
        await this.deps.assignmentAuthority.assertGenerationActive(key);
        if (closed) throw new Error("Native provisioning owner has closed.");
        const committed = await this.deps.repository.appendCheckpoint({ ...key,
          provisioningOwner: frozen.provisioningOwner, provisioningLeaseExpiresAt: frozen.provisioningLeaseExpiresAt,
          expectedSequence: nextSequence - 1, recordHex: checkpoint.recordHex });
        if (closed || committed.recordHex !== checkpoint.recordHex) throw new Error("Native provisioning acknowledgement is unavailable.");
        nextSequence++;
        return committed.recordSha256;
      })().finally(() => { pending = undefined; });
      return pending;
    };
    try {
      await this.deps.assignmentAuthority.assertGenerationActive(key);
      await this.deps.native.create(prepared.record.plan, commitCheckpoint);
      closed = true;
      const unfinished = pending;
      if (unfinished) {
        await unfinished.catch(() => undefined);
        throw new Error("Native provisioning returned before its checkpoint acknowledgement.");
      }
      if (nextSequence !== 6) throw new Error("Native provisioning did not record all five checkpoints.");
      const snapshot = await this.deps.repository.getSnapshot(key);
      if (!snapshot || snapshot.plan.planSha256 !== prepared.record.planSha256 || snapshot.checkpoints.length !== 5 || snapshot.volumeCheckpoints.length) {
        throw new Error("Canonical provisioning completion is unavailable.");
      }
      return { status: "recorded", snapshot };
    } catch (error) {
      closed = true;
      // A driver failure cannot leave an unobserved commit running after return.
      const unfinished = pending;
      if (unfinished) await unfinished.catch(() => undefined);
      throw new RemoteWorkerCellProvisioningInterruptedError(error);
    }
  }

  public async reconcile(input: RemoteWorkerCellKey): Promise<RemoteWorkerCellProvisioningResult> {
    const key = keyOf(input);
    await this.deps.assignmentAuthority.assertGenerationActive(key);
    const stored = await this.deps.repository.getSnapshot(key);
    if (!stored) throw new Error("Canonical cell provisioning plan is unavailable.");
    // This native port verifies creation only. Preserve the canonical volume
    // history until a volume-capable native recovery owner can verify it.
    if (stored.volumeCheckpoints.length) return { status: "reconciliation_required", reason: "volume_verification_unavailable", snapshot: stored };
    const snapshot: RemoteWorkerCellProvisioningSnapshot = Object.freeze({
      plan: Object.freeze({ ...stored.plan, plan: normalizeRemoteWorkerCellProvisioningPlan(stored.plan.plan) }),
      checkpoints: Object.freeze(stored.checkpoints.map((record) => readRemoteWorkerCellProvisioningCheckpoint(record.recordHex))),
      volumeCheckpoints: Object.freeze([]),
      formatCheckpoints: Object.freeze([]),
      protectionCheckpoints: Object.freeze([]),
      mountCheckpoints: Object.freeze([]),
      mountedWorkspaceCheckpoints: Object.freeze([]),
    });
    if (!snapshot.checkpoints.length) return { status: "reconciliation_required", reason: "no_anchor", snapshot };
    const returned = await this.deps.native.recover(Object.freeze({
      plan: snapshot.plan.plan, preparedRecordHex: snapshot.checkpoints[0]!.recordHex,
    }));
    if (!Array.isArray(returned) || returned.length !== snapshot.checkpoints.length) {
      return { status: "reconciliation_required", reason: "checkpoint_mismatch", snapshot };
    }
    const observed = Object.freeze([...returned]);
    if (observed.some((record, index) => record !== snapshot.checkpoints[index]?.recordHex)) {
      return { status: "reconciliation_required", reason: "checkpoint_mismatch", snapshot };
    }
    await this.deps.assignmentAuthority.assertGenerationActive(key);
    const current = await this.deps.repository.getSnapshot(key);
    if (current?.volumeCheckpoints.length) return { status: "reconciliation_required", reason: "volume_verification_unavailable", snapshot: current };
    if (!current || current.plan.planSha256 !== snapshot.plan.planSha256 || current.checkpoints.length !== observed.length ||
        current.checkpoints.some((record, index) => record.recordHex !== observed[index])) {
      return { status: "reconciliation_required", reason: "checkpoint_mismatch", snapshot };
    }
    return current.checkpoints.length === 5 ? { status: "recovery_verified", snapshot: current }
      : { status: "reconciliation_required", reason: "incomplete_journal", snapshot: current };
  }
}
function keyOf(input: RemoteWorkerCellKey): RemoteWorkerCellKey {
  return Object.freeze({ registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId,
    assignmentGeneration: input.assignmentGeneration });
}
