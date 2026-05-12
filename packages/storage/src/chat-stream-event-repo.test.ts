import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatStreamEventRepository } from "./chat-stream-event-repo.js";

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

function createStore(): { db: DatabaseClient; repo: ChatStreamEventRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-stream-event-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatStreamEventRepository(db) };
}

function setRawField(db: DatabaseClient, eventId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE chat_stream_events SET ${field} = ? WHERE event_id = ?`).run(value, eventId);
}

describe("ChatStreamEventRepository", () => {
  it("appends, upserts, lists, fetches, and purges stream events", () => {
    const { repo } = createStore();
    const createdAtA = "2026-03-26T00:00:01.000Z";
    const createdAtB = "2026-03-26T00:00:02.000Z";
    const createdAtC = "2026-03-26T00:00:03.000Z";

    const first = repo.append({
      eventId: "event-a",
      sessionId: "session-a",
      turnId: "turn-a",
      sequence: 1,
      runId: "run-a",
      chunkType: "text_delta",
      payload: { text: "goat" },
      createdAt: createdAtA,
    });
    repo.append({
      eventId: "event-b",
      sessionId: "session-a",
      turnId: "turn-a",
      sequence: 2,
      chunkType: "tool_call",
      payload: { tool: "browser.search" },
      createdAt: createdAtB,
    });
    repo.append({
      eventId: "event-c",
      sessionId: "session-a",
      turnId: "turn-b",
      sequence: 1,
      chunkType: "done",
      payload: { ok: true },
      createdAt: createdAtC,
    });

    assert.equal(first.eventId, "event-a");
    assert.equal(first.runId, "run-a");
    assert.deepEqual(first.payload, { text: "goat" });
    assert.equal(repo.get("turn-a", 1)?.eventId, "event-a");
    assert.equal(repo.get("turn-a", 99), undefined);
    assert.equal(repo.getByEventId("missing"), undefined);
    assert.equal(repo.getLatestSequence("turn-a"), 2);
    assert.equal(repo.getLatestSequence("missing-turn"), 0);
    assert.deepEqual(
      repo.listByTurn("turn-a").map((event) => event.eventId),
      ["event-a", "event-b"],
    );
    assert.deepEqual(
      repo.listByTurn("turn-a", 1).map((event) => event.eventId),
      ["event-b"],
    );
    assert.deepEqual(
      repo.listByTurn("turn-a", 0, 0).map((event) => event.eventId),
      ["event-a"],
    );

    const updated = repo.append({
      eventId: "event-a",
      sessionId: "session-a",
      turnId: "turn-a",
      sequence: 3,
      chunkType: "replacement",
      payload: { text: "updated" },
      createdAt: "2026-03-26T00:00:04.000Z",
    });
    assert.equal(updated.sequence, 3);
    assert.equal(updated.runId, undefined);
    assert.deepEqual(updated.payload, { text: "updated" });
    assert.equal(repo.get("turn-a", 1), undefined);
    assert.equal(repo.getLatestSequence("turn-a"), 3);

    assert.equal(repo.purgeBefore(createdAtC), 1);
    assert.equal(repo.getByEventId("event-b"), undefined);
    assert.equal(repo.getByEventId("event-c")?.eventId, "event-c");
    assert.equal(repo.purgeBefore("2026-03-26T00:00:05.000Z"), 2);
    assert.deepEqual(repo.listByTurn("turn-a"), []);
  });

  it("drops malformed rows and coerces malformed payloads to empty records", () => {
    const { db, repo } = createStore();
    repo.append({
      eventId: "event-a",
      sessionId: "session-a",
      turnId: "turn-a",
      sequence: 1,
      chunkType: "text_delta",
      payload: { text: "goat" },
      createdAt: "2026-03-26T00:00:01.000Z",
    });
    repo.append({
      eventId: "event-b",
      sessionId: "session-a",
      turnId: "turn-a",
      sequence: 2,
      chunkType: "text_delta",
      payload: { text: "citadel" },
      createdAt: "2026-03-26T00:00:02.000Z",
    });

    setRawField(db, "event-a", "payload_json", "[]");
    assert.deepEqual(repo.getByEventId("event-a")?.payload, {});

    setRawField(db, "event-a", "payload_json", "{bad json");
    assert.deepEqual(repo.get("turn-a", 1)?.payload, {});

    setRawField(db, "event-a", "created_at", new Uint8Array([1]));
    assert.equal(repo.getByEventId("event-a"), undefined);
    assert.deepEqual(
      repo.listByTurn("turn-a").map((event) => event.eventId),
      ["event-b"],
    );

    setRawField(db, "event-b", "sequence", new Uint8Array([2]));
    assert.equal(repo.get("turn-a", 2), undefined);
    assert.deepEqual(repo.listByTurn("turn-a"), []);
    assert.equal(repo.getLatestSequence("turn-a"), 0);
  });
});
