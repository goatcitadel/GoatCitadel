import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { ChatMessageRecord, ChatMessageRole } from "@goatcitadel/contracts";
import { ChatMessageRepository, buildSafeFtsMatchQuery, buildSafePostgresSearchQuery } from "./chat-message-repo.js";
import type { SearchMessagesOptions } from "./chat-message-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { createDatabase } from "./sqlite.js";
import type { DatabaseClient, DbStatement } from "./db.js";

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

function ensureSearchSessions(db: DatabaseClient, ...sessionIds: string[]): void {
  const meta = new ChatSessionMetaRepository(db);
  for (const sessionId of sessionIds) {
    meta.ensure(sessionId, "2026-06-01T00:00:00.000Z", "workspace-1");
  }
}

function search(repo: ChatMessageRepository, query: string, options: Omit<SearchMessagesOptions, "workspaceId"> = {}) {
  return repo.searchMessages(query, { workspaceId: "workspace-1", ...options });
}

function expectSqlUsesPostgresSearch(preparedSql: string[]): void {
  const searchSql = preparedSql.filter((sql) => sql.includes("content_search_vector")).join("\n");
  assert.match(searchSql, /plainto_tsquery\('simple', \?\)/);
  assert.match(searchSql, /content_search_vector @@ search_query\.query/);
  assert.doesNotMatch(searchSql, /chat_messages_fts/);
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

test("buildSafePostgresSearchQuery strips punctuation into plain tsquery input", () => {
  assert.equal(buildSafePostgresSearchQuery("deploy plan"), "deploy plan");
  assert.equal(buildSafePostgresSearchQuery('gateway AND (deploy OR "rollout")'), "gateway AND deploy OR rollout");
  assert.equal(buildSafePostgresSearchQuery(""), null);
  assert.equal(buildSafePostgresSearchQuery("***"), null);
});

test("searchMessages uses Postgres search vectors and coerces numeric rows", () => {
  const preparedSql: string[] = [];
  const searchCalls: unknown[][] = [];
  const db: DatabaseClient = {
    dialect: "postgres",
    prepare(sql: string): DbStatement {
      preparedSql.push(sql);
      return {
        run: () => ({ changes: 0 }),
        get: () => undefined,
        all: <T = unknown>(...params: unknown[]): T[] => {
          if (sql.includes("content_search_vector")) {
            searchCalls.push(params);
            return [
              {
                seq: "7",
                workspace_id: "workspace-1",
                include_in_history: 1,
                message_id: "msg-pg-hit",
                session_id: "sess-pg",
                role: "assistant",
                content: "Gateway deploy rollout",
                timestamp: "2026-06-01T00:00:07.000Z",
                score: "-0.42",
              },
            ] as unknown as T[];
          }
          if (sql.includes("m.seq < ?") || sql.includes("m.seq > ?")) return [];
          return [];
        },
      };
    },
    exec: () => undefined,
    close: () => undefined,
    transaction: (_mode, callback) => callback(),
  };

  const repo = new ChatMessageRepository(db);
  const hits = search(repo, 'gateway AND (deploy OR "rollout")', {
    sessionId: "sess-pg",
    limit: 3,
    contextRadius: 1,
  });

  expectSqlUsesPostgresSearch(preparedSql);
  assert.deepEqual(searchCalls[0], ["gateway AND deploy OR rollout", "workspace-1", 0, "sess-pg", 3]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.score, -0.42);
  assert.equal(hits[0]?.context[0]?.isHit, true);
});

test("searchMessages returns ranked hits and never throws on punctuation/operator input", () => {
  withDatabase((db) => {
    const repo = new ChatMessageRepository(db);
    ensureSearchSessions(db, "sess-a");
    repo.upsert(makeMessage("sess-a", "user", "We should deploy the gateway tomorrow"));
    repo.upsert(makeMessage("sess-a", "assistant", "Deploy is scheduled; the gateway rollout looks ready"));
    repo.upsert(makeMessage("sess-a", "user", "Unrelated note about lunch"));

    const hits = search(repo, "gateway deploy");
    assert.equal(hits.length, 2);
    for (const hit of hits) {
      assert.match(hit.content.toLowerCase(), /gateway|deploy/);
      assert.equal(typeof hit.score, "number");
      assert.equal(hit.sessionId, "sess-a");
    }

    // Arbitrary operator-laden text must not raise an FTS syntax error. Operators
    // are sanitized into literal terms, so this is a plain (possibly empty) result.
    assert.doesNotThrow(() => search(repo, 'gateway AND (deploy OR "rollout") NEAR -note*'));
    assert.ok(Array.isArray(search(repo, 'gateway AND (deploy OR "rollout")')));
    // Quotes/parens around a real term still match that term as a literal.
    assert.ok(search(repo, '"gateway"').length >= 1);
  });
});

test("searchMessages scopes hits to a single session when sessionId is provided", () => {
  withDatabase((db) => {
    const repo = new ChatMessageRepository(db);
    ensureSearchSessions(db, "sess-a", "sess-b");
    repo.upsert(makeMessage("sess-a", "user", "migration plan for the durable runtime"));
    repo.upsert(makeMessage("sess-b", "user", "migration plan for the billing service"));

    const scoped = search(repo, "migration plan", { sessionId: "sess-a" });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]?.sessionId, "sess-a");

    const unscoped = search(repo, "migration plan");
    assert.equal(unscoped.length, 2);
  });
});

test("searchMessages never crosses workspace boundaries and excludes hidden sessions by default", () => {
  withDatabase((db) => {
    const repo = new ChatMessageRepository(db);
    const meta = new ChatSessionMetaRepository(db);
    meta.ensure("visible-a", "2026-06-01T00:00:00.000Z", "workspace-1");
    meta.ensure("hidden-a", "2026-06-01T00:00:00.000Z", "workspace-1");
    meta.patch("hidden-a", { includeInHistory: false }, "2026-06-01T00:00:01.000Z");
    meta.ensure("visible-b", "2026-06-01T00:00:00.000Z", "workspace-2");
    repo.upsert(makeMessage("visible-a", "user", "workspace marker"));
    repo.upsert(makeMessage("hidden-a", "user", "workspace marker"));
    repo.upsert(makeMessage("visible-b", "user", "workspace marker"));

    const visible = search(repo, "workspace marker");
    assert.deepEqual(
      visible.map((hit) => hit.sessionId),
      ["visible-a"],
    );
    assert.equal(visible[0]?.workspaceId, "workspace-1");
    assert.ok(Number.isSafeInteger(visible[0]?.sequence));

    const withHidden = search(repo, "workspace marker", { includeHidden: true });
    assert.deepEqual(withHidden.map((hit) => hit.sessionId).sort(), ["hidden-a", "visible-a"]);
  });
});

test("searchMessages attaches a chronological context window around each hit", () => {
  withDatabase((db) => {
    const repo = new ChatMessageRepository(db);
    ensureSearchSessions(db, "sess-c");
    repo.upsert(makeMessage("sess-c", "user", "first message before"));
    repo.upsert(makeMessage("sess-c", "assistant", "second message before"));
    repo.upsert(makeMessage("sess-c", "user", "the UNIQUEMARKER hit message"));
    repo.upsert(makeMessage("sess-c", "assistant", "first message after"));
    repo.upsert(makeMessage("sess-c", "user", "second message after"));

    const hits = search(repo, "UNIQUEMARKER", { contextRadius: 1 });
    assert.equal(hits.length, 1);
    const context = hits[0]?.context ?? [];
    assert.equal(context.length, 3, "context should be hit ± 1 neighbour");
    assert.equal(context[0]?.content, "second message before");
    assert.equal(context[1]?.isHit, true);
    assert.equal(context[2]?.content, "first message after");
    assert.equal(context.filter((entry) => entry.isHit).length, 1);

    // contextRadius 0 returns only the hit itself.
    const noContext = search(repo, "UNIQUEMARKER", { contextRadius: 0 });
    assert.equal(noContext[0]?.context.length, 1);
    assert.equal(noContext[0]?.context[0]?.isHit, true);
  });
});

test("FTS index stays in sync with chat_messages on insert, update, and delete", () => {
  withDatabase((db) => {
    const repo = new ChatMessageRepository(db);
    ensureSearchSessions(db, "sess-d");
    const message = makeMessage("sess-d", "user", "original syncword content", { messageId: "msg-sync-1" });
    repo.upsert(message);

    // INSERT trigger indexed it.
    assert.equal(search(repo, "syncword").length, 1);

    // UPDATE trigger retracts old terms and indexes new ones (same message_id via upsert).
    repo.upsert({ ...message, content: "replaced freshword content" });
    assert.equal(search(repo, "syncword").length, 0, "old terms removed by update trigger");
    assert.equal(search(repo, "freshword").length, 1, "new terms indexed by update trigger");

    // DELETE trigger removes it from the index.
    const deleted = repo.deleteByMessageIds("sess-d", ["msg-sync-1"]);
    assert.equal(deleted, 1);
    assert.equal(search(repo, "freshword").length, 0, "delete trigger retracted the row");
  });
});

test("searchMessages returns empty for empty queries and no matches", () => {
  withDatabase((db) => {
    const repo = new ChatMessageRepository(db);
    ensureSearchSessions(db, "sess-e");
    repo.upsert(makeMessage("sess-e", "user", "some indexed content"));

    assert.deepEqual(search(repo, ""), []);
    assert.deepEqual(search(repo, "   "), []);
    assert.deepEqual(search(repo, "***"), []);
    assert.deepEqual(search(repo, "nonexistentterm"), []);
  });
});

test("searchMessages backfill rebuilds the index for pre-existing rows", () => {
  withDatabase((db) => {
    // Simulate an older database that has chat_messages rows but whose FTS index was
    // (re)built after the fact: drop the index, re-insert raw rows bypassing triggers,
    // then rebuild via the same command the migration uses.
    const repo = new ChatMessageRepository(db);
    ensureSearchSessions(db, "sess-f");
    repo.upsert(makeMessage("sess-f", "user", "backfillword present in history", { messageId: "msg-bf-1" }));

    db.exec("DELETE FROM chat_messages_fts;");
    assert.equal(search(repo, "backfillword").length, 0, "index emptied");

    db.exec("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('rebuild');");
    assert.equal(search(repo, "backfillword").length, 1, "rebuild restored the index");
  });
});
