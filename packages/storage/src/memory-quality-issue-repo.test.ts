import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { MemoryQualityIssueRepository } from "./memory-quality-issue-repo.js";

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

function createRepo(): MemoryQualityIssueRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-memory-quality-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new MemoryQualityIssueRepository(db);
}

describe("MemoryQualityIssueRepository", () => {
  it("deduplicates open issues and tracks resolution state", () => {
    const repo = createRepo();

    const first = repo.upsertOpenIssue({
      workspaceId: "default",
      kind: "source_drift",
      severity: "high",
      targetKind: "learning",
      targetRef: "learning-1",
      relatedRefs: ["docs/plan.md"],
      evidenceRefs: [{ sourceType: "artifact", sourceRef: "docs/plan.md", title: "Learning staleness check" }],
      summary: "Referenced file docs/plan.md changed since the learning was recorded.",
      rationale: "Recorded content hashes no longer match.",
      metadata: { stalenessIssue: "changed_hash" },
      dedupKey: "default|source_drift|learning|learning-1|changed_hash|docs/plan.md",
    });

    assert.equal(first.created, true);
    assert.equal(first.record.status, "open");
    assert.equal(first.record.severity, "high");
    assert.deepEqual(first.record.relatedRefs, ["docs/plan.md"]);
    assert.equal(repo.list({ workspaceId: "default", status: "open" }).length, 1);

    const second = repo.upsertOpenIssue({
      workspaceId: "default",
      kind: "source_drift",
      severity: "medium",
      targetKind: "learning",
      targetRef: "learning-1",
      relatedRefs: ["docs/plan.md"],
      summary: "Referenced file docs/plan.md still differs from the recorded learning hash.",
      metadata: { stalenessIssue: "changed_hash", rescanned: true },
      dedupKey: "default|source_drift|learning|learning-1|changed_hash|docs/plan.md",
    });

    assert.equal(second.created, false);
    assert.equal(second.record.issueId, first.record.issueId);
    assert.equal(second.record.severity, "medium");
    assert.equal(second.record.summary, "Referenced file docs/plan.md still differs from the recorded learning hash.");
    assert.equal(repo.list({ workspaceId: "default", status: "open" }).length, 1);

    const resolved = repo.patchStatus(first.record.issueId, {
      status: "resolved",
      resolutionNote: "Learning was refreshed.",
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolutionNote, "Learning was refreshed.");
    assert.ok(resolved.resolvedAt);
    assert.equal(repo.list({ workspaceId: "default", status: "open" }).length, 0);
    assert.equal(repo.list({ workspaceId: "default", status: "resolved" }).length, 1);

    const reopened = repo.upsertOpenIssue({
      workspaceId: "default",
      kind: "source_drift",
      targetKind: "learning",
      targetRef: "learning-1",
      summary: "Referenced file docs/plan.md changed again.",
      dedupKey: "default|source_drift|learning|learning-1|changed_hash|docs/plan.md",
    });
    assert.equal(reopened.created, false);
    assert.equal(reopened.record.status, "open");
    assert.equal(reopened.record.resolvedAt, undefined);
    assert.equal(reopened.record.resolutionNote, undefined);
  });
});
