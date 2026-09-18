import { remoteWorkerAssignmentCanonicalSha256, normalizeRemoteWorkerRuntimeResultSubmission, type ToolGrantRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { RemoteWorkerRuntimeResultRepository } from "./remote-worker-runtime-result-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { snapshotRemoteWorkerCellCapacityAuthority, type RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";
import { RemoteWorkerCellConflictError } from "./remote-worker-cell-repo.js";
import { ToolAccessDecisionRepository } from "./tool-access-decision-repo.js";
import { ToolGrantRepository } from "./tool-grant-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";

export type NativePolicyReservationLookup = RemoteWorkerCellCapacityAuthority & { nonce: string; requestSha256: string };
const where = "registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration AND nonce = @nonce";
interface Row { request_sha256: string; policy_request_sha256: string; approval_id: string; decision_id: string; grant_sha256: string | null }
const refused = () => new RemoteWorkerCellConflictError("Native policy reservation requires its exact admitted request and current authority.");
function hash(value: string) { if (!/^[a-f0-9]{64}$/u.test(value) || /^0+$/u.test(value)) throw refused(); return value; }
function grantHash(grant: ToolGrantRecord) {
  const { usesRemaining: _usesRemaining, ...identity } = grant;
  return remoteWorkerAssignmentCanonicalSha256(identity);
}
function snapshot(input: NativePolicyReservationLookup) {
  const key = normalizeRemoteWorkerRuntimeResultSubmission({ kind: "runtime.result.lookup", nonce: input.nonce, requestSha256: input.requestSha256 });
  return { ...snapshotRemoteWorkerCellCapacityAuthority(input), nonce: key.nonce, requestSha256: key.requestSha256 };
}
function rowKey(input: NativePolicyReservationLookup) {
  return { registryWorkspaceId: input.registryWorkspaceId, assignmentId: input.assignmentId,
    assignmentGeneration: input.assignmentGeneration, nonce: input.nonce };
}

/** Internal policy owner only. The retained association is not a worker token,
 * approval bypass, or authority to launch again. Every read rechecks the native
 * approval/lease plus the exact grant identity, revocation and expiry. */
export class RemoteWorkerNativePolicyReservationRepository {
  constructor(private readonly db: DatabaseClient) {}

  public retainForAssignment(input: NativePolicyReservationLookup & { policyRequestSha256: string; decisionId: string }): void {
    const command = snapshot(input), policyRequestSha256 = hash(input.policyRequestSha256), decisionId = input.decisionId;
    this.db.transaction("immediate", () => {
      new RemoteWorkerRuntimeResultRepository(this.db).authorizeForAssignment({ ...command, phase: "execution" });
      const admission = this.db.prepare(`SELECT approval_id FROM remote_worker_runtime_expectations WHERE ${where}`).get<{ approval_id: string }>(rowKey(command));
      if (!admission?.approval_id) throw refused();
      const decision = this.decision(command, decisionId);
      const grant = decision.matchedGrantId ? new ToolGrantRepository(this.db).get(decision.matchedGrantId) : undefined;
      if (grant) this.assertGrant(grant);
      this.db.prepare(`INSERT INTO remote_worker_native_policy_reservations
        (registry_workspace_id, assignment_id, assignment_generation, nonce, request_sha256, policy_request_sha256, approval_id, decision_id, grant_sha256)
        VALUES (@registryWorkspaceId, @assignmentId, @assignmentGeneration, @nonce, @requestSha256, @policyRequestSha256, @approvalId, @decisionId, @grantSha256)`)
        .run({ ...rowKey(command), requestSha256: command.requestSha256, policyRequestSha256, approvalId: admission.approval_id, decisionId, grantSha256: grant ? grantHash(grant) : null });
    });
  }

  public readForAssignment(input: NativePolicyReservationLookup) {
    const command = snapshot(input);
    return this.db.transaction("immediate", () => {
      new RemoteWorkerRuntimeResultRepository(this.db).authorizeForAssignment({ ...command, phase: "delivery" });
      const row = this.db.prepare(`SELECT * FROM remote_worker_native_policy_reservations WHERE ${where}`).get<Row>(rowKey(command));
      if (!row || row.request_sha256 !== command.requestSha256) throw refused();
      const admission = this.db.prepare(`SELECT approval_id FROM remote_worker_runtime_expectations WHERE ${where}`).get<{ approval_id: string }>(rowKey(command));
      if (admission?.approval_id !== row.approval_id) throw refused();
      const decision = this.decision(command, row.decision_id);
      const grant = decision.matchedGrantId ? new ToolGrantRepository(this.db).get(decision.matchedGrantId) : undefined;
      if (grant) this.assertGrant(grant);
      if ((grant ? grantHash(grant) : null) !== row.grant_sha256) throw refused();
      return { policyRequestSha256: hash(row.policy_request_sha256), decision, grant };
    });
  }

  private decision(command: NativePolicyReservationLookup, decisionId: string) {
    const decision = new ToolAccessDecisionRepository(this.db).get(decisionId);
    const execution = new RemoteWorkerAssignmentRepository(this.db).resolveActiveChatExecution(command, command.protectedAuthority);
    const manifest = execution.authority.assignment.manifest;
    if (!decision || !decision.allowed || !decision.countsTowardLimits || decision.toolName !== "shell.exec" || decision.agentId !== "assistant" ||
        decision.sessionId !== manifest.sessionId || decision.workspaceId !== manifest.executionWorkspaceId ||
        decision.taskId !== manifest.taskId || decision.runId !== manifest.durableRunId) throw refused();
    return decision;
  }
  private assertGrant(grant: ToolGrantRecord) {
    const now = Date.parse(new DurableRunRepository(this.db).readDatabaseNow());
    const expiry = grant.expiresAt === undefined ? undefined : Date.parse(grant.expiresAt);
    if (!Number.isFinite(now) || grant.decision !== "allow" || grant.revokedAt ||
        (expiry !== undefined && (!Number.isFinite(expiry) || expiry <= now)) ||
        (grant.grantType === "one_time" && grant.usesRemaining !== 0)) throw refused();
  }
}
