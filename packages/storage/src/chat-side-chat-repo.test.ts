import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatSideChatRepository } from "./chat-side-chat-repo.js";

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

function createStore(): { db: DatabaseClient; repo: ChatSideChatRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-side-chat-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  seedSession(db, "parent-1");
  seedSession(db, "child-1");
  seedSession(db, "child-2");
  return { db, repo: new ChatSideChatRepository(db) };
}

describe("ChatSideChatRepository", () => {
  it("upserts one side chat per parent and looks it up by parent or child", () => {
    const { repo } = createStore();
    const first = repo.upsert(
      {
        sideChatId: "btw-1",
        parentSessionId: " parent-1 ",
        childSessionId: " child-1 ",
        workspaceId: " workspace-a ",
        createdFromSurface: "cowork",
        sourceTurnId: "turn-1",
      },
      "2026-05-20T00:00:00.000Z",
    );

    assert.deepEqual(first, {
      sideChatId: "btw-1",
      parentSessionId: "parent-1",
      childSessionId: "child-1",
      workspaceId: "workspace-a",
      createdFromSurface: "cowork",
      sourceTurnId: "turn-1",
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
    });
    assert.deepEqual(repo.getByParentSession("parent-1"), first);
    assert.deepEqual(repo.getByChildSession("child-1"), first);

    const updated = repo.upsert(
      {
        sideChatId: "ignored-new-id",
        parentSessionId: "parent-1",
        childSessionId: "child-2",
        workspaceId: "workspace-a",
        createdFromSurface: "chat",
      },
      "2026-05-20T00:00:03.000Z",
    );

    assert.equal(updated.sideChatId, "btw-1");
    assert.equal(updated.childSessionId, "child-2");
    assert.equal(updated.createdFromSurface, "chat");
    assert.equal(updated.sourceTurnId, undefined);
    assert.equal(updated.createdAt, "2026-05-20T00:00:00.000Z");
    assert.equal(updated.updatedAt, "2026-05-20T00:00:03.000Z");
    assert.equal(repo.getByChildSession("child-1"), undefined);
    assert.deepEqual(repo.getByChildSession("child-2"), updated);
  });

  it("rejects invalid workspace ids and malformed stored rows", () => {
    const { db, repo } = createStore();
    assert.throws(
      () =>
        repo.upsert({
          sideChatId: "btw-1",
          parentSessionId: "parent-1",
          childSessionId: "child-1",
          workspaceId: "bad workspace",
          createdFromSurface: "chat",
        }),
      /workspaceId contains unsupported characters/,
    );

    repo.upsert({
      sideChatId: "btw-1",
      parentSessionId: "parent-1",
      childSessionId: "child-1",
      workspaceId: "workspace-a",
      createdFromSurface: "chat",
    });
    db.prepare("UPDATE chat_side_chats SET created_from_surface = ? WHERE parent_session_id = ?").run(
      "bad",
      "parent-1",
    );
    assert.throws(() => repo.getByParentSession("parent-1"), /Unexpected chat_side_chats row shape/);
  });
});

function seedSession(db: DatabaseClient, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (
      session_id, session_key, kind, channel, account, last_activity_at, updated_at
    ) VALUES (?, ?, 'chat', 'mission', 'operator', ?, ?)`,
  ).run(sessionId, `mission:operator:${sessionId}`, "2026-05-20T00:00:00.000Z", "2026-05-20T00:00:00.000Z");
}
