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

  it("keeps session learned memory evidence-only at the storage boundary (HX-402 P1)", () => {
    const repo = createRepo();
    // Authority-looking states can never be minted through this repository.
    assert.throws(
      () =>
        repo.insertItem({
          sessionId: "session-2",
          itemType: "preference",
          content: "attempted authority state",
          confidence: 0.9,
          status: "trusted" as never,
          redacted: false,
          sourceKind: "chat",
          sourceRef: "message-3",
          snippet: "attempted",
        }),
      /evidence-only/,
    );
    const item = repo.insertItem({
      sessionId: "session-2",
      itemType: "preference",
      content: "legit evidence",
      confidence: 0.5,
      status: "active",
      redacted: false,
      sourceKind: "chat",
      sourceRef: "message-4",
      snippet: "legit",
    });
    assert.throws(
      () => repo.updateItemFields(item.itemId, { status: "promoted", content: "still evidence", confidence: 0.5 }),
      /evidence-only/,
    );
    assert.equal(repo.getItem(item.itemId)?.status, "active");

    // Redacted evidence never accepts replacement content.
    const redacted = repo.insertItem({
      sessionId: "session-2",
      itemType: "fact",
      content: "[REDACTED]",
      confidence: 0.2,
      status: "dropped",
      redacted: true,
      sourceKind: "chat",
      sourceRef: "message-5",
      snippet: "Dropped due to secret redaction policy.",
    });
    assert.throws(
      () => repo.updateItemFields(redacted.itemId, { status: "active", content: "sk-recovered", confidence: 0.2 }),
      /redacted/i,
    );
    assert.equal(repo.getItem(redacted.itemId)?.content, "[REDACTED]");
    // Status/confidence updates that keep the redacted content intact still work.
    repo.updateItemFields(redacted.itemId, { status: "disabled", content: "[REDACTED]", confidence: 0.1 });
    assert.equal(repo.getItem(redacted.itemId)?.status, "disabled");
  });
});
