import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ContextManifestRepository } from "./context-manifest-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Ignore cleanup noise for temp databases.
    }
  }
});

function createRepo(): ContextManifestRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-context-manifest-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new ContextManifestRepository(db);
}

describe("ContextManifestRepository", () => {
  it("creates a manifest and returns ordered detail entries", () => {
    const repo = createRepo();
    const manifest = repo.ensure({
      scope: "chat_turn",
      turnId: "turn-1",
      sessionId: "session-1",
      taskId: "task-1",
      createdAt: "2026-04-01T01:00:00.000Z",
    });

    repo.appendEntry({
      manifestId: manifest.manifestId,
      kind: "system_message",
      entryIndex: 0,
      sourceRef: "system:0",
      contentText: "System instructions",
      createdAt: "2026-04-01T01:00:01.000Z",
    });
    repo.appendEntry({
      manifestId: manifest.manifestId,
      kind: "memory_context",
      entryIndex: 1,
      sourceRef: "memory-1",
      contentText: "Relevant memory",
      metadata: { status: "generated" },
      createdAt: "2026-04-01T01:00:02.000Z",
    });

    const detail = repo.getDetailByTurn("turn-1");
    assert.equal(detail.manifest.scope, "chat_turn");
    assert.equal(detail.manifest.sessionId, "session-1");
    assert.equal(detail.entries.length, 2);
    assert.deepEqual(
      detail.entries.map((entry) => [entry.kind, entry.entryIndex, entry.sourceRef]),
      [
        ["system_message", 0, "system:0"],
        ["memory_context", 1, "memory-1"],
      ],
    );
  });

  it("deduplicates identical entries for the same manifest", () => {
    const repo = createRepo();
    const manifest = repo.ensure({
      scope: "chat_turn",
      turnId: "turn-2",
      sessionId: "session-2",
    });

    repo.appendEntry({
      manifestId: manifest.manifestId,
      kind: "system_message",
      entryIndex: 0,
      sourceRef: "system:0",
      contentText: "Repeated system instructions",
    });
    repo.appendEntry({
      manifestId: manifest.manifestId,
      kind: "system_message",
      entryIndex: 0,
      sourceRef: "system:0",
      contentText: "Repeated system instructions",
    });

    const detail = repo.getDetailByTurn("turn-2");
    assert.equal(detail.entries.length, 1);
    assert.equal(detail.entries[0]?.contentText, "Repeated system instructions");
  });

  it("returns undefined for missing turn manifests", () => {
    const repo = createRepo();
    assert.equal(repo.maybeGetDetailByTurn("missing-turn"), undefined);
  });
});
