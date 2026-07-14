import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { buildChatCompactionStateKey, ChatConversationSummaryRepository } from "./chat-conversation-summary-repo.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createRepo(): ChatConversationSummaryRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-conversation-summary-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new ChatConversationSummaryRepository(db);
}

describe("ChatConversationSummaryRepository", () => {
  it("reuses exact logical windows across branch heads without duplicating rows", () => {
    const repo = createRepo();

    const created = repo.upsert({
      sessionId: "sess-1",
      branchHeadTurnId: "turn-9",
      startTurnId: "turn-1",
      endTurnId: "turn-8",
      turnIds: ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8"],
      sourceHash: "hash-1",
      tokenEstimate: 640,
      summary: "First summary",
    });

    assert.equal(created.summary, "First summary");
    assert.equal(created.turnIds.length, 8);

    const reused = repo.upsert({
      sessionId: "sess-1",
      branchHeadTurnId: "turn-12",
      startTurnId: "turn-1",
      endTurnId: "turn-8",
      turnIds: ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8"],
      sourceHash: "hash-1",
      tokenEstimate: 640,
      summary: "Concurrent duplicate summary",
      updatedAt: "2026-03-12T10:00:00.000Z",
    });

    assert.equal(reused.summaryId, created.summaryId);
    assert.equal(reused.summary, "First summary");
    assert.equal(reused.sourceHash, "hash-1");
    assert.equal(repo.listByBranch("sess-1", "turn-9").length, 1);

    repo.upsert({
      sessionId: "sess-1",
      branchHeadTurnId: "turn-12",
      startTurnId: "turn-9",
      endTurnId: "turn-11",
      turnIds: ["turn-9", "turn-10", "turn-11"],
      sourceHash: "hash-3",
      tokenEstimate: 280,
      summary: "Different branch summary",
    });

    assert.equal(repo.listByBranch("sess-1", "turn-9").length, 1);
    assert.equal(repo.listByBranch("sess-1", "turn-12").length, 1);
    assert.equal(repo.listBySession("sess-1", 10).length, 2);
    assert.equal(
      repo.findReusableWindow({
        sessionId: "sess-1",
        turnIds: ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8"],
        sourceHash: "hash-1",
      })?.summaryId,
      created.summaryId,
    );
  });

  it("keeps exact-window and monotonic-state writes idempotent across two database writers", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-conversation-summary-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const firstDb = createDatabase({ dbPath });
    const secondDb = createDatabase({ dbPath });
    try {
      const first = new ChatConversationSummaryRepository(firstDb);
      const second = new ChatConversationSummaryRepository(secondDb);
      const summaryInput = {
        sessionId: "sess-two-writer",
        branchHeadTurnId: "turn-9",
        startTurnId: "turn-1",
        endTurnId: "turn-8",
        turnIds: ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8"],
        sourceHash: "two-writer-source",
        tokenEstimate: 640,
        summary: "First writer summary",
      };

      const firstSummary = first.upsert(summaryInput);
      const secondSummary = second.upsert({ ...summaryInput, summary: "Second writer duplicate" });
      assert.equal(secondSummary.summaryId, firstSummary.summaryId);
      assert.equal(secondSummary.summary, "First writer summary");

      const boundaryTurnIds = summaryInput.turnIds;
      const stateKey = buildChatCompactionStateKey(
        summaryInput.sessionId,
        "dimension-two-writer",
        boundaryTurnIds,
        "two-writer-boundary",
      );
      const firstState = first.upsertCompactionState({
        stateKey,
        sessionId: summaryInput.sessionId,
        dimensionHash: "dimension-two-writer",
        boundaryTurnIds,
        boundarySourceHash: "two-writer-boundary",
        baselineInputTokens: 1200,
        lastObservedInputTokens: 1200,
        observedTurnCount: 14,
        armed: true,
      });
      const secondState = second.upsertCompactionState({
        ...firstState,
        baselineInputTokens: 2400,
        lastObservedInputTokens: 2400,
        armed: false,
      });

      assert.equal(secondState.baselineInputTokens, 1200);
      assert.equal(secondState.armed, false);
      assert.equal(first.listCompactionStates(summaryInput.sessionId, "dimension-two-writer").length, 1);
    } finally {
      secondDb.close();
      firstDb.close();
    }
  });

  it("bounds retained summary and compaction-state rows per session", () => {
    const repo = createRepo();
    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;
    const sessionId = "sess-retention";

    for (let index = 0; index < 257; index += 1) {
      const turnId = `turn-summary-${index}`;
      repo.upsert({
        sessionId,
        branchHeadTurnId: turnId,
        startTurnId: turnId,
        endTurnId: turnId,
        turnIds: [turnId],
        sourceHash: `summary-source-${index}`,
        tokenEstimate: index,
        summary: `summary ${index}`,
      });
    }
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM chat_conversation_summaries WHERE session_id = ?")
        .get<{ count: number }>(sessionId)?.count,
      256,
    );

    for (let index = 0; index < 129; index += 1) {
      const boundaryTurnIds = [`turn-state-${index}`];
      const dimensionHash = `dimension-${index}`;
      const boundarySourceHash = `state-source-${index}`;
      repo.upsertCompactionState({
        stateKey: buildChatCompactionStateKey(sessionId, dimensionHash, boundaryTurnIds, boundarySourceHash),
        sessionId,
        dimensionHash,
        boundaryTurnIds,
        boundarySourceHash,
        baselineInputTokens: 1000 + index,
        lastObservedInputTokens: 1000 + index,
        observedTurnCount: index + 1,
        armed: index % 2 === 0,
      });
    }
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM chat_compaction_states WHERE session_id = ?")
        .get<{ count: number }>(sessionId)?.count,
      128,
    );
    assert.equal(repo.listCompactionStates(sessionId, "dimension-128").length, 1);
  });

  it("fails closed on malformed or oversized state and keeps replay updates monotonic", () => {
    const repo = createRepo();

    assert.throws(() => repo.get("missing-summary"), /Chat conversation summary missing-summary not found/);

    const created = repo.upsert({
      summaryId: "summary-1",
      sessionId: "sess-1",
      branchHeadTurnId: "turn-9",
      startTurnId: "turn-1",
      endTurnId: "turn-8",
      turnIds: ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8"],
      sourceHash: "hash-1",
      tokenEstimate: 120,
      summary: "Summary",
      createdAt: "2026-03-12T09:00:00.000Z",
      updatedAt: "2026-03-12T09:00:00.000Z",
    });

    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;
    db.prepare("UPDATE chat_conversation_summaries SET turn_ids_json = @json WHERE summary_id = @summaryId").run({
      json: "{bad-json",
      summaryId: created.summaryId,
    });
    assert.throws(() => repo.get(created.summaryId), /not found/);
    assert.throws(
      () =>
        repo.upsert({
          sessionId: "sess-1",
          branchHeadTurnId: "turn-oversized",
          startTurnId: "turn-1",
          endTurnId: "turn-1",
          turnIds: ["turn-1"],
          sourceHash: "hash-oversized",
          tokenEstimate: 1,
          summary: "x".repeat(65_537),
        }),
      /summary must be a non-empty string no longer than 65536/,
    );
    const oversizedBoundary = Array.from({ length: 513 }, (_, index) => `turn-${index + 1}`);
    assert.throws(
      () =>
        repo.upsertCompactionState({
          stateKey: buildChatCompactionStateKey("sess-1", "dimension-oversized", oversizedBoundary, "hash"),
          sessionId: "sess-1",
          dimensionHash: "dimension-oversized",
          boundaryTurnIds: oversizedBoundary,
          boundarySourceHash: "hash",
          baselineInputTokens: 1,
          lastObservedInputTokens: 1,
          observedTurnCount: 513,
          armed: false,
        }),
      /turnIds must contain between 1 and 512 entries/,
    );

    const boundaryTurnIds = ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6", "turn-7", "turn-8"];
    const state = repo.upsertCompactionState({
      stateKey: buildChatCompactionStateKey("sess-1", "dimension-1", boundaryTurnIds, "boundary-hash"),
      sessionId: "sess-1",
      dimensionHash: "dimension-1",
      boundaryTurnIds,
      boundarySourceHash: "boundary-hash",
      baselineInputTokens: 1200,
      lastObservedInputTokens: 1200,
      observedTurnCount: 14,
      armed: true,
    });
    assert.equal(state.armed, true);
    const replayedOlderObservation = repo.upsertCompactionState({
      ...state,
      baselineInputTokens: 500,
      lastObservedInputTokens: 500,
      observedTurnCount: 13,
      armed: false,
    });
    assert.equal(replayedOlderObservation.observedTurnCount, 14);
    assert.equal(replayedOlderObservation.armed, true);
    const delayedSameCountRearm = repo.upsertCompactionState({
      ...state,
      baselineInputTokens: 900,
      lastObservedInputTokens: 900,
      observedTurnCount: 14,
      armed: true,
    });
    assert.equal(delayedSameCountRearm.observedTurnCount, 14);
    assert.equal(delayedSameCountRearm.baselineInputTokens, 1200);
    assert.equal(delayedSameCountRearm.armed, true);
    const sameCountDisarmReplay = repo.upsertCompactionState({
      ...state,
      baselineInputTokens: 2000,
      lastObservedInputTokens: 2000,
      observedTurnCount: 14,
      armed: false,
    });
    assert.equal(sameCountDisarmReplay.baselineInputTokens, 1200);
    assert.equal(sameCountDisarmReplay.armed, false);
    const delayedSameCountRearmAfterDisarm = repo.upsertCompactionState({
      ...state,
      baselineInputTokens: 800,
      lastObservedInputTokens: 800,
      observedTurnCount: 14,
      armed: true,
    });
    assert.equal(delayedSameCountRearmAfterDisarm.baselineInputTokens, 1200);
    assert.equal(delayedSameCountRearmAfterDisarm.armed, false);

    db.prepare("UPDATE chat_compaction_states SET boundary_turn_ids_json = @json WHERE state_key = @stateKey").run({
      json: "{bad-json",
      stateKey: state.stateKey,
    });
    assert.deepEqual(repo.listCompactionStates("sess-1", "dimension-1"), []);

    const internal = repo as unknown as {
      getByWindowKeyStmt: { get: (...args: unknown[]) => unknown };
      listByBranchStmt: { all: (...args: unknown[]) => unknown };
      listBySessionStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.getByWindowKeyStmt = { get: () => undefined };
    assert.throws(
      () =>
        repo.upsert({
          sessionId: "sess-2",
          branchHeadTurnId: "turn-2",
          startTurnId: "turn-1",
          endTurnId: "turn-1",
          turnIds: ["turn-1"],
          sourceHash: "hash-2",
          tokenEstimate: 20,
          summary: "Unreadable",
        }),
      /Failed to read chat conversation summary after idempotent insert/,
    );

    internal.listByBranchStmt = { all: () => [null] };
    internal.listBySessionStmt = { all: () => ({ not: "an array" }) };
    assert.deepEqual(repo.listByBranch("sess-1", "turn-9"), []);
    assert.deepEqual(repo.listBySession("sess-1"), []);
  });

  it("installs additive SQLite 155 and Postgres 97 without renumbering prior migrations", () => {
    const repo = createRepo();
    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;
    const sqliteMigration = db.prepare("SELECT version, name FROM schema_migrations WHERE version = 155").get() as {
      version: number;
      name: string;
    };
    assert.deepEqual({ ...sqliteMigration }, { version: 155, name: "chat_compaction_hysteresis_state" });
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM pragma_table_info('chat_conversation_summaries') WHERE name = 'window_key'",
        )
        .get<{ count: number }>()?.count,
      1,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'chat_compaction_states'")
        .get<{ count: number }>()?.count,
      1,
    );

    const postgres = POSTGRES_MIGRATIONS.find((migration) => migration.version === 97);
    assert.equal(postgres?.name, "chat_compaction_hysteresis_state");
    assert.match(postgres?.sql ?? "", /ADD COLUMN IF NOT EXISTS window_key TEXT/);
    assert.match(postgres?.sql ?? "", /CREATE TABLE IF NOT EXISTS chat_compaction_states/);
    assert.equal(
      POSTGRES_MIGRATIONS.find((migration) => migration.version === 96)?.name,
      "chat_turn_capability_profiles",
    );
  });
});
