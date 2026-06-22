import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { ChatMessageRecord, ChatMessageRole } from "@goatcitadel/contracts";
import { ChatMessageRepository, buildSafeFtsMatchQuery } from "./chat-message-repo.js";
import { createDatabase } from "./sqlite.js";
import type { DatabaseClient } from "./db.js";

let messageCounter = 0;

function makeMessage(
  sessionId: string,
  role: ChatMessageRole,
  content: string,
  overrides: Partial<ChatMessageRecord> = {},
): ChatMessageRecord {
  messageCounter += 1;
  const ordinal = String(messageCounter).padStart(4, "0");
  return {
    messageId: overrides.messageId ?? `msg-${sessionId}-${ordinal}`,
    sessionId,
    role,
    actorType: role === "user" ? "user" : role === "system" ? "system" : "agent",
    actorId: role === "user" ? "operator" : "assistant",
    content,
    timestamp: overrides.timestamp ?? `2026-06-01T00:00:${ordinal.slice(-2)}.000Z`,
    ...overrides,
  };
}

function withDatabase(run: (db: DatabaseClient) => void): void {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-search-${randomUUID()}.db`);
  const db = createDatabase({ dbPath });
  try {
    run(db);
  } finally {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {
        // ignore cleanup failures in tests
      }
    }
  }
}

test("buildSafeFtsMatchQuery quotes tokens and neutralizes FTS operators", () => {
  assert.equal(buildSafeFtsMatchQuery("deploy plan"), '"deploy" "plan"');
  // Operators and punctuation degrade to literal quoted terms (no syntax meaning).
  assert.equal(buildSafeFtsMatchQuery("deploy AND OR NOT"), '"deploy" "AND" "OR" "NOT"');
  assert.equal(buildSafeFtsMatchQuery('"); DROP TABLE'), '"DROP" "TABLE"');
  assert.equal(buildSafeFtsMatchQuery("foo* (bar) ^baz col:val -neg"), '"foo" "bar" "baz" "col" "val" "neg"');
  // Unicode tokens are preserved.
  assert.equal(buildSafeFtsMatchQuery("café déjà"), '"café" "déjà"');
  // No searchable tokens -> null.
  assert.equal(buildSafeFtsMatchQuery("   "), null);
  assert.equal(buildSafeFtsMatchQuery("***"), null);
  assert.equal(buildSafeFtsMatchQuery(""), null);
});

test("searchMessages returns ranked hits and never throws on punctuation/operator input", () => {
  withDatabase((db) => {
    const repo = new ChatMessageRepository(db);
    repo.upsert(makeMessage("sess-a", "user", "We should deploy the gateway tomorrow"));
    repo.upsert(makeMessage("sess-a", "assistant", "Deploy is scheduled; the gateway rollout looks ready"));
    repo.upsert(makeMessage("sess-a", "user", "Unrelated note about lunch"));

    const hits = repo.searchMessages("gateway deploy");
    assert.equal(hits.length, 2);
    for (const hit of hits) {
      assert.match(hit.content.toLowerCase(), /gateway|deploy/);
      assert.equal(typeof hit.score, "number");
      assert.equal(hit.sessionId, "sess-a");
    }

    // Arbitrary operator-laden text must not raise an FTS syntax error. Operators
    // are sanitized into literal terms, so this is a plain (possibly empty) result.
    assert.doesNotThrow(() => repo.searchMessages('gateway AND (deploy OR "rollout") NEAR -note*'));
    assert.ok(Array.isArray(repo.searchMessages('gateway AND (deploy OR "rollout")')));
    // Quotes/parens around a real term still match that term as a literal.
    assert.ok(repo.searchMessages('"gateway"').length >= 1);
  });
});

test("searchMessages scopes hits to a single session when sessionId is provided", () => {
  withDatabase((db) => {
    const repo = new ChatMessageRepository(db);
    repo.upsert(makeMessage("sess-a", "user", "migration plan for the durable runtime"));
    repo.upsert(makeMessage("sess-b", "user", "migration plan for the billing service"));

    const scoped = repo.searchMessages("migration plan", { sessionId: "sess-a" });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]?.sessionId, "sess-a");

    const unscoped = repo.searchMessages("migration plan");
    assert.equal(unscoped.length, 2);
  });
});

test("searchMessages attaches a chronological context window around each hit", () => {
  withDatabase((db) => {
    const repo = new ChatMessageRepository(db);
    repo.upsert(makeMessage("sess-c", "user", "first message before"));
    repo.upsert(makeMessage("sess-c", "assistant", "second message before"));
    repo.upsert(makeMessage("sess-c", "user", "the UNIQUEMARKER hit message"));
    repo.upsert(makeMessage("sess-c", "assistant", "first message after"));
    repo.upsert(makeMessage("sess-c", "user", "second message after"));

    const hits = repo.searchMessages("UNIQUEMARKER", { contextRadius: 1 });
    assert.equal(hits.length, 1);
    const context = hits[0]?.context ?? [];
    assert.equal(context.length, 3, "context should be hit ± 1 neighbour");
    assert.equal(context[0]?.content, "second message before");
    assert.equal(context[1]?.isHit, true);
    assert.equal(context[2]?.content, "first message after");
    assert.equal(context.filter((entry) => entry.isHit).length, 1);

    // contextRadius 0 returns only the hit itself.
    const noContext = repo.searchMessages("UNIQUEMARKER", { contextRadius: 0 });
    assert.equal(noContext[0]?.context.length, 1);
    assert.equal(noContext[0]?.context[0]?.isHit, true);
  });
});

test("FTS index stays in sync with chat_messages on insert, update, and delete", () => {
  withDatabase((db) => {
    const repo = new ChatMessageRepository(db);
    const message = makeMessage("sess-d", "user", "original syncword content", { messageId: "msg-sync-1" });
    repo.upsert(message);

    // INSERT trigger indexed it.
    assert.equal(repo.searchMessages("syncword").length, 1);

    // UPDATE trigger retracts old terms and indexes new ones (same message_id via upsert).
    repo.upsert({ ...message, content: "replaced freshword content" });
    assert.equal(repo.searchMessages("syncword").length, 0, "old terms removed by update trigger");
    assert.equal(repo.searchMessages("freshword").length, 1, "new terms indexed by update trigger");

    // DELETE trigger removes it from the index.
    const deleted = repo.deleteByMessageIds("sess-d", ["msg-sync-1"]);
    assert.equal(deleted, 1);
    assert.equal(repo.searchMessages("freshword").length, 0, "delete trigger retracted the row");
  });
});

test("searchMessages returns empty for empty queries and no matches", () => {
  withDatabase((db) => {
    const repo = new ChatMessageRepository(db);
    repo.upsert(makeMessage("sess-e", "user", "some indexed content"));

    assert.deepEqual(repo.searchMessages(""), []);
    assert.deepEqual(repo.searchMessages("   "), []);
    assert.deepEqual(repo.searchMessages("***"), []);
    assert.deepEqual(repo.searchMessages("nonexistentterm"), []);
  });
});

test("searchMessages backfill rebuilds the index for pre-existing rows", () => {
  withDatabase((db) => {
    // Simulate an older database that has chat_messages rows but whose FTS index was
    // (re)built after the fact: drop the index, re-insert raw rows bypassing triggers,
    // then rebuild via the same command the migration uses.
    const repo = new ChatMessageRepository(db);
    repo.upsert(makeMessage("sess-f", "user", "backfillword present in history", { messageId: "msg-bf-1" }));

    db.exec("DELETE FROM chat_messages_fts;");
    assert.equal(repo.searchMessages("backfillword").length, 0, "index emptied");

    db.exec("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('rebuild');");
    assert.equal(repo.searchMessages("backfillword").length, 1, "rebuild restored the index");
  });
});
