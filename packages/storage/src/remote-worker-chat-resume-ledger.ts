import {
  ConflictError,
  canonicalJsonString,
  remoteWorkerAssignmentCanonicalSha256 as digest,
  type DurableRunRecord,
  type RemoteWorkerAssignmentDispatchAuthority,
  type RemoteWorkerAssignmentGenerationRecord,
  type RemoteWorkerAssignmentLeaseRecord,
  type RemoteWorkerAssignmentRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ApprovalRepository } from "./approval-repo.js";
import { ApprovalEffectRepository } from "./approval-effect-repo.js";
import { ChatToolRunRepository } from "./chat-tool-run-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { PendingApprovalActionRepository } from "./pending-approval-action-repo.js";
import { RemoteWorkerEffectRepository } from "./remote-worker-effect-repo.js";
import { RemoteWorkerChatResumeRecoveryLedger, type RemoteWorkerChatResumeRecoveryRecord } from "./remote-worker-chat-resume-recovery-ledger.js";

export interface RemoteWorkerChatResumeWake {
  schemaVersion: "goatcitadel.remote-worker-chat-resume.v1";
  registryWorkspaceId: string;
  assignmentId: string;
  assignmentGeneration: number;
  assignmentManifestSha256: string;
  durableRunId: string;
  payloadSha256: string;
  durableRunAttempt: number;
  waitingRunVersion: number;
  queuedRunVersion: number;
  waitingCheckpointId: string;
  waitingRuntimeAuthoritySha256: string;
  approvalId: string;
  approvalSha256: string;
  intentId: string;
  intentSha256: string;
  pendingActionSha256: string;
  priorLeaseRevision: number;
  priorLeaseRequestSha256: string;
}

export interface RecordRemoteWorkerChatResumeWakeInput {
  registryWorkspaceId: string;
  assignmentId: string;
  approvalId: string;
  expectedParentVersion: number;
  waitingCheckpointId: string;
  waitingRuntimeAuthoritySha256: string;
}

export interface RemoteWorkerChatResumeRecord {
  resumeId: string;
  materialSha256: string;
  material: RemoteWorkerChatResumeWake;
  binding?: RemoteWorkerAssignmentDispatchAuthority;
  recovery?: RemoteWorkerChatResumeRecoveryRecord;
}

export function readChatResumeLeaseHandoff(resume: RemoteWorkerChatResumeRecord):
  Pick<RemoteWorkerChatResumeWake, "priorLeaseRevision" | "priorLeaseRequestSha256"> {
  return resume.recovery?.material ?? resume.material;
}

interface WakeRow {
  resume_id: string;
  registry_workspace_id: string;
  assignment_id: string;
  assignment_generation: number;
  prior_lease_revision: number;
  durable_run_id: string;
  waiting_checkpoint_id: string;
  material_json: string;
  material_sha256: string;
}

/** Internal ledger used by the assignment owner after its canonical lock plan.
 * It cannot authenticate a worker, change the durable run, or issue a lease. */
export class RemoteWorkerChatResumeLedger {
  constructor(private readonly db: DatabaseClient) {}

  readLatest(registryWorkspaceId: string, assignmentId: string, assignmentGeneration: number): RemoteWorkerChatResumeRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM remote_worker_chat_resume_wakes
      WHERE registry_workspace_id = ? AND assignment_id = ? AND assignment_generation = ?
      ORDER BY prior_lease_revision DESC LIMIT 1`).get<WakeRow>(registryWorkspaceId, assignmentId, assignmentGeneration);
    if (!row) return undefined;
    const material = parse<RemoteWorkerChatResumeWake>(row.material_json, row.material_sha256);
    if (material.schemaVersion !== "goatcitadel.remote-worker-chat-resume.v1" ||
      material.registryWorkspaceId !== row.registry_workspace_id || material.assignmentId !== row.assignment_id ||
      material.assignmentGeneration !== Number(row.assignment_generation) ||
      material.priorLeaseRevision !== Number(row.prior_lease_revision) ||
      material.durableRunId !== row.durable_run_id || material.waitingCheckpointId !== row.waiting_checkpoint_id ||
      row.resume_id !== `worker-resume:${row.material_sha256}`) throw invalid();
    const bound = this.db.prepare(`SELECT dispatch_authority_json, dispatch_authority_sha256
      FROM remote_worker_chat_resume_bindings WHERE resume_id = ?`).get<{
      dispatch_authority_json: string; dispatch_authority_sha256: string;
    }>(row.resume_id);
    const binding = bound ? parse<RemoteWorkerAssignmentDispatchAuthority>(
      bound.dispatch_authority_json, bound.dispatch_authority_sha256) : undefined;
    if (binding && (binding.durableRunId !== material.durableRunId ||
      binding.durableRunAttempt !== material.durableRunAttempt ||
      binding.durableRunVersion <= material.queuedRunVersion)) throw invalid();
    const recorded = { resumeId: row.resume_id, materialSha256: row.material_sha256, material, ...(binding ? { binding } : {}) };
    const recovery = new RemoteWorkerChatResumeRecoveryLedger(this.db).read(recorded);
    return recovery ? { ...recorded, recovery, binding: recovery.material.dispatchAuthority } : recorded;
  }

  prepareHandoff(input: RecordRemoteWorkerChatResumeWakeInput, assignment: RemoteWorkerAssignmentRecord,
    generation: RemoteWorkerAssignmentGenerationRecord, lease: RemoteWorkerAssignmentLeaseRecord, run: DurableRunRecord) {
    const manifest = assignment.manifest;
    const checkpoint = new DurableRunRepository(this.db).getLatestCheckpointByKind(run.runId, "run_waiting");
    const seal = record(run.metadata?.chatTurnRuntimeAuthority);
    const sealed = record(seal.material);
    if (run.status !== "waiting" || run.leaseOwnerId || run.leaseExpiresAt || run.version !== input.expectedParentVersion ||
      !checkpoint || checkpoint.checkpointId !== input.waitingCheckpointId ||
      canonicalJsonString(checkpoint.state.chatTurnRuntimeAuthority) !== canonicalJsonString(seal) ||
      seal.materialSha256 !== input.waitingRuntimeAuthoritySha256 || digest(sealed) !== seal.materialSha256 ||
      sealed.runId !== run.runId || sealed.turnId !== manifest.turnId || sealed.transitionKind !== "waiting" ||
      sealed.durableStatus !== "waiting" || sealed.traceStatus !== "waiting_for_approval" ||
      canonicalJsonString(sealed.waitForEvent) !== canonicalJsonString(run.metadata?.waitForEvent) ||
      canonicalJsonString(checkpoint.state.waitForEvent) !== canonicalJsonString(run.metadata?.waitForEvent) ||
      canonicalJsonString(run.metadata?.waitForEvent) !== canonicalJsonString({ eventKey: "approval.resolved", correlationId: input.approvalId }))
      throw invalid();
    // Gateway verifies the complete runtime seal and settled finalizers. These
    // comparisons bind that verification to the exact rows under this lock.
    const approval = new ApprovalRepository(this.db).get(input.approvalId);
    const pending = new PendingApprovalActionRepository(this.db).find(input.approvalId);
    const resolved = approval.status === "approved" || approval.status === "rejected" || approval.status === "edited";
    const expectedPendingStatus = approval.status === "approved" ? "pending" : "rejected";
    if (!resolved || approval.linkage?.workspaceId !== manifest.executionWorkspaceId ||
      approval.linkage.sessionId !== manifest.sessionId || approval.linkage.turnId !== manifest.turnId ||
      approval.linkage.runId !== run.runId || !pending || pending.actionType !== "tool.invoke" || pending.resolutionStatus !== expectedPendingStatus)
      throw invalid();
    const matchingTools = new ChatToolRunRepository(this.db).listByTurn(manifest.turnId!).filter((tool) =>
      tool.approvalId === input.approvalId && tool.toolRunId.startsWith("remote-tool:"));
    if (matchingTools.length !== 1) throw invalid();
    const intentId = matchingTools[0]!.toolRunId.slice("remote-tool:".length);
    const effects = new RemoteWorkerEffectRepository(this.db);
    const intent = effects.listIntents(assignment.registryWorkspaceId, assignment.assignmentId, generation.assignmentGeneration)
      .find((candidate) => candidate.intentId === intentId);
    if (!intent || intent.identity.assignmentManifestSha256 !== assignment.manifestSha256 ||
      intent.identity.workerId !== generation.workerId || intent.identity.workerGeneration !== generation.workerGeneration ||
      intent.identity.executionWorkspaceId !== manifest.executionWorkspaceId) throw invalid();
    const tool = new ChatToolRunRepository(this.db).get(`remote-tool:${intent.intentId}`);
    if (tool.approvalId !== approval.approvalId || tool.status !== "approval_required" ||
      tool.sessionId !== manifest.sessionId || tool.turnId !== manifest.turnId || tool.toolName !== intent.effectSelector ||
      approval.linkage.toolName !== tool.toolName || digest(tool.args) !== intent.canonicalArgsSha256 ||
      pending.request.toolName !== tool.toolName || digest(pending.request.args) !== intent.canonicalArgsSha256 ||
      pending.request.sessionId !== manifest.sessionId || pending.request.workspaceId !== manifest.executionWorkspaceId ||
      pending.request.runId !== run.runId || pending.request.turnId !== manifest.turnId ||
      effects.readTransitionHistory(assignment.registryWorkspaceId, assignment.assignmentId, generation.assignmentGeneration,
        intent.intentId).at(-1)?.record.transitionState !== "approval_wait") throw invalid();
    const material: RemoteWorkerChatResumeWake = {
      schemaVersion: "goatcitadel.remote-worker-chat-resume.v1",
      registryWorkspaceId: assignment.registryWorkspaceId, assignmentId: assignment.assignmentId,
      assignmentGeneration: generation.assignmentGeneration, assignmentManifestSha256: assignment.manifestSha256,
      durableRunId: run.runId, payloadSha256: digest(run.payload), durableRunAttempt: run.attemptCount,
      waitingRunVersion: run.version, queuedRunVersion: run.version + 1,
      waitingCheckpointId: checkpoint.checkpointId, waitingRuntimeAuthoritySha256: input.waitingRuntimeAuthoritySha256,
      approvalId: approval.approvalId, approvalSha256: digest(approval), intentId: intent.intentId,
      intentSha256: intent.intentSha256, pendingActionSha256: digest(pending),
      priorLeaseRevision: lease.leaseRevision, priorLeaseRequestSha256: lease.requestSha256,
    };
    return material;
  }

  recordWake(input: RecordRemoteWorkerChatResumeWakeInput, assignment: RemoteWorkerAssignmentRecord,
    generation: RemoteWorkerAssignmentGenerationRecord, lease: RemoteWorkerAssignmentLeaseRecord, run: DurableRunRecord) {
    const material = this.prepareHandoff(input, assignment, generation, lease, run);
    if (new ApprovalRepository(this.db).get(input.approvalId).status === "approved") {
      const handoff = new ApprovalEffectRepository(this.db).listByApproval(input.approvalId).find((effect) =>
        effect.effectKind === "pending_action_execute" && effect.status === "skipped" &&
        effect.result.reason === "remote_worker_resume_handoff");
      if (!handoff || handoff.result.intentId !== material.intentId) throw invalid();
      if (handoff.result.assignmentId !== assignment.assignmentId ||
        handoff.result.registryWorkspaceId !== assignment.registryWorkspaceId ||
        handoff.result.assignmentGeneration !== generation.assignmentGeneration ||
        handoff.result.pendingActionSha256 !== material.pendingActionSha256 ||
        handoff.result.approvalSha256 !== material.approvalSha256) throw invalid();
    }
    // Rejection/edit resolution already terminalized the exact pending request.
    // It has no action-execution effect to skip and grants no tool permission.
    const materialJson = canonicalJsonString(material);
    const materialSha256 = digest(material);
    const resumeId = `worker-resume:${materialSha256}`;
    const previous = this.readLatest(assignment.registryWorkspaceId, assignment.assignmentId, generation.assignmentGeneration);
    if (previous?.material.priorLeaseRevision === lease.leaseRevision) {
      if (previous.materialSha256 !== materialSha256) throw invalid();
      return previous;
    }
    this.db.prepare(`INSERT INTO remote_worker_chat_resume_wakes (
      resume_id, registry_workspace_id, assignment_id, assignment_generation, prior_lease_revision,
      durable_run_id, waiting_checkpoint_id, material_json, material_sha256, created_at
    ) VALUES (@resumeId, @registryWorkspaceId, @assignmentId, @assignmentGeneration, @priorLeaseRevision,
      @durableRunId, @waitingCheckpointId, @materialJson, @materialSha256, @createdAt)`).run({
      resumeId, registryWorkspaceId: material.registryWorkspaceId, assignmentId: material.assignmentId,
      assignmentGeneration: material.assignmentGeneration, priorLeaseRevision: material.priorLeaseRevision,
      durableRunId: material.durableRunId, waitingCheckpointId: material.waitingCheckpointId,
      materialJson, materialSha256, createdAt: new DurableRunRepository(this.db).readDatabaseNow(),
    });
    return this.readLatest(assignment.registryWorkspaceId, assignment.assignmentId, generation.assignmentGeneration)!;
  }

  bind(recorded: RemoteWorkerChatResumeRecord, authority: RemoteWorkerAssignmentDispatchAuthority,
    lease: RemoteWorkerAssignmentLeaseRecord) {
    if (authority.durableRunId !== recorded.material.durableRunId ||
      authority.durableRunAttempt !== recorded.material.durableRunAttempt ||
      authority.durableRunVersion <= recorded.material.queuedRunVersion) throw invalid();
    if (recorded.binding) {
      if (recorded.binding.durableRunAttempt !== authority.durableRunAttempt) throw invalid();
      if (recorded.binding.dispatchOwnerId === authority.dispatchOwnerId) return recorded;
      new RemoteWorkerChatResumeRecoveryLedger(this.db).append(recorded, authority, lease);
      return this.readLatest(recorded.material.registryWorkspaceId, recorded.material.assignmentId, recorded.material.assignmentGeneration)!;
    }
    this.db.prepare(`INSERT INTO remote_worker_chat_resume_bindings
      (resume_id, dispatch_authority_json, dispatch_authority_sha256, created_at)
      VALUES (?, ?, ?, ?)`).run(recorded.resumeId, canonicalJsonString(authority), digest(authority),
      new DurableRunRepository(this.db).readDatabaseNow());
    return this.readLatest(recorded.material.registryWorkspaceId, recorded.material.assignmentId,
      recorded.material.assignmentGeneration)!;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function parse<T>(json: string, hash: string): T {
  const value: unknown = JSON.parse(json);
  if (canonicalJsonString(value) !== json || digest(value) !== hash) throw invalid();
  return value as T;
}

function invalid() {
  return new ConflictError({ message: "Worker Chat approval resume evidence changed or is incomplete." });
}
