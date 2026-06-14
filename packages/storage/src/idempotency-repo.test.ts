import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { IdempotencyRepository } from "./idempotency-repo.js";

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

function createRepo(): IdempotencyRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-idempotency-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new IdempotencyRepository(db);
}

describe("IdempotencyRepository", () => {
  it("finds inserted events and updates their accepted status", () => {
    const repo = createRepo();

    repo.insertPending({
      endpoint: "/api/v1/events",
      idempotencyKey: "idem-1",
      eventId: "evt-1",
      sessionKey: "discord:me:1",
      payloadHash: "hash-1",
      receivedAt: "2026-03-05T10:00:00.000Z",
      status: "accepted",
    });

    repo.markProcessed(
      "/api/v1/events",
      "idem-1",
      "accepted",
      "2026-03-05T10:00:01.000Z",
    );

    const row = repo.find("/api/v1/events", "idem-1");
    assert.equal(row?.eventId, "evt-1");
    assert.equal(row?.status, "accepted");
    assert.equal(row?.processedAt, "2026-03-05T10:00:01.000Z");
  });

  it("does not downgrade an accepted row to deduped or move its processed_at", () => {
    // F-M3: a duplicate delivery must not corrupt the original event's audit
    // record. Once a row is accepted (with processed_at stamped), a later
    // `deduped` mark is a no-op on both status and processed_at.
    const repo = createRepo();
    repo.insertPending({
      endpoint: "/api/v1/events",
      idempotencyKey: "idem-accepted",
      eventId: "evt-1",
      sessionKey: "discord:me:1",
      payloadHash: "hash-1",
      receivedAt: "2026-03-05T10:00:00.000Z",
      status: "accepted",
    });
    repo.markProcessed("/api/v1/events", "idem-accepted", "accepted", "2026-03-05T10:00:01.000Z");

    // A subsequent duplicate tries to mark the original row as deduped.
    repo.markProcessed("/api/v1/events", "idem-accepted", "deduped", "2026-03-05T10:05:00.000Z");

    const row = repo.find("/api/v1/events", "idem-accepted");
    assert.equal(row?.status, "accepted");
    assert.equal(row?.processedAt, "2026-03-05T10:00:01.000Z");
  });

  it("ignores duplicate pending inserts by endpoint and idempotency key", () => {
    const repo = createRepo();
    const record = {
      endpoint: "/api/v1/events",
      idempotencyKey: "idem-dup",
      eventId: "evt-dup",
      sessionKey: "discord:me:dup",
      payloadHash: "hash-dup",
      receivedAt: "2026-03-05T10:00:00.000Z",
      status: "accepted" as const,
    };

    assert.equal(repo.insertPendingIfAbsent(record), true);
    assert.equal(repo.insertPendingIfAbsent({ ...record, eventId: "evt-other" }), false);
    assert.equal(repo.find(record.endpoint, record.idempotencyKey)?.eventId, "evt-dup");
  });
});
