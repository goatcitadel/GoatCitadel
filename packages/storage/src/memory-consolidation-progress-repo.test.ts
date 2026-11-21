import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryConsolidationProgressRepository } from "./memory-consolidation-progress-repo.js";
import { SystemSettingsRepository } from "./system-settings-repo.js";
import { ChatTurnTraceRepository } from "./chat-turn-trace-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const files = new TempSqliteFiles();
afterEach(() => files.cleanup());
const now = "2026-11-18T00:00:00.000Z";

it("commits source exclusion receipts with the exact checkpoint and preserves them across restart/replay", () => {
  const db = files.open({ dbPath: files.path("consolidation-exclusion") });
  try {
    const settings = new SystemSettingsRepository(db);
    const repo = new MemoryConsolidationProgressRepository(settings, db);
    const claim = repo.claimProgress("A", 0, "worker", now)!;
    const cursor = { finishedAt: now, turnId: "large-turn" };
    const exclusion = {
      ...cursor,
      sessionId: "source-session",
      sourceHash: "a".repeat(64),
      reason: "source_size_limit" as const,
    };
    const saved = repo.commitProgress("A", claim.revision, "worker", cursor, now, [exclusion]);
    expectExclusion(saved);
    const restarted = new MemoryConsolidationProgressRepository(settings, db);
    expectExclusion(restarted.readProgress("A"));
    const next = restarted.claimProgress("A", saved.revision, "worker-next", now)!;
    expectExclusion(restarted.commitProgress("A", next.revision, "worker-next", cursor, now, [exclusion]));
    assert.equal(restarted.readProgress("B").sourceExclusionCount ?? 0, 0);
    function expectExclusion(progress: ReturnType<typeof repo.readProgress>) {
      assert.equal(progress.sourceExclusionCount, 1);
      assert.deepEqual(
        progress.sourceExclusions?.map(({ recordedAt: _at, ...item }) => item),
        [exclusion],
      );
    }
  } finally {
    db.close();
  }
});

describe("workspace consolidation progress", () => {
  it("excludes concurrent workers, stale commits and backwards checkpoints without touching another workspace", () => {
    const db = files.open({ dbPath: files.path("consolidation-progress") });
    try {
      const repo = new MemoryConsolidationProgressRepository(new SystemSettingsRepository(db), db);
      assert.deepEqual(repo.readProgress("A"), { revision: 0 });
      const claim = repo.claimProgress("A", 0, "worker-a", now)!;
      assert.equal(repo.claimProgress("A", 0, "worker-b", now), undefined);
      assert.equal(repo.claimProgress("A", claim.revision, "worker-b", now), undefined);
      assert.throws(() => repo.commitProgress("A", claim.revision, "worker-b", undefined, now));
      const cursor = { finishedAt: now, turnId: "turn-b" };
      const saved = repo.commitProgress("A", claim.revision, "worker-a", cursor, now);
      assert.deepEqual(repo.readProgress("A").cursor, cursor);
      assert.deepEqual(repo.readProgress("B"), { revision: 0 });
      assert.throws(() => repo.commitProgress("A", claim.revision, "worker-a", cursor, now));
      const next = repo.claimProgress("A", saved.revision, "worker-b", now)!;
      assert.throws(() => repo.commitProgress("A", next.revision, "worker-b", { ...cursor, turnId: "turn-a" }, now));
      assert.throws(() => repo.readProgress(""));
    } finally {
      db.close();
    }
  });

  it("lets a new worker reclaim an expired lease and rejects the original worker", () => {
    const db = files.open({ dbPath: files.path("consolidation-expired") });
    try {
      const repo = new MemoryConsolidationProgressRepository(new SystemSettingsRepository(db), db);
      const first = repo.claimProgress("A", 0, "old", now)!;
      const later = "2026-11-18T00:06:00.000Z";
      const next = repo.claimProgress("A", first.revision, "new", later)!;
      assert.ok(next);
      assert.throws(() => repo.commitProgress("A", first.revision, "old", undefined, later));
      repo.commitProgress("A", next.revision, "new", { finishedAt: now, turnId: "first" }, later);
      assert.equal(repo.readProgress("A").leaseOwner, undefined);
    } finally {
      db.close();
    }
  });

  it("pages by completion time and turn ID within an explicit operator workspace", () => {
    const db = files.open({ dbPath: files.path("consolidation-page") });
    try {
      const repo = new ChatTurnTraceRepository(db);
      const meta = new ChatSessionMetaRepository(db);
      meta.ensure("session-a", now, "default");
      db.prepare("UPDATE chat_session_meta SET origin = 'operator' WHERE session_id = ?").run("session-a");
      meta.ensure("session-system", now, "default");
      db.prepare("UPDATE chat_session_meta SET origin = 'system' WHERE session_id = ?").run("session-system");
      for (const [turnId, sessionId, finishedAt] of [
        ["turn-c", "session-a", now],
        ["turn-a", "session-a", now],
        ["turn-b", "session-a", now],
        ["system", "session-system", now],
        ["unowned", "missing", now],
        ["late", "session-a", "2026-11-18T00:00:01.000Z"],
      ]) {
        repo.create({
          turnId: turnId!,
          sessionId: sessionId!,
          userMessageId: `user-${turnId}`,
          mode: "chat",
          webMode: "off",
          memoryMode: "on",
          thinkingLevel: "standard",
          startedAt: "2026-11-17T00:00:00.000Z",
        });
        repo.patch(turnId!, { status: "completed", finishedAt });
      }
      const input = {
        workspaceId: "default",
        after: { finishedAt: "2026-11-17T23:59:59.000Z", turnId: "" },
        through: now,
        limit: 2,
      };
      assert.deepEqual(
        repo.listCompletedTracePage(input).map((t) => t.turnId),
        ["turn-a", "turn-b"],
      );
      assert.deepEqual(
        repo.listCompletedTracePage({ ...input, after: { finishedAt: now, turnId: "turn-b" } }).map((t) => t.turnId),
        ["turn-c"],
      );
      assert.deepEqual(repo.listCompletedTracePage({ ...input, workspaceId: "foreign" }), []);
      assert.deepEqual(
        repo
          .listCompletedTracePage({
            ...input,
            after: { finishedAt: now, turnId: "turn-c" },
            through: "2026-11-18T00:00:02.000Z",
          })
          .map((t) => t.turnId),
        ["late"],
      );
    } finally {
      db.close();
    }
  });
});
