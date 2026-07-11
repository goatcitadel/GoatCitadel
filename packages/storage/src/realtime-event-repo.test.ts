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

function taskEventOptions(taskId: string) {
  return {
    eventClass: "domain_fact" as const,
    eventAuthority: "retained_stream" as const,
    links: { taskId },
  };
}

describe("RealtimeEventRepository", () => {
  it("stores and paginates realtime events", () => {
    const repo = createRepo();
    const first = repo.append(
      "task_created",
      "tasks",
      { taskId: "t1" },
      taskEventOptions("t1"),
      "2026-02-27T10:00:00.000Z",
    );
    const second = repo.append(
      "task_updated",
      "tasks",
      { taskId: "t1" },
      taskEventOptions("t1"),
      "2026-02-27T11:00:00.000Z",
    );

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
    repo.append("task_created", "tasks", { taskId: "a" }, taskEventOptions("a"), "2026-02-27T12:00:00.000Z");
    repo.append("task_updated", "tasks", { taskId: "b" }, taskEventOptions("b"), "2026-02-27T12:00:00.000Z");
    repo.append("task_updated", "tasks", { taskId: "c" }, taskEventOptions("c"), "2026-02-27T11:59:00.000Z");

    const firstPage = repo.list(1);
    const cursor = String(firstPage[0]!.sequence);
    const secondPage = repo.list(10, cursor);

    assert.equal(secondPage.length, 2);
    assert.equal(
      secondPage.some((event) => event.eventId === firstPage[0]?.eventId),
      false,
    );
  });

  it("replays events after a sequence cursor in ascending order", () => {
    const repo = createRepo();
    const first = repo.append(
      "task_created",
      "tasks",
      { taskId: "a" },
      taskEventOptions("a"),
      "2026-02-27T10:00:00.000Z",
    );
    const second = repo.append(
      "task_updated",
      "tasks",
      { taskId: "b" },
      taskEventOptions("b"),
      "2026-02-27T11:00:00.000Z",
    );
    const third = repo.append(
      "task_updated",
      "tasks",
      { taskId: "c" },
      taskEventOptions("c"),
      "2026-02-27T12:00:00.000Z",
    );

    const replay = repo.listAfterSequence(first.sequence, 10);
    assert.deepEqual(
      replay.map((event) => event.eventId),
      [second.eventId, third.eventId],
    );
  });

  it("inherits request attribution into stored event metadata", () => {
    const repo = createRepo();
    const event = runWithRequestAttribution(
      {
        correlationId: "corr-123",
        traceId: "trace-456",
        originSurface: "mission-control-web",
        actorId: "device:grant-1",
        deviceId: "grant-1",
        grantId: "grant-1",
      },
      () => repo.append("task_updated", "tasks", { taskId: "a" }, taskEventOptions("a"), "2026-02-27T12:30:00.000Z"),
    );

    assert.equal(event.correlationId, "corr-123");
    assert.equal(event.traceId, "trace-456");
    assert.equal(event.originSurface, "mission-control-web");
    assert.equal(event.payload.actorId, "device:grant-1");
    assert.equal(event.payload.deviceId, "grant-1");
    assert.equal(event.payload.grantId, "grant-1");
  });

  it("persists a delivery id once and keeps captured attribution across retries", () => {
    const repo = createRepo();
    const input = {
      deliveryId: "approval-observability:approval-1:resolve-realtime",
      occurredAt: "2026-07-10T12:00:00.000Z",
      attribution: {
        correlationId: "corr-original",
        traceId: "trace-original",
        actorId: "operator-original",
      },
    };
    const first = runWithRequestAttribution({ actorId: "wrong-first-context" }, () =>
      repo.appendIdempotent(
        "approval_resolved",
        "approvals",
        { approvalId: "approval-1" },
        {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: { approvalId: "approval-1" },
        },
        input,
      ),
    );
    const retry = runWithRequestAttribution({ actorId: "wrong-retry-context" }, () =>
      repo.appendIdempotent(
        "approval_resolved",
        "approvals",
        { approvalId: "approval-1" },
        {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: { approvalId: "approval-1" },
        },
        input,
      ),
    );

    assert.equal(first.inserted, true);
    assert.equal(retry.inserted, false);
    assert.equal(retry.event.eventId, first.event.eventId);
    assert.equal(repo.list(10).length, 1);
    assert.equal(first.event.timestamp, input.occurredAt);
    assert.equal(first.event.correlationId, "corr-original");
    assert.equal(first.event.traceId, "trace-original");
    assert.equal(first.event.payload.actorId, "operator-original");
    assert.equal(first.event.payload.deliveryId, input.deliveryId);
  });

  it("does not derive idempotent delivery attribution from changing ambient request context", () => {
    const repo = createRepo();
    const input = {
      deliveryId: "approval-observability:approval-1:resolve-realtime-no-attribution",
      occurredAt: "2026-07-10T12:00:00.000Z",
    };
    const first = runWithRequestAttribution({ actorId: "ambient-first" }, () =>
      repo.appendIdempotent(
        "approval_resolved",
        "approvals",
        { approvalId: "approval-1" },
        {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: { approvalId: "approval-1" },
        },
        input,
      ),
    );
    const retry = runWithRequestAttribution({ actorId: "ambient-retry" }, () =>
      repo.appendIdempotent(
        "approval_resolved",
        "approvals",
        { approvalId: "approval-1" },
        {
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: { approvalId: "approval-1" },
        },
        input,
      ),
    );

    assert.equal(first.inserted, true);
    assert.equal(retry.inserted, false);
    assert.equal(first.event.payload.actorId, undefined);
    assert.equal(retry.event.payload.actorId, undefined);
  });

  it("rejects delivery-id reuse with a different realtime payload", () => {
    const repo = createRepo();
    const input = {
      deliveryId: "approval-observability:approval-1:create-realtime",
      occurredAt: "2026-07-10T12:00:00.000Z",
    };
    repo.appendIdempotent(
      "approval_created",
      "approvals",
      { approvalId: "approval-1" },
      {
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        links: { approvalId: "approval-1" },
      },
      input,
    );

    assert.throws(
      () =>
        repo.appendIdempotent(
          "approval_created",
          "approvals",
          { approvalId: "approval-2" },
          {
            eventClass: "domain_fact",
            eventAuthority: "retained_stream",
            links: { approvalId: "approval-1" },
          },
          input,
        ),
      /reused with a different payload/i,
    );
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

  it("rejects protected events when publishers omit explicit metadata", () => {
    const repo = createRepo();
    assert.throws(
      () =>
        repo.append(
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
        ),
      /Explicit realtime metadata is required/,
    );
  });

  it("prunes only overflow rows and keeps the newest events intact", () => {
    const repo = createRepo();
    const first = repo.append(
      "task_created",
      "tasks",
      { taskId: "a" },
      taskEventOptions("a"),
      "2026-02-27T10:00:00.000Z",
    );
    const second = repo.append(
      "task_updated",
      "tasks",
      { taskId: "b" },
      taskEventOptions("b"),
      "2026-02-27T11:00:00.000Z",
    );
    const third = repo.append(
      "task_updated",
      "tasks",
      { taskId: "c" },
      taskEventOptions("c"),
      "2026-02-27T12:00:00.000Z",
    );
    const fourth = repo.append(
      "task_updated",
      "tasks",
      { taskId: "d" },
      taskEventOptions("d"),
      "2026-02-27T13:00:00.000Z",
    );

    const pruned = repo.pruneToMaxRows(2);

    assert.equal(pruned, 2);
    assert.deepEqual(
      repo.list(10).map((event) => event.eventId),
      [fourth.eventId, third.eventId],
    );
    assert.equal(
      repo.list(10).some((event) => event.eventId === second.eventId),
      false,
    );
    assert.equal(
      repo.list(10).some((event) => event.eventId === first.eventId),
      false,
    );
  });

  it("does not prune when the table is already at the threshold", () => {
    const repo = createRepo();
    const first = repo.append(
      "task_created",
      "tasks",
      { taskId: "a" },
      taskEventOptions("a"),
      "2026-02-27T10:00:00.000Z",
    );
    const second = repo.append(
      "task_updated",
      "tasks",
      { taskId: "b" },
      taskEventOptions("b"),
      "2026-02-27T11:00:00.000Z",
    );

    const pruned = repo.pruneToMaxRows(2);

    assert.equal(pruned, 0);
    assert.deepEqual(
      repo.list(10).map((event) => event.eventId),
      [second.eventId, first.eventId],
    );
  });

  it("does not prune when the table is smaller than the threshold", () => {
    const repo = createRepo();
    const first = repo.append(
      "task_created",
      "tasks",
      { taskId: "a" },
      taskEventOptions("a"),
      "2026-02-27T10:00:00.000Z",
    );

    const pruned = repo.pruneToMaxRows(5);

    assert.equal(pruned, 0);
    assert.deepEqual(
      repo.list(10).map((event) => event.eventId),
      [first.eventId],
    );
  });

  it("supports maxRows=1 without negative-limit SQL behavior", () => {
    const repo = createRepo();
    const first = repo.append(
      "task_created",
      "tasks",
      { taskId: "a" },
      taskEventOptions("a"),
      "2026-02-27T10:00:00.000Z",
    );
    const second = repo.append(
      "task_updated",
      "tasks",
      { taskId: "b" },
      taskEventOptions("b"),
      "2026-02-27T11:00:00.000Z",
    );
    const third = repo.append(
      "task_updated",
      "tasks",
      { taskId: "c" },
      taskEventOptions("c"),
      "2026-02-27T12:00:00.000Z",
    );

    const pruned = repo.pruneToMaxRows(1);

    assert.equal(pruned, 2);
    assert.deepEqual(
      repo.list(10).map((event) => event.eventId),
      [third.eventId],
    );
    assert.equal(
      repo.list(10).some((event) => event.eventId === second.eventId),
      false,
    );
    assert.equal(
      repo.list(10).some((event) => event.eventId === first.eventId),
      false,
    );
  });

  it("covers inferred metadata, sequence bounds, older pruning, and maintenance pruning", () => {
    const repo = createRepo();
    const notification = repo.append(
      "approval_remote_action_ready",
      "gateway",
      {
        approvalId: "approval-1",
        nested: {
          durableRunId: "run-1",
          task: { taskId: "task-1" },
        },
        tokenId: "token-1",
        messageId: "message-1",
        blank: "   ",
      },
      undefined,
      "2026-02-27T09:00:00.000Z",
    );
    assert.equal(notification.eventClass, "ui_notification");
    assert.equal(notification.eventAuthority, "retained_stream");
    assert.deepEqual(notification.links, {
      approvalId: "approval-1",
      runId: "run-1",
      taskId: "task-1",
      tokenId: "token-1",
      messageId: "message-1",
    });

    const projection = repo.append(
      "chat_summary_projection",
      "summary",
      {
        session: {
          sessionId: "session-1",
        },
      },
      undefined,
      "2026-02-27T09:01:00.000Z",
    );
    assert.equal(projection.eventClass, "domain_fact");
    assert.equal(projection.eventAuthority, "derived_projection");
    assert.deepEqual(projection.links, { sessionId: "session-1" });

    const operational = repo.append(
      "connector_sync_completed",
      "integrations",
      { connectorId: "connector-1", workspaceId: "workspace-1" },
      undefined,
      "2026-02-27T09:02:00.000Z",
    );
    assert.equal(operational.eventClass, "operational_signal");
    assert.deepEqual(operational.links, { workspaceId: "workspace-1", connectorId: "connector-1" });

    assert.deepEqual(repo.getSequenceBounds(), {
      oldestSequence: notification.sequence,
      newestSequence: operational.sequence,
    });
    assert.deepEqual(
      repo.list(10, `${operational.timestamp}|${operational.eventId}`).map((event) => event.eventId),
      [projection.eventId, notification.eventId],
    );
    assert.equal(repo.list(10, `${operational.timestamp}|`).length, 3);
    assert.equal(repo.list(10, "not-a-composite-cursor").length, 3);
    assert.deepEqual(repo.list(10, "0"), []);
    assert.deepEqual(repo.listAfterSequence(operational.sequence, 10), []);
    assert.equal(repo.pruneOlderThan("2026-02-27T08:00:00.000Z"), 0);
    assert.equal(repo.pruneOlderThan("2026-02-27T09:01:30.000Z"), 2);
    assert.deepEqual(
      repo.list(10).map((event) => event.eventId),
      [operational.eventId],
    );

    for (let index = 0; index < 99; index += 1) {
      repo.append(
        "memory_maintenance_tick",
        "memory",
        { runId: `maintenance-${index}` },
        undefined,
        `2026-02-27T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
      );
    }
    assert.equal(repo.list(200).length, 100);
  });

  it("defensively filters malformed adapter rows and stored realtime envelopes", () => {
    const repo = createRepo();
    const internal = repo as unknown as {
      allocateSequenceStmt: { get: (...args: unknown[]) => unknown };
      listLatestStmt: { all: (...args: unknown[]) => unknown };
      boundsStmt: { get: (...args: unknown[]) => unknown };
      countStmt: { get: (...args: unknown[]) => unknown };
    };

    internal.allocateSequenceStmt = { get: () => null };
    const first = repo.append(
      "connector_sync_completed",
      "integrations",
      { connectorId: "connector-1" },
      undefined,
      "2026-02-28T00:00:00.000Z",
    );
    assert.equal(first.sequence, 1);

    internal.listLatestStmt = {
      all: () => [
        null,
        {
          event_id: "event-invalid-envelope",
          sequence: 10,
          event_type: "custom",
          source: "test",
          payload_json: JSON.stringify({
            __gcEventClass: "unknown",
            __gcEventAuthority: "unknown",
            __gcEventLinks: ["bad"],
            keep: true,
          }),
          created_at: "2026-02-28T00:00:01.000Z",
        },
      ],
    };
    const listed = repo.list(10);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.eventClass, undefined);
    assert.equal(listed[0]?.eventAuthority, undefined);
    assert.equal(listed[0]?.links, undefined);
    assert.deepEqual(listed[0]?.payload, { keep: true });

    internal.boundsStmt = { get: () => undefined };
    assert.deepEqual(repo.getSequenceBounds(), { oldestSequence: undefined, newestSequence: undefined });

    internal.countStmt = { get: () => ({ count: "bad" }) };
    assert.equal(repo.pruneToMaxRows(10), 0);
  });
});
