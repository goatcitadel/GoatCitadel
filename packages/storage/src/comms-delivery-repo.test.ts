import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { CommsDeliveryRepository } from "./comms-delivery-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures in transient test databases
    }
  }
});

function createRepo(): CommsDeliveryRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-comms-delivery-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new CommsDeliveryRepository(createDatabase({ dbPath }));
}

describe("CommsDeliveryRepository", () => {
  it("persists queued delivery retry metadata and idempotency lookup", () => {
    const repo = createRepo();
    const queued = repo.createQueued(
      {
        connectionId: "conn-1",
        channelKey: "slack",
        target: "C123",
        payload: { message: "hello" },
        idempotencyKey: "delivery-idem-1",
        maxAttempts: 4,
        baseBackoffMs: 1_000,
        maxBackoffMs: 30_000,
        staleAfterMs: 60_000,
      },
      "2026-05-05T00:00:00.000Z",
    );

    repo.markAttempt(queued.deliveryId, 1, "2026-05-05T00:00:01.000Z");
    repo.markRetrying(
      queued.deliveryId,
      {
        attempts: 1,
        error: "Slack 503",
        nextAttemptAt: "2026-05-05T00:00:06.000Z",
      },
      "2026-05-05T00:00:01.000Z",
    );

    const earlyDue = repo.listDue("2026-05-05T00:00:05.000Z");
    assert.equal(earlyDue.length, 0);

    const due = repo.listDue("2026-05-05T00:00:06.000Z");
    assert.equal(due.length, 1);
    assert.equal(due[0]?.deliveryId, queued.deliveryId);
    assert.equal(due[0]?.attempts, 1);
    assert.equal(due[0]?.maxAttempts, 4);
    assert.equal(due[0]?.nextAttemptAt, "2026-05-05T00:00:06.000Z");
    assert.deepEqual(due[0]?.payload, { message: "hello" });

    const idempotent = repo.createQueued(
      {
        connectionId: "conn-1",
        channelKey: "slack",
        target: "C123",
        payload: { message: "hello" },
        idempotencyKey: "delivery-idem-1",
      },
      "2026-05-05T00:00:02.000Z",
    );
    assert.equal(idempotent.deliveryId, queued.deliveryId);
  });

  it("persists canonical payload hashes independent of object key insertion order", () => {
    const repo = createRepo();
    const queued = repo.createQueued(
      {
        connectionId: "conn-1",
        channelKey: "slack",
        target: "C123",
        payload: { z: 1, a: { y: 2, b: 3 } },
      },
      "2026-05-05T00:00:00.000Z",
    );

    const canonicalHash = createHash("sha256")
      .update(JSON.stringify({ a: { b: 3, y: 2 }, z: 1 }))
      .digest("hex");

    assert.equal(queued.payloadHash, canonicalHash);
  });

  it("persists stale final-delivery state separately from provider failures", () => {
    const repo = createRepo();
    const queued = repo.createQueued(
      {
        connectionId: "conn-2",
        channelKey: "telegram",
        target: "chat-1",
        payload: { message: "final answer" },
      },
      "2026-05-05T00:00:00.000Z",
    );

    repo.markFailed(
      queued.deliveryId,
      "Delivery became stale before it could be sent.",
      "2026-05-05T00:15:00.000Z",
      "degraded",
      "Delivery became stale before it could be sent.",
    );

    const [record] = repo.list("conn-2");
    assert.equal(record?.status, "failed");
    assert.equal(record?.deliveryStatus, "degraded");
    assert.equal(record?.staleReason, "Delivery became stale before it could be sent.");
  });

  it("covers sent state, missing idempotency, list-all, and malformed optional payload fields", () => {
    const repo = createRepo();
    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;
    const queued = repo.createQueued(
      {
        connectionId: "conn-3",
        channelKey: "email",
        target: "operator@example.com",
        payload: { nested: { b: 2, a: 1 }, list: [2, { z: true, a: false }] },
      },
      "2026-05-05T00:00:00.000Z",
    );

    assert.equal(repo.findByIdempotencyKey("missing-idempotency"), undefined);

    repo.markSent(queued.deliveryId, undefined, "2026-05-05T00:01:00.000Z");
    const sent = repo.list(undefined, 1)[0];
    assert.equal(sent?.deliveryId, queued.deliveryId);
    assert.equal(sent?.status, "sent");
    assert.equal(sent?.providerMessageId, undefined);
    assert.equal(sent?.deliveryStatus, "sent");

    db.prepare(
      `
      UPDATE comms_deliveries
      SET payload_json = ?,
          delivery_status = ?,
          stale_after_ms = NULL,
          base_backoff_ms = NULL,
          max_backoff_ms = NULL,
          error = NULL,
          stale_reason = ?
      WHERE delivery_id = ?
    `,
    ).run("{bad", "mystery", "stale-only", queued.deliveryId);

    const malformed = repo.list("conn-3", 1)[0];
    assert.equal(malformed?.payload, undefined);
    assert.equal(malformed?.deliveryStatus, undefined);
    assert.equal(malformed?.attempts, 0);
    assert.equal(malformed?.maxAttempts, 3);
    assert.equal(malformed?.fallbackReason, "stale-only");

    const internal = repo as unknown as {
      listStmt: { all: (...args: unknown[]) => unknown };
      listByConnectionStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.listStmt = { all: () => ({ not: "an array" }) };
    assert.deepEqual(repo.list(), []);

    internal.listByConnectionStmt = {
      all: () => [
        {
          delivery_id: "delivery-legacy",
          connection_id: "conn-legacy",
          channel_key: "email",
          target: "operator@example.com",
          payload_hash: "hash",
          payload_json: undefined,
          status: "queued",
          delivery_status: undefined,
          idempotency_key: undefined,
          attempts: undefined,
          max_attempts: undefined,
          next_attempt_at: undefined,
          stale_after_ms: undefined,
          base_backoff_ms: undefined,
          max_backoff_ms: undefined,
          provider_msg_id: null,
          error: null,
          stale_reason: undefined,
          created_at: "2026-05-05T00:00:00.000Z",
          updated_at: "2026-05-05T00:00:00.000Z",
        },
      ],
    };
    const legacy = repo.list("conn-legacy")[0];
    assert.equal(legacy?.payload, undefined);
    assert.equal(legacy?.deliveryStatus, undefined);
    assert.equal(legacy?.idempotencyKey, undefined);
    assert.equal(legacy?.nextAttemptAt, undefined);
  });
});
