import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
    recipeId: "recipe.search.connection",
    recipeVersion: 1,
    scope,
    state: "blocked",
    revision: 1,
    expectedWaitingRunVersion: 4,
    expectedOwnerRevision: "owner-revision-1",
    promptId: null,
    promptExpiresAt: null,
    approvalId: null,
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

    const applying = state({ state: "applying", revision: 3, updatedAt: "2026-08-08T18:02:00.000Z" });
    repo.transitionState({
      ownerId: "connection-owner",
      expectedRevision: 2,
      next: applying,
      idempotencyKey: "transition-2",
      recordedAt: applying.updatedAt,
    });
    assert.deepEqual(
      repo.listStateRecoveryCandidates({ updatedBefore: applying.updatedAt }).map((item) => item.record.remediationId),
      ["remediation-1"],
    );
  });

  it("persists immutable typed receipts/failures and quarantined reconciliation recovery", () => {
    const { db, repo } = createStore();
    repo.createState({ ownerId: "connection-owner", record: state(), idempotencyKey: "create-1" });
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
          failure: failure({ scope: { ...scope, scopeId: "workspace-other" } }),
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
});
