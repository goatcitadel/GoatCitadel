import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";

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

function createRepo(): ChatSessionMetaRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-meta-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new ChatSessionMetaRepository(db);
}

describe("ChatSessionMetaRepository", () => {
  it("returns defaults when ensuring a missing row", () => {
    const repo = createRepo();
    const meta = repo.ensure("sess-1");

    assert.equal(meta.workspaceId, "default");
    assert.equal(meta.origin, undefined);
    assert.equal(meta.includeInHistory, true);
    assert.equal(meta.pinned, false);
    assert.equal(meta.lifecycleStatus, "active");
  });

  it("round-trips origin and history visibility fields", () => {
    const repo = createRepo();
    const patched = repo.patch("sess-1", {
      workspaceId: "workspace-a",
      title: "Prompt pack scratch session",
      origin: "prompt_pack",
      includeInHistory: false,
      pinned: true,
      lifecycleStatus: "archived",
      archivedAt: "2026-03-26T00:00:00.000Z",
    }, "2026-03-26T00:00:00.000Z");

    assert.equal(patched.workspaceId, "workspace-a");
    assert.equal(patched.title, "Prompt pack scratch session");
    assert.equal(patched.origin, "prompt_pack");
    assert.equal(patched.includeInHistory, false);
    assert.equal(patched.pinned, true);
    assert.equal(patched.lifecycleStatus, "archived");
    assert.equal(patched.archivedAt, "2026-03-26T00:00:00.000Z");

    const reloaded = repo.get("sess-1");
    assert.equal(reloaded?.origin, "prompt_pack");
    assert.equal(reloaded?.includeInHistory, false);
  });

  it("filters listed rows by workspace id", () => {
    const repo = createRepo();
    repo.patch("sess-1", { workspaceId: "workspace-a", origin: "operator", includeInHistory: true });
    repo.patch("sess-2", { workspaceId: "workspace-b", origin: "system", includeInHistory: false });

    const listed = repo.listBySessionIds(["sess-1", "sess-2"], "workspace-a");

    assert.equal(listed.size, 1);
    assert.equal(listed.get("sess-1")?.workspaceId, "workspace-a");
    assert.equal(listed.has("sess-2"), false);
  });
});
