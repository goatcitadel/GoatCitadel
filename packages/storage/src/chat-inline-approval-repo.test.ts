import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ChatInlineApprovalRepository } from "./chat-inline-approval-repo.js";

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

function createRepo(): { db: ReturnType<typeof createDatabase>; repo: ChatInlineApprovalRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-inline-approval-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatInlineApprovalRepository(db) };
}

describe("ChatInlineApprovalRepository", () => {
  it("upserts, lists, resolves, and maps malformed details defensively", () => {
    const { db, repo } = createRepo();

    assert.equal(repo.get("missing-approval"), undefined);

    const pending = repo.upsert({
      approvalId: "approval-1",
      sessionId: "session-1",
      turnId: "turn-1",
      kind: "tool_call",
      toolName: "shell_command",
      status: "pending",
      reason: "Needs operator approval",
      riskLevel: "danger",
      details: { command: "pnpm test" },
      expiresAt: "2026-05-12T00:05:00.000Z",
      createdAt: "2026-05-12T00:00:00.000Z",
    });
    assert.equal(pending.resolvedAt, undefined);
    assert.deepEqual(pending.details, { command: "pnpm test" });

    const approved = repo.upsert({
      approvalId: "approval-1",
      sessionId: "session-1",
      turnId: "turn-1",
      status: "approved",
      resolvedBy: "operator",
      resolvedAt: "2026-05-12T00:01:00.000Z",
    });
    assert.equal(approved.expiresAt, "2026-05-12T00:05:00.000Z");
    assert.equal(approved.resolvedBy, "operator");
    assert.equal(approved.createdAt, "2026-05-12T00:00:00.000Z");

    db.prepare("UPDATE chat_inline_approvals SET details_json = ? WHERE approval_id = ?").run("{bad", "approval-1");
    assert.deepEqual(repo.get("approval-1")?.details, {});
    assert.deepEqual(
      repo.listByTurn("turn-1").map((approval) => approval.approvalId),
      ["approval-1"],
    );
    assert.deepEqual(
      repo.listBySession("session-1").map((approval) => approval.approvalId),
      ["approval-1"],
    );
  });

  it("throws when query adapters return malformed inline approval rows", () => {
    const { repo } = createRepo();

    (repo as unknown as { getStmt: { get: () => unknown } }).getStmt = { get: () => ({}) };
    assert.throws(() => repo.get("bad-row"), /unexpected row shape/);

    (repo as unknown as { listByTurnStmt: { all: () => unknown[] } }).listByTurnStmt = { all: () => [{}] };
    assert.throws(() => repo.listByTurn("turn-1"), /unexpected row shape/);

    (repo as unknown as { getStmt: { get: () => unknown } }).getStmt = { get: () => undefined };
    assert.throws(
      () =>
        repo.upsert({
          approvalId: "approval-missing-readback",
          sessionId: "session-1",
          turnId: "turn-1",
          status: "denied",
        }),
      /chat inline approval approval-missing-readback not found/,
    );
  });
});
