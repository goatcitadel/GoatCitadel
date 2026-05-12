import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { LearnedMemoryRepository } from "./learned-memory-repo.js";

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

function createRepo(): LearnedMemoryRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-learned-memory-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new LearnedMemoryRepository(createDatabase({ dbPath }));
}

describe("LearnedMemoryRepository", () => {
  it("manages item lifecycle, confidence clamps, conflicts, and session cleanup", () => {
    const repo = createRepo();
    const lowConfidence = repo.insertItem({
      sessionId: "session-1",
      itemType: "preference",
      content: "prefers concise updates",
      confidence: -1,
      status: "active",
      redacted: false,
      sourceKind: "chat",
      sourceRef: "message-1",
      snippet: "Keep it short",
    });
    const highConfidence = repo.insertItem({
      sessionId: "session-1",
      itemType: "goal",
      content: "finish coverage",
      confidence: 2,
      status: "conflict",
      redacted: true,
      sourceKind: "chat",
      sourceRef: "message-2",
      snippet: "100 percent line coverage",
    });

    assert.equal(lowConfidence.confidence, 0);
    assert.equal(highConfidence.confidence, 1);
    assert.equal(repo.getItem(lowConfidence.itemId)?.redacted, false);
    assert.equal(repo.getItem(highConfidence.itemId)?.redacted, true);
    assert.equal(repo.getItem("missing"), undefined);
    assert.deepEqual(
      repo
        .listItemsBySession("session-1", 10)
        .map((item) => item.itemId)
        .sort(),
      [highConfidence.itemId, lowConfidence.itemId].sort(),
    );
    assert.deepEqual(
      repo.findActiveByType("session-1", "goal").map((item) => item.itemId),
      [highConfidence.itemId],
    );

    repo.appendSource(lowConfidence.itemId, "manual", "operator", "updated source");
    repo.updateItemFields(lowConfidence.itemId, {
      status: "disabled",
      content: "updated content",
      confidence: 0.5,
    });
    assert.equal(repo.getItem(lowConfidence.itemId)?.content, "updated content");
    assert.equal(repo.getItem(lowConfidence.itemId)?.confidence, 0.5);

    repo.updateItemConfidence(highConfidence.itemId, -5);
    assert.equal(repo.getItem(highConfidence.itemId)?.confidence, 0);
    repo.supersedeItem(lowConfidence.itemId, highConfidence.itemId);
    assert.equal(repo.getItem(lowConfidence.itemId)?.status, "superseded");
    assert.equal(repo.getItem(lowConfidence.itemId)?.supersededByItemId, highConfidence.itemId);

    repo.insertConflict({
      sessionId: "session-1",
      itemType: "preference",
      existingItemId: lowConfidence.itemId,
      incomingItemId: highConfidence.itemId,
      incomingContent: "conflicting preference",
    });
    const conflicts = repo.listConflictsBySession("session-1", 10);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.existingItemId, lowConfidence.itemId);
    assert.equal(conflicts[0]?.incomingItemId, highConfidence.itemId);
    assert.equal(conflicts[0]?.status, "open");

    repo.clearSession("session-1");
    assert.deepEqual(repo.listItemsBySession("session-1", 10), []);
    assert.deepEqual(repo.listConflictsBySession("session-1", 10), []);
  });
});
