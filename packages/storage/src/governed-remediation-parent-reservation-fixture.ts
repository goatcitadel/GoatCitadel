import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJsonString, GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION, GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION, GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION, GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION, type GovernedRemediationStateRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { GovernedRemediationRepository } from "./governed-remediation-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const fixtureLeaseToken = Buffer.alloc(32, 3).toString("base64url");
const fixtureLeaseHash = createHash("sha256").update(Buffer.from(fixtureLeaseToken, "base64url")).digest("hex");

export function createRemediationParentFixture(db: DatabaseClient) {
  const fixture = createContinuationFixture(db);
  const checkpoint = new DurableRunRepository(db).createCheckpoint({
    runId: fixture.runId, checkpointKind: "run_waiting", state: {},
  });
  const input = createRemediationParentState(db, {
    ...fixture.resolution.admissionIdentity,
    durableRunId: fixture.runId, blockedCheckpointId: checkpoint.checkpointId,
  }, "remediation-parent-test", 2);
  return { ...fixture, input };
}

export function createRemediationParentState(
  db: DatabaseClient,
  identity: import("./session-mutation-admission-repo.js").TurnWriteAdmissionIdentity & { durableRunId: string; blockedCheckpointId: string },
  remediationId: string,
  waitingVersion: number,
): import("./session-mutation-admission-repo.js").ReserveDurableChatRemediationInput {
  const now = new Date().toISOString();
  const record: GovernedRemediationStateRecord = {
    schemaVersion: GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
    remediationId, workspaceId: identity.workspaceId, sessionId: identity.sessionId,
    sourceTurnId: identity.turnId, durableRunId: identity.durableRunId,
    blockedCheckpointId: identity.blockedCheckpointId, requesterActorId: "operator-a",
    recipeId: "recipe.budgets.mirror", recipeVersion: 1, recipeSha256: "a".repeat(64),
    scope: { schemaVersion: GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION, deploymentId: "deployment-local",
      scopeKind: "workspace", scopeId: identity.workspaceId, targetId: "budgets-mirror" },
    state: "blocked", revision: 1, expectedWaitingRunVersion: waitingVersion,
    expectedOwnerRevision: "owner-revision-1", parentReservationId: null,
    promptId: null, promptExpiresAt: null, preEffectApprovalId: null, activationApprovalId: null,
    effectId: null, latestReceiptId: null, failureId: null, reconciliationId: null,
    createdAt: now, updatedAt: now,
  };
  const owner = new GovernedRemediationRepository(db);
  owner.createState({ ownerId: "budgets-owner", record, idempotencyKey: `create-${remediationId}` });
  owner.transitionState({ ownerId: "budgets-owner", expectedRevision: 1,
    next: { ...record, state: "offered", revision: 2 },
    idempotencyKey: `offer-${remediationId}`, recordedAt: now });
  const input = { ...identity, remediationId, requesterActorId: record.requesterActorId,
    stateRevision: 2, expectedWaitingRunVersion: waitingVersion, recipeSha256: record.recipeSha256,
    effectId: `effect-${remediationId}`, expectedOwnerRevision: record.expectedOwnerRevision!,
    preEffectApprovalId: null, promptId: null, operationId: `operation-${remediationId}`,
    idempotencyKey: `reserve-${remediationId}` };
  assert.equal(owner.acquirePhaseClaim({ claimId: `claim-${remediationId}`, aggregateKind: "state",
    aggregateId: remediationId, remediationId, phase: "parent_reserve", claimantId: "gateway-test",
    expectedAggregateRevision: 2, operationId: input.operationId, effectId: input.effectId,
    expectedOwnerRevision: input.expectedOwnerRevision, leaseTokenSha256: fixtureLeaseHash,
    leaseDurationSeconds: 300, acquisitionIdempotencyKey: `claim-${remediationId}`,
  }).disposition, "acquired");
  return input;
}

export function createRemediationReleaseFixture(db: DatabaseClient, uncertain: boolean | "rollback" | "misreported" = false) {
  const fixture = createRemediationParentFixture(db);
  const { input } = fixture;
  const reserved = fixture.repo.reserveDurableChatRemediation(input);
  const owner = new GovernedRemediationRepository(db);
  const offered = owner.getState(input.remediationId).record;
  const applying = { ...offered, state: "applying" as const, revision: 3,
    parentReservationId: reserved.reservationId, effectId: input.effectId };
  owner.publishClaimedPhaseOutcome({ claim: { remediationId: input.remediationId, phase: "parent_reserve",
    claimId: `claim-${input.remediationId}`, claimRevision: 1, claimantId: "gateway-test", leaseToken: fixtureLeaseToken },
    expectedAggregateRevision: 2, outcome: { kind: "state_transition", nextState: applying }, publicationIdempotencyKey: "publish-parent",
  });
  const claim = owner.acquirePhaseClaim({ claimId: "release-fixture-apply", aggregateKind: "state",
    aggregateId: input.remediationId, remediationId: input.remediationId, phase: "apply", claimantId: "gateway-test",
    expectedAggregateRevision: 3, operationId: "apply-release-fixture", effectId: input.effectId,
    expectedOwnerRevision: input.expectedOwnerRevision, leaseTokenSha256: fixtureLeaseHash,
    leaseDurationSeconds: 300, acquisitionIdempotencyKey: "claim-release-fixture-apply" });
  assert.equal(claim.disposition, "acquired");
  assert.ok(claim.claim);
  if (uncertain === "rollback" || uncertain === "misreported") {
    const application = { schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION, receiptId: "release-application",
      remediationId: input.remediationId, recipeId: offered.recipeId, recipeVersion: offered.recipeVersion, scope: offered.scope,
      kind: "application" as const, recordedAt: offered.updatedAt, ownerId: "budgets-owner", effectId: input.effectId,
      ownerRevisionBefore: input.expectedOwnerRevision, ownerRevisionAfter: "owner-revision-2" };
    const verifying = { ...applying, state: "verifying" as const, revision: 4, latestReceiptId: application.receiptId };
    owner.publishClaimedPhaseOutcome({ claim: { remediationId: input.remediationId, phase: "apply", claimId: claim.claim.claimId,
      claimRevision: claim.claim.claimRevision, claimantId: "gateway-test", leaseToken: fixtureLeaseToken },
      expectedAggregateRevision: 3, outcome: { kind: "state_receipt", receipt: application, nextState: verifying },
      publicationIdempotencyKey: "publish-release-application" });
    const verificationFailure = { schemaVersion: GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
      failureId: "release-verification-failure", remediationId: input.remediationId,
      recipeId: offered.recipeId, recipeVersion: offered.recipeVersion, scope: offered.scope,
      phase: "verify" as const, reason: "verification_failed" as const,
      effectBoundary: uncertain === "misreported" ? "not_crossed" as const : "crossed" as const,
      disposition: uncertain === "misreported" ? "terminal_no_effect" as const : "rollback_required" as const,
      ownerRevisionObserved: "owner-revision-2", occurredAt: offered.updatedAt };
    const rollingBack = { ...verifying, state: "rolling_back" as const, revision: 5, failureId: verificationFailure.failureId };
    for (const [phase, revision] of [["verify", 4], ["rollback", 5]] as const) {
      const acquired = owner.acquirePhaseClaim({ claimId: `release-${phase}`, aggregateKind: "state", aggregateId: input.remediationId,
        remediationId: input.remediationId, phase, claimantId: "gateway-test", expectedAggregateRevision: revision,
        operationId: `release-${phase}`, effectId: input.effectId, expectedOwnerRevision: "owner-revision-2",
        leaseTokenSha256: fixtureLeaseHash, leaseDurationSeconds: 300, acquisitionIdempotencyKey: `acquire-release-${phase}` });
      assert.equal(acquired.disposition, "acquired");
      assert.ok(acquired.claim);
      const rollback = { schemaVersion: application.schemaVersion, remediationId: input.remediationId,
        recipeId: offered.recipeId, recipeVersion: offered.recipeVersion, scope: offered.scope, recordedAt: offered.updatedAt,
        receiptId: "release-rollback", kind: "rollback" as const,
        applicationReceiptId: application.receiptId, rollbackStrategy: "restore_previous" as const,
        outcome: "rolled_back" as const, ownerRevisionBefore: "owner-revision-2", ownerRevisionAfter: "owner-revision-3" };
      owner.publishClaimedPhaseOutcome({ claim: { remediationId: input.remediationId, phase, claimId: acquired.claim.claimId,
        claimRevision: acquired.claim.claimRevision, claimantId: "gateway-test", leaseToken: fixtureLeaseToken },
        expectedAggregateRevision: revision, outcome: phase === "verify" ? { kind: "state_failure", failure: verificationFailure,
          nextState: uncertain === "misreported" ? { ...rollingBack, state: "failed" } : rollingBack }
          : { kind: "state_receipt", receipt: rollback, nextState: { ...rollingBack, state: "rolled_back", revision: 6, latestReceiptId: rollback.receiptId } },
        publicationIdempotencyKey: `publish-release-${phase}` });
      if (uncertain === "misreported") return { ...fixture, release: { ...input, reservationId: reserved.reservationId,
        stateRevision: 5, expectedReservedRunVersion: 3, receiptId: null, failureId: verificationFailure.failureId,
        operationId: "release-parent", idempotencyKey: "release-parent" } };
    }
    return { ...fixture, release: { ...input, reservationId: reserved.reservationId, stateRevision: 6,
      expectedReservedRunVersion: 3, receiptId: "release-rollback", failureId: null,
      operationId: "release-parent", idempotencyKey: "release-parent" } };
  }
  const failure = { schemaVersion: GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION, failureId: "release-fixture-failure",
    remediationId: input.remediationId, recipeId: offered.recipeId, recipeVersion: offered.recipeVersion, scope: offered.scope,
    phase: "apply" as const, reason: "owner_unavailable" as const, effectBoundary: uncertain ? "unknown" as const : "not_crossed" as const,
    disposition: uncertain ? "manual_required" as const : "terminal_no_effect" as const,
    ownerRevisionObserved: input.expectedOwnerRevision, occurredAt: offered.updatedAt };
  owner.publishClaimedPhaseOutcome({ claim: { remediationId: input.remediationId, phase: "apply",
    claimId: claim.claim.claimId, claimRevision: claim.claim.claimRevision, claimantId: "gateway-test", leaseToken: fixtureLeaseToken },
    expectedAggregateRevision: 3, outcome: { kind: "state_failure", failure,
      nextState: { ...applying, state: "failed", revision: 4, failureId: failure.failureId } },
    publicationIdempotencyKey: "publish-release-fixture-failure" });
  return { ...fixture, release: { ...input, reservationId: reserved.reservationId, stateRevision: 4,
    expectedReservedRunVersion: 3, receiptId: null, failureId: failure.failureId,
    operationId: "release-parent", idempotencyKey: "release-parent" } };
}

export function createRemediationResumeFixture(db: DatabaseClient) {
  const fixture = createRemediationParentFixture(db);
  const { input } = fixture;
  const reserved = fixture.repo.reserveDurableChatRemediation(input);
  const owner = new GovernedRemediationRepository(db);
  const offered = owner.getState(input.remediationId).record;
  const applying = { ...offered, state: "applying" as const, revision: 3,
    parentReservationId: reserved.reservationId, effectId: input.effectId };
  owner.publishClaimedPhaseOutcome({ claim: { remediationId: input.remediationId, phase: "parent_reserve",
    claimId: `claim-${input.remediationId}`, claimRevision: 1, claimantId: "gateway-test", leaseToken: fixtureLeaseToken },
    expectedAggregateRevision: 2, outcome: { kind: "state_transition", nextState: applying }, publicationIdempotencyKey: "publish-parent" });
  const acquire = (phase: "apply" | "verify" | "resume", revision: number, ownerRevision: string) => {
    const acquired = owner.acquirePhaseClaim({ claimId: `resume-fixture-${phase}`, aggregateKind: "state",
      aggregateId: input.remediationId, remediationId: input.remediationId, phase, claimantId: "gateway-test",
      expectedAggregateRevision: revision, operationId: `resume-fixture-${phase}`, effectId: input.effectId,
      expectedOwnerRevision: ownerRevision, leaseTokenSha256: fixtureLeaseHash, leaseDurationSeconds: 300,
      acquisitionIdempotencyKey: `acquire-resume-${phase}` });
    assert.equal(acquired.disposition, "acquired");
    assert.ok(acquired.claim);
    return { remediationId: input.remediationId, phase, claimId: acquired.claim.claimId,
      claimRevision: acquired.claim.claimRevision, claimantId: "gateway-test", leaseToken: fixtureLeaseToken };
  };
  const application = { schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION, receiptId: "resume-application",
    remediationId: input.remediationId, recipeId: offered.recipeId, recipeVersion: offered.recipeVersion, scope: offered.scope,
    kind: "application" as const, recordedAt: offered.updatedAt, ownerId: "budgets-owner", effectId: input.effectId,
    ownerRevisionBefore: input.expectedOwnerRevision, ownerRevisionAfter: "owner-revision-2" };
  const verifying = { ...applying, state: "verifying" as const, revision: 4, latestReceiptId: application.receiptId };
  owner.publishClaimedPhaseOutcome({ claim: acquire("apply", 3, input.expectedOwnerRevision), expectedAggregateRevision: 3,
    outcome: { kind: "state_receipt", receipt: application, nextState: verifying }, publicationIdempotencyKey: "publish-resume-application" });
  const verification = { schemaVersion: application.schemaVersion, receiptId: "resume-verification",
    remediationId: input.remediationId, recipeId: offered.recipeId, recipeVersion: offered.recipeVersion, scope: offered.scope,
    kind: "verification" as const, recordedAt: offered.updatedAt, applicationReceiptId: application.receiptId,
    activationReceiptId: null, probeId: "budgets-mirror-probe", probeResult: "accepted" as const, ownerRevisionObserved: "owner-revision-2" };
  const verified = { ...verifying, state: "verified" as const, revision: 5, latestReceiptId: verification.receiptId };
  owner.publishClaimedPhaseOutcome({ claim: acquire("verify", 4, "owner-revision-2"), expectedAggregateRevision: 4,
    outcome: { kind: "state_receipt", receipt: verification, nextState: verified }, publicationIdempotencyKey: "publish-resume-verification" });
  owner.transitionState({ ownerId: "budgets-owner", expectedRevision: 5, next: { ...verified, state: "resuming", revision: 6 },
    idempotencyKey: "begin-resume", recordedAt: offered.updatedAt });
  acquire("resume", 6, "owner-revision-2");
  return { ...fixture, resume: { ...input, reservationId: reserved.reservationId, stateRevision: 6,
    expectedReservedRunVersion: 3, verificationReceiptId: verification.receiptId, promptId: fixture.resolution.promptId,
    operationId: "resume-fixture-resume", idempotencyKey: "resume-parent" } };
}

function createContinuationFixture(db: DatabaseClient) {
  const workspaceId = "workspace-continuation";
  const sessionId = "session-continuation";
  const turnId = "turn-continuation";
  const runId = "run-continuation";
  const promptId = "prompt-continuation";
  const lifecycle = new ChatSessionLifecycleRepository(db).initialize({
    workspaceId,
    sessionId,
    actorId: "operator-a",
    idempotencyKey: "lifecycle:init:session-continuation",
    correlationId: "correlation:init:session-continuation",
  });
  const actorKind = "operator" as const;
  const actorId = "operator-a";
  const controllerGeneration = 1;
  const request = { content: "Continue after operator input." };
  const materialSha256 = sha256(canonicalJsonString({ version: 2, request }));
  const repo = new SessionMutationAdmissionRepository(db);
  const admitted = repo.admit({
    workspaceId,
    sessionId,
    expectedSessionIncarnationId: lifecycle.intent.sessionIncarnationId,
    turnId,
    runtimeOwnerId: "request-runtime-continuation",
    admissionKind: "turn_write",
    aggregateRevision: 1,
    controllerGeneration,
    actorKind,
    actorId,
    operation: "chat.turn.execute",
    materialSha256,
    idempotencyKey: "admission:continuation",
    correlationId: "correlation:continuation",
  }).admission;
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: admitted.admissionId,
    sessionIncarnationId: admitted.sessionIncarnationId,
    admissionMaterialSha256: materialSha256,
    workspaceId,
    admissionAggregateRevision: 1,
    admissionControllerGeneration: controllerGeneration,
    sessionId,
    turnId,
    request,
    requestActor: { actorKind, actorId },
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId },
    userMessageId: "message-continuation",
    assistantMessageId: "assistant-continuation",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    effectiveRequestMaterialSha256: sha256(
      canonicalJsonString({ version: 1, admissionMaterialSha256: materialSha256, request }),
    ),
    userInputResponses: [],
  };
  const pendingPrompt = {
    promptId,
    turnId,
    kind: "text",
    title: "Operator input",
    question: "What should the durable run do next?",
  };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO durable_runs (
       run_id, workflow_key, status, attempt_count, max_attempts, payload_json, metadata_json,
       version, created_at, updated_at
     ) VALUES (
       @runId, 'chat.turn.execute', 'waiting', 0, 3, @payloadJson, @metadataJson,
       2, @now, @now
     )`,
  ).run({
    runId,
    payloadJson: canonicalJsonString(payload),
    metadataJson: canonicalJsonString({
      waitForEvent: { eventKey: "chat.user_input.resolved", correlationId: promptId },
    }),
    now,
  });
  db.prepare(
    `INSERT INTO chat_turn_traces (
       turn_id, session_id, user_message_id, status, mode, web_mode, memory_mode,
       thinking_level, routing_json, pending_user_input_json, durable_json, started_at
     ) VALUES (
       @turnId, @sessionId, 'message-continuation', 'waiting_for_user_input', 'chat',
       'off', 'off', 'standard', '{}', @pendingUserInputJson, @durableJson, @now
     )`,
  ).run({
    turnId,
    sessionId,
    pendingUserInputJson: canonicalJsonString(pendingPrompt),
    durableJson: canonicalJsonString({ runId }),
    now,
  });
  repo.bindDurableRun({
    admissionId: admitted.admissionId,
    sessionIncarnationId: admitted.sessionIncarnationId,
    workspaceId,
    sessionId,
    turnId,
    durableRunId: runId,
    requestRuntimeClaim: {
      runtimeOwnerId: admitted.runtimeOwnerId!,
      leaseRevision: admitted.runtimeLeaseRevision!,
    },
  });
  return {
    repo,
    runId,
    turnId,
    resolution: {
      admissionIdentity: {
        admissionId: admitted.admissionId,
        sessionIncarnationId: admitted.sessionIncarnationId,
        workspaceId,
        sessionId,
        turnId,
        aggregateRevision: 1,
        controllerGeneration,
        materialSha256,
      },
      durableRunId: runId,
      expectedWaitingRunVersion: 2,
      promptId,
      eventKey: "chat.user_input.resolved" as const,
      correlationId: promptId,
      responder: { actorId: "operator-a", authActorSource: "token" as const },
      response: { kind: "text" as const, text: "Proceed with the verified plan." },
    },
  };
}
