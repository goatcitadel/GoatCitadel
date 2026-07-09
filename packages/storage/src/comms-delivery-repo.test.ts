import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import type { DatabaseClient } from "./db.js";
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
  it("casts nullable lease parameters in PostgreSQL CAS statements", () => {
    const preparedSql: string[] = [];
    const statement = {
      run: () => ({ changes: 0 }),
      get: () => undefined,
      all: () => [],
    };
    const db = {
      dialect: "postgres",
      prepare: (sql: string) => {
        preparedSql.push(sql);
        return statement;
      },
    } as unknown as DatabaseClient;

    new CommsDeliveryRepository(db);

    const nullableLeaseStatements = preparedSql.filter((sql) => sql.includes("@expectedNextAttemptAt"));
    assert.equal(nullableLeaseStatements.length, 2);
    for (const sql of nullableLeaseStatements) {
      assert.match(sql, /@expectedNextAttemptAt::text IS NULL/);
      assert.match(sql, /next_attempt_at = @expectedNextAttemptAt::text/);
      assert.doesNotMatch(sql, /\(@expectedNextAttemptAt IS NULL/);
    }
  });

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

  it("atomically claims a due delivery across repository instances", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-comms-delivery-claim-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const firstDb = createDatabase({ dbPath });
    const secondDb = createDatabase({ dbPath });
    const firstRepo = new CommsDeliveryRepository(firstDb) as CommsDeliveryRepository & {
      claimAttempt(
        deliveryId: string,
        expectedAttempts: number,
        attempts: number,
        claimExpiresAt: string,
        updatedAt?: string,
      ): boolean;
    };
    const secondRepo = new CommsDeliveryRepository(secondDb) as CommsDeliveryRepository & {
      claimAttempt(
        deliveryId: string,
        expectedAttempts: number,
        attempts: number,
        claimExpiresAt: string,
        updatedAt?: string,
      ): boolean;
    };
    try {
      const queued = firstRepo.createQueued(
        {
          connectionId: "conn-claim",
          channelKey: "slack",
          target: "C123",
          payload: { message: "claim exactly once" },
        },
        "2026-05-05T00:00:00.000Z",
      );
      const firstView = firstRepo.listDue("2026-05-05T00:00:01.000Z")[0];
      const secondView = secondRepo.listDue("2026-05-05T00:00:01.000Z")[0];

      assert.equal(firstView?.deliveryId, queued.deliveryId);
      assert.equal(secondView?.deliveryId, queued.deliveryId);
      assert.equal(firstView?.attempts, 0);
      assert.equal(secondView?.attempts, 0);
      assert.equal(
        firstRepo.claimAttempt(
          queued.deliveryId,
          firstView?.attempts ?? -1,
          (firstView?.attempts ?? -1) + 1,
          "2026-05-05T00:15:01.000Z",
          "2026-05-05T00:00:01.000Z",
        ),
        true,
      );
      assert.equal(
        secondRepo.claimAttempt(
          queued.deliveryId,
          secondView?.attempts ?? -1,
          (secondView?.attempts ?? -1) + 1,
          "2026-05-05T00:15:01.000Z",
          "2026-05-05T00:00:01.000Z",
        ),
        false,
      );
      assert.equal(firstRepo.list("conn-claim", 1)[0]?.attempts, 1);
    } finally {
      firstDb.close();
      secondDb.close();
    }
  });

  it("does not let an expired recovery snapshot overwrite a delivery completed by its owner", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-comms-delivery-quarantine-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const ownerDb = createDatabase({ dbPath });
    const recoveryDb = createDatabase({ dbPath });
    const ownerRepo = new CommsDeliveryRepository(ownerDb);
    const recoveryRepo = new CommsDeliveryRepository(recoveryDb);
    try {
      const queued = ownerRepo.createQueued(
        {
          connectionId: "conn-quarantine",
          channelKey: "slack",
          target: "C123",
          payload: { message: "send exactly once" },
          idempotencyKey: "quarantine-race-idempotency-key",
        },
        "2026-05-05T00:00:00.000Z",
      );
      assert.equal(
        ownerRepo.claimAttempt(queued.deliveryId, 0, 1, "2026-05-05T00:15:01.000Z", "2026-05-05T00:00:01.000Z"),
        true,
      );
      const recoverySnapshot = recoveryRepo.findByIdempotencyKey("quarantine-race-idempotency-key");
      assert.equal(recoverySnapshot?.attempts, 1);
      assert.equal(recoverySnapshot?.nextAttemptAt, "2026-05-05T00:15:01.000Z");

      ownerRepo.markSent(queued.deliveryId, "provider-race-1", "2026-05-05T00:00:02.000Z");
      assert.equal(
        recoveryRepo.quarantineAttempt(
          queued.deliveryId,
          recoverySnapshot?.attempts ?? -1,
          recoverySnapshot?.nextAttemptAt,
          "stale recovery must not overwrite sent truth",
          "2026-05-05T00:15:01.000Z",
        ),
        false,
      );

      const persisted = ownerRepo.list("conn-quarantine", 1)[0];
      assert.equal(persisted?.status, "sent");
      assert.equal(persisted?.deliveryStatus, "sent");
      assert.equal(persisted?.providerMessageId, "provider-race-1");
    } finally {
      ownerDb.close();
      recoveryDb.close();
    }
  });

  it("fences a late owner completion after recovery quarantines its expired claim", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-comms-delivery-late-owner-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const ownerDb = createDatabase({ dbPath });
    const recoveryDb = createDatabase({ dbPath });
    const ownerRepo = new CommsDeliveryRepository(ownerDb);
    const recoveryRepo = new CommsDeliveryRepository(recoveryDb);
    try {
      const queued = ownerRepo.createQueued(
        {
          connectionId: "conn-late-owner",
          channelKey: "slack",
          target: "C123",
          payload: { message: "slow provider response" },
        },
        "2026-05-05T00:00:00.000Z",
      );
      const claimExpiresAt = "2026-05-05T00:15:01.000Z";
      assert.equal(ownerRepo.claimAttempt(queued.deliveryId, 0, 1, claimExpiresAt, "2026-05-05T00:00:01.000Z"), true);
      assert.equal(
        recoveryRepo.quarantineAttempt(
          queued.deliveryId,
          1,
          claimExpiresAt,
          "expired owner claim requires reconciliation",
          claimExpiresAt,
        ),
        true,
      );
      assert.equal(
        ownerRepo.finalizeAttemptSent(
          queued.deliveryId,
          1,
          claimExpiresAt,
          "provider-late-1",
          "2026-05-05T00:15:02.000Z",
        ),
        false,
      );
      assert.equal(
        ownerRepo.recordManualProviderOutcome(
          queued.deliveryId,
          1,
          "provider-late-1",
          "provider completed after claim loss",
          "2026-05-05T00:15:02.000Z",
        ),
        true,
      );

      const persisted = ownerRepo.list("conn-late-owner", 1)[0];
      assert.equal(persisted?.status, "failed");
      assert.equal(persisted?.deliveryStatus, "manual_reconciliation_required");
      assert.equal(persisted?.providerMessageId, "provider-late-1");
      assert.equal(persisted?.error, "provider completed after claim loss");
    } finally {
      ownerDb.close();
      recoveryDb.close();
    }
  });

  it("retains the provider message id when a dispatched delivery requires manual reconciliation", () => {
    const repo = createRepo() as CommsDeliveryRepository & {
      markFailed(
        deliveryId: string,
        error: string,
        updatedAt?: string,
        deliveryStatus?: string,
        staleReason?: string,
        providerMessageId?: string,
      ): void;
    };
    const queued = repo.createQueued(
      {
        connectionId: "conn-manual",
        channelKey: "slack",
        target: "C123",
        payload: { message: "provider accepted this message" },
      },
      "2026-05-05T00:00:00.000Z",
    );

    repo.markFailed(
      queued.deliveryId,
      "provider dispatch completed but finalization failed",
      "2026-05-05T00:00:01.000Z",
      "manual_reconciliation_required",
      undefined,
      "provider-manual-1",
    );

    const persisted = repo.list("conn-manual", 1)[0];
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.deliveryStatus, "manual_reconciliation_required");
    assert.equal(persisted?.providerMessageId, "provider-manual-1");
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
