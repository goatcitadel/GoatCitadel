import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  remoteWorkerAssignmentSettlementReplayMaterial,
  REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SCHEMA_VERSION,
  type SettleRemoteWorkerAssignmentWorkerCommand,
  type StartRemoteWorkerAssignmentGenerationCommand,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import {
  RemoteWorkerAssignmentRepository,
  type RemoteWorkerAssignmentProtectedCommitFence,
} from "./remote-worker-assignment-repo.js";
import { prepareChatOfferFixture } from "./remote-worker-chat-offer-fixture.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function assertRawSettlementGuard(
  db: DatabaseClient,
  command: SettleRemoteWorkerAssignmentWorkerCommand,
  accepted: boolean,
): void {
  const rollback = new Error("rollback accepted cancellation guard probe");
  assert.throws(
    () =>
      db.transaction("immediate", () => {
        db.prepare(
          `INSERT INTO remote_worker_assignment_settlements (
      registry_workspace_id, assignment_id, assignment_generation, schema_version, outcome, origin,
      final_event_sequence, final_event_sha256, failure_sha256, idempotency_key, request_sha256, settled_at
    ) VALUES (@workspace, @assignment, @generation, @schema, @outcome, 'worker',
      0, @genesis, @failure, @key, @request, @now)`,
        ).run({
          workspace: command.registryWorkspaceId,
          assignment: command.assignmentId,
          generation: command.expectedAssignmentGeneration,
          schema: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SCHEMA_VERSION,
          outcome: command.outcome,
          genesis: command.finalEventSha256,
          failure: command.failureSha256 ?? null,
          key: `${command.idempotencyKey}:raw`,
          request: digest("raw-guard-probe"),
          now: new DurableRunRepository(db).readDatabaseNow(),
        });
        throw rollback;
      }),
    (error) => (accepted ? error === rollback : error !== rollback),
  );
}

/** Shared SQLite/PostgreSQL proof for terminal renewal, rollback and exact replay. */
export function verifyWorkerTerminalRenewal(
  db: DatabaseClient,
  seed: string,
  worker: Pick<
    StartRemoteWorkerAssignmentGenerationCommand,
    "workerId" | "workerGeneration" | "nodeId" | "nodeAdmissionGeneration"
  >,
  fence: RemoteWorkerAssignmentProtectedCommitFence,
): void {
  const assignments = new RemoteWorkerAssignmentRepository(db);
  const runs = new DurableRunRepository(db);
  for (const outcome of ["failed", "cancelled"] as const) {
    const key = `${seed}-${outcome}`;
    const prepared = prepareChatOfferFixture(db, true, `-terminal-${key}`);
    const assignment = assignments.scheduleTaskBoundChatOffer(prepared.offerInput).assignment;
    const leaseTokenSha256 = digest(`${key}:lease`);
    const initial = assignments.startGeneration({
      ...worker,
      registryWorkspaceId: "default",
      assignmentId: assignment.assignmentId,
      dispatchOwnerId: prepared.offerInput.dispatchOwnerId,
      durableRunAttempt: prepared.offerInput.durableRunAttempt,
      leaseTokenSha256,
      idempotencyKey: `${key}:generation`,
    });
    const command = {
      registryWorkspaceId: "default",
      assignmentId: assignment.assignmentId,
      expectedAssignmentGeneration: initial.generation.assignmentGeneration,
      expectedLeaseRevision: 1,
      leaseTokenSha256,
      origin: "worker" as const,
      finalEventSequence: 0,
      finalEventSha256: "0".repeat(64),
      idempotencyKey: `${key}:settle`,
      ...(outcome === "cancelled"
        ? { outcome: "cancelled" as const }
        : { outcome: "failed" as const, failureSha256: digest(`${key}:failure`) }),
    };
    const terminal: SettleRemoteWorkerAssignmentWorkerCommand = {
      ...command,
      ...(outcome === "cancelled" ? {} : { renewalLeaseTokenSha256: digest(`${key}:terminal-lease`) }),
    };
    const parent = runs.getRun(prepared.durableRunId);
    assert.ok(
      runs.renewLease({
        runId: parent.runId,
        workerId: parent.leaseOwnerId!,
        leaseHeartbeatAt: runs.readDatabaseNow(),
        leaseExpiresAt: parent.leaseExpiresAt!,
      }),
    );
    // Database guards must independently refuse an unbound heartbeat or an
    // unrequested cancellation even when the repository is bypassed.
    assertRawSettlementGuard(db, command, false);
    if (outcome === "cancelled") {
      assert.throws(() => assignments.settleAssignment(terminal, fence));
      assignments.requestCancellation({
        registryWorkspaceId: "default",
        assignmentId: assignment.assignmentId,
        expectedAssignmentGeneration: initial.generation.assignmentGeneration,
        expectedLeaseRevision: 1,
        reasonCode: "operator_cancelled",
        reasonSha256: digest(`${key}:cancel`),
        actorId: "fixture-operator",
        idempotencyKey: `${key}:cancel`,
      });
    }
    const unchanged = () => {
      const aggregate = assignments.findAssignmentAggregate("default", assignment.assignmentId)!;
      assert.equal(aggregate.lease!.leaseRevision, 1);
      assert.equal(aggregate.settlement, undefined);
    };
    if (outcome !== "cancelled") {
      assert.throws(() => assignments.settleAssignment(command, fence));
      assert.throws(() => assignments.settleAssignment(terminal));
    }
    assert.throws(() => assignments.settleAssignment({ ...terminal, leaseTokenSha256: digest("wrong-token") }, fence));
    unchanged();
    // Failure AFTER the proposed rotation must roll the lease back as well.
    assert.throws(() => assignments.settleAssignment({ ...terminal, finalEventSequence: 1 }, fence));
    unchanged();
    const { failureSha256: _failure, ...withoutFailure } = terminal;
    const missingArtifact = {
      ...withoutFailure,
      outcome: "completed" as const,
      resultSha256: digest("result"),
      outputManifestSha256: digest("missing-manifest"),
    };
    assert.throws(() => assignments.settleAssignment(missingArtifact, fence));
    unchanged();

    const beforeReplacement = runs.getRun(parent.runId);
    const replacement = runs.updateRun({
      runId: parent.runId,
      status: "running",
      expectedVersion: beforeReplacement.version,
      leaseOwnerId: "unbound-parent",
    });
    assert.throws(() => assignments.settleAssignment(terminal, fence));
    assertRawSettlementGuard(db, command, false);
    unchanged();
    runs.updateRun({
      runId: parent.runId,
      status: "running",
      expectedVersion: replacement.version,
      leaseOwnerId: beforeReplacement.leaseOwnerId,
    });

    assertRawSettlementGuard(db, command, outcome === "cancelled");
    const committed = assignments.settleAssignment(terminal, fence);
    assert.equal(committed.disposition, "settled");
    assert.equal(committed.settlement.outcome, outcome);
    assert.equal(
      committed.settlement.requestSha256,
      digest(canonicalJsonString(remoteWorkerAssignmentSettlementReplayMaterial(terminal))),
    );
    const finalLease = assignments.findAssignmentAggregate("default", assignment.assignmentId)!.lease!;
    const terminalRevision = outcome === "cancelled" ? 1 : 2;
    assert.equal(finalLease.leaseRevision, terminalRevision);
    assert.ok(finalLease.expiresAt >= initial.lease.expiresAt);
    if (outcome !== "cancelled")
      assert.equal(finalLease.parentDispatchAuthority.durableRunVersion, runs.getRun(parent.runId).version);
    assert.throws(() =>
      assignments.resolveActiveChatExecution(
        {
          registryWorkspaceId: "default",
          assignmentId: assignment.assignmentId,
          assignmentGeneration: initial.generation.assignmentGeneration,
          leaseTokenSha256: terminal.renewalLeaseTokenSha256 ?? leaseTokenSha256,
        },
        fence,
      ),
    );
    assert.equal(assignments.settleAssignment(terminal, fence).disposition, "replayed");
    assert.throws(() =>
      assignments.settleAssignment({ ...terminal, finalEventSha256: digest("different-final-event") }, fence),
    );
    if (outcome !== "cancelled")
      assert.throws(() =>
        assignments.settleAssignment({ ...terminal, renewalLeaseTokenSha256: digest("different-renewal") }, fence),
      );
    assert.equal(
      assignments.findAssignmentAggregate("default", assignment.assignmentId)!.lease!.leaseRevision,
      terminalRevision,
    );
  }
}
