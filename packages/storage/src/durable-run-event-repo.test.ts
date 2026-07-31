import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { DurableRunEventRepository } from "./durable-run-event-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";

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

function createRepos(): {
  db: ReturnType<typeof createDatabase>;
  events: DurableRunEventRepository;
  runs: DurableRunRepository;
} {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-durable-events-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    db,
    events: new DurableRunEventRepository(db),
    runs: new DurableRunRepository(db),
  };
}

describe("DurableRunEventRepository", () => {
  it("appends timeline events and maps null step keys plus malformed payloads safely", () => {
    const { db, events, runs } = createRepos();
    runs.createRun({
      runId: "run-1",
      workflowKey: "chat.turn.execute",
      now: "2026-05-12T00:00:00.000Z",
    });

    const appended = events.append({
      eventId: "event-1",
      runId: "run-1",
      eventType: "run_started",
      stepKey: "provider-call",
      payload: { providerId: "openai" },
      createdAt: "2026-05-12T00:00:01.000Z",
    });
    assert.equal(appended.stepKey, "provider-call");

    events.append({
      eventId: "event-2",
      runId: "run-1",
      eventType: "run_waiting",
      createdAt: "2026-05-12T00:00:02.000Z",
    });
    db.prepare("UPDATE durable_run_events SET payload_json = ? WHERE event_id = ?").run("{bad-json", "event-2");

    const listed = events.listByRun("run-1", 10);
    assert.deepEqual(
      listed.map((event) => event.eventId),
      ["event-1", "event-2"],
    );
    assert.deepEqual(
      listed.map((event) => event.sequence),
      [1, 2],
    );
    assert.deepEqual(listed[0]?.payload, { providerId: "openai" });
    assert.equal(listed[1]?.stepKey, undefined);
    assert.deepEqual(listed[1]?.payload, {});

    assert.deepEqual(
      events.listByRun("run-1", 0).map((event) => event.eventId),
      ["event-1"],
    );
  });

  it("orders colliding timestamps by the per-run monotonic sequence", () => {
    const { events, runs } = createRepos();
    runs.createRun({
      runId: "run-colliding-time",
      workflowKey: "chat.turn.execute",
      now: "2026-05-12T00:00:00.000Z",
    });
    for (const eventId of ["event-z", "event-a", "event-m"]) {
      events.append({
        eventId,
        runId: "run-colliding-time",
        eventType: "run_started",
        createdAt: "2026-05-12T00:00:01.000Z",
      });
    }

    assert.deepEqual(
      events.listByRun("run-colliding-time").map((event) => [event.eventId, event.sequence]),
      [
        ["event-z", 1],
        ["event-a", 2],
        ["event-m", 3],
      ],
    );
    assert.deepEqual(
      events.listAfterSequence("run-colliding-time", 1).map((event) => event.eventId),
      ["event-a", "event-m"],
    );
  });

  it("rejects a duplicate append without consuming the next per-run sequence", () => {
    const { events, runs } = createRepos();
    runs.createRun({
      runId: "run-duplicate",
      workflowKey: "chat.turn.execute",
      now: "2026-05-12T00:00:00.000Z",
    });
    const first = {
      eventId: "event-stable",
      runId: "run-duplicate",
      eventType: "run_started" as const,
      createdAt: "2026-05-12T00:00:01.000Z",
    };
    events.append(first);

    assert.throws(() => events.append(first), /UNIQUE constraint failed/);
    events.append({
      ...first,
      eventId: "event-after-rejected-duplicate",
    });

    assert.deepEqual(
      events.listByRun("run-duplicate").map((event) => [event.eventId, event.sequence]),
      [
        ["event-stable", 1],
        ["event-after-rejected-duplicate", 2],
      ],
    );
  });

  it("heals a legacy sequence ledger behind persisted events before allocating", () => {
    const { db, events, runs } = createRepos();
    runs.createRun({
      runId: "run-stale-ledger",
      workflowKey: "chat.turn.execute",
      now: "2026-07-30T00:00:00.000Z",
    });
    events.append({
      eventId: "event-ledger-one",
      runId: "run-stale-ledger",
      eventType: "run_waiting",
      createdAt: "2026-07-30T00:00:01.000Z",
    });
    db.prepare(
      `INSERT INTO durable_run_events (
         event_id, run_id, sequence, event_type, step_key, payload_json, created_at
       ) VALUES (?, ?, 2, 'run_woken', NULL, '{}', ?)`,
    ).run("event-direct-two", "run-stale-ledger", "2026-07-30T00:00:02.000Z");

    const healed = events.append({
      eventId: "event-healed-three",
      runId: "run-stale-ledger",
      eventType: "run_started",
      createdAt: "2026-07-30T00:00:03.000Z",
    });

    assert.equal(healed.sequence, 3);
    assert.equal(
      db
        .prepare("SELECT last_sequence FROM durable_run_event_sequences WHERE run_id = ?")
        .get<{ last_sequence: number }>("run-stale-ledger")?.last_sequence,
      3,
    );
    assert.deepEqual(
      events.listByRun("run-stale-ledger").map((event) => event.sequence),
      [1, 2, 3],
    );
  });
});
