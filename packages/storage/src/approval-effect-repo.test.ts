import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
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

    assert.throws(
      () =>
        repo.upsert({
          approvalId: "approval-1",
          effectKind: "approval_wait_wake",
          targetKind: "durable_run",
          targetId: "run-1",
          payload: { reason: "edited" },
          status: "failed",
          updatedAt: "2026-03-21T10:01:00.000Z",
        }),
      /idempotency payload mismatch/i,
    );
    const unchangedByIdempotency = repo.upsert({
      approvalId: "approval-1",
      effectKind: "approval_wait_wake",
      targetKind: "durable_run",
      targetId: "run-1",
      payload: { reason: "approved" },
    });
    assert.equal(unchangedByIdempotency.effectId, pending.effectId);
    assert.equal(unchangedByIdempotency.status, "pending");
    assert.deepEqual(unchangedByIdempotency.payload, { reason: "approved" });
    assert.equal(unchangedByIdempotency.updatedAt, "2026-03-21T10:00:00.000Z");

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

    const deferred = repo.deferEffectForRetry(pending.effectId, "worker-1", renewed!.version, {
      result: { deliveryState: "retry_scheduled", attemptCount: 1 },
      lastError: "audit unavailable",
      retryAt: "2026-03-21T10:09:00.000Z",
      updatedAt: "2026-03-21T10:03:30.000Z",
    });
    assert.equal(deferred?.status, "running");
    assert.equal(deferred?.leaseExpiresAt, "2026-03-21T10:09:00.000Z");
    assert.equal(deferred?.lastError, "audit unavailable");
    assert.deepEqual(deferred?.result, { deliveryState: "retry_scheduled", attemptCount: 1 });

    assert.equal(
      repo.completeEffect(pending.effectId, "other-worker", renewed!.version, {
        result: { ignored: true },
        updatedAt: "2026-03-21T10:04:00.000Z",
      }),
      undefined,
    );
    const completed = repo.completeEffect(pending.effectId, "worker-1", deferred!.version, {
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

  it("claims pending approved action execution before durable wake effects", () => {
    const { repo, db } = createRepoWithDb();
    insertApproval(db, "approval-1");
    const createdAt = "2026-03-21T10:00:00.000Z";

    repo.upsert({
      approvalId: "approval-1",
      effectKind: "approval_wait_wake",
      targetKind: "durable_run",
      targetId: "approval-wait-1",
      createdAt,
      updatedAt: createdAt,
    });
    repo.upsert({
      approvalId: "approval-1",
      effectKind: "linked_chat_turn_wake",
      targetKind: "chat_turn",
      targetId: "turn-1",
      createdAt,
      updatedAt: createdAt,
    });
    const pendingAction = repo.upsert({
      approvalId: "approval-1",
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-1",
      createdAt,
      updatedAt: createdAt,
    });

    const claimed = repo.claimNextPendingEffect("worker-1", createdAt, "2026-03-21T10:05:00.000Z");

    assert.equal(claimed?.effectId, pendingAction.effectId);
    assert.equal(claimed?.effectKind, "pending_action_execute");
  });

  it("keeps observability on an independent filtered claim lane", () => {
    const { repo, db } = createRepoWithDb();
    insertApproval(db, "approval-observability");
    const createdAt = "2026-03-21T10:00:00.000Z";
    const action = repo.upsert({
      approvalId: "approval-observability",
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval-observability",
      payload: { action: true },
      createdAt,
      updatedAt: createdAt,
    });
    const observability = repo.upsert({
      approvalId: "approval-observability",
      effectKind: "approval_observability",
      targetKind: "approval",
      targetId: "approval.resolve.audit",
      payload: { deliveryId: "delivery-1" },
      createdAt,
      updatedAt: createdAt,
    });

    assert.equal(
      repo.claimNextPendingEffect("action-worker", createdAt, "2026-03-21T10:05:00.000Z")?.effectId,
      action.effectId,
    );
    assert.equal(
      repo.claimNextPendingObservabilityEffect("observability-worker", createdAt, "2026-03-21T10:05:00.000Z")?.effectId,
      observability.effectId,
    );
  });

  it("allocates one immutable predecessor chain for an observability batch", () => {
    const { repo, db } = createRepoWithDb();
    insertApproval(db, "approval-observability-batch");

    const effects = repo.upsertObservabilityBatch({
      approvalId: "approval-observability-batch",
      occurredAt: "2026-03-21T10:00:00.000Z",
      attribution: { actorId: "operator-batch" },
      items: [
        {
          operationId: "created-audit-v1",
          delivery: {
            kind: "audit",
            stream: "approvals",
            payload: { action: "approval.created" },
          },
        },
        {
          operationId: "resolved-audit-v1",
          delivery: {
            kind: "audit",
            stream: "approvals",
            payload: { action: "approval.resolved" },
          },
        },
      ],
    });

    assert.equal(effects.length, 2);
    assert.deepEqual(effects[0]?.payload, {
      schemaVersion: "approval_observability.v1",
      deliveryId: "approval-observability:approval-observability-batch:created-audit-v1",
      operationId: "created-audit-v1",
      occurredAt: "2026-03-21T10:00:00.000Z",
      orderIndex: 1,
      attribution: { actorId: "operator-batch" },
      delivery: {
        kind: "audit",
        stream: "approvals",
        payload: { action: "approval.created" },
      },
    });
    assert.deepEqual(effects[1]?.payload, {
      schemaVersion: "approval_observability.v1",
      deliveryId: "approval-observability:approval-observability-batch:resolved-audit-v1",
      operationId: "resolved-audit-v1",
      occurredAt: "2026-03-21T10:00:00.000Z",
      orderIndex: 2,
      predecessorDeliveryId: "approval-observability:approval-observability-batch:created-audit-v1",
      attribution: { actorId: "operator-batch" },
      delivery: {
        kind: "audit",
        stream: "approvals",
        payload: { action: "approval.resolved" },
      },
    });

    const [duplicate] = repo.upsertObservabilityBatch({
      approvalId: "approval-observability-batch",
      occurredAt: "2026-03-21T10:05:00.000Z",
      attribution: { actorId: "operator-retry" },
      items: [
        {
          operationId: "created-audit-v1",
          delivery: {
            kind: "audit",
            stream: "approvals",
            payload: { action: "approval.created" },
          },
        },
      ],
    });
    assert.deepEqual(duplicate?.payload, effects[0]?.payload);
    assert.throws(
      () =>
        repo.upsertObservabilityBatch({
          approvalId: "approval-observability-batch",
          occurredAt: "2026-03-21T10:05:00.000Z",
          attribution: { actorId: "operator-retry" },
          items: [
            {
              operationId: "created-audit-v1",
              delivery: {
                kind: "audit",
                stream: "approvals",
                payload: { action: "approval.created.edited" },
              },
            },
          ],
        }),
      /idempotency payload mismatch/i,
    );
  });

  it("persists observability chain timestamps in predecessor order before claiming", () => {
    const { repo, db } = createRepoWithDb();
    insertApproval(db, "approval-observability-claim-order");
    const occurredAt = "2026-03-21T10:00:00.000Z";

    const firstBatch = repo.upsertObservabilityBatch({
      approvalId: "approval-observability-claim-order",
      occurredAt,
      items: [
        {
          operationId: "create-audit",
          delivery: { kind: "audit", stream: "approvals", payload: { event: "create" } },
        },
        {
          operationId: "create-realtime",
          delivery: {
            kind: "realtime",
            eventType: "approval_created",
            source: "approvals",
            payload: { event: "create" },
          },
        },
      ],
    });
    const [resolvedAudit] = repo.upsertObservabilityBatch({
      approvalId: "approval-observability-claim-order",
      occurredAt,
      items: [
        {
          operationId: "resolve-audit",
          delivery: { kind: "audit", stream: "approvals", payload: { event: "resolve" } },
        },
      ],
    });

    assert.ok(firstBatch[0]);
    assert.ok(firstBatch[1]);
    assert.ok(resolvedAudit);
    assert.ok(firstBatch[0].createdAt < firstBatch[1].createdAt);
    assert.ok(firstBatch[1].createdAt < resolvedAudit.createdAt);
    assert.equal(
      repo.claimNextPendingObservabilityEffect("observability-worker", occurredAt, "2026-03-21T10:05:00.000Z")
        ?.effectId,
      firstBatch[0].effectId,
    );
  });

  it("serializes concurrent SQLite observability batches into one predecessor chain", async () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-effect-concurrent-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const repo = new ApprovalEffectRepository(db);
    const approvalId = "approval-observability-concurrent";
    insertApproval(db, approvalId);

    try {
      await runConcurrentObservabilityWorkers({
        kind: "sqlite",
        workerOptions: { dbPath },
        approvalId,
        countPerWorker: 30,
      });

      assertSingleObservabilityChain(repo.listByApproval(approvalId), 60);
    } finally {
      db.close();
    }
  });

  it("claims linked child chat-turn wakes before orchestration parent wakes", () => {
    const { repo, db } = createRepoWithDb();
    insertApproval(db, "approval-1");
    const createdAt = "2026-03-21T10:00:00.000Z";

    repo.upsert({
      approvalId: "approval-1",
      effectKind: "orchestration_parent_wake",
      targetKind: "durable_run",
      targetId: "parent-durable-run",
      createdAt,
      updatedAt: createdAt,
    });
    const linked = repo.upsert({
      approvalId: "approval-1",
      effectKind: "linked_chat_turn_wake",
      targetKind: "chat_turn",
      targetId: "child-turn-1",
      createdAt,
      updatedAt: createdAt,
    });

    const claimed = repo.claimNextPendingEffect("worker-1", createdAt, "2026-03-21T10:05:00.000Z");

    assert.equal(claimed?.effectId, linked.effectId);
    assert.equal(claimed?.effectKind, "linked_chat_turn_wake");
  });

  it("maps legacy wake-effect rows into current approval effect records", () => {
    const { repo } = createRepoWithDb();
    (repo as unknown as { getByIdStmt: { get: () => unknown } }).getByIdStmt = {
      get: () => ({
        effect_id: "effect-legacy",
        approval_id: "approval-legacy",
        effect_kind: "wake_durable_run",
        target_kind: null,
        target_id: "run-legacy",
        idempotency_key: null,
        status: "pending",
        outcome: "resumed",
        detail: "legacy detail",
        details_json: '{"source":"legacy"}',
        attempt_count: 0,
        payload_json: '{"payload":true}',
        result_json: null,
        last_error: null,
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        version: null,
        created_at: "2026-03-21T11:00:00.000Z",
        updated_at: "2026-03-21T11:00:00.000Z",
        completed_at: null,
      }),
    };

    const legacy = repo.get("effect-legacy");

    assert.equal(legacy.effectKind, "approval_wait_wake");
    assert.equal(legacy.targetKind, "durable_run");
    assert.equal(legacy.idempotencyKey, "approval-legacy:approval_wait_wake:durable_run:run-legacy");
    assert.deepEqual(legacy.payload, { payload: true });
    assert.deepEqual(legacy.result, {
      source: "legacy",
      outcome: "resumed",
      detail: "legacy detail",
    });
  });

  it("honors explicit idempotency keys and default completion payloads", () => {
    const { repo, db } = createRepoWithDb();
    insertApproval(db, "approval-defaults");

    const explicit = repo.upsert({
      approvalId: "approval-defaults",
      effectKind: "approval_inbox_follow_up",
      targetKind: "approval",
      targetId: "approval-defaults",
      idempotencyKey: "custom-key",
      status: "running",
      attemptCount: 3,
      result: { previous: true },
      lastError: "old failure",
      claimedBy: "worker-defaults",
      claimedAt: "2026-03-22T10:00:00.000Z",
      leaseExpiresAt: "2026-03-22T10:10:00.000Z",
      version: 7,
      completedAt: "2026-03-22T10:01:00.000Z",
    });

    assert.equal(explicit.idempotencyKey, "custom-key");
    assert.equal(explicit.status, "running");
    assert.equal(explicit.attemptCount, 3);
    assert.deepEqual(explicit.result, { previous: true });
    assert.equal(explicit.lastError, "old failure");
    assert.equal(explicit.claimedBy, "worker-defaults");
    assert.equal(explicit.claimedAt, "2026-03-22T10:00:00.000Z");
    assert.equal(explicit.leaseExpiresAt, "2026-03-22T10:10:00.000Z");
    assert.equal(explicit.version, 7);
    assert.equal(explicit.completedAt, "2026-03-22T10:01:00.000Z");

    assert.equal(repo.completeEffect(explicit.effectId, "worker-mismatch", 7, {}), undefined);
    const completed = repo.completeEffect(explicit.effectId, "worker-defaults", 7, {});
    assert.equal(completed?.status, "completed");
    assert.deepEqual(completed?.result, {});
    assert.ok(completed?.completedAt);

    const skippedBase = repo.upsert({
      approvalId: "approval-defaults",
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "action-defaults",
      status: "running",
      claimedBy: "worker-skip",
      version: 1,
    });
    const skipped = repo.skipEffect(skippedBase.effectId, "worker-skip", 1, {});
    assert.equal(skipped?.status, "skipped");
    assert.deepEqual(skipped?.result, {});
    assert.ok(skipped?.completedAt);

    const failedBase = repo.upsert({
      approvalId: "approval-defaults",
      effectKind: "linked_chat_turn_wake",
      targetKind: "chat_turn",
      targetId: "turn-defaults",
      status: "running",
      claimedBy: "worker-fail",
      version: 1,
    });
    const failed = repo.failEffect(failedBase.effectId, "worker-fail", 1, {
      lastError: "still failing",
    });
    assert.equal(failed?.status, "failed");
    assert.deepEqual(failed?.result, {});
    assert.equal(failed?.lastError, "still failing");
  });

  it("continues past stale claim candidates and maps malformed legacy result fallbacks", () => {
    const { repo } = createRepoWithDb();
    const internal = repo as unknown as {
      claimCandidatesStmt: { all: (...args: unknown[]) => unknown };
      claimEffectStmt: { run: (...args: unknown[]) => { changes?: number } };
      getByIdStmt: { get: (...args: unknown[]) => unknown };
    };

    internal.claimCandidatesStmt = {
      all: () => [
        {
          effect_id: "effect-stale",
          version: null,
        },
      ],
    };
    internal.claimEffectStmt = { run: () => ({}) };
    assert.equal(
      repo.claimNextPendingEffect("worker", "2026-03-22T12:00:00.000Z", "2026-03-22T12:05:00.000Z"),
      undefined,
    );

    internal.getByIdStmt = {
      get: () => ({
        effect_id: "effect-legacy-empty",
        approval_id: "approval-legacy",
        effect_kind: "approval_wait_wake",
        target_kind: "durable_run",
        target_id: "run-legacy",
        idempotency_key: "legacy-key",
        status: "pending",
        outcome: null,
        detail: null,
        details_json: "{bad",
        attempt_count: null,
        payload_json: "{bad",
        result_json: null,
        last_error: null,
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        version: null,
        created_at: "2026-03-22T12:00:00.000Z",
        updated_at: "2026-03-22T12:00:00.000Z",
        completed_at: null,
      }),
    };

    const legacy = repo.get("effect-legacy-empty");
    assert.equal(legacy.idempotencyKey, "legacy-key");
    assert.deepEqual(legacy.payload, {});
    assert.deepEqual(legacy.result, {});
    assert.equal(legacy.attemptCount, 0);
    assert.equal(legacy.version, 1);
  });
});

interface ConcurrentObservabilityWorkerInput {
  kind: "sqlite" | "postgres";
  workerOptions: Record<string, unknown>;
  approvalId: string;
  countPerWorker: number;
}

async function runConcurrentObservabilityWorkers(input: ConcurrentObservabilityWorkerInput): Promise<void> {
  const startGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = ["left", "right"].map(
    (prefix) =>
      new Worker(CONCURRENT_OBSERVABILITY_WORKER_SOURCE, {
        eval: true,
        workerData: {
          ...input,
          prefix,
          startGate,
          repoModuleUrl: new URL("./approval-effect-repo.ts", import.meta.url).href,
          sqliteModuleUrl: new URL("./sqlite.ts", import.meta.url).href,
          postgresModuleUrl: new URL("./postgres/sync.ts", import.meta.url).href,
          tsxApiUrl: import.meta.resolve("tsx/esm/api"),
        },
      }),
  );
  const ready = workers.map((worker) => waitForWorkerReady(worker));
  await Promise.all(ready);
  Atomics.store(new Int32Array(startGate), 0, 1);
  Atomics.notify(new Int32Array(startGate), 0);
  await Promise.all(workers.map((worker) => waitForWorkerCompletion(worker)));
}

function waitForWorkerReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (isWorkerMessage(message, "ready")) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

function waitForWorkerCompletion(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.on("message", (message: unknown) => {
      if (isWorkerMessage(message, "done")) {
        resolve();
      } else if (isWorkerMessage(message, "error")) {
        reject(new Error(String((message as { error?: unknown }).error ?? "Concurrent observability worker failed.")));
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Concurrent observability worker exited with code ${code}.`));
      }
    });
  });
}

function isWorkerMessage(value: unknown, type: string): boolean {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === type);
}

function assertSingleObservabilityChain(
  effects: readonly { payload: Record<string, unknown> }[],
  expectedCount: number,
) {
  const envelopes = effects
    .map((effect) => effect.payload)
    .filter((payload) => payload.schemaVersion === "approval_observability.v1")
    .sort((left, right) => Number(left.orderIndex) - Number(right.orderIndex));
  assert.equal(envelopes.length, expectedCount);
  assert.deepEqual(
    envelopes.map((envelope) => Number(envelope.orderIndex)),
    Array.from({ length: expectedCount }, (_, index) => index + 1),
  );
  for (let index = 1; index < envelopes.length; index += 1) {
    assert.equal(envelopes[index]?.predecessorDeliveryId, envelopes[index - 1]?.deliveryId);
  }
}

const CONCURRENT_OBSERVABILITY_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  void (async () => {
    const { tsImport } = await import(workerData.tsxApiUrl);
    const { ApprovalEffectRepository } = await tsImport(workerData.repoModuleUrl, workerData.repoModuleUrl);
    let db;
    if (workerData.kind === "sqlite") {
      const { createDatabase } = await tsImport(workerData.sqliteModuleUrl, workerData.repoModuleUrl);
      db = createDatabase(workerData.workerOptions);
    } else {
      const { PostgresSyncDatabaseClient } = await tsImport(workerData.postgresModuleUrl, workerData.repoModuleUrl);
      db = new PostgresSyncDatabaseClient(workerData.workerOptions);
    }
    const repo = new ApprovalEffectRepository(db);
    parentPort.postMessage({ type: "ready" });
    Atomics.wait(new Int32Array(workerData.startGate), 0, 0);
    try {
      for (let index = 0; index < workerData.countPerWorker; index += 1) {
        repo.upsertObservabilityBatch({
          approvalId: workerData.approvalId,
          occurredAt: "2026-03-21T10:00:00.000Z",
          attribution: { actorId: "operator-" + workerData.prefix },
          items: [
            {
              operationId: workerData.prefix + "-" + index,
              delivery: {
                kind: "audit",
                stream: "approvals",
                payload: { action: "approval.concurrent", index },
              },
            },
          ],
        });
      }
      parentPort.postMessage({ type: "done" });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    } finally {
      db.close();
    }
  })();
`;
