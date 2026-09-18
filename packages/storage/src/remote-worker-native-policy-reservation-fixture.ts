import assert from "node:assert/strict";
import { remoteWorkerAssignmentCanonicalSha256, normalizeRemoteWorkerRuntimeResultExpectation } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import type { RemoteWorkerCellCapacityAuthority } from "./remote-worker-cell-capacity-admission-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { RemoteWorkerNativePolicyReservationRepository } from "./remote-worker-native-policy-reservation-repo.js";
import { RemoteWorkerAssignmentRepository } from "./remote-worker-assignment-repo.js";
import { ToolGrantRepository } from "./tool-grant-repo.js";
import { ToolAccessDecisionRepository } from "./tool-access-decision-repo.js";

/** Actual native admission/approval/lease repositories on either SQL dialect.
 * Native journal bytes are controlled fixtures, not physical-host evidence. */
export function verifyNativePolicyReservation(db: DatabaseClient, authority: RemoteWorkerCellCapacityAuthority) {
    const key = { registryWorkspaceId: authority.registryWorkspaceId, assignmentId: authority.assignmentId, assignmentGeneration: authority.assignmentGeneration };
    const raw = db.prepare(`SELECT expectation_json FROM remote_worker_runtime_expectations
      WHERE registry_workspace_id = @registryWorkspaceId AND assignment_id = @assignmentId AND assignment_generation = @assignmentGeneration`)
      .get<{ expectation_json: string }>(key);
    assert.ok(raw);
    const expectation = normalizeRemoteWorkerRuntimeResultExpectation(JSON.parse(raw.expectation_json));
    const lookup = { ...authority, nonce: expectation.nonce, requestSha256: expectation.requestSha256 };
    const manifest = new RemoteWorkerAssignmentRepository(db).resolveActiveChatExecution(authority, authority.protectedAuthority).authority.assignment.manifest;
    assert.ok(manifest.sessionId);
    const grants = new ToolGrantRepository(db), decisions = new ToolAccessDecisionRepository(db);
    const grant = grants.create({ toolPattern: "shell.exec", decision: "allow", scope: "session", scopeRef: manifest.sessionId,
      grantType: "one_time", createdBy: "operator", constraints: { maxCallsPerHour: 1, maxWritesPerHour: 1 } });
    const decision = decisions.record({ toolName: "shell.exec", agentId: "assistant", sessionId: manifest.sessionId,
      workspaceId: manifest.executionWorkspaceId, taskId: manifest.taskId, runId: manifest.durableRunId,
      allowed: true, requiresApproval: true, riskLevel: "danger", reasonCodes: [], matchedGrantId: grant.grantId, countsTowardLimits: true });
    const owner = new RemoteWorkerNativePolicyReservationRepository(db), policyRequestSha256 = remoteWorkerAssignmentCanonicalSha256("controlled-native-policy");
    assert.throws(() => owner.readForAssignment(lookup), "older admissions have no implicit reservation");
    assert.throws(() => owner.retainForAssignment({ ...lookup, policyRequestSha256, decisionId: decision.decisionId }), "an unconsumed one-time grant is not reserved");
    assert.equal(grants.consumeOne(grant.grantId), true);
    owner.retainForAssignment({ ...lookup, policyRequestSha256, decisionId: decision.decisionId });
    const saved = owner.readForAssignment(lookup);
    assert.equal(saved.grant?.usesRemaining, 0);
    assert.equal(remoteWorkerAssignmentCanonicalSha256(saved.decision), remoteWorkerAssignmentCanonicalSha256(decision));
    assert.deepEqual(new RemoteWorkerNativePolicyReservationRepository(db).readForAssignment(lookup), saved);
    const countInput = { toolName: "shell.exec", scope: "session" as const, agentId: "assistant", sessionId: manifest.sessionId };
    assert.equal(decisions.countToolCallsInLastHourInScope(countInput), 1);
    assert.equal(decisions.countToolCallsInLastHourInScope({ ...countInput, excludeDecisionId: decision.decisionId }), 0);
    assert.equal(decisions.countWritesInLastHourInScope({ ...countInput, excludeDecisionId: decision.decisionId }), 0);
    assert.equal(decisions.countToolCallsInLastHourInScope({ ...countInput, excludeDecisionId: "unknown" }), 1);
    for (const patch of [{ requestSha256: "ab".repeat(32) }, { nonce: "ab".repeat(32) }, { leaseRevision: 999 }])
      assert.throws(() => owner.readForAssignment({ ...lookup, ...patch }));
    for (const sql of ["UPDATE remote_worker_native_policy_reservations SET policy_request_sha256 = policy_request_sha256",
      "DELETE FROM remote_worker_native_policy_reservations"]) assert.throws(() => db.prepare(sql).run(), /immutable|retained/u);
    const rollback = new Error("restore grant fixture");
    assert.throws(() => db.transaction("immediate", () => {
      grants.revoke(grant.grantId, undefined, "operator");
      assert.throws(() => owner.readForAssignment(lookup)); throw rollback;
    }), error => error === rollback);
    assert.deepEqual(owner.readForAssignment(lookup), saved);
    assert.throws(() => db.transaction("immediate", () => {
      const runs = new DurableRunRepository(db), run = runs.getRun(manifest.durableRunId);
      runs.updateRun({ runId: run.runId, status: "cancelled", clearLease: true, expectedVersion: run.version });
      assert.throws(() => owner.readForAssignment(lookup)); throw rollback;
    }), error => error === rollback);
    assert.deepEqual(owner.readForAssignment(lookup), saved);
}
