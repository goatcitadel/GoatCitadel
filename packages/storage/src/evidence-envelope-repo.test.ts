import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { EvidenceEnvelopeRepository } from "./evidence-envelope-repo.js";
import type { DatabaseClient } from "./db.js";

const createdFiles: string[] = [];
const createdDbs: DatabaseClient[] = [];

afterEach(() => {
  for (const db of createdDbs.splice(0)) {
    db.close();
  }
  for (const file of createdFiles.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

function createRepo(): EvidenceEnvelopeRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-evidence-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  createdDbs.push(db);
  return new EvidenceEnvelopeRepository(db);
}

describe("EvidenceEnvelopeRepository", () => {
  it("persists hash-linked unsigned local envelopes", () => {
    const repo = createRepo();

    const first = repo.create({
      envelopeId: "env-1",
      eventKind: "tool_invocation",
      sessionId: "session-1",
      contentHash: "hash-1",
      payloadHash: "payload-1",
      toolCallHashes: ["tool-hash-1"],
      signatureStatus: "unsigned_local",
      metadata: { toolName: "browser.open" },
      createdAt: "2026-05-04T00:00:00.000Z",
    });
    const second = repo.create({
      envelopeId: "env-2",
      eventKind: "memory_write",
      sessionId: "session-1",
      contentHash: "hash-2",
      previousEnvelopeHash: first.contentHash,
      payloadHash: "payload-2",
      memoryLineage: ["turn-1"],
      signatureStatus: "unsigned_local",
      metadata: { decision: { decision: "proposed" } },
      createdAt: "2026-05-04T00:00:01.000Z",
    });

    assert.equal(second.previousEnvelopeHash, "hash-1");
    assert.equal(repo.latest()?.envelopeId, "env-2");
    assert.deepEqual(
      repo.list({ sessionId: "session-1" }).map((item) => item.envelopeId),
      ["env-2", "env-1"],
    );
    assert.deepEqual(repo.get("env-1")?.toolCallHashes, ["tool-hash-1"]);
  });
});
