import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TranscriptEvent } from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { TranscriptOutboxRepository } from "./transcript-outbox-repo.js";

const createdFiles: string[] = [];
type FakeStatementOverrides = {
  run?: (...params: unknown[]) => { changes: number };
  get?: (...params: unknown[]) => unknown;
  all?: (...params: unknown[]) => unknown;
};

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

function createRepo(): TranscriptOutboxRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-transcript-outbox-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new TranscriptOutboxRepository(createDatabase({ dbPath }));
}

function transcriptEvent(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    eventId: "event-1",
    actionId: "action-1",
    idempotencyKey: "idem-1",
    sessionId: "session-1",
    sessionKey: "chat:session-1",
    timestamp: "2026-04-20T00:00:00.000Z",
    type: "message.user",
    actorType: "user",
    actorId: "user-1",
    payload: { text: "hello" },
    ...overrides,
  };
}

describe("TranscriptOutboxRepository", () => {
  it("tracks pending, failed, delivered, duplicate, and session-scoped outbox state", () => {
    const repo = createRepo();
    const event = transcriptEvent();

    const enqueued = repo.enqueue(event);
    assert.equal(enqueued.eventId, "event-1");
    assert.equal(enqueued.attemptCount, 0);
    assert.equal(repo.get(event.eventId)?.event.payload.text, "hello");
    assert.deepEqual(
      repo.listPending(10).map((item) => item.eventId),
      ["event-1"],
    );
    assert.deepEqual(
      repo.listPending(10, "session-1").map((item) => item.eventId),
      ["event-1"],
    );
    assert.deepEqual(repo.listPending(10, "missing-session"), []);

    const failed = repo.markFailed(event.eventId, {
      lastAttemptAt: "2026-04-20T00:01:00.000Z",
      lastError: "network timeout",
    });
    assert.equal(failed?.attemptCount, 1);
    assert.equal(failed?.lastAttemptAt, "2026-04-20T00:01:00.000Z");
    assert.equal(failed?.lastError, "network timeout");

    const delivered = repo.markDelivered(event.eventId, {
      deliveredAt: "2026-04-20T00:02:00.000Z",
      transcriptOffset: 42,
    });
    assert.equal(delivered?.deliveredAt, "2026-04-20T00:02:00.000Z");
    assert.equal(delivered?.transcriptOffset, 42);
    assert.equal(delivered?.lastAttemptAt, "2026-04-20T00:02:00.000Z");
    assert.equal(delivered?.lastError, undefined);
    assert.deepEqual(repo.listPending(10), []);

    const duplicate = repo.enqueue(transcriptEvent({ timestamp: "2026-04-20T00:03:00.000Z" }));
    assert.equal(duplicate.enqueuedAt, "2026-04-20T00:00:00.000Z");
    assert.equal(repo.markFailed("missing-event", { lastError: "missing" }), undefined);
    assert.equal(repo.markDelivered("missing-event", { transcriptOffset: 99 }), undefined);
  });

  it("falls back on malformed rows and invalid serialized transcript events", () => {
    const row = {
      event_id: "event-bad-json",
      session_id: "session-1",
      event_json: "{bad-json",
      enqueued_at: "2026-04-20T00:00:00.000Z",
      delivered_at: null,
      transcript_offset: null,
      attempt_count: 0,
      last_attempt_at: null,
      last_error: null,
    };
    const repo = new TranscriptOutboxRepository(
      fakeDatabase([
        fakeStatement(),
        fakeStatement({ get: () => row }),
        fakeStatement({ all: () => [null, { ...row, event_id: 10 }, row] }),
        fakeStatement({ all: () => "not-an-array" }),
        fakeStatement(),
        fakeStatement(),
      ]),
    );

    assert.equal(repo.get("event-bad-json")?.event.payload.reason, "invalid_transcript_event");
    assert.deepEqual(
      repo.listPending().map((item) => item.eventId),
      ["event-bad-json"],
    );
    assert.deepEqual(repo.listPending(10, "session-1"), []);
  });

  it("returns the enqueue fallback when an insert cannot be reloaded", () => {
    const repo = new TranscriptOutboxRepository(
      fakeDatabase([
        fakeStatement(),
        fakeStatement({ get: () => undefined }),
        fakeStatement(),
        fakeStatement(),
        fakeStatement(),
        fakeStatement(),
      ]),
    );
    const fallback = repo.enqueue(transcriptEvent({ eventId: "fallback-event" }), "2026-04-20T00:05:00.000Z");

    assert.equal(fallback.eventId, "fallback-event");
    assert.equal(fallback.enqueuedAt, "2026-04-20T00:05:00.000Z");
    assert.equal(fallback.attemptCount, 0);
  });
});

function fakeDatabase(statements: DbStatement[]): DatabaseClient {
  let index = 0;
  return {
    dialect: "sqlite",
    prepare: () => statements[index++] ?? fakeStatement(),
    exec: () => undefined,
    close: () => undefined,
    transaction: (_mode, callback) => callback(),
  };
}

function fakeStatement(overrides: FakeStatementOverrides = {}): DbStatement {
  return {
    run: overrides.run ?? (() => ({ changes: 1 })),
    get: <T = unknown>(...params: unknown[]) => (overrides.get?.(...params) as T | undefined) ?? undefined,
    all: <T = unknown>(...params: unknown[]) => (overrides.all?.(...params) ?? []) as T[],
  };
}
