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
});
