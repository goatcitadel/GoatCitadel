import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ApprovalRepository } from "./approval-repo.js";
import { ApprovalWaitRunRepository } from "./approval-wait-run-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

function createRepos(): {
  approvals: ApprovalRepository;
  approvalWaitRuns: ApprovalWaitRunRepository;
  durableRuns: DurableRunRepository;
} {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-wait-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    approvals: new ApprovalRepository(db),
    approvalWaitRuns: new ApprovalWaitRunRepository(db),
    durableRuns: new DurableRunRepository(db),
  };
}

describe("ApprovalWaitRunRepository", () => {
  it("reserves the first run id without allowing a competing overwrite", () => {
    const { approvals, approvalWaitRuns: repo } = createRepos();
    const approval = approvals.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: {},
      preview: {},
    });

    const first = repo.createOrGet({
      approvalId: approval.approvalId,
      runId: "reserved-run-a",
      createdAt: "2026-04-10T11:00:00.000Z",
    });
    const competing = repo.createOrGet({
      approvalId: approval.approvalId,
      runId: "reserved-run-b",
      createdAt: "2026-04-10T11:00:01.000Z",
    });

    assert.equal(first.runId, "reserved-run-a");
    assert.equal(competing.runId, "reserved-run-a");
  });

  it("creates, replaces, and resolves approval wait run mappings", () => {
    const { approvals, approvalWaitRuns: repo, durableRuns } = createRepos();
    const approval = approvals.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { sessionId: "session-1" },
      preview: { label: "Run shell command" },
      linkage: { sessionId: "session-1" },
    });
    const firstRun = durableRuns.createRun({
      workflowKey: "approval.wait",
      payload: { approvalId: "approval-1" },
    });

    const created = repo.upsert({
      approvalId: approval.approvalId,
      runId: firstRun.runId,
      createdAt: "2026-04-10T12:00:00.000Z",
    });
    const approvalId = created.approvalId;
    assert.equal(created.runId, firstRun.runId);
    assert.equal(repo.getRunId(approvalId), firstRun.runId);

    const secondRun = durableRuns.createRun({
      workflowKey: "approval.wait",
      payload: { approvalId, replacement: true },
    });

    const replaced = repo.upsert({
      approvalId,
      runId: secondRun.runId,
      createdAt: "2026-04-10T12:05:00.000Z",
    });
    assert.equal(replaced.runId, secondRun.runId);
    assert.equal(replaced.createdAt, "2026-04-10T12:05:00.000Z");

    const resolved = repo.markResolved(approvalId, "2026-04-10T12:10:00.000Z");
    assert.equal(resolved?.resolvedAt, "2026-04-10T12:10:00.000Z");
    assert.equal(repo.get(approvalId)?.runId, secondRun.runId);
  });
});
