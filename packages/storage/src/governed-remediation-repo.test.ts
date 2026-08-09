import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
  type GovernedRemediationFailure,
  type GovernedRemediationReceipt,
  type GovernedRemediationReconciliation,
  type GovernedRemediationScope,
  type GovernedRemediationStateRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { GovernedRemediationRepository } from "./governed-remediation-repo.js";
import { createDatabase } from "./sqlite.js";

const opened: DatabaseClient[] = [];
const files: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const file of files.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.rmSync(candidate, { force: true });
      } catch {
        // Best-effort test cleanup.
      }
    }
  }
});

function createStore(): { db: DatabaseClient; repo: GovernedRemediationRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-governed-remediation-${randomUUID()}.db`);
  files.push(dbPath);
  const db = createDatabase({ dbPath });
  opened.push(db);
  return { db, repo: new GovernedRemediationRepository(db) };
}

const scope: GovernedRemediationScope = {
  schemaVersion: GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  deploymentId: "deployment-local",
  scopeKind: "workspace",
  scopeId: "workspace-1",
  targetId: "search-connection",
};

function state(overrides: Partial<GovernedRemediationStateRecord> = {}): GovernedRemediationStateRecord {
  return {
    schemaVersion: GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
    remediationId: "remediation-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sourceTurnId: "turn-1",
    durableRunId: "durable-run-1",
    blockedCheckpointId: "checkpoint-1",
    requesterActorId: "actor-1",
    recipeId: "recipe.search.connection",
    recipeVersion: 1,
    recipeSha256: "a".repeat(64),
    scope,
    state: "blocked",
    revision: 1,
    expectedWaitingRunVersion: 4,
    expectedOwnerRevision: "owner-revision-1",
    parentReservationId: null,
    promptId: null,
    promptExpiresAt: null,
    preEffectApprovalId: null,
    activationApprovalId: null,
    effectId: null,
    latestReceiptId: null,
    failureId: null,
    reconciliationId: null,
    createdAt: "2026-08-08T18:00:00.000Z",
    updatedAt: "2026-08-08T18:00:00.000Z",
    ...overrides,
  };
}

function failure(overrides: Partial<GovernedRemediationFailure> = {}): GovernedRemediationFailure {
  return {
    schemaVersion: GOVERNED_REMEDIATION_FAILURE_SCHEMA_VERSION,
    failureId: "failure-1",
    remediationId: "remediation-1",
    recipeId: "recipe.search.connection",
    recipeVersion: 1,
    scope,
    phase: "rollback",
    reason: "rollback_failed",
    effectBoundary: "unknown",
    disposition: "manual_required",
    ownerRevisionObserved: "owner-revision-2",
    occurredAt: "2026-08-08T18:03:00.000Z",
    ...overrides,
  };
}

function reconciliation(overrides: Partial<GovernedRemediationReconciliation> = {}): GovernedRemediationReconciliation {
  return {
    schemaVersion: GOVERNED_REMEDIATION_RECONCILIATION_SCHEMA_VERSION,
    reconciliationId: "reconciliation-1",
    remediationId: "remediation-1",
    failureId: "failure-1",
    recipeId: "recipe.search.connection",
    recipeVersion: 1,
    scope,
    domain: "effect",
    reason: "rollback_failed",
    observation: "unknown",
    state: "open",
    ownerRevisionObserved: "owner-revision-2",
    resolutionReceiptId: null,
    revision: 1,
    createdAt: "2026-08-08T18:04:00.000Z",
    updatedAt: "2026-08-08T18:04:00.000Z",
    ...overrides,
  };
}

function claimWitness(
  repo: GovernedRemediationRepository,
  input: {
    claimId: string;
    phase:
      | "parent_reserve"
      | "apply"
      | "verify"
      | "activate_and_verify"
      | "rollback"
      | "resume"
      | "effect_reconcile"
      | "resume_reconcile";
    expectedRevision: number;
    effectId: string;
    expectedOwnerRevision: string | null;
    aggregateKind?: "state" | "reconciliation";
    aggregateId?: string;
    remediationId?: string;
  },
) {
  const leaseToken = Buffer.alloc(32, input.claimId.charCodeAt(input.claimId.length - 1) % 251).toString("base64url");
  const aggregateKind = input.aggregateKind ?? "state";
  const remediationId = input.remediationId ?? "remediation-1";
  const result = repo.acquirePhaseClaim({
    claimId: input.claimId,
    aggregateKind,
    aggregateId: input.aggregateId ?? remediationId,
    remediationId,
    phase: input.phase,
    claimantId: "gateway-test",
    expectedAggregateRevision: input.expectedRevision,
    operationId: "operation-" + input.claimId,
    effectId: input.effectId,
    expectedOwnerRevision: input.expectedOwnerRevision,
    leaseTokenSha256: createHash("sha256").update(Buffer.from(leaseToken, "base64url")).digest("hex"),
    leaseDurationSeconds: 300,
    acquisitionIdempotencyKey: "acquire-" + input.claimId,
  });
  assert.equal(result.disposition, "acquired");
  assert.ok(result.claim);
  return {
    remediationId,
    phase: input.phase,
    claimId: input.claimId,
    claimRevision: result.claim.claimRevision,
    claimantId: "gateway-test",
    leaseToken,
  };
}

describe("GovernedRemediationRepository", () => {
  it("creates exact owner-scoped state and advances it with durable idempotent CAS", () => {
    const { repo } = createStore();
    const created = repo.createState({ ownerId: "connection-owner", record: state(), idempotencyKey: "create-1" });
    assert.deepEqual(created, { ownerId: "connection-owner", record: state() });
    assert.deepEqual(
      repo.createState({ ownerId: "connection-owner", record: state(), idempotencyKey: "create-1" }),
      created,
    );
    assert.equal(
      repo.findScopedState({ remediationId: "remediation-1", ownerId: "connection-owner", scope })?.record.state,
      "blocked",
    );
    assert.equal(
      repo.findScopedState({ remediationId: "remediation-1", ownerId: "different-owner", scope }),
      undefined,
    );
    assert.equal(
      repo.findLatestStateByOwnerScope({
        ownerId: "connection-owner",
        scope: { ...scope, scopeId: "workspace-other" },
      }),
      undefined,
    );

    const offered = state({ state: "offered", revision: 2, updatedAt: "2026-08-08T18:01:00.000Z" });
    const first = repo.transitionState({
      ownerId: "connection-owner",
      expectedRevision: 1,
      next: offered,
      idempotencyKey: "transition-1",
      recordedAt: offered.updatedAt,
    });
    assert.equal(first.replayed, false);
    assert.equal(first.appliedRevision, 2);
    assert.equal(first.record.record.state, "offered");

    assert.throws(
      () =>
        repo.transitionState({
          ownerId: "connection-owner",
          expectedRevision: 2,
          next: state({
            state: "manual_required",
            revision: 3,
            recipeSha256: "b".repeat(64),
            updatedAt: "2026-08-08T18:02:00.000Z",
          }),
          idempotencyKey: "transition-recipe-drift",
          recordedAt: "2026-08-08T18:02:00.000Z",
        }),
      /immutable binding/u,
    );

    const replay = repo.transitionState({
      ownerId: "connection-owner",
      expectedRevision: 1,
      next: offered,
      idempotencyKey: "transition-1",
      recordedAt: offered.updatedAt,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.appliedRevision, 2);
    assert.throws(
      () =>
        repo.transitionState({
          ownerId: "connection-owner",
          expectedRevision: 1,
          next: state({ state: "manual_required", revision: 2, updatedAt: offered.updatedAt }),
          idempotencyKey: "transition-1",
          recordedAt: offered.updatedAt,
        }),
      /conflicts with durable governed-remediation authority/u,
    );

    assert.throws(
      () =>
        repo.transitionState({
          ownerId: "connection-owner",
          expectedRevision: 2,
          next: state({ state: "applying", revision: 3, updatedAt: "2026-08-08T18:02:00.000Z" }),
          idempotencyKey: "unclaimed-applying",
          recordedAt: "2026-08-08T18:02:00.000Z",
        }),
      /claimed phase state publication fence/u,
    );
    assert.throws(
      () =>
        repo.transitionState({
          ownerId: "connection-owner",
          expectedRevision: 2,
          next: state({
            state: "awaiting_preapproval",
            revision: 3,
            parentReservationId: "forged-reservation",
            effectId: "forged-effect",
            updatedAt: "2026-08-08T18:02:00.000Z",
          }),
          idempotencyKey: "unclaimed-parent-binding",
          recordedAt: "2026-08-08T18:02:00.000Z",
        }),
      /claimed parent reservation publication fence/u,
    );

    const reservationClaim = claimWitness(repo, {
      claimId: "basic-parent-claim",
      phase: "parent_reserve",
      expectedRevision: 2,
      effectId: "basic-effect",
      expectedOwnerRevision: "owner-revision-1",
    });
    const applying = state({
      state: "applying",
      revision: 3,
      parentReservationId: "basic-reservation",
      effectId: "basic-effect",
      updatedAt: "2026-08-08T18:02:00.000Z",
    });
    repo.publishClaimedPhaseOutcome({
      claim: reservationClaim,
      expectedAggregateRevision: 2,
      outcome: { kind: "state_transition", nextState: applying },
      publicationIdempotencyKey: "transition-2",
    });
    assert.deepEqual(
      repo.listStateRecoveryCandidates({ updatedBefore: applying.updatedAt }).map((item) => item.record.remediationId),
      ["remediation-1"],
    );
  });

  it("persists immutable typed receipts/failures and quarantined reconciliation recovery", () => {
    const { db, repo } = createStore();
    repo.createState({
      ownerId: "connection-owner",
      record: state(),
      idempotencyKey: "create-1",
    });
    const offered = state({ state: "offered", revision: 2, updatedAt: "2026-08-08T18:01:00.000Z" });
    repo.transitionState({
      ownerId: "connection-owner",
      expectedRevision: 1,
      next: offered,
      idempotencyKey: "offer-for-child-lineage",
      recordedAt: offered.updatedAt,
    });
    const reservationClaim = claimWitness(repo, {
      claimId: "child-lineage-parent-claim",
      phase: "parent_reserve",
      expectedRevision: 2,
      effectId: "effect-1",
      expectedOwnerRevision: "owner-revision-1",
    });
    const applying = state({
      state: "applying",
      revision: 3,
      parentReservationId: "child-lineage-reservation",
      effectId: "effect-1",
      updatedAt: "2026-08-08T18:01:30.000Z",
    });
    repo.publishClaimedPhaseOutcome({
      claim: reservationClaim,
      expectedAggregateRevision: 2,
      outcome: { kind: "state_transition", nextState: applying },
      publicationIdempotencyKey: "publish-child-lineage-parent",
    });
    (repo as unknown as { claimedPublicationDepth: number }).claimedPublicationDepth = 1;
    const application: GovernedRemediationReceipt = {
      schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
      receiptId: "receipt-application-1",
      remediationId: "remediation-1",
      recipeId: "recipe.search.connection",
      recipeVersion: 1,
      scope,
      kind: "application",
      ownerId: "connection-owner",
      effectId: "effect-1",
      ownerRevisionBefore: "owner-revision-1",
      ownerRevisionAfter: "owner-revision-2",
      recordedAt: "2026-08-08T18:02:00.000Z",
    };
    assert.deepEqual(repo.appendReceipt({ receipt: application, idempotencyKey: "receipt-application" }), application);
    assert.deepEqual(repo.appendReceipt({ receipt: application, idempotencyKey: "receipt-application" }), application);
    const verifyingWithApplication = state({
      state: "verifying",
      revision: 4,
      parentReservationId: "child-lineage-reservation",
      effectId: "effect-1",
      latestReceiptId: application.receiptId,
      updatedAt: "2026-08-08T18:02:01.000Z",
    });
    repo.transitionState({
      ownerId: "connection-owner",
      expectedRevision: 3,
      next: verifyingWithApplication,
      idempotencyKey: "transition-application",
      recordedAt: verifyingWithApplication.updatedAt,
    });

    const rollback: GovernedRemediationReceipt = {
      schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
      receiptId: "receipt-rollback-1",
      remediationId: "remediation-1",
      recipeId: "recipe.search.connection",
      recipeVersion: 1,
      scope,
      kind: "rollback",
      applicationReceiptId: application.receiptId,
      rollbackStrategy: "restore_previous",
      outcome: "rolled_back",
      ownerRevisionBefore: application.ownerRevisionAfter,
      ownerRevisionAfter: "owner-revision-restored",
      recordedAt: "2026-08-08T18:02:30.000Z",
    };
    assert.deepEqual(repo.appendReceipt({ receipt: rollback, idempotencyKey: "receipt-rollback" }), rollback);

    const typedFailure = failure();
    assert.deepEqual(repo.appendFailure({ failure: typedFailure, idempotencyKey: "failure-key-1" }), typedFailure);
    assert.deepEqual(repo.listFailures("remediation-1"), [typedFailure]);

    const open = reconciliation();
    assert.deepEqual(
      repo.createReconciliation({ reconciliation: open, idempotencyKey: "reconciliation-create-1" }),
      open,
    );
    assert.equal(
      repo.findScopedReconciliation({
        reconciliationId: open.reconciliationId,
        ownerId: "connection-owner",
        scope,
      })?.state,
      "open",
    );
    assert.equal(
      repo.findScopedReconciliation({
        reconciliationId: open.reconciliationId,
        ownerId: "different-owner",
        scope,
      }),
      undefined,
    );
    assert.deepEqual(
      repo.listReconciliationRecoveryCandidates().map((item) => item.reconciliationId),
      ["reconciliation-1"],
    );
    const quarantined = reconciliation({
      state: "quarantined",
      revision: 2,
      updatedAt: "2026-08-08T18:05:00.000Z",
    });
    const quarantinedResult = repo.transitionReconciliation({
      expectedRevision: 1,
      next: quarantined,
      idempotencyKey: "reconciliation-transition-1",
      recordedAt: quarantined.updatedAt,
    });
    assert.equal(quarantinedResult.record.state, "quarantined");
    assert.equal(
      repo.listReconciliationRecoveryCandidates()[0]?.state,
      "quarantined",
      "quarantine has recovery priority",
    );

    const resolutionReceipt: GovernedRemediationReceipt = {
      schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
      receiptId: "receipt-reconciliation-1",
      remediationId: "remediation-1",
      recipeId: "recipe.search.connection",
      recipeVersion: 1,
      scope,
      kind: "reconciliation",
      reconciliationId: "reconciliation-1",
      failureId: "failure-1",
      resolution: "confirmed_no_effect",
      applicationReceiptId: null,
      resumeReceiptId: null,
      ownerRevisionObserved: "owner-revision-2",
      recordedAt: "2026-08-08T18:06:00.000Z",
    };
    repo.appendReceipt({ receipt: resolutionReceipt, idempotencyKey: "receipt-reconciliation" });
    const resolved = reconciliation({
      observation: "effect_absent",
      state: "resolved_no_effect",
      resolutionReceiptId: resolutionReceipt.receiptId,
      revision: 3,
      updatedAt: "2026-08-08T18:07:00.000Z",
    });
    repo.transitionReconciliation({
      expectedRevision: 2,
      next: resolved,
      idempotencyKey: "reconciliation-transition-2",
      recordedAt: resolved.updatedAt,
    });
    assert.deepEqual(repo.listReconciliationRecoveryCandidates(), []);

    assert.throws(
      () => db.prepare("UPDATE governed_remediation_receipts SET effect_id = 'effect-2'").run(),
      /immutable/u,
    );
    assert.throws(() => db.prepare("DELETE FROM governed_remediation_failures").run(), /immutable/u);
    assert.throws(() => db.prepare("DELETE FROM governed_remediation_reconciliations").run(), /cannot be deleted/u);
  });

  it("rejects direct state writes, wrong owner/scope children, and idempotency drift", () => {
    const { db, repo } = createStore();
    assert.throws(
      () =>
        repo.createState({
          ownerId: "connection-owner",
          record: state({ state: "applying", parentReservationId: "forged", effectId: "forged" }),
          idempotencyKey: "forged-create",
        }),
      /new remediation state authority/u,
    );
    repo.createState({ ownerId: "connection-owner", record: state(), idempotencyKey: "create-1" });
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE governed_remediation_states
             SET state = 'manual_required', revision = 2, updated_at = '2026-08-08T18:01:00.000Z'`,
          )
          .run(),
      /CAS|binding/u,
    );
    assert.throws(
      () =>
        repo.appendFailure({
          failure: failure({
            scope: { ...scope, scopeId: "workspace-other" },
            phase: "preflight",
            reason: "owner_unavailable",
            effectBoundary: "not_crossed",
          }),
          idempotencyKey: "wrong-scope",
        }),
      /owner or scope/u,
    );
    const first = failure({
      failureId: "failure-replay",
      reason: "owner_unavailable",
      phase: "preflight",
      effectBoundary: "not_crossed",
      disposition: "terminal_no_effect",
    });
    repo.appendFailure({ failure: first, idempotencyKey: "failure-replay-key" });
    assert.throws(
      () =>
        repo.appendFailure({
          failure: { ...first, failureId: "failure-different" },
          idempotencyKey: "failure-replay-key",
        }),
      /conflicts with durable governed-remediation authority/u,
    );
  });

  it("fences phase outcomes with hash-only DB-clock leases and publishes state plus receipt atomically", () => {
    const { db, repo } = createStore();
    repo.createState({ ownerId: "connection-owner", record: state(), idempotencyKey: "claim-create" });
    const offered = state({ state: "offered", revision: 2, updatedAt: "2026-08-08T18:01:00.000Z" });
    repo.transitionState({
      ownerId: "connection-owner",
      expectedRevision: 1,
      next: offered,
      idempotencyKey: "claim-offered",
      recordedAt: offered.updatedAt,
    });

    const reservationClaim = claimWitness(repo, {
      claimId: "claim-parent-1",
      phase: "parent_reserve",
      expectedRevision: 2,
      effectId: "effect-claim-1",
      expectedOwnerRevision: "owner-revision-1",
    });
    const applying = state({
      state: "applying",
      revision: 3,
      parentReservationId: "reservation-1",
      effectId: "effect-claim-1",
      updatedAt: "2026-08-08T18:02:00.000Z",
    });
    assert.throws(
      () =>
        repo.publishClaimedPhaseOutcome({
          claim: reservationClaim,
          expectedAggregateRevision: 2,
          outcome: { kind: "state_transition", nextState: { ...applying, state: "awaiting_preapproval" } },
          publicationIdempotencyKey: "publish-parent-wrong-state",
        }),
      /claimed parent reservation effect binding/u,
    );
    const reserved = repo.publishClaimedPhaseOutcome({
      claim: reservationClaim,
      expectedAggregateRevision: 2,
      outcome: { kind: "state_transition", nextState: applying },
      publicationIdempotencyKey: "publish-parent-1",
    });
    assert.equal(reserved.state?.record.parentReservationId, "reservation-1");
    assert.equal(
      repo.publishClaimedPhaseOutcome({
        claim: reservationClaim,
        expectedAggregateRevision: 2,
        outcome: { kind: "state_transition", nextState: applying },
        publicationIdempotencyKey: "publish-parent-1",
      }).replayed,
      true,
    );

    const applyClaim = claimWitness(repo, {
      claimId: "claim-apply-1",
      phase: "apply",
      expectedRevision: 3,
      effectId: "effect-claim-1",
      expectedOwnerRevision: "owner-revision-1",
    });
    const application: GovernedRemediationReceipt = {
      schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
      receiptId: "receipt-claim-application",
      remediationId: "remediation-1",
      recipeId: "recipe.search.connection",
      recipeVersion: 1,
      scope,
      kind: "application",
      ownerId: "connection-owner",
      effectId: "effect-claim-1",
      ownerRevisionBefore: "owner-revision-1",
      ownerRevisionAfter: "owner-revision-2",
      recordedAt: "2026-08-08T18:03:00.000Z",
    };
    const verifying = state({
      state: "verifying",
      revision: 4,
      parentReservationId: "reservation-1",
      effectId: "effect-claim-1",
      latestReceiptId: application.receiptId,
      updatedAt: "2026-08-08T18:03:00.000Z",
    });
    assert.throws(
      () =>
        repo.publishClaimedPhaseOutcome({
          claim: { ...applyClaim, leaseToken: Buffer.alloc(32, 99).toString("base64url") },
          expectedAggregateRevision: 3,
          outcome: { kind: "state_receipt", receipt: application, nextState: verifying },
          publicationIdempotencyKey: "publish-apply-1",
        }),
      /phase claim witness/u,
    );
    const published = repo.publishClaimedPhaseOutcome({
      claim: applyClaim,
      expectedAggregateRevision: 3,
      outcome: { kind: "state_receipt", receipt: application, nextState: verifying },
      publicationIdempotencyKey: "publish-apply-1",
    });
    assert.equal(published.state?.record.state, "verifying");
    assert.deepEqual(repo.getReceipt(application.receiptId), application);

    const verifyClaim = claimWitness(repo, {
      claimId: "claim-verify-1",
      phase: "verify",
      expectedRevision: 4,
      effectId: "effect-claim-1",
      expectedOwnerRevision: "owner-revision-2",
    });
    const initialVerification: GovernedRemediationReceipt = {
      schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
      receiptId: "receipt-claim-verification-initial",
      remediationId: "remediation-1",
      recipeId: "recipe.search.connection",
      recipeVersion: 1,
      scope,
      kind: "verification",
      applicationReceiptId: application.receiptId,
      activationReceiptId: null,
      probeId: "probe-initial",
      probeResult: "accepted",
      ownerRevisionObserved: "owner-revision-2",
      recordedAt: "2026-08-08T18:04:00.000Z",
    };
    const credentialVerified = state({
      state: "credential_verified",
      revision: 5,
      parentReservationId: "reservation-1",
      effectId: "effect-claim-1",
      latestReceiptId: initialVerification.receiptId,
      updatedAt: initialVerification.recordedAt,
    });
    repo.publishClaimedPhaseOutcome({
      claim: verifyClaim,
      expectedAggregateRevision: 4,
      outcome: { kind: "state_receipt", receipt: initialVerification, nextState: credentialVerified },
      publicationIdempotencyKey: "publish-verify-1",
    });

    const activating = state({
      state: "activating",
      revision: 6,
      parentReservationId: "reservation-1",
      activationApprovalId: "activation-approval-1",
      effectId: "effect-claim-1",
      latestReceiptId: initialVerification.receiptId,
      updatedAt: "2026-08-08T18:05:00.000Z",
    });
    repo.transitionState({
      ownerId: "connection-owner",
      expectedRevision: 5,
      next: activating,
      idempotencyKey: "enter-activating",
      recordedAt: activating.updatedAt,
    });
    const activationClaim = claimWitness(repo, {
      claimId: "claim-activation-1",
      phase: "activate_and_verify",
      expectedRevision: 6,
      effectId: "effect-claim-1",
      expectedOwnerRevision: "owner-revision-2",
    });
    const activation: GovernedRemediationReceipt = {
      schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
      receiptId: "receipt-claim-activation",
      remediationId: "remediation-1",
      recipeId: "recipe.search.connection",
      recipeVersion: 1,
      scope,
      kind: "activation",
      applicationReceiptId: application.receiptId,
      initialVerificationReceiptId: initialVerification.receiptId,
      ownerRevisionBefore: "owner-revision-2",
      ownerRevisionAfter: "owner-revision-3",
      recordedAt: "2026-08-08T18:06:00.000Z",
    };
    const postActivationVerification: GovernedRemediationReceipt = {
      ...initialVerification,
      receiptId: "receipt-claim-verification-activated",
      activationReceiptId: activation.receiptId,
      probeId: "probe-activated",
      ownerRevisionObserved: "owner-revision-3",
      recordedAt: "2026-08-08T18:06:01.000Z",
    };
    const verified = state({
      state: "verified",
      revision: 7,
      parentReservationId: "reservation-1",
      activationApprovalId: "activation-approval-1",
      effectId: "effect-claim-1",
      latestReceiptId: postActivationVerification.receiptId,
      updatedAt: postActivationVerification.recordedAt,
    });
    repo.publishClaimedPhaseOutcome({
      claim: activationClaim,
      expectedAggregateRevision: 6,
      outcome: {
        kind: "state_activation_receipts",
        activationReceipt: activation,
        verificationReceipt: postActivationVerification,
        nextState: verified,
      },
      publicationIdempotencyKey: "publish-activation-1",
    });
    assert.deepEqual(repo.getReceipt(activation.receiptId), activation);
    assert.deepEqual(repo.getReceipt(postActivationVerification.receiptId), postActivationVerification);
    assert.deepEqual(
      repo.listStateRecoveryCandidates({ states: ["verified"] }).map((candidate) => candidate.record.remediationId),
      ["remediation-1"],
    );
    assert.deepEqual(
      repo.listStateRecoveryCandidates({
        states: ["verified"],
        after: { updatedAt: verified.updatedAt, remediationId: verified.remediationId },
      }),
      [],
    );

    const serialized = JSON.stringify(
      db.prepare("SELECT * FROM governed_remediation_phase_claims ORDER BY claim_id").all(),
    );
    assert.equal(serialized.includes(applyClaim.leaseToken), false);
    assert.throws(
      () => repo.appendReceipt({ receipt: application, idempotencyKey: "direct-receipt-bypass" }),
      /publication fence/u,
    );
  });
});
