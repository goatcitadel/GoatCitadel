import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatProjectRepository } from "./chat-project-repo.js";
import { ChatSessionProjectRepository } from "./chat-session-project-repo.js";

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

function createStore(): { db: DatabaseClient; repo: ChatSessionProjectRepository; projectId: string } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-session-project-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  const project = new ChatProjectRepository(db).create(
    {
      workspaceId: "workspace-a",
      name: "Workspace project",
      workspacePath: "F:/work/project-a",
    },
    "2026-03-26T00:00:00.000Z",
  );
  return { db, repo: new ChatSessionProjectRepository(db), projectId: project.projectId };
}

function setRawField(db: DatabaseClient, sessionId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_session_projects SET ${field} = ? WHERE session_id = ?`).run(value, sessionId);
}

describe("ChatSessionProjectRepository", () => {
  it("assigns, replaces, lists, and unassigns project links", () => {
    const { repo, projectId } = createStore();

    const first = repo.assign("session-a", projectId, "2026-03-26T00:00:01.000Z");
    assert.deepEqual(first, {
      sessionId: "session-a",
      revision: 2,
      projectId,
      assignedAt: "2026-03-26T00:00:01.000Z",
    });
    assert.deepEqual(repo.get("session-a"), first);

    const replaced = repo.assign("session-a", projectId, "2026-03-26T00:00:02.000Z");
    assert.equal(replaced.assignedAt, "2026-03-26T00:00:01.000Z");
    assert.equal(replaced.revision, 2);
    assert.deepEqual(repo.listBySessionIds([]), new Map());
    assert.deepEqual(repo.listBySessionIds(["session-a", "missing"]).get("session-a"), replaced);

    assert.equal(repo.unassign("session-a"), true);
    assert.equal(repo.get("session-a"), undefined);
    assert.equal(repo.unassign("session-a"), false);
  });

  it("filters malformed rows from direct and batched lookups", () => {
    const { db, repo, projectId } = createStore();
    repo.assign("session-a", projectId, "2026-03-26T00:00:01.000Z");

    setRawField(db, "session-a", "assigned_at", new Uint8Array([1]));
    assert.equal(repo.get("session-a"), undefined);
    assert.deepEqual(repo.listBySessionIds(["session-a"]), new Map());
  });
});
