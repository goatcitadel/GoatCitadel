import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatSessionBindingRepository } from "./chat-session-binding-repo.js";

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

function createStore(): { db: DatabaseClient; repo: ChatSessionBindingRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-session-binding-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatSessionBindingRepository(db) };
}

function setRawField(db: DatabaseClient, sessionId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_session_bindings SET ${field} = ? WHERE session_id = ?`).run(value, sessionId);
}

describe("ChatSessionBindingRepository", () => {
  it("upserts, preserves defaults, and lists bindings by session and workspace", () => {
    const { repo } = createStore();
    const first = repo.upsert(
      {
        sessionId: "session-a",
        workspaceId: " workspace-a ",
        transport: "integration",
        connectionId: "connection-a",
        target: "slack:#ops",
        writable: false,
      },
      "2026-03-26T00:00:01.000Z",
    );

    assert.deepEqual(first, {
      sessionId: "session-a",
      transport: "integration",
      connectionId: "connection-a",
      target: "slack:#ops",
      writable: false,
      createdAt: "2026-03-26T00:00:01.000Z",
      updatedAt: "2026-03-26T00:00:01.000Z",
    });
    assert.deepEqual(repo.get("session-a"), first);

    const updated = repo.upsert(
      {
        sessionId: "session-a",
        transport: "llm",
      },
      "2026-03-26T00:00:02.000Z",
    );
    assert.equal(updated.transport, "llm");
    assert.equal(updated.connectionId, undefined);
    assert.equal(updated.target, undefined);
    assert.equal(updated.writable, false);
    assert.equal(updated.createdAt, "2026-03-26T00:00:01.000Z");
    assert.equal(updated.updatedAt, "2026-03-26T00:00:02.000Z");

    assert.deepEqual(repo.listBySessionIds([]), new Map());
    assert.deepEqual(repo.listBySessionIds(["session-a"], "workspace-a").get("session-a"), updated);
    assert.equal(repo.listBySessionIds(["session-a"], "workspace-b").size, 0);
    assert.equal(repo.get("missing-session"), undefined);
    assert.throws(
      () => repo.upsert({ sessionId: "session-b", workspaceId: "bad workspace", transport: "llm" }),
      /workspaceId contains unsupported characters/,
    );
  });

  it("fails clearly on malformed stored rows and malformed targets", () => {
    const { db, repo } = createStore();
    repo.upsert({
      sessionId: "session-a",
      workspaceId: "workspace-a",
      transport: "integration",
      target: "discord:ops",
    });

    setRawField(db, "session-a", "target_json", "[]");
    assert.equal(repo.get("session-a")?.target, undefined);

    setRawField(db, "session-a", "writable", new Uint8Array([1]));
    assert.throws(() => repo.get("session-a"), /Unexpected chat_session_bindings row shape/);
    assert.throws(() => repo.listBySessionIds(["session-a"]), /Unexpected chat_session_bindings row shape/);
  });
});
