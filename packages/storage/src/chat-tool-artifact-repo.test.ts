import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatToolArtifactRepository } from "./chat-tool-artifact-repo.js";

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

function createStore(): { db: DatabaseClient; repo: ChatToolArtifactRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-tool-artifact-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatToolArtifactRepository(db) };
}

function setRawField(db: DatabaseClient, artifactId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_tool_artifacts SET ${field} = ? WHERE artifact_id = ?`).run(value, artifactId);
}

describe("ChatToolArtifactRepository", () => {
  it("creates, gets, and lists tool artifacts", () => {
    const { repo } = createStore();
    const full = repo.create({
      artifactId: "artifact-b",
      sessionId: "session-a",
      turnId: "turn-a",
      toolRunId: "tool-run-a",
      toolName: "browser.search",
      contentType: "text/markdown",
      byteLength: 120,
      snippet: "Search result",
      storageRelPath: "tool-artifacts/artifact-b.md",
      createdAt: "2026-03-26T00:00:02.000Z",
    });
    const minimal = repo.create({
      artifactId: "artifact-a",
      sessionId: "session-a",
      turnId: "turn-a",
      toolRunId: "tool-run-b",
      toolName: "shell.run",
      byteLength: 0,
      storageRelPath: "tool-artifacts/artifact-a.txt",
      createdAt: "2026-03-26T00:00:01.000Z",
    });
    repo.create({
      artifactId: "artifact-c",
      sessionId: "session-a",
      turnId: "turn-b",
      toolRunId: "tool-run-c",
      toolName: "file.read",
      byteLength: 42,
      storageRelPath: "tool-artifacts/artifact-c.txt",
      createdAt: "2026-03-26T00:00:03.000Z",
    });

    assert.equal(full.contentType, "text/markdown");
    assert.equal(full.snippet, "Search result");
    assert.equal(minimal.contentType, undefined);
    assert.equal(minimal.snippet, undefined);
    assert.deepEqual(repo.get("artifact-b"), full);
    assert.deepEqual(
      repo.listByTurn("turn-a").map((artifact) => artifact.artifactId),
      ["artifact-a", "artifact-b"],
    );
    assert.deepEqual(
      repo.listBySession("session-a", 0).map((artifact) => artifact.artifactId),
      ["artifact-c"],
    );
    assert.deepEqual(
      repo.listBySession("session-a", 5001).map((artifact) => artifact.artifactId),
      ["artifact-c", "artifact-b", "artifact-a"],
    );
    assert.deepEqual(repo.listByTurn("missing-turn"), []);
    assert.deepEqual(repo.listBySession("missing-session"), []);
    assert.throws(() => repo.get("missing-artifact"), /Chat tool artifact missing-artifact not found/);
  });

  it("filters malformed stored rows defensively", () => {
    const { db, repo } = createStore();
    repo.create({
      artifactId: "artifact-a",
      sessionId: "session-a",
      turnId: "turn-a",
      toolRunId: "tool-run-a",
      toolName: "browser.search",
      contentType: "text/plain",
      byteLength: 10,
      snippet: "artifact",
      storageRelPath: "tool-artifacts/artifact-a.txt",
      createdAt: "2026-03-26T00:00:01.000Z",
    });

    setRawField(db, "artifact-a", "byte_length", new Uint8Array([1]));
    assert.throws(() => repo.get("artifact-a"), /Chat tool artifact artifact-a not found/);
    assert.deepEqual(repo.listByTurn("turn-a"), []);
    assert.deepEqual(repo.listBySession("session-a"), []);

    setRawField(db, "artifact-a", "byte_length", 10);
    setRawField(db, "artifact-a", "created_at", new Uint8Array([1]));
    assert.throws(() => repo.get("artifact-a"), /Chat tool artifact artifact-a not found/);
    assert.deepEqual(repo.listByTurn("turn-a"), []);
  });
});
