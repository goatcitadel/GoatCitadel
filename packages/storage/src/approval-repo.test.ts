import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ApprovalRepository } from "./approval-repo.js";

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

function createRepo(): ApprovalRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-repo-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new ApprovalRepository(db);
}

describe("ApprovalRepository", () => {
  it("tracks explanation lifecycle state", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
    });

    assert.equal(created.explanationStatus, "not_requested");
    assert.equal(created.explanation, undefined);

    const firstMark = repo.markExplanationPending(created.approvalId);
    const secondMark = repo.markExplanationPending(created.approvalId);
    assert.equal(firstMark, true);
    assert.equal(secondMark, false);

    const pending = repo.get(created.approvalId);
    assert.equal(pending.explanationStatus, "pending");

    const completed = repo.setExplanation(created.approvalId, {
      summary: "This command lists files in the current folder.",
      riskExplanation: "It is usually low risk unless used in sensitive locations.",
      saferAlternative: "Limit it to a known workspace path.",
      generatedAt: "2026-02-28T00:00:00.000Z",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    assert.equal(completed.explanationStatus, "completed");
    assert.equal(completed.explanation?.providerId, "openai");
    assert.equal(completed.explanation?.summary.includes("lists files"), true);
  });

  it("stores explanation failure details", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "fs.write",
      riskLevel: "danger",
      payload: { path: "workspace/a.txt" },
      preview: { path: "workspace/a.txt" },
    });

    assert.equal(repo.markExplanationPending(created.approvalId), true);
    const failed = repo.setExplanationFailed(created.approvalId, "provider timeout");
    assert.equal(failed.explanationStatus, "failed");
    assert.equal(failed.explanationError, "provider timeout");
  });

  it("round-trips approvals with and without expiry", () => {
    const repo = createRepo();
    const withoutExpiry = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
    });
    const withExpiry = repo.create({
      kind: "browser.click",
      riskLevel: "danger",
      payload: { selector: "#confirm" },
      preview: { selector: "#confirm" },
      expiresAt: "2026-03-22T16:15:00.000Z",
    });

    assert.equal(withoutExpiry.expiresAt, undefined);
    assert.equal(repo.get(withExpiry.approvalId).expiresAt, "2026-03-22T16:15:00.000Z");
  });

  it("prevents double resolution of the same approval", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
    });

    const resolved = repo.resolve(created.approvalId, {
      decision: "approve",
      resolvedBy: "operator",
    });
    assert.equal(resolved.status, "approved");

    assert.throws(() => {
      repo.resolve(created.approvalId, {
        decision: "reject",
        resolvedBy: "operator",
      });
    });
  });
});
