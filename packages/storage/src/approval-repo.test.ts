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
  return createRepoAtPath(dbPath);
}

function createRepoAtPath(dbPath: string): ApprovalRepository {
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

  it("allows only one concurrent resolver to win the same approval", async () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-repo-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const creatorRepo = createRepoAtPath(dbPath);
    const resolverA = createRepoAtPath(dbPath);
    const resolverB = createRepoAtPath(dbPath);
    const created = creatorRepo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
    });

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        resolverA.resolve(created.approvalId, {
          decision: "approve",
          resolvedBy: "operator-a",
        }),
      ),
      Promise.resolve().then(() =>
        resolverB.resolve(created.approvalId, {
          decision: "approve",
          resolvedBy: "operator-b",
        }),
      ),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const final = creatorRepo.get(created.approvalId);
    assert.equal(final.status, "approved");
    assert.ok(final.resolvedBy === "operator-a" || final.resolvedBy === "operator-b");
  });

  it("persists explicit approval linkage separately from the public payload", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
      linkage: {
        sessionId: "session-1",
        taskId: "task-1",
        durableRunId: "run-1",
        correlationId: "corr-1",
      },
    });

    assert.deepEqual(created.linkage, {
      sessionId: "session-1",
      taskId: "task-1",
      durableRunId: "run-1",
      correlationId: "corr-1",
    });
    assert.deepEqual(created.payload, { command: "dir" });
    assert.deepEqual(created.preview, { command: "dir" });

    const merged = repo.mergeLinkage(created.approvalId, {
      traceId: "trace-1",
      toolName: "shell_command",
    });

    assert.deepEqual(merged.linkage, {
      sessionId: "session-1",
      taskId: "task-1",
      durableRunId: "run-1",
      correlationId: "corr-1",
      traceId: "trace-1",
      toolName: "shell_command",
    });
    assert.deepEqual(merged.payload, { command: "dir" });
    assert.deepEqual(merged.preview, { command: "dir" });
  });

  it("lists statuses, supports alternate resolutions, and validates defensive linkage paths", () => {
    const repo = createRepo();
    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;

    assert.throws(() => repo.get("missing-approval"), /Approval missing-approval not found/);
    assert.throws(() => repo.mergeLinkage("missing-approval", { sessionId: "session-1" }), /Approval missing-approval/);

    const blankLinkage = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
      linkage: {
        sessionId: "   ",
        taskId: "",
      } as NonNullable<Parameters<ApprovalRepository["create"]>[0]["linkage"]>,
    });
    assert.equal(blankLinkage.linkage, undefined);

    const edited = repo.create({
      kind: "fs.write",
      riskLevel: "danger",
      payload: { path: "notes.md", content: "draft" },
      preview: { path: "notes.md" },
    });
    const rejected = repo.create({
      kind: "browser.click",
      riskLevel: "caution",
      payload: { selector: "#delete" },
      preview: { selector: "#delete" },
    });

    assert.equal(repo.list("pending", 10).length, 3);
    assert.ok(repo.list(undefined, 10).some((approval) => approval.approvalId === edited.approvalId));

    const editedResult = repo.resolve(edited.approvalId, {
      decision: "edit",
      editedPayload: { path: "notes.md", content: "final" },
      resolvedBy: "operator",
      resolutionNote: "reduced scope",
    });
    assert.equal(editedResult.status, "edited");
    assert.deepEqual(editedResult.payload, { path: "notes.md", content: "final" });
    assert.equal(editedResult.resolutionNote, "reduced scope");

    const rejectedResult = repo.resolve(rejected.approvalId, {
      decision: "reject",
      resolvedBy: "operator",
    });
    assert.equal(rejectedResult.status, "rejected");
    assert.equal(repo.list("rejected", 10)[0]?.approvalId, rejected.approvalId);

    db.prepare(
      `
      UPDATE approvals
      SET linkage_json = NULL,
          payload_json = ?,
          preview_json = ?,
          explanation_json = ?
      WHERE approval_id = ?
    `,
    ).run(
      JSON.stringify({ command: "dir", __gcApprovalLinkage: { sessionId: "embedded-session" } }),
      JSON.stringify({ command: "dir", __gcApprovalLinkage: { taskId: "embedded-task" } }),
      "{bad",
      blankLinkage.approvalId,
    );

    const embedded = repo.get(blankLinkage.approvalId);
    assert.deepEqual(embedded.linkage, { sessionId: "embedded-session" });
    assert.deepEqual(embedded.payload, { command: "dir" });
    assert.deepEqual(embedded.preview, { command: "dir" });
    assert.equal(embedded.explanation, undefined);

    const internal = repo as unknown as {
      getStmt: { get: (...args: unknown[]) => unknown };
      listStmt: { all: (...args: unknown[]) => unknown };
      listByStatusStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.getStmt = { get: () => ({ approval_id: "bad" }) };
    assert.throws(() => repo.get("bad-row"), /Unexpected approvals row shape/);

    internal.listStmt = { all: () => ({ not: "an array" }) };
    internal.listByStatusStmt = { all: () => [null] };
    assert.throws(() => repo.list(undefined, 10), /Unexpected approvals row shape/);
    assert.throws(() => repo.list("pending", 10), /Unexpected approvals row shape/);
  });

  it("persists shellExplanations and round-trips them on read", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "caution",
      payload: { commands: ["rm -rf /tmp/x"] },
      preview: { commands: ["rm -rf /tmp/x"] },
    });

    assert.equal(created.shellExplanations, undefined);

    const updated = repo.setShellExplanations(created.approvalId, [
      {
        command: "rm -rf /tmp/x",
        parsed: true,
        program: "rm",
        summary: "Recursively delete /tmp/x",
        details: [],
        risks: [{ level: "danger", label: "Recursive delete", explanation: "deletes directories" }],
        highestRisk: "danger",
      },
    ]);
    assert.equal(updated, true);

    const fetched = repo.get(created.approvalId);
    assert.equal(fetched.shellExplanations?.length, 1);
    assert.equal(fetched.shellExplanations?.[0].highestRisk, "danger");
    assert.equal(fetched.shellExplanations?.[0].command, "rm -rf /tmp/x");
  });

  it("setShellExplanations returns false for unknown approval id", () => {
    const repo = createRepo();
    assert.equal(repo.setShellExplanations("missing-approval", []), false);
  });
});
