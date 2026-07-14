import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { ChatMessageRecord } from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatMessageRepository } from "./chat-message-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { StateValidationQuarantineRepository } from "./state-validation-quarantine-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): ChatMessageRepository {
  return createRepoWithDb().repo;
}

function createRepoWithDb(): { repo: ChatMessageRepository; db: ReturnType<typeof createDatabase> } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-messages-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { repo: new ChatMessageRepository(db), db };
}

function message(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    messageId: "m1",
    sessionId: "sess-1",
    role: "user",
    actorType: "user",
    actorId: "operator",
    content: "hello",
    timestamp: "2026-03-05T01:00:00.000Z",
    ...overrides,
  };
}

function setRawMessageField(db: DatabaseClient, messageId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_messages SET ${field} = ? WHERE message_id = ?`).run(value, messageId);
}

function createFailingBatchRepo(execLog: string[]): ChatMessageRepository {
  const statement: DbStatement = {
    run: () => {
      throw new Error("insert failed");
    },
    get: () => undefined,
    all: () => [],
  };
  const db: DatabaseClient = {
    dialect: "sqlite",
    prepare: () => statement,
    exec: (sql) => {
      execLog.push(sql);
    },
    close: () => undefined,
    transaction: (mode, callback) => {
      execLog.push(`BEGIN ${mode}`);
      try {
        const result = callback();
        execLog.push("COMMIT");
        return result;
      } catch (error) {
        execLog.push("ROLLBACK");
        throw error;
      }
    },
  };
  return new ChatMessageRepository(db);
}

function createGuardRepo(options: {
  countRow?: unknown;
  cursorRow?: unknown;
  latestRows?: unknown;
}): ChatMessageRepository {
  const noopStatement: DbStatement = {
    run: () => ({ changes: 0 }),
    get: () => undefined,
    all: () => [],
  };
  const countStatement: DbStatement = {
    ...noopStatement,
    get: <T = unknown>() => options.countRow as T | undefined,
  };
  const cursorStatement: DbStatement = {
    ...noopStatement,
    get: <T = unknown>() => options.cursorRow as T | undefined,
  };
  const latestStatement: DbStatement = {
    ...noopStatement,
    all: () => options.latestRows as never[],
  };
  const db: DatabaseClient = {
    dialect: "sqlite",
    prepare(sql) {
      if (sql.includes("SELECT COUNT(1)")) {
        return countStatement;
      }
      if (sql.includes("SELECT seq")) {
        return cursorStatement;
      }
      if (sql.includes("ORDER BY seq DESC")) {
        return latestStatement;
      }
      return noopStatement;
    },
    exec: () => undefined,
    close: () => undefined,
    transaction: (_mode, callback) => callback(),
  };
  return new ChatMessageRepository(db);
}

describe("ChatMessageRepository", () => {
  it("lists latest messages in ascending display order", () => {
    const repo = createRepo();
    repo.upsert({
      messageId: "m1",
      sessionId: "sess-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "first",
      timestamp: "2026-03-05T01:00:00.000Z",
    });
    repo.upsert({
      messageId: "m2",
      sessionId: "sess-1",
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: "second",
      timestamp: "2026-03-05T01:00:01.000Z",
    });
    repo.upsert({
      messageId: "m3",
      sessionId: "sess-1",
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: "third",
      timestamp: "2026-03-05T01:00:02.000Z",
    });

    const items = repo.list("sess-1", 2);
    assert.deepEqual(
      items.map((item) => item.messageId),
      ["m2", "m3"],
    );
  });

  it("pages older items by cursor message id", () => {
    const repo = createRepo();
    for (let index = 1; index <= 5; index += 1) {
      repo.upsert({
        messageId: `m${index}`,
        sessionId: "sess-1",
        role: index % 2 === 0 ? "assistant" : "user",
        actorType: index % 2 === 0 ? "agent" : "user",
        actorId: index % 2 === 0 ? "assistant" : "operator",
        content: `msg-${index}`,
        timestamp: `2026-03-05T01:00:0${index}.000Z`,
      });
    }
    const page = repo.list("sess-1", 2, "m4");
    assert.deepEqual(
      page.map((item) => item.messageId),
      ["m2", "m3"],
    );
  });

  it("bounds the first keyset page by the captured high-water sequence", () => {
    const boundedCalls: unknown[][] = [];
    const noopStatement: DbStatement = {
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => [],
    };
    const db: DatabaseClient = {
      dialect: "postgres",
      prepare(sql) {
        if (sql.includes("SELECT workspace_id") && sql.includes("chat_session_meta")) {
          return {
            ...noopStatement,
            get: <T = unknown>() => ({ workspace_id: "workspace-1" }) as T,
          };
        }
        if (sql.includes("SELECT MAX(cm.seq) AS seq")) {
          // Model a READ COMMITTED transaction whose first statement observes seq=2.
          return { ...noopStatement, get: <T = unknown>() => ({ seq: 2 }) as T };
        }
        if (sql.includes("cm.seq <= ?") && sql.includes("ORDER BY cm.seq DESC")) {
          return {
            ...noopStatement,
            all: <T = unknown>(...params: unknown[]): T[] => {
              boundedCalls.push(params);
              return [
                {
                  seq: 2,
                  message_id: "m2",
                  session_id: "sess-1",
                  role: "assistant",
                  actor_type: "agent",
                  actor_id: "assistant",
                  content: "captured",
                  parts_json: null,
                  attachments_json: null,
                  timestamp: "2026-03-05T01:00:02.000Z",
                  token_input: null,
                  token_output: null,
                  cost_usd: null,
                  created_at: "2026-03-05T01:00:02.000Z",
                  steered: null,
                  parent_delegation_step_id: null,
                },
              ] as unknown as T[];
            },
          };
        }
        if (
          sql.includes("WHERE session_id = ?") &&
          !sql.includes("seq < ?") &&
          !sql.includes("seq > ?") &&
          sql.includes("ORDER BY seq DESC")
        ) {
          return {
            ...noopStatement,
            all: () => {
              throw new Error("unbounded latest read would admit the concurrent seq=3 append");
            },
          };
        }
        return noopStatement;
      },
      exec: () => undefined,
      close: () => undefined,
      transaction: (_mode, callback) => callback(),
    };

    const page = new ChatMessageRepository(db).listPage({
      workspaceId: "workspace-1",
      sessionId: "sess-1",
      limit: 2,
    });

    assert.deepEqual(boundedCalls, [["workspace-1", "sess-1", 2, 3]]);
    assert.equal(page.snapshotMaxSequence, 2);
    assert.deepEqual(
      page.items.map((item) => item.messageId),
      ["m2"],
    );
  });

  it("returns explicit stale cursor truth instead of falling back to latest messages", () => {
    const { repo, db } = createRepoWithDb();
    new ChatSessionMetaRepository(db).ensure("sess-page", undefined, "workspace-1");
    repo.upsertMany([
      message({ messageId: "page-1", sessionId: "sess-page" }),
      message({ messageId: "page-2", sessionId: "sess-page" }),
    ]);

    const page = repo.listPage({
      workspaceId: "workspace-1",
      sessionId: "sess-page",
      cursor: "deleted-cursor",
    });

    assert.equal(page.cursorState, "stale");
    assert.deepEqual(page.items, []);
  });

  it("freezes numeric-offset compatibility pages to the first page high-water mark", () => {
    const { repo, db } = createRepoWithDb();
    new ChatSessionMetaRepository(db).ensure("sess-offset", undefined, "workspace-1");
    for (let index = 1; index <= 5; index += 1) {
      repo.upsert(message({ messageId: `offset-${index}`, sessionId: "sess-offset" }));
    }
    const first = repo.listOffsetPage({
      workspaceId: "workspace-1",
      sessionId: "sess-offset",
      limit: 2,
      offset: 0,
    });
    repo.upsert(message({ messageId: "offset-concurrent", sessionId: "sess-offset" }));
    const second = repo.listOffsetPage({
      workspaceId: "workspace-1",
      sessionId: "sess-offset",
      limit: 2,
      offset: first.nextOffset,
      snapshotMaxSequence: first.snapshotMaxSequence,
      snapshotMessageCount: first.snapshotMessageCount,
    });

    assert.equal(first.cursorState, "offset");
    assert.equal(second.cursorState, "offset");
    assert.equal(
      second.items.some((item) => item.messageId === "offset-concurrent"),
      false,
    );
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.messageId)).size, 4);
    assert.equal(
      repo.listOffsetPage({
        workspaceId: "workspace-1",
        sessionId: "sess-offset",
        limit: 2,
        offset: 2,
      }).cursorState,
      "stale",
    );

    repo.deleteByMessageIds("sess-offset", [first.items.at(-1)!.messageId]);
    assert.equal(
      repo.listOffsetPage({
        workspaceId: "workspace-1",
        sessionId: "sess-offset",
        limit: 2,
        offset: first.nextOffset,
        snapshotMaxSequence: first.snapshotMaxSequence,
        snapshotMessageCount: first.snapshotMessageCount,
      }).cursorState,
      "stale",
      "deleting a row before the next numeric offset must not shift and skip a message",
    );
  });

  it("centers and top-ups exact anchored windows without crossing session or workspace identity", () => {
    const { repo, db } = createRepoWithDb();
    const meta = new ChatSessionMetaRepository(db);
    meta.ensure("sess-anchor", undefined, "workspace-1");
    meta.ensure("sess-other", undefined, "workspace-2");
    for (let index = 1; index <= 7; index += 1) {
      repo.upsert(message({ messageId: `anchor-${index}`, sessionId: "sess-anchor", content: `message ${index}` }));
      if (index <= 3) {
        repo.upsert(message({ messageId: `other-${index}`, sessionId: "sess-other", content: `other ${index}` }));
      }
    }
    const anchorSequence = Number(
      (db.prepare("SELECT seq FROM chat_messages WHERE message_id = ?").get("anchor-2") as { seq: number }).seq,
    );

    const found = repo.readAnchoredWindow(
      {
        workspaceId: "workspace-1",
        sessionId: "sess-anchor",
        messageId: "anchor-2",
        sequence: anchorSequence,
      },
      5,
    );
    assert.equal(found.anchor.state, "found");
    assert.deepEqual(
      found.items.map((entry) => entry.message.messageId),
      ["anchor-1", "anchor-2", "anchor-3", "anchor-4", "anchor-5"],
    );
    assert.equal(found.items.filter((entry) => entry.isAnchor).length, 1);

    assert.equal(
      repo.readAnchoredWindow({
        workspaceId: "workspace-1",
        sessionId: "sess-anchor",
        messageId: "anchor-2",
        sequence: anchorSequence + 1,
      }).anchor.state,
      "identity_mismatch",
    );
    assert.equal(
      repo.readAnchoredWindow({
        workspaceId: "workspace-2",
        sessionId: "sess-anchor",
        messageId: "anchor-2",
        sequence: anchorSequence,
      }).anchor.state,
      "identity_mismatch",
    );

    repo.deleteByMessageIds("sess-anchor", ["anchor-2"]);
    const unavailable = repo.readAnchoredWindow({
      workspaceId: "workspace-1",
      sessionId: "sess-anchor",
      messageId: "anchor-2",
      sequence: anchorSequence,
    });
    assert.equal(unavailable.anchor.state, "unavailable");
    assert.equal(unavailable.anchor.unavailableReason, "missing_deleted_or_compacted");
  });

  it("pages older and newer from exact anchored cursors without duplicates, skips, or snapshot drift", () => {
    const { repo, db } = createRepoWithDb();
    const meta = new ChatSessionMetaRepository(db);
    meta.ensure("sess-continuation", undefined, "workspace-1");
    meta.ensure("sess-gap", undefined, "workspace-1");
    for (let index = 1; index <= 6; index += 1) {
      repo.upsert(message({ messageId: `continuation-${index}`, sessionId: "sess-continuation" }));
      repo.upsert(message({ messageId: `gap-${index}`, sessionId: "sess-gap" }));
    }
    const anchorSequence = Number(
      (db.prepare("SELECT seq FROM chat_messages WHERE message_id = ?").get("continuation-4") as { seq: number }).seq,
    );
    const window = repo.readAnchoredWindow(
      {
        workspaceId: "workspace-1",
        sessionId: "sess-continuation",
        messageId: "continuation-4",
        sequence: anchorSequence,
      },
      1,
    );
    assert.equal(window.anchor.state, "found");
    const oldest = window.items[0]!;
    const newest = window.items.at(-1)!;
    const snapshotMaxSequence = window.snapshotMaxSequence!;

    repo.upsert(message({ messageId: "continuation-appended", sessionId: "sess-continuation" }));
    const older = repo.readHistoryContinuation({
      workspaceId: "workspace-1",
      sessionId: "sess-continuation",
      direction: "older",
      cursorMessageId: oldest.message.messageId,
      cursorSequence: oldest.sequence,
      snapshotMaxSequence,
      limit: 2,
    });
    const newer = repo.readHistoryContinuation({
      workspaceId: "workspace-1",
      sessionId: "sess-continuation",
      direction: "newer",
      cursorMessageId: newest.message.messageId,
      cursorSequence: newest.sequence,
      snapshotMaxSequence,
      limit: 2,
    });
    assert.equal(older.hasMore, true);
    assert.ok(older.nextCursor);
    const oldestPage = repo.readHistoryContinuation({
      workspaceId: "workspace-1",
      sessionId: "sess-continuation",
      direction: "older",
      cursorMessageId: older.nextCursor!.messageId,
      cursorSequence: older.nextCursor!.sequence,
      snapshotMaxSequence: older.nextCursor!.snapshotMaxSequence,
      limit: 2,
    });
    const allIds = [...oldestPage.items, ...older.items, ...window.items, ...newer.items].map(
      (entry) => entry.message.messageId,
    );
    assert.deepEqual(
      allIds,
      Array.from({ length: 6 }, (_, index) => `continuation-${index + 1}`),
    );
    assert.equal(new Set(allIds).size, allIds.length);
    assert.equal(
      allIds.includes("continuation-appended"),
      false,
      "post-snapshot appends must not enter continuation pages",
    );
    assert.equal(older.cursorState, "valid");
    assert.equal(newer.cursorState, "valid");

    repo.deleteByMessageIds("sess-continuation", [oldest.message.messageId]);
    const stale = repo.readHistoryContinuation({
      workspaceId: "workspace-1",
      sessionId: "sess-continuation",
      direction: "older",
      cursorMessageId: oldest.message.messageId,
      cursorSequence: oldest.sequence,
      snapshotMaxSequence,
      limit: 2,
    });
    assert.equal(stale.cursorState, "stale");
    assert.deepEqual(stale.items, []);
  });

  it("loads selected messages in one bounded batch", () => {
    const repo = createRepo();
    repo.upsertMany([
      message({ messageId: "m1", content: "first" }),
      message({ messageId: "m2", role: "assistant", actorType: "agent", actorId: "assistant", content: "second" }),
      message({ messageId: "m3", content: "third" }),
    ]);

    const byId = repo.listByMessageIds(["m3", "m1", "m1", "missing"]);

    assert.deepEqual([...byId.keys()].sort(), ["m1", "m3"]);
    assert.equal(byId.get("m3")?.content, "third");
  });

  it("upsertMany works inside an outer transaction", () => {
    const { repo, db } = createRepoWithDb();
    const messages = [
      {
        messageId: "m1",
        sessionId: "sess-nested",
        role: "user" as const,
        actorType: "user" as const,
        actorId: "operator",
        content: "first",
        timestamp: "2026-03-05T01:00:00.000Z",
      },
      {
        messageId: "m2",
        sessionId: "sess-nested",
        role: "assistant" as const,
        actorType: "agent" as const,
        actorId: "assistant",
        content: "second",
        timestamp: "2026-03-05T01:00:01.000Z",
      },
    ];

    db.exec("BEGIN IMMEDIATE");
    try {
      repo.upsertMany(messages);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const items = repo.list("sess-nested");
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((item) => item.messageId),
      ["m1", "m2"],
    );
  });

  it("preserves original createdAt when a message is upserted again", () => {
    const { repo, db } = createRepoWithDb();
    repo.upsert({
      messageId: "m1",
      sessionId: "sess-created-at",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "first",
      timestamp: "2026-03-05T01:00:00.000Z",
    });

    repo.upsert({
      messageId: "m1",
      sessionId: "sess-created-at",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "updated",
      timestamp: "2026-03-05T01:01:00.000Z",
    });

    const [item] = repo.list("sess-created-at");
    const row = db.prepare("SELECT created_at FROM chat_messages WHERE message_id = ?").get("m1") as
      | { created_at: string }
      | undefined;
    assert.equal(item?.content, "updated");
    assert.equal(row?.created_at, "2026-03-05T01:00:00.000Z");
  });

  it("preserves original createdAt when messages are batch upserted again", () => {
    const { repo, db } = createRepoWithDb();
    repo.upsertMany([
      {
        messageId: "m1",
        sessionId: "sess-created-at-batch",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "first",
        timestamp: "2026-03-05T01:00:00.000Z",
      },
    ]);

    repo.upsertMany([
      {
        messageId: "m1",
        sessionId: "sess-created-at-batch",
        role: "user",
        actorType: "user",
        actorId: "operator",
        content: "updated",
        timestamp: "2026-03-05T01:01:00.000Z",
      },
    ]);

    const [item] = repo.list("sess-created-at-batch");
    const row = db.prepare("SELECT created_at FROM chat_messages WHERE message_id = ?").get("m1") as
      | { created_at: string }
      | undefined;
    assert.equal(item?.content, "updated");
    assert.equal(row?.created_at, "2026-03-05T01:00:00.000Z");
  });

  it("round-trips counts, get lookups, usage, multimodal parts, and attachments", () => {
    const { repo, db } = createRepoWithDb();
    repo.upsert(
      message({
        messageId: "m-rich",
        parts: [
          { type: "text", text: "hello" },
          { type: "image_ref", attachmentId: "img-1", mimeType: "image/png", detail: "auto" },
          { type: "audio_ref", attachmentId: "aud-1", mimeType: "audio/wav" },
          { type: "video_ref", attachmentId: "vid-1", mimeType: "video/mp4" },
          { type: "file_ref", attachmentId: "file-1", mimeType: "application/pdf" },
        ],
        tokenInput: 12,
        tokenOutput: 34,
        costUsd: 0.056,
        attachments: [
          {
            attachmentId: "file-1",
            fileName: "notes.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1234,
          },
        ],
      }),
      "2026-03-05T01:00:10.000Z",
    );

    const loaded = repo.get("m-rich");
    assert.equal(repo.countBySession("sess-1"), 1);
    assert.equal(loaded?.tokenInput, 12);
    assert.equal(loaded?.tokenOutput, 34);
    assert.equal(loaded?.costUsd, 0.056);
    assert.deepEqual(
      loaded?.parts?.map((part) => part.type),
      ["text", "image_ref", "audio_ref", "video_ref", "file_ref"],
    );
    assert.deepEqual(loaded?.attachments, [
      {
        attachmentId: "file-1",
        fileName: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1234,
      },
    ]);
    assert.equal(repo.get("missing-message"), undefined);

    setRawMessageField(db, "m-rich", "parts_json", '{"not":"array"}');
    assert.equal(repo.get("m-rich")?.parts, undefined);
    setRawMessageField(db, "m-rich", "parts_json", "{bad json");
    assert.equal(repo.get("m-rich")?.parts, undefined);
    setRawMessageField(db, "m-rich", "parts_json", '[{"type":"image_ref","attachmentId":"img-1","detail":"bad"}]');
    assert.equal(repo.get("m-rich")?.parts, undefined);

    setRawMessageField(db, "m-rich", "attachments_json", '{"not":"array"}');
    assert.equal(repo.get("m-rich")?.attachments, undefined);
    setRawMessageField(db, "m-rich", "attachments_json", "{bad json");
    assert.equal(repo.get("m-rich")?.attachments, undefined);
    setRawMessageField(
      db,
      "m-rich",
      "attachments_json",
      '[null, {"attachmentId":"file-1"}, {"attachmentId":"file-2","fileName":"bad","mimeType":"text/plain","sizeBytes":"big"}]',
    );
    assert.equal(repo.get("m-rich")?.attachments, undefined);
  });

  it("handles empty, large, and failed batch upserts", () => {
    const { repo } = createRepoWithDb();
    repo.upsertMany([]);
    assert.equal(repo.countBySession("sess-empty"), 0);

    repo.upsertMany(
      Array.from({ length: 51 }, (_, index) =>
        message({
          messageId: `batch-${index}`,
          sessionId: "sess-batch",
          content: `message-${index}`,
          timestamp: `2026-03-05T01:00:${String(index).padStart(2, "0")}.000Z`,
        }),
      ),
    );
    assert.equal(repo.countBySession("sess-batch"), 51);

    const execLog: string[] = [];
    assert.throws(() => createFailingBatchRepo(execLog).upsertMany([message()]), /insert failed/);
    assert.equal(execLog.length, 3);
    assert.match(execLog[0] ?? "", /^SAVEPOINT chat_messages_upsert_many_/);
    assert.match(execLog[1] ?? "", /^ROLLBACK TO SAVEPOINT chat_messages_upsert_many_/);
    assert.match(execLog[2] ?? "", /^RELEASE SAVEPOINT chat_messages_upsert_many_/);
  });

  it("falls back on malformed count, cursor, and list rows", () => {
    assert.equal(createGuardRepo({ countRow: "not a row" }).countBySession("sess-1"), 0);
    assert.equal(createGuardRepo({ countRow: { count: "bad" } }).countBySession("sess-1"), 0);
    assert.deepEqual(createGuardRepo({ cursorRow: "not a row", latestRows: "not rows" }).list("sess-1", 0, "m1"), []);
    assert.deepEqual(createGuardRepo({ cursorRow: { seq: "bad" }, latestRows: [null] }).list("sess-1", 1001, "m1"), []);
  });
});

describe("ChatMessageRepository sanitization", () => {
  it("quarantines a chat message whose parts_json is malformed and falls back to undefined parts", () => {
    const dbPath = path.join(os.tmpdir(), `gc-chat-parts-sanitize-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const repo = new ChatMessageRepository(db, { quarantine });

    const messageId = randomUUID();
    repo.upsert({
      messageId,
      sessionId: "sess-sanitize-parts",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "hello",
      timestamp: "2026-03-05T01:00:00.000Z",
    });

    db.prepare("UPDATE chat_messages SET parts_json = ? WHERE message_id = ?").run("{not json", messageId);

    const reloaded = repo.get(messageId);
    assert.ok(reloaded);
    assert.equal(reloaded.parts, undefined);
    assert.equal(quarantine.count(), 1);
    const entry0 = quarantine.list(10)[0];
    assert.ok(entry0);
    assert.equal(entry0.store, "chat_message.parts");
    assert.equal(entry0.rowId, messageId);
  });

  it("quarantines a chat message whose attachments_json is malformed and falls back to undefined attachments", () => {
    const dbPath = path.join(os.tmpdir(), `gc-chat-attach-sanitize-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const quarantine = new StateValidationQuarantineRepository(db);
    const repo = new ChatMessageRepository(db, { quarantine });

    const messageId = randomUUID();
    repo.upsert({
      messageId,
      sessionId: "sess-sanitize-attach",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "hello",
      timestamp: "2026-03-05T01:00:00.000Z",
    });

    db.prepare("UPDATE chat_messages SET attachments_json = ? WHERE message_id = ?").run("[oops", messageId);

    const reloaded = repo.get(messageId);
    assert.ok(reloaded);
    assert.equal(reloaded.attachments, undefined);
    assert.equal(quarantine.count(), 1);
    const entry0 = quarantine.list(10)[0];
    assert.ok(entry0);
    assert.equal(entry0.store, "chat_message.attachments");
    assert.equal(entry0.rowId, messageId);
  });
});
