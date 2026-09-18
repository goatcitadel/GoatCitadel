import { ConflictError, canonicalJsonString, remoteWorkerAssignmentCanonicalSha256 as digest,
  type RemoteWorkerAssignmentDispatchAuthority, type RemoteWorkerAssignmentLeaseRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ApprovalRepository } from "./approval-repo.js";
import { PendingApprovalActionRepository } from "./pending-approval-action-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import type { RemoteWorkerChatResumeRecord } from "./remote-worker-chat-resume-ledger.js";

interface ToolRecoveryMaterial {
  schemaVersion: "goatcitadel.remote-worker-chat-resume-recovery.v1";
  resumeId: string;
  resumeSha256: string;
  recoveryRevision: number;
  priorAuthorityRecordSha256: string;
  priorLeaseRevision: number;
  priorLeaseRequestSha256: string;
  approvalSha256: string;
  pendingActionSha256: string;
  dispatchAuthority: RemoteWorkerAssignmentDispatchAuthority;
}

interface NativeRecoveryMaterial extends Omit<ToolRecoveryMaterial, "schemaVersion" | "pendingActionSha256"> {
  schemaVersion: "goatcitadel.remote-worker-native-runtime-resume-recovery.v1";
  nativeRuntimeBindingSha256: string;
  pendingActionSha256?: never;
}
type RecoveryMaterial = ToolRecoveryMaterial | NativeRecoveryMaterial;

export interface RemoteWorkerChatResumeRecoveryRecord { material: RecoveryMaterial; materialSha256: string }
interface Row { recovery_revision: number; material_json: string; material_sha256: string }

/** Only the assignment repository calls this owner after locking the admitted
 * parent and worker. A recovery records a new claim; it never issues a lease. */
export class RemoteWorkerChatResumeRecoveryLedger {
  constructor(private readonly db: DatabaseClient) {}

  read(recorded: RemoteWorkerChatResumeRecord): RemoteWorkerChatResumeRecoveryRecord | undefined {
    const rows = this.db.prepare(`SELECT recovery_revision, material_json, material_sha256
      FROM remote_worker_chat_resume_recoveries WHERE resume_id = ? ORDER BY recovery_revision DESC LIMIT 2`)
      .all<Row>(recorded.resumeId);
    if (!rows.length) return undefined;
    if (!recorded.binding) throw invalid();
    const records = rows.map(row => {
      const material = JSON.parse(row.material_json) as RecoveryMaterial;
      if (canonicalJsonString(material) !== row.material_json || digest(material) !== row.material_sha256 ||
        (recorded.material.schemaVersion === "goatcitadel.remote-worker-native-runtime-resume.v1"
          ? material.schemaVersion !== "goatcitadel.remote-worker-native-runtime-resume-recovery.v1" ||
            material.nativeRuntimeBindingSha256 !== recorded.material.nativeRuntimeBindingSha256 || Object.hasOwn(material, "pendingActionSha256")
          : material.schemaVersion !== "goatcitadel.remote-worker-chat-resume-recovery.v1" || !/^[a-f0-9]{64}$/.test(material.pendingActionSha256)) ||
        material.resumeId !== recorded.resumeId || material.resumeSha256 !== recorded.materialSha256 ||
        material.approvalSha256 !== recorded.material.approvalSha256 ||
        !/^[a-f0-9]{64}$/.test(material.priorLeaseRequestSha256) ||
        material.recoveryRevision !== Number(row.recovery_revision) ||
        !Number.isSafeInteger(material.priorLeaseRevision) || material.priorLeaseRevision < recorded.material.priorLeaseRevision ||
        material.dispatchAuthority.durableRunId !== recorded.material.durableRunId ||
        material.dispatchAuthority.durableRunAttempt !== recorded.material.durableRunAttempt ||
        material.dispatchAuthority.durableRunVersion <= recorded.material.queuedRunVersion) throw invalid();
      return { material, materialSha256: row.material_sha256 };
    });
    const latest = records[0]!;
    const previous = records[1];
    const priorAuthority = previous?.material.dispatchAuthority ?? recorded.binding;
    if (latest.material.recoveryRevision !== (previous?.material.recoveryRevision ?? 0) + 1 ||
      latest.material.priorAuthorityRecordSha256 !== (previous?.materialSha256 ?? digest(recorded.binding)) ||
      latest.material.dispatchAuthority.durableRunVersion <= priorAuthority.durableRunVersion ||
      latest.material.priorLeaseRevision < (previous?.material.priorLeaseRevision ?? recorded.material.priorLeaseRevision) ||
      latest.material.dispatchAuthority.dispatchOwnerId === priorAuthority.dispatchOwnerId) throw invalid();
    return latest;
  }

  append(recorded: RemoteWorkerChatResumeRecord, authority: RemoteWorkerAssignmentDispatchAuthority,
    lease: RemoteWorkerAssignmentLeaseRecord): void {
    const previous = recorded.binding;
    const handoff = recorded.recovery?.material ?? recorded.material;
    if (!previous || authority.dispatchOwnerId === previous.dispatchOwnerId ||
      authority.durableRunId !== previous.durableRunId || authority.durableRunAttempt !== previous.durableRunAttempt ||
      authority.durableRunVersion <= previous.durableRunVersion || lease.leaseRevision < handoff.priorLeaseRevision)
      throw invalid();
    const unrotated = lease.leaseRevision === handoff.priorLeaseRevision && lease.requestSha256 === handoff.priorLeaseRequestSha256;
    if (!unrotated && (lease.parentDispatchAuthority.dispatchOwnerId !== previous.dispatchOwnerId ||
      lease.parentDispatchAuthority.durableRunAttempt !== previous.durableRunAttempt ||
      lease.parentDispatchAuthority.durableRunVersion < previous.durableRunVersion)) throw invalid();
    const approval = new ApprovalRepository(this.db).get(recorded.material.approvalId);
    if (approval.status === "pending" || digest(approval) !== recorded.material.approvalSha256) throw invalid();
    let requestEvidence: Pick<ToolRecoveryMaterial, "schemaVersion" | "pendingActionSha256"> |
      Pick<NativeRecoveryMaterial, "schemaVersion" | "nativeRuntimeBindingSha256">;
    if (recorded.material.schemaVersion === "goatcitadel.remote-worker-native-runtime-resume.v1") {
      if (approval.kind !== "remote_worker.native_runtime" || approval.status === "edited" ||
          digest(approval.payload.nativeRuntime) !== recorded.material.nativeRuntimeBindingSha256) throw invalid();
      requestEvidence = { schemaVersion: "goatcitadel.remote-worker-native-runtime-resume-recovery.v1",
        nativeRuntimeBindingSha256: recorded.material.nativeRuntimeBindingSha256 };
    } else {
      const pending = new PendingApprovalActionRepository(this.db).find(recorded.material.approvalId);
      if (!pending || pending.actionType !== "tool.invoke") throw invalid();
      // Tool terminal fields can change, but their original request cannot.
      const originalPending = { ...pending };
      if (approval.status === "approved") {
        if (!["pending", "executed", "failed"].includes(pending.resolutionStatus ?? "")) throw invalid();
        originalPending.resolutionStatus = "pending";
        delete originalPending.resolvedAt;
        delete originalPending.result;
      }
      if (digest(originalPending) !== recorded.material.pendingActionSha256) throw invalid();
      requestEvidence = { schemaVersion: "goatcitadel.remote-worker-chat-resume-recovery.v1", pendingActionSha256: digest(pending) };
    }
    const material: RecoveryMaterial = {
      ...requestEvidence, resumeId: recorded.resumeId,
      resumeSha256: recorded.materialSha256, recoveryRevision: (recorded.recovery?.material.recoveryRevision ?? 0) + 1,
      priorAuthorityRecordSha256: recorded.recovery?.materialSha256 ?? digest(previous),
      priorLeaseRevision: lease.leaseRevision, priorLeaseRequestSha256: lease.requestSha256,
      approvalSha256: digest(approval), dispatchAuthority: authority,
    };
    this.db.prepare(`INSERT INTO remote_worker_chat_resume_recoveries
      (resume_id, recovery_revision, material_json, material_sha256, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(recorded.resumeId, material.recoveryRevision, canonicalJsonString(material), digest(material),
        new DurableRunRepository(this.db).readDatabaseNow());
  }
}

function invalid() { return new ConflictError({ message: "Worker Chat resume recovery evidence changed or is incomplete." }); }
