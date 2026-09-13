import { ConflictError, canonicalJsonString, remoteWorkerAssignmentCanonicalSha256 as digest,
  type RemoteWorkerAssignmentRecord, type RemoteWorkerAssignmentGenerationRecord,
  type RemoteWorkerAssignmentDispatchAuthority, type RemoteWorkerAssignmentLeaseRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";

export interface RemoteWorkerChatParentRecoveryMaterial {
  schemaVersion: "goatcitadel.remote-worker-chat-parent-recovery.v1";
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  assignmentManifestSha256: string;
  originalDispatchAuthoritySha256: string;
  payloadSha256: string;
  recoveryRevision: number;
  priorAuthorityRecordSha256: string;
  priorLeaseRevision: number;
  priorLeaseRequestSha256: string;
  dispatchAuthority: RemoteWorkerAssignmentDispatchAuthority;
}
export interface RemoteWorkerChatParentRecoveryRecord {
  material: RemoteWorkerChatParentRecoveryMaterial;
  materialSha256: string;
}
interface Row { recovery_revision: number; material_json: string; material_sha256: string }

/** Internal ledger called under the assignment owner's canonical lock order.
 * It records a parent handoff and cannot authenticate a worker or issue a lease. */
export class RemoteWorkerChatParentRecoveryLedger {
  constructor(private readonly db: DatabaseClient) {}

  readLatest(assignment: RemoteWorkerAssignmentRecord, generation: RemoteWorkerAssignmentGenerationRecord):
    RemoteWorkerChatParentRecoveryRecord | undefined {
    const rows = this.db.prepare(`SELECT recovery_revision, material_json, material_sha256
      FROM remote_worker_chat_parent_recoveries WHERE registry_workspace_id = ? AND assignment_id = ?
      AND assignment_generation = ? ORDER BY recovery_revision DESC LIMIT 2`)
      .all<Row>(assignment.registryWorkspaceId, assignment.assignmentId, generation.assignmentGeneration);
    if (!rows.length) return undefined;
    const records = rows.map(row => {
      const material = JSON.parse(row.material_json) as RemoteWorkerChatParentRecoveryMaterial;
      if (canonicalJsonString(material) !== row.material_json || digest(material) !== row.material_sha256 ||
        material.schemaVersion !== "goatcitadel.remote-worker-chat-parent-recovery.v1" ||
        material.registryWorkspaceId !== assignment.registryWorkspaceId || material.assignmentId !== assignment.assignmentId ||
        material.assignmentGeneration !== generation.assignmentGeneration || material.assignmentManifestSha256 !== assignment.manifestSha256 ||
        material.originalDispatchAuthoritySha256 !== generation.dispatchAuthoritySha256 ||
        material.recoveryRevision !== Number(row.recovery_revision) ||
        !/^[a-f0-9]{64}$/.test(material.payloadSha256) || !/^[a-f0-9]{64}$/.test(material.priorLeaseRequestSha256) ||
        !Number.isSafeInteger(material.priorLeaseRevision) || material.priorLeaseRevision < 1 ||
        material.dispatchAuthority.durableRunId !== assignment.manifest.durableRunId ||
        material.dispatchAuthority.durableRunAttempt !== generation.dispatchAuthority.durableRunAttempt ||
        material.dispatchAuthority.durableRunVersion <= generation.dispatchAuthority.durableRunVersion) throw invalid();
      return { material, materialSha256: row.material_sha256 };
    });
    const latest = records[0]!;
    const previous = records[1];
    const prior = previous?.material.dispatchAuthority ?? generation.dispatchAuthority;
    if (latest.material.recoveryRevision !== (previous?.material.recoveryRevision ?? 0) + 1 ||
      latest.material.priorAuthorityRecordSha256 !== (previous?.materialSha256 ?? generation.dispatchAuthoritySha256) ||
      latest.material.dispatchAuthority.dispatchOwnerId === prior.dispatchOwnerId ||
      latest.material.dispatchAuthority.durableRunVersion <= prior.durableRunVersion ||
      (previous && (latest.material.payloadSha256 !== previous.material.payloadSha256 ||
        latest.material.priorLeaseRevision < previous.material.priorLeaseRevision))) throw invalid();
    return latest;
  }

  bind(assignment: RemoteWorkerAssignmentRecord, generation: RemoteWorkerAssignmentGenerationRecord,
    lease: RemoteWorkerAssignmentLeaseRecord, authority: RemoteWorkerAssignmentDispatchAuthority, payloadSha256: string):
    RemoteWorkerChatParentRecoveryRecord | undefined {
    const previous = this.readLatest(assignment, generation);
    const prior = previous?.material.dispatchAuthority ?? generation.dispatchAuthority;
    if (authority.durableRunId !== prior.durableRunId || authority.durableRunAttempt !== prior.durableRunAttempt ||
      (previous && previous.material.payloadSha256 !== payloadSha256)) throw invalid();
    if (authority.dispatchOwnerId === prior.dispatchOwnerId) return previous;
    if (authority.durableRunVersion <= prior.durableRunVersion) throw invalid();
    const unrotated = previous && lease.leaseRevision === previous.material.priorLeaseRevision &&
      lease.requestSha256 === previous.material.priorLeaseRequestSha256;
    if ((!unrotated && (lease.parentDispatchAuthority.dispatchOwnerId !== prior.dispatchOwnerId ||
      lease.parentDispatchAuthority.durableRunAttempt !== prior.durableRunAttempt ||
      lease.parentDispatchAuthority.durableRunVersion < prior.durableRunVersion)) ||
      (previous && lease.leaseRevision < previous.material.priorLeaseRevision)) throw invalid();
    const material: RemoteWorkerChatParentRecoveryMaterial = {
      schemaVersion: "goatcitadel.remote-worker-chat-parent-recovery.v1",
      registryWorkspaceId: assignment.registryWorkspaceId, assignmentId: assignment.assignmentId,
      assignmentGeneration: generation.assignmentGeneration, assignmentManifestSha256: assignment.manifestSha256,
      originalDispatchAuthoritySha256: generation.dispatchAuthoritySha256, payloadSha256,
      recoveryRevision: (previous?.material.recoveryRevision ?? 0) + 1,
      priorAuthorityRecordSha256: previous?.materialSha256 ?? generation.dispatchAuthoritySha256,
      priorLeaseRevision: lease.leaseRevision, priorLeaseRequestSha256: lease.requestSha256, dispatchAuthority: authority,
    };
    this.db.prepare(`INSERT INTO remote_worker_chat_parent_recoveries
      (registry_workspace_id, assignment_id, assignment_generation, recovery_revision, material_json, material_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(assignment.registryWorkspaceId, assignment.assignmentId,
        generation.assignmentGeneration, material.recoveryRevision, canonicalJsonString(material), digest(material),
        new DurableRunRepository(this.db).readDatabaseNow());
    return this.readLatest(assignment, generation)!;
  }
}

function invalid() { return new ConflictError({ message: "Worker Chat parent recovery evidence changed or is incomplete." }); }
