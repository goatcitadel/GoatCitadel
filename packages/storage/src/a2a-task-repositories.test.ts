import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { A2ATaskBindingRepository } from "./a2a-task-binding-repo.js";
import { A2ATaskPushConfigRepository } from "./a2a-task-push-config-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${file}${suffix}`, { force: true });
    }
  }
});

function createRepositories() {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-a2a-repositories-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    bindings: new A2ATaskBindingRepository(db),
    db,
    pushConfigs: new A2ATaskPushConfigRepository(db),
  };
}

describe("A2ATaskBindingRepository", () => {
  it("persists idempotent bindings, updates runtime linkage, and scopes peer listings", () => {
    const { bindings, db } = createRepositories();
    try {
      const created = bindings.createOrGet(
        {
          a2aTaskId: "a2a-task-1",
          contextId: "context-1",
          peerId: "peer-1",
          idempotencyKey: "dispatch-1",
          metadata: { source: "chat", attempt: 1 },
        },
        "2026-07-11T10:00:00.000Z",
      );

      assert.deepEqual(created, {
        a2aTaskId: "a2a-task-1",
        contextId: "context-1",
        peerId: "peer-1",
        workspaceId: "default",
        sessionId: undefined,
        localTaskId: undefined,
        durableRunId: undefined,
        state: "submitted",
        lastEventSequence: 0,
        idempotencyKey: "dispatch-1",
        metadata: { source: "chat", attempt: 1 },
        createdAt: "2026-07-11T10:00:00.000Z",
        updatedAt: "2026-07-11T10:00:00.000Z",
      });

      const replayedByKey = bindings.createOrGet({
        a2aTaskId: created.a2aTaskId,
        contextId: created.contextId,
        peerId: "peer-1",
        workspaceId: created.workspaceId,
        idempotencyKey: "dispatch-1",
      });
      assert.equal(replayedByKey.a2aTaskId, created.a2aTaskId);
      assert.ok(Math.abs(Date.parse(bindings.readDatabaseNow()) - Date.now()) < 5_000);

      assert.throws(
        () =>
          bindings.createOrGet({
            a2aTaskId: created.a2aTaskId,
            contextId: created.contextId,
            peerId: created.peerId,
            workspaceId: "other-workspace",
            idempotencyKey: created.idempotencyKey,
          }),
        /conflicts with the persisted A2A binding owner or request identity/,
      );

      assert.throws(
        () =>
          bindings.createOrGet({
            a2aTaskId: created.a2aTaskId,
            contextId: "ignored-context",
            peerId: "peer-1",
            idempotencyKey: "dispatch-new-key",
          }),
        /conflicts with the persisted A2A binding owner or request identity/,
      );

      assert.throws(
        () =>
          bindings.createOrGet({
            a2aTaskId: created.a2aTaskId,
            contextId: created.contextId,
            peerId: "peer-2",
            workspaceId: created.workspaceId,
            idempotencyKey: "peer-2-dispatch",
          }),
        /conflicts with the persisted A2A binding owner or request identity/,
      );
      assert.deepEqual(bindings.get(created.a2aTaskId), created);

      const updated = bindings.update(
        created.a2aTaskId,
        {
          contextId: "context-2",
          workspaceId: "workspace-2",
          sessionId: "session-2",
          localTaskId: "local-task-2",
          durableRunId: "durable-run-2",
          state: "working",
          lastEventSequence: 7,
          metadata: { source: "durable", recovered: true },
        },
        "2026-07-11T10:01:00.000Z",
      );
      assert.deepEqual(
        {
          contextId: updated.contextId,
          durableRunId: updated.durableRunId,
          lastEventSequence: updated.lastEventSequence,
          localTaskId: updated.localTaskId,
          metadata: updated.metadata,
          sessionId: updated.sessionId,
          state: updated.state,
          workspaceId: updated.workspaceId,
        },
        {
          contextId: "context-2",
          durableRunId: "durable-run-2",
          lastEventSequence: 7,
          localTaskId: "local-task-2",
          metadata: { source: "durable", recovered: true },
          sessionId: "session-2",
          state: "working",
          workspaceId: "workspace-2",
        },
      );

      bindings.createOrGet(
        {
          a2aTaskId: "a2a-task-2",
          contextId: "context-3",
          peerId: "peer-1",
          idempotencyKey: "dispatch-2",
        },
        "2026-07-11T10:02:00.000Z",
      );
      bindings.createOrGet({
        a2aTaskId: "a2a-task-other-peer",
        contextId: "context-other",
        peerId: "peer-2",
        idempotencyKey: "dispatch-other",
      });

      assert.deepEqual(
        bindings.listByPeer("peer-1", 5000).map((binding) => binding.a2aTaskId),
        ["a2a-task-2", "a2a-task-1"],
      );
      assert.deepEqual(
        bindings.listByPeer("peer-1", 0).map((binding) => binding.a2aTaskId),
        ["a2a-task-2"],
      );
      assert.equal(bindings.find("missing"), undefined);
      assert.throws(() => bindings.get("missing"), /Unknown A2A task binding missing/);
      assert.equal(bindings.getForUpdate(created.a2aTaskId).a2aTaskId, created.a2aTaskId);
      assert.throws(() => bindings.getForUpdate("missing"), /Unknown A2A task binding missing/);
    } finally {
      db.close();
    }
  });

  it("sanitizes malformed persisted metadata and numeric event state", () => {
    const { bindings, db } = createRepositories();
    try {
      bindings.createOrGet({
        a2aTaskId: "a2a-task-malformed",
        contextId: "context-malformed",
        peerId: "peer-malformed",
        idempotencyKey: "dispatch-malformed",
      });
      db.prepare("UPDATE a2a_task_bindings SET metadata_json = ?, last_event_sequence = ? WHERE a2a_task_id = ?").run(
        "[1,2,3]",
        "not-a-number",
        "a2a-task-malformed",
      );

      const sanitized = bindings.get("a2a-task-malformed");
      assert.deepEqual(sanitized.metadata, {});
      assert.equal(sanitized.lastEventSequence, 0);

      const internals = bindings as unknown as { getStmt: { get: () => unknown } };
      internals.getStmt = { get: () => null };
      assert.equal(bindings.find("a2a-task-malformed"), undefined);
    } finally {
      db.close();
    }
  });
});

describe("A2ATaskPushConfigRepository", () => {
  it("normalizes push configuration and preserves delivery state across updates", () => {
    const { db, pushConfigs } = createRepositories();
    try {
      const created = pushConfigs.upsert(
        {
          taskId: "a2a-task-1",
          peerId: "peer-1",
          url: "https://peer.example/push",
          events: ["task.message", "task.message", "invalid-event" as never, 42 as never],
          enabled: false,
          authToken: "  secret-token-1234567890  ",
          maxAttempts: 99,
        },
        "2026-07-11T11:00:00.000Z",
      );

      assert.deepEqual(created.events, ["task.message"]);
      assert.equal(created.enabled, false);
      assert.equal(created.maxAttempts, 5);
      assert.equal(created.authToken, "secret-token-1234567890");
      assert.deepEqual(created.auth, { scheme: "bearer", tokenPreview: "secr...7890" });
      assert.equal(created.attemptCount, 0);
      assert.equal(created.lastDeliveryStatus, "pending");

      const delivered = pushConfigs.recordDelivery(
        created.taskId,
        created.peerId,
        {
          status: "retry_scheduled",
          attemptCount: -4,
          error: "x".repeat(1105),
          deliveredAt: "2026-07-11T11:01:00.000Z",
          nextRetryAt: "2026-07-11T11:02:00.000Z",
          lastEventSequence: -8,
        },
        "2026-07-11T11:01:30.000Z",
      );
      assert.equal(delivered.attemptCount, 0);
      assert.equal(delivered.lastDeliveryStatus, "retry_scheduled");
      assert.equal(delivered.lastDeliveryError?.length, 1000);
      assert.equal(delivered.lastEventSequence, 0);
      assert.equal(delivered.nextRetryAt, "2026-07-11T11:02:00.000Z");

      const updated = pushConfigs.upsert(
        {
          taskId: created.taskId,
          peerId: created.peerId,
          url: "https://peer.example/push-v2",
          authToken: "short",
          maxAttempts: Number.NaN,
        },
        "2026-07-11T11:03:00.000Z",
      );
      assert.equal(updated.url, "https://peer.example/push-v2");
      assert.deepEqual(updated.events, ["task.status"]);
      assert.equal(updated.maxAttempts, 3);
      assert.equal(updated.lastDeliveryStatus, "retry_scheduled");
      assert.equal(updated.createdAt, created.createdAt);
      assert.deepEqual(updated.auth, { scheme: "bearer", tokenPreview: "***" });

      pushConfigs.upsert(
        {
          taskId: "a2a-task-2",
          peerId: "peer-1",
          url: "https://peer.example/second",
        },
        "2026-07-11T11:04:00.000Z",
      );
      pushConfigs.upsert({
        taskId: "a2a-task-other-peer",
        peerId: "peer-2",
        url: "https://other.example/push",
      });
      assert.deepEqual(
        pushConfigs.listByPeer("peer-1", 5000).map((config) => config.taskId),
        ["a2a-task-2", "a2a-task-1"],
      );
      assert.deepEqual(
        pushConfigs.listByPeer("peer-1", 0).map((config) => config.taskId),
        ["a2a-task-2"],
      );

      assert.equal(pushConfigs.delete(created.taskId, created.peerId), true);
      assert.equal(pushConfigs.delete(created.taskId, created.peerId), false);
      assert.equal(pushConfigs.find(created.taskId, created.peerId), undefined);
      assert.throws(
        () => pushConfigs.get(created.taskId, created.peerId),
        /Unknown A2A push config a2a-task-1 for peer peer-1/,
      );
    } finally {
      db.close();
    }
  });

  it("sanitizes malformed persisted events, delivery state, counters, and credentials", () => {
    const { db, pushConfigs } = createRepositories();
    try {
      pushConfigs.upsert({
        taskId: "a2a-task-malformed",
        peerId: "peer-malformed",
        url: "https://peer.example/malformed",
      });
      db.prepare(
        `
        UPDATE a2a_task_push_configs
        SET events_json = ?,
            auth_token = ?,
            max_attempts = ?,
            attempt_count = ?,
            last_delivery_status = ?,
            last_event_sequence = ?
        WHERE a2a_task_id = ? AND peer_id = ?
      `,
      ).run(
        '{"not":"an-array"}',
        "   ",
        "not-a-number",
        "not-a-number",
        "unknown-status",
        "not-a-number",
        "a2a-task-malformed",
        "peer-malformed",
      );

      const sanitized = pushConfigs.get("a2a-task-malformed", "peer-malformed");
      assert.deepEqual(sanitized.events, ["task.status"]);
      assert.equal(sanitized.authToken, undefined);
      assert.equal(sanitized.auth, undefined);
      assert.equal(sanitized.maxAttempts, 3);
      assert.equal(sanitized.attemptCount, 0);
      assert.equal(sanitized.lastDeliveryStatus, "pending");
      assert.equal(sanitized.lastEventSequence, 0);

      assert.throws(
        () =>
          pushConfigs.recordDelivery("missing", "peer-malformed", {
            status: "delivered",
            attemptCount: 1,
            lastEventSequence: 1,
          }),
        /Unknown A2A push config missing for peer peer-malformed/,
      );
    } finally {
      db.close();
    }
  });
});
