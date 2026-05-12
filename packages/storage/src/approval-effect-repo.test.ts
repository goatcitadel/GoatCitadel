import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ApprovalEffectRepository, buildApprovalEffectIdempotencyKey } from "./approval-effect-repo.js";
import { createDatabase } from "./sqlite.js";

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

function createRepoWithDb(): { repo: ApprovalEffectRepository; db: ReturnType<typeof createDatabase> } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-effect-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    repo: new ApprovalEffectRepository(db),
    db,
  };
}

function insertApproval(db: ReturnType<typeof createDatabase>, approvalId: string): void {
  db.prepare(
    `
    INSERT INTO approvals (
      approval_id,
      kind,
      risk_level,
      status,
      payload_json,
      preview_json,
      explanation_status,
      created_at
    ) VALUES (?, 'tool_call', 'caution', 'approved', '{}', '{}', 'not_requested', ?)
  `,
  ).run(approvalId, "2026-03-21T10:00:00.000Z");
}

describe("ApprovalEffectRepository", () => {
  it("builds stable idempotency keys", () => {
    assert.equal(
      buildApprovalEffectIdempotencyKey({
        approvalId: "approval-1",
        effectKind: "approval_wait_wake",
        targetKind: "durable_run",
        targetId: "run-1",
      }),
      "approval-1:approval_wait_wake:durable_run:run-1",
    );
  });

  it("upserts, claims, renews, completes, skips, fails, and recovers effects", () => {
    const { repo, db } = createRepoWithDb();
    insertApproval(db, "approval-1");

    assert.throws(() => repo.get("missing-effect"), /approval effect/);
    assert.equal(repo.getByIdempotencyKey("missing-key"), undefined);
    assert.equal(repo.getByTarget("approval-1", "approval_wait_wake", "durable_run", "missing-run"), undefined);
    assert.equal(
      repo.claimNextPendingEffect("worker-1", "2026-03-21T10:00:00.000Z", "2026-03-21T10:05:00.000Z"),
      undefined,
    );

    const pending = repo.upsert({
      approvalId: "approval-1",
      effectKind: "approval_wait_wake",
      targetKind: "durable_run",
      targetId: "run-1",
      payload: { reason: "approved" },
      createdAt: "2026-03-21T10:00:00.000Z",
      updatedAt: "2026-03-21T10:00:00.000Z",
    });
    assert.match(pending.effectId, /^[0-9a-f-]{36}$/);
    assert.equal(pending.idempotencyKey, "approval-1:approval_wait_wake:durable_run:run-1");
    assert.deepEqual(pending.payload, { reason: "approved" });
    assert.deepEqual(repo.get(pending.effectId), pending);
    assert.deepEqual(repo.getByTarget("approval-1", "approval_wait_wake", "durable_run", "run-1"), pending);
    assert.deepEqual(
      repo.listByApproval("approval-1").map((effect) => effect.effectId),
      [pending.effectId],
    );

    const updatedByIdempotency = repo.upsert({
      approvalId: "approval-1",
      effectKind: "approval_wait_wake",
      targetKind: "durable_run",
      targetId: "run-1",
      payload: { reason: "edited" },
      status: "failed",
      updatedAt: "2026-03-21T10:01:00.000Z",
    });
    assert.equal(updatedByIdempotency.effectId, pending.effectId);
    assert.equal(updatedByIdempotency.status, "pending");
    assert.deepEqual(updatedByIdempotency.payload, { reason: "edited" });
    assert.equal(updatedByIdempotency.updatedAt, "2026-03-21T10:01:00.000Z");

    const claimed = repo.claimNextPendingEffect("worker-1", "2026-03-21T10:02:00.000Z", "2026-03-21T10:07:00.000Z", 0);
    assert.equal(claimed?.effectId, pending.effectId);
    assert.equal(claimed?.status, "running");
    assert.equal(claimed?.attemptCount, 1);
    assert.equal(claimed?.claimedBy, "worker-1");
    assert.equal(claimed?.version, 2);

    assert.equal(
      repo.renewEffectLease(
        pending.effectId,
        "other-worker",
        claimed!.version,
        "2026-03-21T10:03:00.000Z",
        "2026-03-21T10:08:00.000Z",
      ),
      undefined,
    );
    const renewed = repo.renewEffectLease(
      pending.effectId,
      "worker-1",
      claimed!.version,
      "2026-03-21T10:03:00.000Z",
      "2026-03-21T10:08:00.000Z",
    );
    assert.equal(renewed?.leaseExpiresAt, "2026-03-21T10:08:00.000Z");
    assert.equal(renewed?.version, 3);

    assert.equal(
      repo.completeEffect(pending.effectId, "other-worker", renewed!.version, {
        result: { ignored: true },
        updatedAt: "2026-03-21T10:04:00.000Z",
      }),
      undefined,
    );
    const completed = repo.completeEffect(pending.effectId, "worker-1", renewed!.version, {
      result: { resumed: true },
      updatedAt: "2026-03-21T10:04:00.000Z",
    });
    assert.equal(completed?.status, "completed");
    assert.deepEqual(completed?.result, { resumed: true });
    assert.equal(completed?.claimedBy, undefined);
    assert.equal(completed?.completedAt, "2026-03-21T10:04:00.000Z");

    const skippedBase = repo.upsert({
      approvalId: "approval-1",
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "action-1",
      status: "running",
      claimedBy: "worker-2",
      claimedAt: "2026-03-21T10:10:00.000Z",
      leaseExpiresAt: "2026-03-21T10:20:00.000Z",
      version: 4,
      result: { old: true },
      createdAt: "2026-03-21T10:10:00.000Z",
      updatedAt: "2026-03-21T10:10:00.000Z",
    });
    const skipped = repo.skipEffect(skippedBase.effectId, "worker-2", 4, {
      result: { skipped: "no-op" },
      updatedAt: "2026-03-21T10:11:00.000Z",
      completedAt: "2026-03-21T10:12:00.000Z",
    });
    assert.equal(skipped?.status, "skipped");
    assert.deepEqual(skipped?.result, { skipped: "no-op" });
    assert.equal(skipped?.completedAt, "2026-03-21T10:12:00.000Z");

    const failedBase = repo.upsert({
      approvalId: "approval-1",
      effectKind: "approval_inbox_follow_up",
      targetKind: "approval",
      targetId: "approval-1",
      status: "running",
      claimedBy: "worker-3",
      claimedAt: "2026-03-21T10:15:00.000Z",
      leaseExpiresAt: "2026-03-21T10:25:00.000Z",
      version: 6,
      createdAt: "2026-03-21T10:15:00.000Z",
      updatedAt: "2026-03-21T10:15:00.000Z",
    });
    const failed = repo.failEffect(failedBase.effectId, "worker-3", 6, {
      result: { attempted: true },
      lastError: "provider unavailable",
      updatedAt: "2026-03-21T10:16:00.000Z",
    });
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.lastError, "provider unavailable");
    assert.deepEqual(failed?.result, { attempted: true });

    const expired = repo.upsert({
      approvalId: "approval-1",
      effectKind: "linked_chat_turn_wake",
      targetKind: "chat_turn",
      targetId: "turn-1",
      status: "running",
      claimedBy: "worker-expired",
      claimedAt: "2026-03-21T09:00:00.000Z",
      leaseExpiresAt: "2026-03-21T09:05:00.000Z",
      version: 2,
      lastError: "stale",
      createdAt: "2026-03-21T09:00:00.000Z",
      updatedAt: "2026-03-21T09:00:00.000Z",
    });
    assert.equal(repo.recoverExpiredEffect(expired.effectId, 99, "2026-03-21T10:00:00.000Z"), undefined);
    const recovered = repo.recoverExpiredEffect(expired.effectId, 2, "2026-03-21T10:00:00.000Z");
    assert.equal(recovered?.status, "pending");
    assert.equal(recovered?.claimedBy, undefined);
    assert.equal(recovered?.leaseExpiresAt, undefined);
    assert.equal(recovered?.version, 3);

    const claimedRecovered = repo.claimNextPendingEffect(
      "worker-4",
      "2026-03-21T10:01:00.000Z",
      "2026-03-21T10:06:00.000Z",
      10,
    );
    assert.equal(claimedRecovered?.effectId, expired.effectId);
    assert.equal(claimedRecovered?.attemptCount, 1);
  });
});
