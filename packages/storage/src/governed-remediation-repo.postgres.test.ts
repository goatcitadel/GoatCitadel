import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
  type GovernedRemediationReceipt,
  type GovernedRemediationScope,
  type GovernedRemediationStateRecord,
} from "@goatcitadel/contracts";
import { GovernedRemediationRepository } from "./governed-remediation-repo.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;

const scope: GovernedRemediationScope = {
  schemaVersion: GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  deploymentId: "deployment-postgres",
  scopeKind: "workspace",
  scopeId: "workspace-postgres",
  targetId: "connection-postgres",
};

function state(overrides: Partial<GovernedRemediationStateRecord> = {}): GovernedRemediationStateRecord {
  return {
    schemaVersion: GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
    remediationId: "remediation-postgres",
    workspaceId: "workspace-postgres",
    sessionId: "session-postgres",
    sourceTurnId: "turn-postgres",
    durableRunId: "run-postgres",
    blockedCheckpointId: "checkpoint-postgres",
    requesterActorId: "actor-postgres",
    recipeId: "recipe.postgres",
    recipeVersion: 1,
    recipeSha256: "c".repeat(64),
    scope,
    state: "blocked",
    revision: 1,
    expectedWaitingRunVersion: 1,
    expectedOwnerRevision: null,
    parentReservationId: null,
    promptId: null,
    promptExpiresAt: null,
    preEffectApprovalId: null,
    activationApprovalId: null,
    effectId: null,
    latestReceiptId: null,
    failureId: null,
    reconciliationId: null,
    createdAt: "2026-08-08T20:00:00.000Z",
    updatedAt: "2026-08-08T20:00:00.000Z",
    ...overrides,
  };
}

function acquireClaim(
  repo: GovernedRemediationRepository,
  input: {
    claimId: string;
    phase: "parent_reserve" | "apply" | "verify" | "rollback";
    expectedRevision: number;
    effectId: string;
    expectedOwnerRevision: string | null;
  },
) {
  const leaseToken = Buffer.alloc(32, input.claimId.length).toString("base64url");
  const result = repo.acquirePhaseClaim({
    claimId: input.claimId,
    aggregateKind: "state",
    aggregateId: "remediation-postgres",
    remediationId: "remediation-postgres",
    phase: input.phase,
    claimantId: "gateway-postgres-test",
    expectedAggregateRevision: input.expectedRevision,
    operationId: `operation-${input.claimId}`,
    effectId: input.effectId,
    expectedOwnerRevision: input.expectedOwnerRevision,
    leaseTokenSha256: createHash("sha256").update(Buffer.from(leaseToken, "base64url")).digest("hex"),
    leaseDurationSeconds: 300,
    acquisitionIdempotencyKey: `acquire-${input.claimId}`,
  });
  assert.equal(result.disposition, "acquired");
  assert.ok(result.claim);
  return {
    remediationId: "remediation-postgres",
    phase: input.phase,
    claimId: input.claimId,
    claimRevision: result.claim.claimRevision,
    claimantId: "gateway-postgres-test",
    leaseToken,
  };
}

describe("GovernedRemediationRepository live PostgreSQL (skips without GOATCITADEL_TEST_POSTGRES_URL)", () => {
  postgresIt(
    "enforces exact owner scope, idempotent CAS, immutable rows, and secret-free columns",
    { timeout: 300_000 },
    async () => {
      const testScope = await createRemoteWorkerPostgresTestScope(postgresConnectionString!, "governed_remediation");
      try {
        const repo = new GovernedRemediationRepository(testScope.db);
        repo.createState({ ownerId: "owner-postgres", record: state(), idempotencyKey: "create-postgres" });
        const offered = state({ state: "offered", revision: 2, updatedAt: "2026-08-08T20:01:00.000Z" });
        const first = repo.transitionState({
          ownerId: "owner-postgres",
          expectedRevision: 1,
          next: offered,
          idempotencyKey: "transition-postgres",
          recordedAt: offered.updatedAt,
        });
        const replay = repo.transitionState({
          ownerId: "owner-postgres",
          expectedRevision: 1,
          next: offered,
          idempotencyKey: "transition-postgres",
          recordedAt: offered.updatedAt,
        });
        assert.equal(first.replayed, false);
        assert.equal(replay.replayed, true);
        assert.equal(
          repo.findScopedState({ remediationId: offered.remediationId, ownerId: "owner-postgres", scope })?.record
            .revision,
          2,
        );
        assert.equal(
          repo.findScopedState({ remediationId: offered.remediationId, ownerId: "wrong-owner", scope }),
          undefined,
        );
        const parentClaim = acquireClaim(repo, {
          claimId: "claim-parent-postgres",
          phase: "parent_reserve",
          expectedRevision: 2,
          effectId: "effect-postgres",
          expectedOwnerRevision: "revision-before-postgres",
        });
        const applying = state({
          state: "applying",
          revision: 3,
          parentReservationId: "reservation-postgres",
          effectId: "effect-postgres",
          updatedAt: "2026-08-08T20:01:05.000Z",
        });
        repo.publishClaimedPhaseOutcome({
          claim: parentClaim,
          expectedAggregateRevision: 2,
          outcome: { kind: "state_transition", nextState: applying },
          publicationIdempotencyKey: "publish-parent-postgres",
        });
        const applyClaim = acquireClaim(repo, {
          claimId: "claim-apply-postgres",
          phase: "apply",
          expectedRevision: 3,
          effectId: "effect-postgres",
          expectedOwnerRevision: "revision-before-postgres",
        });
        const application: GovernedRemediationReceipt = {
          schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
          receiptId: "receipt-application-postgres",
          remediationId: offered.remediationId,
          recipeId: offered.recipeId,
          recipeVersion: offered.recipeVersion,
          scope,
          kind: "application",
          ownerId: "owner-postgres",
          effectId: "effect-postgres",
          ownerRevisionBefore: "revision-before-postgres",
          ownerRevisionAfter: "revision-applied-postgres",
          recordedAt: "2026-08-08T20:01:10.000Z",
        };
        const verifying = state({
          state: "verifying",
          revision: 4,
          parentReservationId: "reservation-postgres",
          effectId: "effect-postgres",
          latestReceiptId: application.receiptId,
          updatedAt: application.recordedAt,
        });
        repo.publishClaimedPhaseOutcome({
          claim: applyClaim,
          expectedAggregateRevision: 3,
          outcome: { kind: "state_receipt", receipt: application, nextState: verifying },
          publicationIdempotencyKey: "publish-application-postgres",
        });
        const verifyClaim = acquireClaim(repo, {
          claimId: "claim-verify-postgres",
          phase: "verify",
          expectedRevision: 4,
          effectId: "effect-postgres",
          expectedOwnerRevision: application.ownerRevisionAfter,
        });
        const verification: GovernedRemediationReceipt = {
          schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
          receiptId: "receipt-verification-postgres",
          remediationId: offered.remediationId,
          recipeId: offered.recipeId,
          recipeVersion: offered.recipeVersion,
          scope,
          kind: "verification",
          applicationReceiptId: application.receiptId,
          activationReceiptId: null,
          probeId: "probe-postgres",
          probeResult: "accepted",
          ownerRevisionObserved: application.ownerRevisionAfter,
          recordedAt: "2026-08-08T20:01:15.000Z",
        };
        const credentialVerified = state({
          state: "credential_verified",
          revision: 5,
          parentReservationId: "reservation-postgres",
          effectId: "effect-postgres",
          latestReceiptId: verification.receiptId,
          updatedAt: verification.recordedAt,
        });
        repo.publishClaimedPhaseOutcome({
          claim: verifyClaim,
          expectedAggregateRevision: 4,
          outcome: { kind: "state_receipt", receipt: verification, nextState: credentialVerified },
          publicationIdempotencyKey: "publish-verification-postgres",
        });
        const rollbackClaim = acquireClaim(repo, {
          claimId: "claim-rollback-postgres",
          phase: "rollback",
          expectedRevision: 5,
          effectId: "effect-postgres",
          expectedOwnerRevision: application.ownerRevisionAfter,
        });
        const rollback: GovernedRemediationReceipt = {
          schemaVersion: GOVERNED_REMEDIATION_RECEIPT_SCHEMA_VERSION,
          receiptId: "receipt-rollback-postgres",
          remediationId: offered.remediationId,
          recipeId: offered.recipeId,
          recipeVersion: offered.recipeVersion,
          scope,
          kind: "rollback",
          applicationReceiptId: application.receiptId,
          rollbackStrategy: "restore_previous",
          outcome: "rolled_back",
          ownerRevisionBefore: application.ownerRevisionAfter,
          ownerRevisionAfter: "revision-restored-postgres",
          recordedAt: "2026-08-08T20:01:20.000Z",
        };
        const declined = state({
          state: "declined",
          revision: 6,
          parentReservationId: "reservation-postgres",
          effectId: "effect-postgres",
          latestReceiptId: rollback.receiptId,
          updatedAt: rollback.recordedAt,
        });
        repo.publishClaimedPhaseOutcome({
          claim: rollbackClaim,
          expectedAggregateRevision: 5,
          outcome: { kind: "state_receipt", receipt: rollback, nextState: declined },
          publicationIdempotencyKey: "publish-rollback-postgres",
        });
        assert.deepEqual(repo.getReceipt(rollback.receiptId), rollback);
        assert.throws(
          () =>
            testScope.db
              .prepare(
                `UPDATE governed_remediation_states
                 SET state = 'manual_required', revision = 3, updated_at = '2026-08-08T20:02:00.000Z'`,
              )
              .run(),
          /CAS|binding/u,
        );

        const columns = (
          testScope.db
            .prepare(
              `SELECT table_name, column_name FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name LIKE 'governed_remediation_%'`,
            )
            .all() as Array<{ table_name: string; column_name: string }>
        ).map((row) => `${row.table_name}.${row.column_name}`);
        for (const forbidden of ["secret", "credential_value", "oauth_code", "command", "payload", "raw_error"]) {
          assert.equal(
            columns.some((column) => column.toLowerCase().includes(forbidden)),
            false,
            `found forbidden ${forbidden} column`,
          );
        }
      } finally {
        await testScope.teardown();
      }
    },
  );
});
