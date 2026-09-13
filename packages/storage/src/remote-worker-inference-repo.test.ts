import { seedRemoteWorkerInferenceAuthority, type SeededAuthority } from "./remote-worker-inference-fixture.js";
import { RemoteWorkerInferenceRepository } from "./remote-worker-inference-repo.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  REMOTE_WORKER_INFERENCE_APPROVAL_RESOLUTION_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
  authorizeRemoteWorkerInferenceRequestSubmission,
  remoteWorkerInferenceEffectiveRouteSha256,
  remoteWorkerInferenceRequestSha256,
  type RemoteWorkerInferenceGovernanceReceipt,
  type RemoteWorkerInferenceBudgetOperationInput,
  type RemoteWorkerInferenceEffectiveRouteReceipt,
  type RemoteWorkerInferenceAuthorizedSubmission,
  type RemoteWorkerInferenceRequestSubmission,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";

const clients: DatabaseClient[] = [];
const FUTURE = "2099-01-01T00:00:00.000Z";
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

function seedAuthority(seed: string): SeededAuthority {
  const db = createDatabase({ dbPath: ":memory:" });
  clients.push(db);
  return seedRemoteWorkerInferenceAuthority(db, seed);
}

function submissionFor(
  a: SeededAuthority,
  overrides: Partial<RemoteWorkerInferenceRequestSubmission> = {},
): RemoteWorkerInferenceAuthorizedSubmission {
  return authorizeRemoteWorkerInferenceRequestSubmission({
    registryWorkspaceId: "default",
    assignmentId: a.assignmentId,
    assignmentGeneration: a.assignmentGeneration,
    inferenceRequestId: "inference-1",
    attempt: 1,
    idempotencyKey: "inference:idem:1",
    leaseToken: "seed:lease:1",
    messages: [{ role: "user", text: "Hello." }],
    inputSha256: D("input"),
    contextSha256: D("context"),
    modelIntentSha256: D("intent"),
    outputTokenCeiling: 4096,
    reasoningTokenCeiling: 1024,
    temperatureMilli: 700,
    ...overrides,
  }).submission;
}

function governanceReceipt(
  decision: RemoteWorkerInferenceGovernanceReceipt["decision"] = "allowed",
): RemoteWorkerInferenceGovernanceReceipt {
  return {
    schemaVersion: REMOTE_WORKER_INFERENCE_GOVERNANCE_SCHEMA_VERSION,
    decision,
    effectiveRouteSha256: remoteWorkerInferenceEffectiveRouteSha256(routeReceipt()),
    policyRevision: 4,
    policySha256: D("policy"),
    ...(decision === "approval_required" ? { approvalReceiptSha256: D("approval") } : {}),
    outputTokenCeiling: 4096,
    reasoningTokenCeiling: 1024,
    expiresAt: FUTURE,
  };
}

function routeReceipt(): RemoteWorkerInferenceEffectiveRouteReceipt {
  return {
    schemaVersion: REMOTE_WORKER_INFERENCE_EFFECTIVE_ROUTE_SCHEMA_VERSION,
    providerId: "anthropic",
    modelId: "claude-opus-4",
    apiStyle: "anthropic_messages",
    credentialType: "api_key",
    usagePool: "standard",
    credentialSource: "env",
  };
}

function admissionFor(
  a: SeededAuthority,
  overrides: Partial<RemoteWorkerInferenceRequestSubmission> = {},
  decision: RemoteWorkerInferenceGovernanceReceipt["decision"] = "allowed",
) {
  const submission = submissionFor(a, overrides);
  const governance = governanceReceipt(decision);
  const operation = {
    operationId: "operation-1",
    dispatchGeneration: "dispatch-generation-1",
    requestSha256: remoteWorkerInferenceRequestSha256(submission),
    effectiveRouteSha256: governance.effectiveRouteSha256,
    registryWorkspaceId: submission.registryWorkspaceId,
    executionWorkspaceId: "default",
    assignmentId: submission.assignmentId,
    assignmentGeneration: submission.assignmentGeneration,
    workerId: a.workerId,
    workerGeneration: a.workerGeneration,
    admittedLeaseRevision: 1,
    sessionId: a.sessionId,
    turnId: a.turnId,
    durableRunId: a.durableRunId,
    taskId: a.taskId,
    capabilityProfileSha256: D("capability-profile"),
    routedContextSha256: submission.contextSha256,
    outputTokenCeiling: Math.min(submission.outputTokenCeiling, governance.outputTokenCeiling),
    reasoningTokenCeiling: Math.min(submission.reasoningTokenCeiling, governance.reasoningTokenCeiling),
  } as const;
  return {
    submission,
    workerId: a.workerId,
    workerGeneration: a.workerGeneration,
    executionWorkspaceId: "default",
    sessionId: a.sessionId,
    turnId: a.turnId,
    durableRunId: a.durableRunId,
    taskId: a.taskId,
    admittedLeaseRevision: 1,
    capabilityProfileSha256: D("capability-profile"),
    routedContextSha256: submission.contextSha256,
    operationId: "operation-1",
    dispatchGeneration: "dispatch-generation-1",
    governance,
    ...(decision === "allowed" ? { effectiveRoute: routeReceipt(), budgetOperation: operation } : {}),
    admittedAt: a.now,
  };
}

function keyFor(a: SeededAuthority, inferenceRequestId = "inference-1", attempt = 1) {
  return {
    registryWorkspaceId: "default",
    assignmentId: a.assignmentId,
    assignmentGeneration: a.assignmentGeneration,
    inferenceRequestId,
    attempt,
  };
}

function claimInputFor(a: SeededAuthority, owner: string, key = keyFor(a)) {
  const current = a.repo.getRequest(key);
  assert.ok(current?.budgetOperationJson);
  const operation = JSON.parse(current.budgetOperationJson) as {
    operationId: string;
    requestSha256: string;
    effectiveRouteSha256: string;
    outputTokenCeiling: number;
    reasoningTokenCeiling: number;
  };
  a.repo.recordBudgetReservation(
    key,
    {
      schemaVersion: REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION,
      budgetOwnerId: "test-budget-owner",
      reservationId: "reservation-1",
      operationId: operation.operationId,
      operationSha256: current.budgetOperationSha256!,
      requestSha256: operation.requestSha256,
      effectiveRouteSha256: operation.effectiveRouteSha256,
      reservedOutputTokens: operation.outputTokenCeiling,
      reservedReasoningTokens: operation.reasoningTokenCeiling,
      reservedCostMicrousd: 1000,
      expiresAt: FUTURE,
    },
    a.now,
  );
  return {
    ...key,
    dispatchClaimOwner: owner,
    effectiveProviderId: "anthropic",
    effectiveModelId: "claude-opus-4",
    effectiveRouteSha256: current.effectiveRouteSha256,
    dispatchLeaseExpiresAt: FUTURE,
    now: a.now,
  };
}

describe("RemoteWorkerInferenceRepository SQLite", () => {
  it("admits, exactly replays, and conflicts on changed canonical bytes", () => {
    const a = seedAuthority("admit");
    const created = a.repo.admitOrReplay(admissionFor(a));
    assert.equal(created.disposition, "created");
    assert.equal(created.request.state, "admitted");
    assert.equal(created.request.accountingDisposition, undefined);

    const replay = a.repo.admitOrReplay(admissionFor(a));
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.request.requestSha256, created.request.requestSha256);

    assert.throws(() => a.repo.admitOrReplay(admissionFor(a, { temperatureMilli: 701 })), /replay does not match/u);
  });

  it("derives the initial state from the governance decision", () => {
    const a = seedAuthority("gov");
    const waiting = a.repo.admitOrReplay(
      admissionFor(a, { idempotencyKey: "w", inferenceRequestId: "w" }, "approval_required"),
    );
    assert.equal(waiting.request.state, "waiting_approval");
    assert.equal(waiting.request.budgetAuthorityState, "not_required");

    const denied = a.repo.admitOrReplay(admissionFor(a, { idempotencyKey: "d", inferenceRequestId: "d" }, "denied"));
    assert.equal(denied.request.state, "blocked");
  });

  it("lets exactly one dispatch claimant win", () => {
    const a = seedAuthority("claim");
    a.repo.admitOrReplay(admissionFor(a));
    const first = a.repo.claimDispatch(claimInputFor(a, "owner-a"));
    const second = a.repo.claimDispatch(claimInputFor(a, "owner-b"));
    assert.ok(first);
    assert.equal(first.state, "dispatch_claimed");
    assert.equal(first.dispatchClaimOwner, "owner-a");
    assert.equal(first.accountingDisposition, "delegated");
    assert.equal(second, undefined);
  });

  it("exact-binds every budget authority field, ceiling, and claimed route", () => {
    const drift = seedAuthority("operation-drift");
    const invalid = admissionFor(drift);
    const operationMutations: Array<Partial<RemoteWorkerInferenceBudgetOperationInput>> = [
      { operationId: "different-operation" },
      { dispatchGeneration: "different-dispatch" },
      { requestSha256: D("different-request") },
      { effectiveRouteSha256: D("different-route") },
      { registryWorkspaceId: "different-registry-workspace" },
      { executionWorkspaceId: "different-execution-workspace" },
      { assignmentId: "different-assignment" },
      { assignmentGeneration: invalid.submission.assignmentGeneration + 1 },
      { workerId: "different-worker" },
      { workerGeneration: invalid.workerGeneration + 1 },
      { admittedLeaseRevision: invalid.admittedLeaseRevision + 1 },
      { sessionId: "different-session" },
      { turnId: "different-turn" },
      { durableRunId: "different-run" },
      { taskId: "different-task" },
      { capabilityProfileSha256: D("different-capability-profile") },
      { routedContextSha256: D("different-routed-context") },
      { outputTokenCeiling: invalid.budgetOperation!.outputTokenCeiling + 1 },
      { reasoningTokenCeiling: invalid.budgetOperation!.reasoningTokenCeiling + 1 },
    ];
    for (const mutation of operationMutations) {
      assert.throws(
        () =>
          drift.repo.admitOrReplay({
            ...invalid,
            budgetOperation: { ...invalid.budgetOperation!, ...mutation },
          }),
        /budget operation does not bind/u,
      );
    }

    const a = seedAuthority("reservation-drift");
    const admitted = a.repo.admitOrReplay(admissionFor(a)).request;
    const operation = JSON.parse(admitted.budgetOperationJson!) as {
      operationId: string;
      requestSha256: string;
      effectiveRouteSha256: string;
      outputTokenCeiling: number;
      reasoningTokenCeiling: number;
    };
    assert.throws(
      () =>
        a.repo.recordBudgetReservation(
          keyFor(a),
          {
            schemaVersion: REMOTE_WORKER_INFERENCE_BUDGET_SCHEMA_VERSION,
            budgetOwnerId: "test-budget-owner",
            reservationId: "reservation-over-ceiling",
            operationId: operation.operationId,
            operationSha256: admitted.budgetOperationSha256!,
            requestSha256: operation.requestSha256,
            effectiveRouteSha256: operation.effectiveRouteSha256,
            reservedOutputTokens: operation.outputTokenCeiling + 1,
            reservedReasoningTokens: operation.reasoningTokenCeiling,
            reservedCostMicrousd: 1000,
            expiresAt: FUTURE,
          },
          a.now,
        ),
      /ceilings do not match/u,
    );
    const claim = claimInputFor(a, "owner-a");
    assert.throws(
      () =>
        a.db
          .prepare(
            "UPDATE remote_worker_inference_requests SET budget_authority_state = 'settled' WHERE inference_request_id = 'inference-1'",
          )
          .run(),
      /authority transition|evidence is incomplete/u,
    );
    assert.throws(() => a.repo.claimDispatch({ ...claim, effectiveModelId: "different-model" }), /route drifted/u);
    assert.throws(
      () => a.repo.claimDispatch({ ...claim, dispatchClaimOwner: "Bearer dispatch-owner-secret-canary" }),
      /secret-like/u,
    );
  });

  it("exact-binds every authority and ceiling field again at approval continuation", () => {
    const a = seedAuthority("continuation-operation-drift");
    const waiting = admissionFor(a, {}, "approval_required");
    a.repo.admitOrReplay(waiting);
    const allowed = admissionFor(a);
    const approval = {
      schemaVersion: REMOTE_WORKER_INFERENCE_APPROVAL_RESOLUTION_SCHEMA_VERSION,
      decision: "approved" as const,
      pendingApprovalReceiptSha256: waiting.governance.approvalReceiptSha256!,
      resolutionSha256: D("approval-resolution"),
      resolvedAt: a.now,
    };
    assert.throws(
      () =>
        a.repo.recordApprovalContinuation({
          ...keyFor(a),
          approvalResolution: { ...approval, resolvedAt: "2000-01-01T00:00:00.000Z" },
          governance: allowed.governance,
          effectiveRoute: allowed.effectiveRoute!,
          budgetOperation: allowed.budgetOperation!,
          now: a.now,
        }),
      /continuation evidence drifted/u,
    );
    assert.throws(
      () =>
        a.repo.recordApprovalContinuation({
          ...keyFor(a),
          approvalResolution: approval,
          governance: { ...allowed.governance, expiresAt: a.now },
          effectiveRoute: allowed.effectiveRoute!,
          budgetOperation: allowed.budgetOperation!,
          now: a.now,
        }),
      /continuation evidence drifted/u,
    );
    const operationMutations: Array<Partial<RemoteWorkerInferenceBudgetOperationInput>> = [
      { operationId: "different-operation" },
      { dispatchGeneration: "different-dispatch" },
      { requestSha256: D("different-request") },
      { effectiveRouteSha256: D("different-route") },
      { registryWorkspaceId: "different-registry-workspace" },
      { executionWorkspaceId: "different-execution-workspace" },
      { assignmentId: "different-assignment" },
      { assignmentGeneration: allowed.submission.assignmentGeneration + 1 },
      { workerId: "different-worker" },
      { workerGeneration: allowed.workerGeneration + 1 },
      { admittedLeaseRevision: allowed.admittedLeaseRevision + 1 },
      { sessionId: "different-session" },
      { turnId: "different-turn" },
      { durableRunId: "different-run" },
      { taskId: "different-task" },
      { capabilityProfileSha256: D("different-capability-profile") },
      { routedContextSha256: D("different-routed-context") },
      { outputTokenCeiling: allowed.budgetOperation!.outputTokenCeiling + 1 },
      { reasoningTokenCeiling: allowed.budgetOperation!.reasoningTokenCeiling + 1 },
    ];
    for (const mutation of operationMutations) {
      assert.throws(
        () =>
          a.repo.recordApprovalContinuation({
            ...keyFor(a),
            approvalResolution: approval,
            governance: allowed.governance,
            effectiveRoute: allowed.effectiveRoute!,
            budgetOperation: { ...allowed.budgetOperation!, ...mutation },
            now: a.now,
          }),
        /continuation evidence drifted/u,
      );
    }
    const continued = a.repo.recordApprovalContinuation({
      ...keyFor(a),
      approvalResolution: approval,
      governance: allowed.governance,
      effectiveRoute: allowed.effectiveRoute!,
      budgetOperation: allowed.budgetOperation!,
      now: a.now,
    });
    assert.equal(continued?.state, "admitted");
    assert.equal(continued?.budgetAuthorityState, "reservation_pending");
  });

  it("appends hash-chained frames, enforces output bounds, and finalizes an immutable terminal", () => {
    const a = seedAuthority("stream");
    a.repo.admitOrReplay(admissionFor(a));
    a.repo.claimDispatch(claimInputFor(a, "owner-a"));

    const frame1 = a.repo.appendOutputFrame({
      ...keyFor(a),
      dispatchClaimOwner: "owner-a",
      text: "Hello ",
      now: a.now,
    });
    const frame2 = a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "owner-a", text: "world", now: a.now });
    assert.equal(frame1.frame.frameSequence, 1);
    assert.equal(frame2.frame.frameSequence, 2);
    assert.equal(frame2.frame.previousFrameSha256, frame1.frame.frameSha256);
    assert.equal(frame2.request.state, "streaming");
    assert.equal(frame2.request.outputFrameCount, 2);

    // A non-claimant cannot append.
    assert.throws(
      () => a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "intruder", text: "x", now: a.now }),
      /claim owner mismatch/u,
    );

    const toolCalls = [{ callId: "call-1", modelToolName: "fs_read", argumentsJson: ' {"path":"note.txt"} ' }];
    assert.throws(() => a.repo.finalizeTerminal({
      ...keyFor(a), dispatchClaimOwner: "owner-a", terminalState: "completed",
      usageEventIds: ["usage-terminal-1"], toolCalls: [{ ...toolCalls[0]!, argumentsJson: "{" }], now: a.now,
    }), /incomplete JSON/);
    assert.equal(a.repo.getRequest(keyFor(a))?.state, "streaming");
    assert.equal(a.repo.listFramesAfter(keyFor(a), 0).length, 2);
    const finalized = a.repo.finalizeTerminal({
      ...keyFor(a),
      dispatchClaimOwner: "owner-a",
      terminalState: "completed",
      usageEventIds: ["usage-intent-1", "usage-terminal-1"],
      toolCalls,
      now: a.now,
    });
    assert.equal(finalized.state, "completed");
    assert.equal(finalized.terminalFrameSequence, 3);
    assert.deepEqual(JSON.parse(new RemoteWorkerInferenceRepository(a.db).listFramesAfter(keyFor(a), 2)[0]!.payloadJson).toolCalls, toolCalls);
    assert.equal(finalized.usageTerminalEventId, "usage-terminal-1");
    assert.equal(finalized.accountingDisposition, "delegated");
    assert.equal(finalized.budgetAuthorityState, "settlement_pending");
    assert.throws(
      () =>
        a.db
          .prepare(
            "UPDATE remote_worker_inference_requests SET budget_authority_state = 'reserved' WHERE inference_request_id = 'inference-1'",
          )
          .run(),
      /authority transition|evidence is incomplete/u,
    );
    const settled = a.repo.markBudgetSettled(keyFor(a), a.now);
    assert.equal(settled.accountingDisposition, "settled");
    assert.equal(settled.budgetAuthorityState, "settled");

    // Terminal is immutable: a raw state change is rejected by the trigger.
    assert.throws(
      () =>
        a.db
          .prepare(
            "UPDATE remote_worker_inference_requests SET state = 'failed' WHERE inference_request_id = 'inference-1'",
          )
          .run(),
      /immutable/u,
    );
    for (const mutation of [
      "accounting_disposition = 'delegated'",
      "budget_authority_state = 'settlement_pending'",
      "usage_terminal_event_id = 'fabricated-usage-id'",
    ]) {
      assert.throws(
        () =>
          a.db
            .prepare(
              `UPDATE remote_worker_inference_requests SET ${mutation} WHERE inference_request_id = 'inference-1'`,
            )
            .run(),
        /authority transition|evidence is incomplete|immutable/u,
      );
    }
    // But acknowledgement still advances.
    const acked = a.repo.acknowledge(keyFor(a), 3, a.now);
    assert.equal(acked.workerAcknowledgedThrough, 3);
  });

  it("rejects out-of-order and mutated outbox frames at the database", () => {
    const a = seedAuthority("outbox");
    a.repo.admitOrReplay(admissionFor(a));
    a.repo.claimDispatch(claimInputFor(a, "owner-a"));
    const frame = a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "owner-a", text: "hi", now: a.now });

    // Append-only: no update, no delete.
    assert.throws(
      () =>
        a.db.prepare("UPDATE remote_worker_inference_outbox SET frame_char_count = 9 WHERE frame_sequence = 1").run(),
      /append-only/u,
    );
    assert.throws(
      () => a.db.prepare("DELETE FROM remote_worker_inference_outbox WHERE frame_sequence = 1").run(),
      /append-only/u,
    );

    // Out-of-order raw insert is rejected by the chain guard.
    assert.throws(
      () =>
        a.db
          .prepare(
            `INSERT INTO remote_worker_inference_outbox (
               registry_workspace_id, assignment_id, assignment_generation, inference_request_id, attempt,
               frame_sequence, frame_kind, payload_json, payload_sha256, previous_frame_sha256, frame_sha256,
               effective_route_sha256, usage_event_id, frame_char_count, created_at
             ) VALUES ('default', @assignmentId, @gen, 'inference-1', 1, 5, 'output_text',
               '{"schemaVersion":"goatcitadel.remote-worker-inference-frame.v1","kind":"output_text","text":"x"}',
               @payload, @prev, @self, @route, NULL, 1, @now)`,
          )
          .run({
            assignmentId: a.assignmentId,
            gen: a.assignmentGeneration,
            payload: D("p"),
            prev: frame.frame.frameSha256,
            self: D("s"),
            route: D("route"),
            now: a.now,
          }),
      /out of order/u,
    );
  });

  it("bounds acknowledgement to delivered frames and forbids regression", () => {
    const a = seedAuthority("ack");
    a.repo.admitOrReplay(admissionFor(a));
    a.repo.claimDispatch(claimInputFor(a, "owner-a"));
    a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "owner-a", text: "one", now: a.now });
    assert.throws(() => a.repo.acknowledge(keyFor(a), 5, a.now), /cannot exceed/u);
    a.repo.acknowledge(keyFor(a), 1, a.now);
    assert.throws(() => a.repo.acknowledge(keyFor(a), 0, a.now), /cannot regress/u);
  });

  it("marks dispatch_unknown without a terminal frame and blocks late finalization", () => {
    const a = seedAuthority("unknown");
    a.repo.admitOrReplay(admissionFor(a));
    a.repo.claimDispatch(claimInputFor(a, "owner-a"));
    const unknown = a.repo.markDispatchUnknown(keyFor(a), { dispatchClaimOwner: "owner-a", now: a.now });
    assert.equal(unknown.state, "dispatch_unknown");
    assert.equal(unknown.accountingDisposition, "unknown");
    assert.equal(unknown.terminalFrameSequence, undefined);
    assert.throws(
      () =>
        a.repo.finalizeTerminal({
          ...keyFor(a),
          dispatchClaimOwner: "owner-a",
          terminalState: "completed",
          usageEventIds: ["late-usage"],
          now: a.now,
        }),
      /cannot terminate from state dispatch_unknown/u,
    );
  });

  it("permits release only for a blocked never-dispatched reservation", () => {
    const blocked = seedAuthority("released-blocked");
    blocked.repo.admitOrReplay(admissionFor(blocked));
    claimInputFor(blocked, "owner-a"); // records the exact reservation without claiming dispatch
    const intent = blocked.repo.recordBudgetReleaseIntent(keyFor(blocked), {
      blockReason: "pre_dispatch_authority_lost",
      reason: "pre_dispatch_authority_lost",
      now: blocked.now,
    });
    assert.equal(intent.state, "blocked");
    assert.equal(intent.budgetAuthorityState, "reserved");
    assert.throws(
      () =>
        blocked.db
          .prepare(
            "UPDATE remote_worker_inference_requests SET budget_release_reason = 'governance_denied' WHERE inference_request_id = 'inference-1'",
          )
          .run(),
      /immutable/u,
    );
    const released = blocked.repo.markBudgetReleased(keyFor(blocked), "pre_dispatch_authority_lost", blocked.now);
    assert.equal(released.state, "blocked");
    assert.equal(released.budgetAuthorityState, "released");
    for (const mutation of [
      "budget_authority_state = 'reserved'",
      "accounting_disposition = 'unknown'",
      "budget_release_requested_at = '2098-01-01T00:00:00.000Z'",
    ]) {
      assert.throws(
        () =>
          blocked.db
            .prepare(
              `UPDATE remote_worker_inference_requests SET ${mutation} WHERE inference_request_id = 'inference-1'`,
            )
            .run(),
        /authority transition|evidence is incomplete|immutable/u,
      );
    }

    for (const terminalState of ["completed", "failed", "cancelled"] as const) {
      const terminal = seedAuthority(`released-${terminalState}`);
      terminal.repo.admitOrReplay(admissionFor(terminal));
      terminal.repo.claimDispatch(claimInputFor(terminal, "owner-a"));
      terminal.repo.finalizeTerminal({
        ...keyFor(terminal),
        dispatchClaimOwner: "owner-a",
        terminalState,
        usageEventIds: [`usage-${terminalState}`],
        now: terminal.now,
      });
      assert.throws(
        () =>
          terminal.db
            .prepare(
              `UPDATE remote_worker_inference_requests
               SET budget_authority_state = 'released', budget_released_at = @now
               WHERE inference_request_id = 'inference-1'`,
            )
            .run({ now: terminal.now }),
        /authority transition|incomplete/u,
      );
    }
  });

  it("moves expired claimed and streaming rows to reconciliation without redispatch authority", () => {
    for (const sourceState of ["dispatch_claimed", "streaming"] as const) {
      const a = seedAuthority(`expired-${sourceState}`);
      a.repo.admitOrReplay(admissionFor(a));
      a.repo.claimDispatch(claimInputFor(a, "owner-a"));
      if (sourceState === "streaming") {
        a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "owner-a", text: "partial", now: a.now });
      }
      a.db
        .prepare(
          "UPDATE remote_worker_inference_requests SET dispatch_lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE inference_request_id = 'inference-1'",
        )
        .run();
      const recovered = a.repo.recoverExpiredDispatchUnknown(keyFor(a), a.now);
      assert.equal(recovered?.state, "dispatch_unknown");
      assert.equal(recovered?.budgetAuthorityState, "reconciliation_required");
      assert.equal(recovered?.usageIntentEventId, undefined);
    }
  });

  it("replays durable outbox frames strictly after the acknowledgement watermark", () => {
    const a = seedAuthority("replay");
    a.repo.admitOrReplay(admissionFor(a));
    a.repo.claimDispatch(claimInputFor(a, "owner-a"));
    a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "owner-a", text: "a", now: a.now });
    a.repo.appendOutputFrame({ ...keyFor(a), dispatchClaimOwner: "owner-a", text: "b", now: a.now });
    a.repo.acknowledge(keyFor(a), 1, a.now);
    const pending = a.repo.listFramesAfter(keyFor(a), 1);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.frameSequence, 2);
    // A fresh repository instance over the same durable rows replays identically.
    const restarted = new RemoteWorkerInferenceRepository(a.db);
    assert.deepEqual(
      restarted.listFramesAfter(keyFor(a), 1).map((frame) => frame.frameSequence),
      [2],
    );
  });
});
