import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ChatMessageRepository } from "./chat-message-repo.js";

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
});
