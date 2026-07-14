import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createDatabase } from "./sqlite.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import {
  buildChatCompactionAttemptId,
  buildChatCompactionStateKey,
  ChatConversationSummaryRepository,
  type ChatCompactionStateUpsertInput,
} from "./chat-conversation-summary-repo.js";

const createdFiles: string[] = [];
const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.rmSync(candidate, { force: true });
      } catch {
        // Ignore test cleanup noise.
      }
    }
  }
});

describe("ChatConversationSummaryRepository compaction breaker", () => {
  it("commits a boundary and pending evidence atomically and survives restart", () => {
    const dbPath = createDbPath();
    const firstDb = createDatabase({ dbPath });
    const first = new ChatConversationSummaryRepository(firstDb);
    const state = compactionState("sess-restart", "dim-a", 8, 14);

    const committed = first.commitCompactionBoundary({
      state,
      attemptId: boundaryAttemptId(state, "turn-14", "structured"),
      branchHeadTurnId: "turn-14",
      disposition: "structured",
      startedAt: "2026-07-14T03:00:00.000Z",
    });

    assert.equal(committed.breaker.status, "awaiting_evidence");
    assert.equal(committed.breaker.pendingStateKey, state.stateKey);
    firstDb.close();

    const secondDb = createDatabase({ dbPath });
    try {
      const restarted = new ChatConversationSummaryRepository(secondDb);
      assert.deepEqual(restarted.getCompactionBreaker("sess-restart", "dim-a"), committed.breaker);
      assert.equal(restarted.listCompactionStates("sess-restart", "dim-a")[0]?.stateKey, state.stateKey);
    } finally {
      secondDb.close();
    }
  });

  it("saturates ineffective strikes at two and enforces CAS", () => {
    const { db, repo } = createRepo();
    try {
      const firstState = compactionState("sess-ineffective", "dim-a", 8, 14);
      const first = repo.commitCompactionBoundary({
        state: firstState,
        attemptId: boundaryAttemptId(firstState, "turn-14", "structured"),
        branchHeadTurnId: "turn-14",
        disposition: "structured",
      });
      const firstEvidence = repo.observeCompactionEvidence({
        ...identity("sess-ineffective", "dim-a"),
        evidenceTurnId: "turn-15",
        evidenceObservedTurnCount: 15,
        reportedInputTokens: 2_200,
        rearmTokens: 1_600,
        triggerTokens: 2_200,
      });
      assert.equal(firstEvidence?.ineffectiveStreak, 1);
      assert.equal(firstEvidence?.status, "closed");

      assert.throws(
        () =>
          repo.recordCompactionNoProgress({
            ...identity("sess-ineffective", "dim-a"),
            attemptId: noProgressAttemptId("sess-ineffective", "dim-a", "turn-15", 15, "stale-cas-source"),
            branchHeadTurnId: "turn-15",
            observedTurnCount: 15,
            attemptedBoundarySourceHash: "stale-cas-source",
            expectedBreakerRevision: first.breaker.revision,
          }),
        /revision changed/,
      );

      const secondState = compactionState("sess-ineffective", "dim-a", 16, 22);
      const second = repo.commitCompactionBoundary({
        state: secondState,
        attemptId: boundaryAttemptId(secondState, "turn-22", "structured"),
        branchHeadTurnId: "turn-22",
        disposition: "structured",
        expectedBreakerRevision: firstEvidence?.revision,
      });
      const tripped = repo.observeCompactionEvidence({
        ...identity("sess-ineffective", "dim-a"),
        evidenceTurnId: "turn-23",
        evidenceObservedTurnCount: 23,
        reportedInputTokens: 2_500,
        rearmTokens: 1_600,
        triggerTokens: 2_200,
      });
      assert.equal(second.breaker.status, "awaiting_evidence");
      assert.equal(tripped?.ineffectiveStreak, 2);
      assert.equal(tripped?.status, "tripped");

      assert.equal(tripped?.status, "tripped");
    } finally {
      db.close();
    }
  });

  it("keeps fallback strikes across ordinary fitting evidence until a forced healthy structured boundary", () => {
    const { db, repo } = createRepo();
    try {
      const firstState = compactionState("sess-fallback", "dim-a", 8, 14);
      const first = repo.commitCompactionBoundary({
        state: firstState,
        attemptId: boundaryAttemptId(firstState, "turn-14", "fallback"),
        branchHeadTurnId: "turn-14",
        disposition: "fallback",
      });
      const afterFirstFit = repo.observeCompactionEvidence({
        ...identity("sess-fallback", "dim-a"),
        evidenceTurnId: "turn-15",
        evidenceObservedTurnCount: 15,
        reportedInputTokens: 1_200,
        rearmTokens: 1_600,
        triggerTokens: 2_200,
      });
      assert.equal(first.breaker.fallbackStreak, 1);
      assert.equal(afterFirstFit?.fallbackStreak, 1);

      const ordinaryFit = repo.observeCompactionEvidence({
        ...identity("sess-fallback", "dim-a"),
        evidenceTurnId: "turn-16",
        evidenceObservedTurnCount: 16,
        reportedInputTokens: 1_100,
        rearmTokens: 1_600,
        triggerTokens: 2_200,
      });
      assert.equal(ordinaryFit?.revision, afterFirstFit?.revision);
      assert.equal(ordinaryFit?.fallbackStreak, 1);

      const secondState = compactionState("sess-fallback", "dim-a", 16, 22);
      repo.commitCompactionBoundary({
        state: secondState,
        attemptId: boundaryAttemptId(secondState, "turn-22", "fallback"),
        branchHeadTurnId: "turn-22",
        disposition: "fallback",
        expectedBreakerRevision: afterFirstFit?.revision,
      });
      const tripped = repo.observeCompactionEvidence({
        ...identity("sess-fallback", "dim-a"),
        evidenceTurnId: "turn-23",
        evidenceObservedTurnCount: 23,
        reportedInputTokens: 1_100,
        rearmTokens: 1_600,
        triggerTokens: 2_200,
      });
      assert.equal(tripped?.fallbackStreak, 2);
      assert.equal(tripped?.status, "tripped");

      const forceAction = createPendingAction(repo, {
        sessionId: "sess-fallback",
        dimensionHash: "dim-a",
        actionKind: "force",
        expectedBreakerRevision: tripped!.revision,
      });
      const forcedState = compactionState("sess-fallback", "dim-a", 24, 30);
      const forced = repo.commitCompactionBoundary({
        state: forcedState,
        attemptId: boundaryAttemptId(forcedState, "turn-30", "structured"),
        branchHeadTurnId: "turn-30",
        disposition: "structured",
        expectedBreakerRevision: tripped?.revision,
        forceAction: { actionId: forceAction.actionId, actorHash: forceAction.actorHash },
      });
      assert.equal(forced.breaker.status, "awaiting_evidence");
      assert.equal(repo.getCompactionBreakerAction(forceAction.actionId).status, "consumed");
      const healthy = repo.observeCompactionEvidence({
        ...identity("sess-fallback", "dim-a"),
        evidenceTurnId: "turn-31",
        evidenceObservedTurnCount: 31,
        reportedInputTokens: 1_000,
        rearmTokens: 1_600,
        triggerTokens: 2_200,
      });
      assert.deepEqual(
        { status: healthy?.status, fallback: healthy?.fallbackStreak, outcome: healthy?.lastOutcome },
        { status: "closed", fallback: 0, outcome: "healthy" },
      );
    } finally {
      db.close();
    }
  });

  it("records each no-progress attempt once and blocks after the second distinct attempt", () => {
    const { db, repo } = createRepo();
    try {
      const firstSource = "no-progress-source-1";
      const first = repo.recordCompactionNoProgress({
        ...identity("sess-no-progress", "dim-a"),
        attemptId: noProgressAttemptId("sess-no-progress", "dim-a", "turn-14", 14, firstSource),
        branchHeadTurnId: "turn-14",
        observedTurnCount: 14,
        attemptedBoundarySourceHash: firstSource,
      });
      const replay = repo.recordCompactionNoProgress({
        ...identity("sess-no-progress", "dim-a"),
        attemptId: noProgressAttemptId("sess-no-progress", "dim-a", "turn-14", 14, firstSource),
        branchHeadTurnId: "turn-14",
        observedTurnCount: 14,
        attemptedBoundarySourceHash: firstSource,
        expectedBreakerRevision: first.revision,
      });
      assert.equal(replay.revision, first.revision);
      assert.equal(replay.ineffectiveStreak, 1);

      const secondSource = "no-progress-source-2";
      const second = repo.recordCompactionNoProgress({
        ...identity("sess-no-progress", "dim-a"),
        attemptId: noProgressAttemptId("sess-no-progress", "dim-a", "turn-22", 22, secondSource),
        branchHeadTurnId: "turn-22",
        observedTurnCount: 22,
        attemptedBoundarySourceHash: secondSource,
        expectedBreakerRevision: first.revision,
      });
      assert.equal(second.ineffectiveStreak, 2);
      assert.equal(second.status, "tripped");
    } finally {
      db.close();
    }
  });

  it("enforces one pending actor-bound force action and expires it without weakening the breaker", () => {
    const { db, repo } = createRepo();
    try {
      const tripped = tripBreaker(repo, "sess-actions", "dim-a");
      const forceAction = createPendingAction(repo, {
        sessionId: "sess-actions",
        dimensionHash: "dim-a",
        actionKind: "force",
        expectedBreakerRevision: tripped.revision,
      });
      assert.throws(
        () =>
          createPendingAction(repo, {
            sessionId: "sess-actions",
            dimensionHash: "dim-a",
            actionKind: "force",
            expectedBreakerRevision: tripped.revision,
          }),
        /pending compaction breaker action already exists/,
      );
      assert.throws(
        () =>
          repo.validatePendingCompactionBreakerForceAction({
            sessionId: "sess-actions",
            dimensionHash: "dim-a",
            actionId: forceAction.actionId,
            actorHash: "sha256:different-operator",
          }),
        /not bound to this actor/,
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE chat_compaction_breaker_actions SET actor_hash = 'sha256:tampered' WHERE action_id = ?")
            .run(forceAction.actionId),
        /identity is immutable|lifecycle is immutable/,
      );
      const expired = repo.getCompactionBreakerAction(
        forceAction.actionId,
        new Date(Date.parse(forceAction.expiresAt) + 1).toISOString(),
      );
      assert.equal(expired.status, "expired");
      assert.equal(repo.getCompactionBreaker("sess-actions", "dim-a")?.status, "tripped");
    } finally {
      db.close();
    }
  });

  it("allows only a pending-to-terminal direct SQL transition and freezes the terminal row", () => {
    const { db, repo } = createRepo();
    try {
      const tripped = tripBreaker(repo, "sess-action-transition", "dim-a");
      const forceAction = createPendingAction(repo, {
        sessionId: "sess-action-transition",
        dimensionHash: "dim-a",
        actionKind: "force",
        expectedBreakerRevision: tripped.revision,
      });

      assert.throws(
        () =>
          db
            .prepare("UPDATE chat_compaction_breaker_actions SET updated_at = ? WHERE action_id = ?")
            .run("2026-07-14T03:01:00.000Z", forceAction.actionId),
        /lifecycle is immutable/,
      );
      assert.equal(
        db
          .prepare(
            "UPDATE chat_compaction_breaker_actions SET status = 'expired', updated_at = expires_at WHERE action_id = ?",
          )
          .run(forceAction.actionId).changes,
        1,
      );
      assert.equal(repo.getCompactionBreakerAction(forceAction.actionId).status, "expired");
      assert.throws(
        () =>
          db
            .prepare(
              "UPDATE chat_compaction_breaker_actions SET status = 'rejected', rejection_reason = 'late mutation', updated_at = ? WHERE action_id = ?",
            )
            .run("2026-07-14T03:02:00.000Z", forceAction.actionId),
        /lifecycle is immutable/,
      );
    } finally {
      db.close();
    }
  });

  it("rejects a forced no-progress result atomically and never rearms the tripped breaker", () => {
    const { db, repo } = createRepo();
    try {
      const tripped = tripBreaker(repo, "sess-force-no-progress", "dim-a");
      const forceAction = createPendingAction(repo, {
        sessionId: "sess-force-no-progress",
        dimensionHash: "dim-a",
        actionKind: "force",
        expectedBreakerRevision: tripped.revision,
      });
      const source = "forced-no-progress-source";
      const breaker = repo.recordCompactionNoProgress({
        ...identity("sess-force-no-progress", "dim-a"),
        attemptId: noProgressAttemptId("sess-force-no-progress", "dim-a", "turn-30", 30, source),
        branchHeadTurnId: "turn-30",
        observedTurnCount: 30,
        attemptedBoundarySourceHash: source,
        expectedBreakerRevision: tripped.revision,
        forceAction: { actionId: forceAction.actionId, actorHash: forceAction.actorHash },
      });
      assert.deepEqual(
        { status: breaker.status, fallback: breaker.fallbackStreak, ineffective: breaker.ineffectiveStreak },
        { status: "tripped", fallback: tripped.fallbackStreak, ineffective: 2 },
      );
      assert.match(repo.getCompactionBreakerAction(forceAction.actionId).rejectionReason ?? "", /no exact structured/);
      assert.equal(repo.getCompactionBreakerAction(forceAction.actionId).status, "rejected");
    } finally {
      db.close();
    }
  });

  it("rejects recovery actions outside their exact breaker states", () => {
    const { db, repo } = createRepo();
    try {
      const source = "closed-source";
      const closed = repo.recordCompactionNoProgress({
        ...identity("sess-scope", "dim-a"),
        attemptId: noProgressAttemptId("sess-scope", "dim-a", "turn-14", 14, source),
        branchHeadTurnId: "turn-14",
        observedTurnCount: 14,
        attemptedBoundarySourceHash: source,
      });
      assert.equal(closed.status, "closed");
      assert.throws(
        () =>
          createPendingAction(repo, {
            sessionId: "sess-scope",
            dimensionHash: "dim-a",
            actionKind: "force",
            expectedBreakerRevision: closed.revision,
          }),
        /exactly tripped/,
      );
      const tripped = tripBreaker(repo, "sess-repair-scope", "dim-a");
      assert.throws(
        () =>
          createPendingAction(repo, {
            sessionId: "sess-repair-scope",
            dimensionHash: "dim-a",
            actionKind: "repair",
            expectedBreakerRevision: tripped.revision,
          }),
        /blocked corrupt/,
      );
    } finally {
      db.close();
    }
  });

  it("fails closed on a corrupt referenced boundary and protects a pending boundary from pruning", () => {
    const { db, repo } = createRepo();
    try {
      const pendingState = compactionState("sess-corrupt", "dim-pending", 8, 14);
      const pendingCommit = repo.commitCompactionBoundary({
        state: pendingState,
        attemptId: boundaryAttemptId(pendingState, "turn-14", "structured"),
        branchHeadTurnId: "turn-14",
        disposition: "structured",
      });
      for (let index = 0; index < 140; index += 1) {
        repo.upsertCompactionState(compactionState("sess-corrupt", `dim-${index}`, 1, index + 1));
      }
      assert.equal(repo.listCompactionStates("sess-corrupt", "dim-pending")[0]?.stateKey, pendingState.stateKey);

      db.prepare("UPDATE chat_compaction_states SET boundary_turn_ids_json = '{bad' WHERE state_key = ?").run(
        pendingState.stateKey,
      );
      assert.throws(
        () =>
          createPendingAction(repo, {
            sessionId: "sess-corrupt",
            dimensionHash: "dim-pending",
            actionKind: "repair",
            expectedBreakerRevision: pendingCommit.breaker.revision,
          }),
        /revision changed/,
      );
      const blocked = repo.getCompactionBreaker("sess-corrupt", "dim-pending");
      assert.equal(blocked?.status, "blocked_corrupt");
      assert.equal(blocked?.pendingStateKey, undefined);
      assert.equal(
        repo.getCompactionBreaker("sess-corrupt", "dim-pending")?.revision,
        blocked?.revision,
        "a canonical blocked-corrupt snapshot must not bump its revision on repeated strict reads",
      );
      const repairAction = createPendingAction(repo, {
        sessionId: "sess-corrupt",
        dimensionHash: "dim-pending",
        actionKind: "repair",
        expectedBreakerRevision: blocked!.revision,
      });
      const repairResult = repo.consumeCompactionBreakerRepairAction({
        actionId: repairAction.actionId,
        sessionId: "sess-corrupt",
        dimensionHash: "dim-pending",
        actorHash: repairAction.actorHash,
      });
      const repaired = repairResult.breaker;
      assert.deepEqual(
        {
          status: repaired.status,
          providerId: repaired.providerId,
          model: repaired.model,
          profileFingerprint: repaired.profileFingerprint,
        },
        { status: "tripped", providerId: "openai", model: "gpt-4.1", profileFingerprint: "profile-a" },
      );
      assert.equal(repairResult.action.status, "consumed");
      assert.equal(repairResult.action.quarantinedStateKey, pendingState.stateKey);
      assert.equal(repaired.lastRepairedActorHash, repairAction.actorHash);
      const forceAction = createPendingAction(repo, {
        sessionId: "sess-corrupt",
        dimensionHash: "dim-pending",
        actionKind: "force",
        expectedBreakerRevision: repaired.revision,
      });
      const recoveredState = compactionState("sess-corrupt", "dim-pending", 16, 22);
      assert.equal(
        repo.commitCompactionBoundary({
          state: recoveredState,
          attemptId: boundaryAttemptId(recoveredState, "turn-22", "structured"),
          branchHeadTurnId: "turn-22",
          disposition: "structured",
          expectedBreakerRevision: repaired.revision,
          forceAction: { actionId: forceAction.actionId, actorHash: forceAction.actorHash },
        }).breaker.status,
        "awaiting_evidence",
      );
    } finally {
      db.close();
    }
  });

  it("stabilizes an oversized provider corruption so a governed repair can be created and consumed", () => {
    const { db, repo } = createRepo();
    try {
      tripBreaker(repo, "sess-provider-corrupt", "dim-a");
      db.prepare("UPDATE chat_compaction_breakers SET provider_id = ? WHERE session_id = ? AND dimension_hash = ?").run(
        "p".repeat(300),
        "sess-provider-corrupt",
        "dim-a",
      );

      const blocked = repo.getCompactionBreaker("sess-provider-corrupt", "dim-a");
      assert.equal(blocked?.status, "blocked_corrupt");
      assert.equal(blocked?.providerId, undefined);
      assert.equal(repo.getCompactionBreaker("sess-provider-corrupt", "dim-a")?.revision, blocked?.revision);

      const repairAction = createPendingAction(repo, {
        sessionId: "sess-provider-corrupt",
        dimensionHash: "dim-a",
        actionKind: "repair",
        expectedBreakerRevision: blocked!.revision,
      });
      const repaired = repo.consumeCompactionBreakerRepairAction({
        actionId: repairAction.actionId,
        sessionId: "sess-provider-corrupt",
        dimensionHash: "dim-a",
        actorHash: repairAction.actorHash,
      });
      assert.equal(repaired.breaker.status, "tripped");
      assert.equal(repaired.breaker.providerId, undefined);
      assert.equal(repaired.action.status, "consumed");
    } finally {
      db.close();
    }
  });

  it("quarantines and exposes an exact cross-dimension pending state key during governed repair", () => {
    const { db, repo } = createRepo();
    try {
      const foreignState = compactionState("sess-foreign", "dim-foreign", 8, 14);
      repo.upsertCompactionState(foreignState);
      const targetState = compactionState("sess-target", "dim-target", 8, 14);
      repo.commitCompactionBoundary({
        state: targetState,
        attemptId: boundaryAttemptId(targetState, "turn-14", "structured"),
        branchHeadTurnId: "turn-14",
        disposition: "structured",
      });
      db.prepare(
        "UPDATE chat_compaction_breakers SET pending_state_key = ? WHERE session_id = ? AND dimension_hash = ?",
      ).run(foreignState.stateKey, "sess-target", "dim-target");

      const blocked = repo.getCompactionBreaker("sess-target", "dim-target");
      assert.equal(blocked?.status, "blocked_corrupt");
      const quarantined = db
        .prepare(
          "SELECT pending_state_key, quarantined_state_key FROM chat_compaction_breakers WHERE session_id = ? AND dimension_hash = ?",
        )
        .get<{ pending_state_key: string | null; quarantined_state_key: string | null }>("sess-target", "dim-target");
      assert.deepEqual(
        { pending: quarantined?.pending_state_key, quarantined: quarantined?.quarantined_state_key },
        { pending: null, quarantined: foreignState.stateKey },
      );

      const repairAction = createPendingAction(repo, {
        sessionId: "sess-target",
        dimensionHash: "dim-target",
        actionKind: "repair",
        expectedBreakerRevision: blocked!.revision,
      });
      const repaired = repo.consumeCompactionBreakerRepairAction({
        actionId: repairAction.actionId,
        sessionId: "sess-target",
        dimensionHash: "dim-target",
        actorHash: repairAction.actorHash,
      });
      assert.equal(repaired.action.quarantinedStateKey, foreignState.stateKey);
      assert.equal(repaired.breaker.status, "tripped");
      assert.equal(
        db
          .prepare(
            "SELECT quarantined_state_key FROM chat_compaction_breakers WHERE session_id = ? AND dimension_hash = ?",
          )
          .get<{ quarantined_state_key: string | null }>("sess-target", "dim-target")?.quarantined_state_key,
        null,
      );
    } finally {
      db.close();
    }
  });

  it("allows only one of two writers to win the same breaker revision", () => {
    const dbPath = createDbPath();
    const firstDb = createDatabase({ dbPath });
    const secondDb = createDatabase({ dbPath });
    try {
      const first = new ChatConversationSummaryRepository(firstDb);
      const second = new ChatConversationSummaryRepository(secondDb);
      const firstSource = "cas-source-1";
      first.recordCompactionNoProgress({
        ...identity("sess-cas", "dim-a"),
        attemptId: noProgressAttemptId("sess-cas", "dim-a", "turn-14", 14, firstSource),
        branchHeadTurnId: "turn-14",
        observedTurnCount: 14,
        attemptedBoundarySourceHash: firstSource,
      });
      assert.throws(
        () =>
          second.recordCompactionNoProgress({
            ...identity("sess-cas", "dim-a"),
            attemptId: noProgressAttemptId("sess-cas", "dim-a", "turn-14", 14, "cas-source-2"),
            branchHeadTurnId: "turn-14",
            observedTurnCount: 14,
            attemptedBoundarySourceHash: "cas-source-2",
          }),
        /revision changed/,
      );
    } finally {
      secondDb.close();
      firstDb.close();
    }
  });

  it("keeps the SQLite 163 and Postgres 105 breaker schema contract aligned", () => {
    const { db } = createRepo();
    try {
      const sqliteMigration = db.prepare("SELECT version, name FROM schema_migrations WHERE version = 163").get() as {
        version: number;
        name: string;
      };
      assert.deepEqual({ ...sqliteMigration }, { version: 163, name: "context_pressure_recovery_truth" });
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('chat_compaction_breakers') ORDER BY cid")
        .all<{ name: string }>()
        .map((row) => row.name);
      assert.deepEqual(columns, [
        "session_id",
        "dimension_hash",
        "provider_id",
        "model",
        "profile_fingerprint",
        "status",
        "fallback_streak",
        "ineffective_streak",
        "pending_attempt_id",
        "pending_state_key",
        "quarantined_state_key",
        "pending_branch_head_turn_id",
        "pending_observed_turn_count",
        "pending_disposition",
        "pending_started_at",
        "last_attempt_id",
        "last_evidence_turn_id",
        "last_evidence_input_tokens",
        "last_outcome",
        "revision",
        "last_repaired_at",
        "last_repair_reason",
        "last_repaired_actor_hash",
        "created_at",
        "updated_at",
      ]);
      const sqliteSql =
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_compaction_breakers'")
          .get<{ sql: string }>()?.sql ?? "";
      assert.match(sqliteSql, /PRIMARY KEY\(session_id, dimension_hash\)/);
      assert.match(sqliteSql, /pending_state_key\) REFERENCES chat_compaction_states\(state_key\) ON DELETE RESTRICT/);
      assert.match(sqliteSql, /fallback_streak BETWEEN 0 AND 2/);
      assert.match(sqliteSql, /status = 'awaiting_evidence'/);
      const actionColumns = db
        .prepare("SELECT name FROM pragma_table_info('chat_compaction_breaker_actions') ORDER BY cid")
        .all<{ name: string }>()
        .map((row) => row.name);
      assert.deepEqual(actionColumns, [
        "action_id",
        "session_id",
        "dimension_hash",
        "action_kind",
        "expected_breaker_revision",
        "actor_hash",
        "request_evidence_hash",
        "policy_decision_hash",
        "audit_evidence_hash",
        "approval_id",
        "reason",
        "status",
        "rejection_reason",
        "created_at",
        "expires_at",
        "consumed_at",
        "resulting_attempt_id",
        "resulting_breaker_revision",
        "quarantined_state_key",
        "updated_at",
      ]);
      const sqliteTransitionSql =
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
          .get<{ sql: string }>("trg_chat_compaction_breaker_actions_transition")?.sql ?? "";
      assert.match(sqliteTransitionSql, /OLD\.status IS NOT 'pending'/);
      assert.match(sqliteTransitionSql, /NEW\.status IS NOT 'consumed'/);

      const postgres = POSTGRES_MIGRATIONS.find((migration) => migration.version === 105);
      assert.equal(postgres?.name, "context_pressure_recovery_truth");
      assert.match(postgres?.sql ?? "", /CREATE TABLE IF NOT EXISTS chat_compaction_breakers/);
      assert.match(postgres?.sql ?? "", /PRIMARY KEY\(session_id, dimension_hash\)/);
      assert.match(postgres?.sql ?? "", /REFERENCES chat_compaction_states\(state_key\) ON DELETE RESTRICT/);
      assert.match(postgres?.sql ?? "", /fallback_streak BETWEEN 0 AND 2/);
      assert.match(postgres?.sql ?? "", /idx_chat_compaction_breakers_pending_state/);
      assert.match(postgres?.sql ?? "", /CREATE TABLE IF NOT EXISTS chat_compaction_breaker_actions/);
      assert.match(postgres?.sql ?? "", /trg_chat_compaction_breaker_actions_immutable/);
      assert.match(postgres?.sql ?? "", /trg_chat_compaction_breaker_actions_transition/);
      assert.match(postgres?.sql ?? "", /OLD\.status IS DISTINCT FROM 'pending'/);
      assert.match(postgres?.sql ?? "", /NEW\.status IS DISTINCT FROM 'consumed'/);
      assert.match(postgres?.sql ?? "", /ADD COLUMN IF NOT EXISTS quarantined_state_key TEXT/);
    } finally {
      db.close();
    }
  });

  it("replays SQLite migration 163 to restore quarantine evidence and lifecycle enforcement", () => {
    const dbPath = createDbPath();
    const initial = createDatabase({ dbPath });
    initial.exec("DROP TRIGGER trg_chat_compaction_breaker_actions_transition");
    initial.exec("ALTER TABLE chat_compaction_breakers DROP COLUMN quarantined_state_key");
    initial.prepare("DELETE FROM schema_migrations WHERE version = 163").run();
    initial.close();

    const replayed = createDatabase({ dbPath });
    try {
      const replayedMigration = replayed
        .prepare("SELECT version, name FROM schema_migrations WHERE version = 163")
        .get<{ version: number; name: string }>();
      assert.deepEqual(replayedMigration ? { ...replayedMigration } : undefined, {
        version: 163,
        name: "context_pressure_recovery_truth",
      });
      assert.equal(
        replayed
          .prepare("SELECT COUNT(*) AS count FROM pragma_table_info('chat_compaction_breakers') WHERE name = ?")
          .get<{ count: number }>("quarantined_state_key")?.count,
        1,
      );
      assert.equal(
        replayed
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = ?")
          .get<{ count: number }>("trg_chat_compaction_breaker_actions_transition")?.count,
        1,
      );
    } finally {
      replayed.close();
    }
  });

  it(
    "enforces the breaker action lifecycle guard on real Postgres",
    { skip: postgresConnectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
    async () => {
      assert.ok(postgresConnectionString);
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const schemaName = `coverage_chat_breaker_${suffix}`;
      const adminPool = new Pool({ connectionString: postgresConnectionString });
      const scopedUrl = new URL(postgresConnectionString);
      scopedUrl.searchParams.set("options", `-csearch_path=${schemaName}`);
      const migrationPool = new Pool({ connectionString: scopedUrl.toString() });
      const migrationClient = new PostgresDatabaseClient(
        { connectionString: scopedUrl.toString(), database: "goatcitadel_test" },
        { pool: migrationPool },
      );

      try {
        await adminPool.query(`CREATE SCHEMA ${schemaName}`);
        await runPostgresMigrations(migrationClient, POSTGRES_MIGRATIONS);
        await migrationPool.query(`
          INSERT INTO chat_compaction_breakers (
            session_id, dimension_hash, status, fallback_streak, ineffective_streak,
            last_outcome, revision, created_at, updated_at
          ) VALUES (
            'pg-session', 'pg-dimension', 'tripped', 2, 2,
            'unverified', 1, '2026-07-14T03:00:00.000Z', '2026-07-14T03:00:00.000Z'
          );
          INSERT INTO chat_compaction_breaker_actions (
            action_id, session_id, dimension_hash, action_kind, expected_breaker_revision,
            actor_hash, request_evidence_hash, policy_decision_hash, audit_evidence_hash,
            approval_id, reason, status, created_at, expires_at, updated_at
          ) VALUES (
            'pg-action', 'pg-session', 'pg-dimension', 'force', 1,
            'sha256:actor', 'sha256:request', 'sha256:policy', 'sha256:audit',
            'pg-approval', 'reviewed', 'pending',
            '2026-07-14T03:00:00.000Z', '2026-07-14T03:05:00.000Z', '2026-07-14T03:00:00.000Z'
          );
        `);
        await migrationPool.query(`
          UPDATE chat_compaction_breaker_actions
          SET status = 'expired', updated_at = expires_at
          WHERE action_id = 'pg-action'
        `);
        await assert.rejects(
          migrationPool.query(`
            UPDATE chat_compaction_breaker_actions
            SET status = 'rejected', rejection_reason = 'late mutation'
            WHERE action_id = 'pg-action'
          `),
          /lifecycle is immutable/,
        );
        const column = await migrationPool.query<{ column_name: string }>(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'chat_compaction_breakers'
            AND column_name = 'quarantined_state_key'
        `);
        assert.equal(column.rowCount, 1);
      } finally {
        await migrationPool.end();
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    },
  );
});

function identity(sessionId: string, dimensionHash: string) {
  return {
    sessionId,
    dimensionHash,
    providerId: "openai",
    model: "gpt-4.1",
    profileFingerprint: "profile-a",
  };
}

function compactionState(
  sessionId: string,
  dimensionHash: string,
  boundaryCount: number,
  observedTurnCount: number,
): ChatCompactionStateUpsertInput {
  const boundaryTurnIds = Array.from({ length: boundaryCount }, (_, index) => `turn-${index + 1}`);
  const boundarySourceHash = `source-${dimensionHash}-${boundaryCount}`;
  return {
    stateKey: buildChatCompactionStateKey(sessionId, dimensionHash, boundaryTurnIds, boundarySourceHash),
    ...identity(sessionId, dimensionHash),
    boundaryTurnIds,
    boundarySourceHash,
    baselineInputTokens: 2_400,
    lastObservedInputTokens: 2_400,
    observedTurnCount,
    armed: false,
  };
}

function boundaryAttemptId(
  state: ChatCompactionStateUpsertInput,
  branchHeadTurnId: string,
  disposition: "structured" | "fallback",
): string {
  return buildChatCompactionAttemptId({
    sessionId: state.sessionId,
    dimensionHash: state.dimensionHash,
    ...(state.providerId ? { providerId: state.providerId } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.profileFingerprint ? { profileFingerprint: state.profileFingerprint } : {}),
    branchHeadTurnId,
    observedTurnCount: state.observedTurnCount,
    boundarySourceHash: state.boundarySourceHash,
    disposition,
  });
}

function noProgressAttemptId(
  sessionId: string,
  dimensionHash: string,
  branchHeadTurnId: string,
  observedTurnCount: number,
  boundarySourceHash: string,
): string {
  return buildChatCompactionAttemptId({
    ...identity(sessionId, dimensionHash),
    branchHeadTurnId,
    observedTurnCount,
    boundarySourceHash,
    disposition: "no_progress",
  });
}

function createDbPath(): string {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-compaction-breaker-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return dbPath;
}

function createRepo() {
  const db = createDatabase({ dbPath: createDbPath() });
  return { db, repo: new ChatConversationSummaryRepository(db) };
}

function createPendingAction(
  repo: ChatConversationSummaryRepository,
  input: {
    sessionId: string;
    dimensionHash: string;
    actionKind: "force" | "repair";
    expectedBreakerRevision: number;
  },
) {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 5 * 60_000).toISOString();
  return repo.createCompactionBreakerAction({
    actionId: `action-${input.actionKind}-${randomUUID()}`,
    ...input,
    actorHash: "sha256:operator-hash",
    requestEvidenceHash: "sha256:request-hash",
    policyDecisionHash: "sha256:policy-hash",
    auditEvidenceHash: "sha256:audit-hash",
    approvalId: `approval-${input.actionKind}`,
    reason: "operator reviewed exact provider evidence",
    status: "pending",
    createdAt,
    expiresAt,
  });
}

function tripBreaker(repo: ChatConversationSummaryRepository, sessionId: string, dimensionHash: string) {
  const firstSource = `trip-1-${sessionId}`;
  const first = repo.recordCompactionNoProgress({
    ...identity(sessionId, dimensionHash),
    attemptId: noProgressAttemptId(sessionId, dimensionHash, "turn-14", 14, firstSource),
    branchHeadTurnId: "turn-14",
    observedTurnCount: 14,
    attemptedBoundarySourceHash: firstSource,
  });
  const secondSource = `trip-2-${sessionId}`;
  return repo.recordCompactionNoProgress({
    ...identity(sessionId, dimensionHash),
    attemptId: noProgressAttemptId(sessionId, dimensionHash, "turn-22", 22, secondSource),
    branchHeadTurnId: "turn-22",
    observedTurnCount: 22,
    attemptedBoundarySourceHash: secondSource,
    expectedBreakerRevision: first.revision,
  });
}
