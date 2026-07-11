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
  it("scopes listed approvals to a workspace when a workspaceId filter is provided", () => {
    const repo = createRepo();
    repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "a" },
      preview: { command: "a" },
      linkage: { workspaceId: "workspace-a", sessionId: "s-a" },
    });
    repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "b" },
      preview: { command: "b" },
      linkage: { workspaceId: "workspace-b", sessionId: "s-b" },
    });
    repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "global" },
      preview: { command: "global" },
    });

    const scoped = repo.list("pending", 100, "workspace-a");
    assert.deepEqual(
      scoped.map((approval) => approval.linkage?.workspaceId),
      ["workspace-a"],
    );

    const unscoped = repo.list("pending", 100);
    assert.equal(unscoped.length, 3);
  });

  it("lists approval pages with stable cursors and workspace filters", () => {
    const repo = createRepo();
    for (const [index, workspaceId] of [
      "workspace-a",
      "workspace-b",
      "workspace-a",
      "workspace-a",
      "workspace-b",
    ].entries()) {
      repo.create({
        kind: "shell.exec",
        riskLevel: "danger",
        payload: { command: `command-${index}` },
        preview: { command: `command-${index}` },
        linkage: { workspaceId },
      });
    }

    const firstPage = repo.listPage({ status: "pending", limit: 2 });
    assert.equal(firstPage.items.length, 2);
    assert.equal(typeof firstPage.nextCursor, "string");

    const secondPage = repo.listPage({ status: "pending", limit: 2, cursor: firstPage.nextCursor });
    assert.equal(secondPage.items.length, 2);
    assert.deepEqual(
      firstPage.items.filter((item) => secondPage.items.some((next) => next.approvalId === item.approvalId)),
      [],
    );

    const scoped = repo.listPage({ status: "pending", limit: 2, workspaceId: "workspace-a" });
    assert.equal(scoped.items.length, 2);
    assert.deepEqual(
      scoped.items.map((approval) => approval.linkage?.workspaceId),
      ["workspace-a", "workspace-a"],
    );
  });

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

  it("lists bounded expired pending approvals in deadline order", () => {
    const repo = createRepo();
    const firstExpired = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "first" },
      preview: { command: "first" },
      expiresAt: "2026-03-20T09:00:00.000Z",
    });
    const secondExpired = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "second" },
      preview: { command: "second" },
      expiresAt: "2026-03-20T09:30:00.000Z",
    });
    const offsetExpired = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "offset-expired" },
      preview: { command: "offset-expired" },
      // 09:15Z: lexically later than the 10:00Z boundary, but chronologically expired.
      expiresAt: "2026-03-20T11:15:00.000+02:00",
    });
    const excludedExpired = repo.create({
      kind: "auth.device_access",
      riskLevel: "danger",
      payload: { requestId: "device-request" },
      preview: { deviceLabel: "Tablet" },
      expiresAt: "2026-03-20T08:45:00.000Z",
    });
    const alreadyResolved = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "resolved" },
      preview: { command: "resolved" },
      expiresAt: "2026-03-20T08:30:00.000Z",
    });
    repo.resolve(
      alreadyResolved.approvalId,
      { decision: "reject", resolvedBy: "operator" },
      { resolvedAt: "2026-03-20T08:00:00.000Z" },
    );
    repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "future" },
      preview: { command: "future" },
      expiresAt: "2026-03-20T11:00:00.000Z",
    });
    repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "offset-future" },
      preview: { command: "offset-future" },
      // 11:30Z: lexically earlier than the boundary, but chronologically still active.
      expiresAt: "2026-03-20T09:30:00.000-02:00",
    });

    assert.deepEqual(
      repo
        .listExpiredPending("2026-03-20T10:00:00.000Z", 1, "auth.device_access")
        .map((approval) => approval.approvalId),
      [firstExpired.approvalId],
    );
    assert.deepEqual(
      repo.listExpiredPending("2026-03-20T10:00:00.000Z", 10).map((approval) => approval.approvalId),
      [excludedExpired.approvalId, firstExpired.approvalId, offsetExpired.approvalId, secondExpired.approvalId],
    );
    assert.deepEqual(
      repo
        .listExpiredPending("2026-03-20T10:00:00.000Z", 10, "auth.device_access")
        .map((approval) => approval.approvalId),
      [firstExpired.approvalId, offsetExpired.approvalId, secondExpired.approvalId],
    );
  });

  it("uses the approval expiry sweep index for representative pending history", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-expiry-plan-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const insert = db.prepare(`
      INSERT INTO approvals (
        approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json,
        explanation_status, created_at, expires_at
      ) VALUES (
        @approvalId, 'shell.exec', 'danger', @status, NULL, '{}', '{}',
        'not_requested', @createdAt, @expiresAt
      )
    `);
    for (let index = 0; index < 500; index += 1) {
      insert.run({
        approvalId: `approval-plan-${index}`,
        status: index % 4 === 0 ? "approved" : "pending",
        createdAt: `2026-03-19T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
        expiresAt: new Date(Date.parse("2026-03-20T00:00:00.000Z") + index * 60_000).toISOString(),
      });
    }

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM approvals
         WHERE status = 'pending'
           AND expires_at IS NOT NULL
           AND julianday(expires_at) IS NOT NULL
           AND julianday(expires_at) <= julianday(@now)
           AND (@excludedKind IS NULL OR kind <> @excludedKind)
         ORDER BY julianday(expires_at) ASC, approval_id ASC
         LIMIT @limit`,
      )
      .all({
        now: "2026-03-20T00:10:00.000Z",
        excludedKind: "auth.device_access",
        limit: 100,
      }) as Array<{ detail?: string }>;

    assert.match(plan.map((entry) => entry.detail ?? "").join("\n"), /idx_approvals_status_expires_at/);
  });

  it("persists rollback notes without synthesizing missing values", () => {
    const repo = createRepo();
    const withoutRollback = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
    });
    const withRollback = repo.create({
      kind: "fs.write",
      riskLevel: "danger",
      payload: { path: "workspace/note.md" },
      preview: { path: "workspace/note.md" },
      rollbackNote: "Restore workspace/note.md from the prior backup.",
    });

    assert.equal(repo.get(withoutRollback.approvalId).rollbackNote, undefined);
    assert.equal(repo.get(withRollback.approvalId).rollbackNote, "Restore workspace/note.md from the prior backup.");
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

  it("rejects resolution at the approval expiry boundary", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
      expiresAt: "2026-03-20T10:00:00.000Z",
    });

    assert.throws(
      () =>
        repo.resolve(
          created.approvalId,
          {
            decision: "approve",
            resolvedBy: "operator",
          },
          { resolvedAt: "2026-03-20T10:00:00.000Z" },
        ),
      /expired/i,
    );
    assert.equal(repo.get(created.approvalId).status, "pending");
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

  it("allows only one concurrent expiry reconciler to win an expired approval", async () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-expiry-repo-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const creatorRepo = createRepoAtPath(dbPath);
    const resolverA = createRepoAtPath(dbPath);
    const resolverB = createRepoAtPath(dbPath);
    const created = creatorRepo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
      expiresAt: "2026-03-20T10:00:00.000Z",
    });

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        resolverA.resolve(
          created.approvalId,
          {
            decision: "reject",
            resolvedBy: "system:approval-expiry:a",
          },
          { resolvedAt: "2026-03-20T10:00:01.000Z", allowExpired: true },
        ),
      ),
      Promise.resolve().then(() =>
        resolverB.resolve(
          created.approvalId,
          {
            decision: "reject",
            resolvedBy: "system:approval-expiry:b",
          },
          { resolvedAt: "2026-03-20T10:00:01.000Z", allowExpired: true },
        ),
      ),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(creatorRepo.get(created.approvalId).status, "rejected");
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
    const first = fetched.shellExplanations?.[0];
    assert.ok(first, "shellExplanations[0] should exist");
    assert.equal(first.highestRisk, "danger");
    assert.equal(first.command, "rm -rf /tmp/x");
  });

  it("setShellExplanations returns false for unknown approval id", () => {
    const repo = createRepo();
    assert.equal(repo.setShellExplanations("missing-approval", []), false);
  });
});
