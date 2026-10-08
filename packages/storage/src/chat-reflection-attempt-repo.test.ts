import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseClient } from "./db.js";
import { ChatReflectionAttemptRepository } from "./chat-reflection-attempt-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createStore(): { db: DatabaseClient; repo: ChatReflectionAttemptRepository } {
  const dbPath = tempDbs.path("goatcitadel-chat-reflection");
  const db = tempDbs.open({ dbPath });
  return { db, repo: new ChatReflectionAttemptRepository(db) };
}

describe("ChatReflectionAttemptRepository", () => {
  it("creates normalized reflection attempts and persists nullable fields", () => {
    const { db, repo } = createStore();
    const full = repo.create({
      attemptId: "attempt-a",
      turnId: "turn-a",
      sessionId: "session-a",
      reason: "low confidence",
      outcome: "repaired",
      attemptCount: 2.8,
      strategy: "  ask model to verify citations  ",
      error: "  recovered after retry  ",
      createdAt: "2026-03-26T00:00:01.000Z",
    });
    const minimal = repo.create({
      turnId: "turn-b",
      sessionId: "session-a",
      reason: "missing tool",
      outcome: "skipped",
      attemptCount: -4,
      strategy: "   ",
      error: null,
      createdAt: "2026-03-26T00:00:02.000Z",
    });

    assert.equal(full.attemptId, "attempt-a");
    assert.equal(full.attemptCount, 2);
    assert.equal(full.strategy, "ask model to verify citations");
    assert.equal(full.error, "recovered after retry");
    assert.equal(minimal.attemptId.length > 0, true);
    assert.equal(minimal.attemptCount, 1);
    assert.equal(minimal.strategy, undefined);
    assert.equal(minimal.error, undefined);

    const rows = db
      .prepare("SELECT * FROM chat_reflection_attempts WHERE session_id = ? ORDER BY created_at ASC")
      .all("session-a") as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.attempt_id, "attempt-a");
    assert.equal(rows[0]?.strategy, "ask model to verify citations");
    assert.equal(rows[1]?.strategy, null);
    assert.equal(rows[1]?.error, null);
  });
});
