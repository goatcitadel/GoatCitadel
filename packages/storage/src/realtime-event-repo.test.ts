import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { RealtimeEventRepository } from "./realtime-event-repo.js";
import { runWithRequestAttribution } from "./request-attribution.js";

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

function createRepo(): RealtimeEventRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-events-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new RealtimeEventRepository(db);
}

describe("RealtimeEventRepository", () => {
  it("stores and paginates realtime events", () => {
    const repo = createRepo();
    const first = repo.append("task_created", "tasks", { taskId: "t1" }, undefined, "2026-02-27T10:00:00.000Z");
    const second = repo.append("task_updated", "tasks", { taskId: "t1" }, undefined, "2026-02-27T11:00:00.000Z");

    const latest = repo.list(10);
    assert.equal(latest.length, 2);
    assert.equal(latest[0]?.eventId, second.eventId);
    assert.equal(typeof latest[0]?.sequence, "number");
    assert.equal((latest[0]?.sequence ?? 0) > (latest[1]?.sequence ?? 0), true);

    const paged = repo.list(10, String(second.sequence));
    assert.equal(paged.length, 1);
    assert.equal(paged[0]?.eventId, first.eventId);
  });

  it("does not drop events sharing the same timestamp across cursor pages", () => {
    const repo = createRepo();
    repo.append("task_created", "tasks", { taskId: "a" }, undefined, "2026-02-27T12:00:00.000Z");
    repo.append("task_updated", "tasks", { taskId: "b" }, undefined, "2026-02-27T12:00:00.000Z");
    repo.append("task_updated", "tasks", { taskId: "c" }, undefined, "2026-02-27T11:59:00.000Z");

    const firstPage = repo.list(1);
    const cursor = String(firstPage[0]!.sequence);
    const secondPage = repo.list(10, cursor);

    assert.equal(secondPage.length, 2);
    assert.equal(secondPage.some((event) => event.eventId === firstPage[0]?.eventId), false);
  });

  it("replays events after a sequence cursor in ascending order", () => {
    const repo = createRepo();
    const first = repo.append("task_created", "tasks", { taskId: "a" }, undefined, "2026-02-27T10:00:00.000Z");
    const second = repo.append("task_updated", "tasks", { taskId: "b" }, undefined, "2026-02-27T11:00:00.000Z");
    const third = repo.append("task_updated", "tasks", { taskId: "c" }, undefined, "2026-02-27T12:00:00.000Z");

    const replay = repo.listAfterSequence(first.sequence, 10);
    assert.deepEqual(
      replay.map((event) => event.eventId),
      [second.eventId, third.eventId],
    );
  });

  it("inherits request attribution into stored event metadata", () => {
    const repo = createRepo();
    const event = runWithRequestAttribution({
      correlationId: "corr-123",
      traceId: "trace-456",
      originSurface: "mission-control-web",
      actorId: "device:grant-1",
      deviceId: "grant-1",
      grantId: "grant-1",
    }, () => repo.append("task_updated", "tasks", { taskId: "a" }, undefined, "2026-02-27T12:30:00.000Z"));

    assert.equal(event.correlationId, "corr-123");
    assert.equal(event.traceId, "trace-456");
    assert.equal(event.originSurface, "mission-control-web");
    assert.equal(event.payload.actorId, "device:grant-1");
    assert.equal(event.payload.deviceId, "grant-1");
    assert.equal(event.payload.grantId, "grant-1");
  });

  it("round-trips top-level event metadata without leaking the storage envelope", () => {
    const repo = createRepo();
    const event = repo.append(
      "approval_created",
      "gateway",
      { summary: "Needs review" },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: {
          approvalId: "approval-1",
          sessionId: "session-1",
          runId: "run-1",
        },
      },
      "2026-02-27T13:00:00.000Z",
    );

    assert.equal(event.eventClass, "domain_fact");
    assert.equal(event.eventAuthority, "retained_stream");
    assert.deepEqual(event.links, {
      approvalId: "approval-1",
      sessionId: "session-1",
      runId: "run-1",
    });
    assert.equal(event.payload.summary, "Needs review");
    assert.equal("__gcEventClass" in event.payload, false);
    assert.equal("__gcEventAuthority" in event.payload, false);
    assert.equal("__gcEventLinks" in event.payload, false);

    const stored = repo.list(1)[0];
    assert.equal(stored?.eventId, event.eventId);
    assert.equal(stored?.eventClass, "domain_fact");
    assert.equal(stored?.eventAuthority, "retained_stream");
    assert.deepEqual(stored?.links, {
      approvalId: "approval-1",
      sessionId: "session-1",
      runId: "run-1",
    });
    assert.equal(stored?.payload.summary, "Needs review");
    assert.equal(stored?.payload.__gcEventClass, undefined);
    assert.equal(stored?.payload.__gcEventAuthority, undefined);
    assert.equal(stored?.payload.__gcEventLinks, undefined);
  });

  it("infers retained stream metadata and links when publishers omit options", () => {
    const repo = createRepo();
    const event = repo.append(
      "approval_created",
      "approvals",
      {
        approvalId: "approval-9",
        sessionId: "session-9",
        taskId: "task-9",
        durableRunId: "run-9",
      },
      undefined,
      "2026-02-27T14:00:00.000Z",
    );

    assert.equal(event.eventClass, "domain_fact");
    assert.equal(event.eventAuthority, "retained_stream");
    assert.deepEqual(event.links, {
      approvalId: "approval-9",
      sessionId: "session-9",
      runId: "run-9",
      taskId: "task-9",
    });
  });

  it("prunes only overflow rows and keeps the newest events intact", () => {
    const repo = createRepo();
    const first = repo.append("task_created", "tasks", { taskId: "a" }, undefined, "2026-02-27T10:00:00.000Z");
    const second = repo.append("task_updated", "tasks", { taskId: "b" }, undefined, "2026-02-27T11:00:00.000Z");
    const third = repo.append("task_updated", "tasks", { taskId: "c" }, undefined, "2026-02-27T12:00:00.000Z");
    const fourth = repo.append("task_updated", "tasks", { taskId: "d" }, undefined, "2026-02-27T13:00:00.000Z");

    const pruned = repo.pruneToMaxRows(2);

    assert.equal(pruned, 2);
    assert.deepEqual(
      repo.list(10).map((event) => event.eventId),
      [fourth.eventId, third.eventId],
    );
    assert.equal(repo.list(10).some((event) => event.eventId === second.eventId), false);
    assert.equal(repo.list(10).some((event) => event.eventId === first.eventId), false);
  });

  it("does not prune when the table is already at the threshold", () => {
    const repo = createRepo();
    const first = repo.append("task_created", "tasks", { taskId: "a" }, undefined, "2026-02-27T10:00:00.000Z");
    const second = repo.append("task_updated", "tasks", { taskId: "b" }, undefined, "2026-02-27T11:00:00.000Z");

    const pruned = repo.pruneToMaxRows(2);

    assert.equal(pruned, 0);
    assert.deepEqual(
      repo.list(10).map((event) => event.eventId),
      [second.eventId, first.eventId],
    );
  });

  it("does not prune when the table is smaller than the threshold", () => {
    const repo = createRepo();
    const first = repo.append("task_created", "tasks", { taskId: "a" }, undefined, "2026-02-27T10:00:00.000Z");

    const pruned = repo.pruneToMaxRows(5);

    assert.equal(pruned, 0);
    assert.deepEqual(repo.list(10).map((event) => event.eventId), [first.eventId]);
  });

  it("supports maxRows=1 without negative-limit SQL behavior", () => {
    const repo = createRepo();
    const first = repo.append("task_created", "tasks", { taskId: "a" }, undefined, "2026-02-27T10:00:00.000Z");
    const second = repo.append("task_updated", "tasks", { taskId: "b" }, undefined, "2026-02-27T11:00:00.000Z");
    const third = repo.append("task_updated", "tasks", { taskId: "c" }, undefined, "2026-02-27T12:00:00.000Z");

    const pruned = repo.pruneToMaxRows(1);

    assert.equal(pruned, 2);
    assert.deepEqual(repo.list(10).map((event) => event.eventId), [third.eventId]);
    assert.equal(repo.list(10).some((event) => event.eventId === second.eventId), false);
    assert.equal(repo.list(10).some((event) => event.eventId === first.eventId), false);
  });
});
