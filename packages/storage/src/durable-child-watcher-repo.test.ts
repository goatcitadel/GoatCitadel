import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DURABLE_CHILD_PAYLOAD_PROJECTION_LIMITS,
  DurableChildWatcherRepository,
} from "./durable-child-watcher-repo.js";
import { DURABLE_CHILD_WATCHER_LIMITS, type DurableChildStateChangedPayload } from "@goatcitadel/contracts";
import { DurableRunEventRepository } from "./durable-run-event-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { createDatabase, __sqliteInternals } from "./sqlite.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Ignore cleanup failures on Windows after a failed test.
    }
  }
});

function createRepos(dbPath = createDbPath()) {
  const db = createDatabase({ dbPath });
  const runs = new DurableRunRepository(db);
  return {
    dbPath,
    db,
    runs,
    events: new DurableRunEventRepository(db),
    watchers: new DurableChildWatcherRepository(db),
  };
}

function createDbPath(): string {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-child-watchers-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return dbPath;
}

function seedRun(runs: DurableRunRepository, runId: string): void {
  runs.createRun({
    runId,
    workflowKey: "chat.turn.execute",
    now: "2026-07-13T00:00:00.000Z",
  });
}

function appendChildEvent(
  events: DurableRunEventRepository,
  input: {
    eventId: string;
    eventType: Parameters<DurableRunEventRepository["append"]>[0]["eventType"];
    createdAt?: string;
  },
): void {
  events.append({
    eventId: input.eventId,
    runId: "child-run",
    eventType: input.eventType,
    payload: { marker: input.eventId },
    createdAt: input.createdAt ?? "2026-07-13T00:00:01.000Z",
  });
}

describe("DurableChildWatcherRepository", () => {
  it("projects historical child transitions exactly once in sequence order", () => {
    const { runs, events, watchers } = createRepos();
    seedRun(runs, "parent-run");
    seedRun(runs, "child-run");
    appendChildEvent(events, { eventId: "child-started", eventType: "run_started" });
    appendChildEvent(events, { eventId: "child-waiting", eventType: "run_waiting" });

    const watcher = watchers.create({
      watcherId: "watcher-1",
      parentRunId: "parent-run",
      childRunId: "child-run",
      source: "chat_delegation",
      metadata: { stepId: "step-1" },
      createdAt: "2026-07-13T00:00:02.000Z",
    });
    assert.equal(watcher.nextSequence, 1);
    const duplicateAttach = watchers.create({
      watcherId: "watcher-duplicate-request",
      parentRunId: "parent-run",
      childRunId: "child-run",
    });
    assert.equal(duplicateAttach.watcherId, "watcher-1");

    const first = watchers.catchUpWatcher("watcher-1", 10);
    assert.equal(first.consumedCount, 2);
    assert.equal(first.projectedCount, 2);
    assert.equal(first.watcher.lastConsumedSequence, 2);
    assert.equal(first.watcher.nextSequence, 3);
    assert.equal(first.watcher.projectedNoticeCount, 2);
    assert.deepEqual(
      first.notices.map((notice) => [notice.sequence, notice.eventType, notice.payload?.childSequence]),
      [
        [1, "child_state_changed", 1],
        [2, "child_state_changed", 2],
      ],
    );

    const duplicate = watchers.catchUpWatcher("watcher-1", 10);
    assert.equal(duplicate.consumedCount, 0);
    assert.equal(duplicate.projectedCount, 0);
    assert.deepEqual(
      events.listByRun("parent-run").map((event) => event.payload?.childEventId),
      ["child-started", "child-waiting"],
    );
  });

  it("preserves its watermark while detached and catches up after reattach", () => {
    const { runs, events, watchers } = createRepos();
    seedRun(runs, "parent-run");
    seedRun(runs, "child-run");
    appendChildEvent(events, { eventId: "child-started", eventType: "run_started" });
    watchers.create({ watcherId: "watcher-detach", parentRunId: "parent-run", childRunId: "child-run" });
    watchers.catchUpWatcher("watcher-detach");

    const detached = watchers.detach("watcher-detach", "2026-07-13T00:00:03.000Z");
    assert.equal(detached.state, "detached");
    appendChildEvent(events, { eventId: "child-waiting", eventType: "run_waiting" });
    appendChildEvent(events, { eventId: "child-completed", eventType: "run_completed" });
    const whileDetached = watchers.catchUpWatcher("watcher-detach");
    assert.equal(whileDetached.consumedCount, 0);
    assert.equal(whileDetached.watcher.lastConsumedSequence, 1);
    assert.equal(events.listByRun("parent-run").length, 1);

    watchers.reattach("watcher-detach", "2026-07-13T00:00:04.000Z");
    const caughtUp = watchers.catchUpWatcher("watcher-detach");
    assert.deepEqual(
      caughtUp.notices.map((notice) => notice.payload?.childEventType),
      ["run_waiting", "run_completed"],
    );
    assert.equal(caughtUp.watcher.lastConsumedSequence, 3);
    assert.equal(caughtUp.watcher.detachedAt, "2026-07-13T00:00:03.000Z");
    assert.equal(caughtUp.watcher.reattachedAt, "2026-07-13T00:00:04.000Z");
  });

  it("bounds catch-up, consumes non-transition events, and resumes without skips", () => {
    const { runs, events, watchers } = createRepos();
    seedRun(runs, "parent-run");
    seedRun(runs, "child-run");
    appendChildEvent(events, { eventId: "lag", eventType: "worker_event_loop_lag" });
    appendChildEvent(events, { eventId: "started", eventType: "run_started" });
    appendChildEvent(events, { eventId: "waiting", eventType: "run_waiting" });
    watchers.create({ watcherId: "watcher-bounded", parentRunId: "parent-run", childRunId: "child-run" });

    const first = watchers.catchUpWatcher("watcher-bounded", 2);
    assert.equal(first.consumedCount, 2);
    assert.equal(first.projectedCount, 1);
    assert.equal(first.hasMore, true);
    assert.equal(first.watcher.lastConsumedSequence, 2);

    const second = watchers.catchUpWatcher("watcher-bounded", 2);
    assert.equal(second.consumedCount, 1);
    assert.equal(second.projectedCount, 1);
    assert.equal(second.hasMore, false);
    assert.deepEqual(
      events.listByRun("parent-run").map((event) => event.payload?.childEventId),
      ["started", "waiting"],
    );
  });

  it("rolls back the parent notice when watermark persistence faults", () => {
    const { db, runs, events, watchers } = createRepos();
    seedRun(runs, "parent-run");
    seedRun(runs, "child-run");
    appendChildEvent(events, { eventId: "child-started", eventType: "run_started" });
    watchers.create({ watcherId: "watcher-fault", parentRunId: "parent-run", childRunId: "child-run" });
    db.exec(`
      CREATE TRIGGER fail_child_watcher_advance
      BEFORE UPDATE OF last_consumed_sequence ON durable_child_watchers
      BEGIN
        SELECT RAISE(ABORT, 'simulated watcher fault');
      END;
    `);

    assert.throws(() => watchers.catchUpWatcher("watcher-fault"), /simulated watcher fault/);
    assert.equal(watchers.get("watcher-fault").lastConsumedSequence, 0);
    assert.deepEqual(events.listByRun("parent-run"), []);

    db.exec("DROP TRIGGER fail_child_watcher_advance");
    const retried = watchers.catchUpWatcher("watcher-fault");
    assert.equal(retried.projectedCount, 1);
    assert.equal(events.listByRun("parent-run").length, 1);
  });

  it("coalesces competing reconcilers onto one notice and one watermark advance", async () => {
    const { db, runs, events, watchers } = createRepos();
    seedRun(runs, "parent-run");
    seedRun(runs, "child-run");
    appendChildEvent(events, { eventId: "child-started", eventType: "run_started" });
    watchers.create({ watcherId: "watcher-race", parentRunId: "parent-run", childRunId: "child-run" });
    const competing = new DurableChildWatcherRepository(db);

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => watchers.catchUpWatcher("watcher-race")),
      Promise.resolve().then(() => competing.catchUpWatcher("watcher-race")),
    ]);

    expectOneProjection(first.projectedCount, second.projectedCount);
    assert.equal(events.listByRun("parent-run").length, 1);
    assert.equal(watchers.get("watcher-race").lastConsumedSequence, 1);
  });

  it("rejects watcher cycles after locking the endpoint runs in stable order", () => {
    const { runs, watchers } = createRepos();
    for (const runId of ["run-a", "run-b", "run-c"]) {
      seedRun(runs, runId);
    }
    watchers.create({ watcherId: "watch-a-b", parentRunId: "run-a", childRunId: "run-b" });
    watchers.create({ watcherId: "watch-b-c", parentRunId: "run-b", childRunId: "run-c" });

    assert.throws(
      () => watchers.create({ watcherId: "watch-c-a", parentRunId: "run-c", childRunId: "run-a" }),
      /would create a run cycle/,
    );
  });

  it("cannot confuse a reused watcher id with a different parent-child pair", () => {
    const { runs, watchers } = createRepos();
    for (const runId of ["parent-a", "child-a", "parent-b", "child-b"]) {
      seedRun(runs, runId);
    }
    watchers.create({ watcherId: "stable-watcher", parentRunId: "parent-a", childRunId: "child-a" });

    assert.throws(
      () => watchers.create({ watcherId: "stable-watcher", parentRunId: "parent-b", childRunId: "child-b" }),
      /UNIQUE constraint failed|duplicate key/i,
    );
    assert.equal(watchers.get("stable-watcher").parentRunId, "parent-a");
    assert.equal(watchers.getByPair("parent-b", "child-b"), undefined);
  });

  it("fails watcher metadata and identifier bounds before persistence or lookup SQL", () => {
    const { db, runs, watchers } = createRepos();
    seedRun(runs, "parent-run");
    seedRun(runs, "child-run");

    assert.throws(
      () =>
        watchers.create({
          watcherId: "watcher-large-metadata",
          parentRunId: "parent-run",
          childRunId: "child-run",
          metadata: { value: "x".repeat(DURABLE_CHILD_WATCHER_LIMITS.metadataBytes + 1) },
        }),
      /metadata exceeds .* bytes/,
    );
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth <= DURABLE_CHILD_WATCHER_LIMITS.metadataMaxDepth; depth += 1) {
      deep = { nested: deep };
    }
    assert.throws(
      () =>
        watchers.create({
          watcherId: "watcher-deep-metadata",
          parentRunId: "parent-run",
          childRunId: "child-run",
          metadata: deep,
        }),
      /metadata exceeds depth/,
    );
    assert.throws(
      () =>
        watchers.create({
          watcherId: "watcher-many-items",
          parentRunId: "parent-run",
          childRunId: "child-run",
          metadata: { values: Array.from({ length: DURABLE_CHILD_WATCHER_LIMITS.metadataMaxItems + 1 }, () => 1) },
        }),
      /metadata exceeds .* keys\/items/,
    );
    const secretKey = "sk-secret-key-1234567890abcdef1234567890";
    assert.throws(
      () =>
        watchers.create({
          watcherId: "watcher-key-channel",
          parentRunId: "parent-run",
          childRunId: "child-run",
          metadata: { [secretKey]: "safe" },
        }),
      /metadata keys must not contain secret material/,
    );
    assert.throws(
      () =>
        watchers.create({
          watcherId: secretKey,
          parentRunId: "parent-run",
          childRunId: "child-run",
        }),
      /watcherId must not contain secret material/,
    );
    assert.throws(
      () =>
        watchers.create({
          watcherId: "watcher-source-channel",
          parentRunId: "parent-run",
          childRunId: "child-run",
          source: secretKey,
        }),
      /source must not contain secret material/,
    );
    assert.throws(() => watchers.get("w".repeat(DURABLE_CHILD_WATCHER_LIMITS.watcherIdBytes + 1)), /watcherId exceeds/);
    assert.equal(watchers.getByPair("parent-run", "child-run"), undefined);
    const persistedSecretKey = db
      .prepare("SELECT metadata_json FROM durable_child_watchers WHERE watcher_id = ?")
      .get<{ metadata_json: string }>("watcher-key-channel");
    assert.equal(persistedSecretKey, undefined);
    const persistedSecretIdentifiers = db
      .prepare("SELECT watcher_id, source FROM durable_child_watchers WHERE watcher_id = ? OR source = ?")
      .all(secretKey, secretKey);
    assert.deepEqual(persistedSecretIdentifiers, []);
  });

  it("redacts safe child payload projections and records a deterministic exact-byte hash", () => {
    const { runs, events, watchers } = createRepos();
    seedRun(runs, "parent-run");
    seedRun(runs, "child-run");
    const payload = {
      apiToken: "sk-1234567890abcdef1234567890",
      nested: { message: "safe" },
    };
    events.append({
      eventId: "secret-child-event",
      runId: "child-run",
      eventType: "run_started",
      payload,
      createdAt: "2026-07-13T00:00:01.000Z",
    });
    watchers.create({ watcherId: "watcher-payload-redaction", parentRunId: "parent-run", childRunId: "child-run" });

    const [notice] = watchers.catchUpWatcher("watcher-payload-redaction").notices;
    const noticePayload = notice?.payload as unknown as DurableChildStateChangedPayload | undefined;
    const expectedHash = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
    assert.deepEqual(noticePayload?.childPayload, {
      apiToken: "[REDACTED]",
      nested: { message: "safe" },
    });
    assert.deepEqual(noticePayload?.childPayloadEvidence, {
      hashAlgorithm: "sha256",
      originalSha256: expectedHash,
      originalByteCount: Buffer.byteLength(JSON.stringify(payload), "utf8"),
      disposition: "included_redacted",
      redactionCount: 1,
    });
    assert.doesNotMatch(JSON.stringify(notice), /sk-1234567890abcdef1234567890/);
  });

  it("omits large and deep child payload values behind a fixed per-notice summary", () => {
    const { runs, events, watchers } = createRepos();
    seedRun(runs, "child-run");
    const largePayload = { value: "s".repeat(DURABLE_CHILD_PAYLOAD_PROJECTION_LIMITS.maxBytes + 100) };
    const rawLargePayload = JSON.stringify(largePayload);
    events.append({
      eventId: "large-child-event",
      runId: "child-run",
      eventType: "run_started",
      payload: largePayload,
      createdAt: "2026-07-13T00:00:01.000Z",
    });
    const evidenceHashes = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      const parentRunId = `large-parent-${index}`;
      seedRun(runs, parentRunId);
      const watcherId = `large-watcher-${index}`;
      watchers.create({ watcherId, parentRunId, childRunId: "child-run" });
      const [notice] = watchers.catchUpWatcher(watcherId).notices;
      const noticePayload = notice?.payload as unknown as DurableChildStateChangedPayload | undefined;
      assert.equal(noticePayload?.childPayload, undefined);
      assert.equal(noticePayload?.childPayloadEvidence.omissionReason, "byte_limit");
      assert.ok(Buffer.byteLength(JSON.stringify(noticePayload), "utf8") < 2_048);
      evidenceHashes.add(String(noticePayload?.childPayloadEvidence.originalSha256));
    }
    assert.deepEqual([...evidenceHashes], [createHash("sha256").update(rawLargePayload, "utf8").digest("hex")]);

    let deepPayload: Record<string, unknown> = { leaf: "safe" };
    for (let depth = 0; depth <= DURABLE_CHILD_PAYLOAD_PROJECTION_LIMITS.maxDepth; depth += 1) {
      deepPayload = { nested: deepPayload };
    }
    events.append({
      eventId: "deep-child-event",
      runId: "child-run",
      eventType: "run_waiting",
      payload: deepPayload,
      createdAt: "2026-07-13T00:00:02.000Z",
    });
    const result = watchers.catchUpWatcher("large-watcher-0");
    const deepNotice = result.notices.find((notice) => notice.payload?.childEventId === "deep-child-event");
    const deepNoticePayload = deepNotice?.payload as unknown as DurableChildStateChangedPayload | undefined;
    assert.equal(deepNoticePayload?.childPayload, undefined);
    assert.equal(deepNoticePayload?.childPayloadEvidence.omissionReason, "depth_limit");
    assert.equal(deepNoticePayload?.childPayloadEvidence.preview?.topLevelType, "object");
    assert.equal(
      deepNoticePayload?.childPayloadEvidence.preview?.summary,
      `Child payload omitted by the depth_limit safety boundary (${Buffer.byteLength(JSON.stringify(deepPayload), "utf8")} bytes).`,
    );

    const secretKey = "sk-secret-key-1234567890abcdef1234567890";
    const secretKeyPayload = { [secretKey]: "safe" };
    events.append({
      eventId: "secret-key-child-event",
      runId: "child-run",
      eventType: "run_completed",
      payload: secretKeyPayload,
      createdAt: "2026-07-13T00:00:03.000Z",
    });
    const secretKeyResult = watchers.catchUpWatcher("large-watcher-0");
    const secretKeyNotice = secretKeyResult.notices.find(
      (notice) => notice.payload?.childEventId === "secret-key-child-event",
    );
    const secretKeyNoticePayload = secretKeyNotice?.payload as unknown as DurableChildStateChangedPayload | undefined;
    assert.equal(secretKeyNoticePayload?.childPayload, undefined);
    assert.equal(secretKeyNoticePayload?.childPayloadEvidence.omissionReason, "invalid_shape");
    assert.deepEqual(deepNoticePayload?.childPayloadEvidence.preview?.topLevelKeys, [
      `sha256:${createHash("sha256").update("nested", "utf8").digest("hex")}`,
    ]);
    assert.deepEqual(secretKeyNoticePayload?.childPayloadEvidence.preview?.topLevelKeys, [
      `sha256:${createHash("sha256").update(secretKey, "utf8").digest("hex")}`,
    ]);
    assert.doesNotMatch(JSON.stringify(secretKeyNoticePayload), /sk-secret-key-1234567890abcdef1234567890/);
    assert.equal(
      secretKeyNoticePayload?.childPayloadEvidence.preview?.summary,
      `Child payload omitted by the invalid_shape safety boundary (${Buffer.byteLength(JSON.stringify(secretKeyPayload), "utf8")} bytes).`,
    );
  });

  it("fairly repairs more than 200 identical-time watchers after the per-child fast-path cap", () => {
    const { runs, events, watchers } = createRepos();
    seedRun(runs, "fair-child");
    const watcherCount = 225;
    for (let index = 0; index < watcherCount; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const parentRunId = `fair-parent-${suffix}`;
      seedRun(runs, parentRunId);
      watchers.create({
        watcherId: `fair-watcher-${suffix}`,
        parentRunId,
        childRunId: "fair-child",
        createdAt: "2026-07-13T00:00:00.000Z",
      });
    }
    events.append({
      eventId: "fair-child-started",
      runId: "fair-child",
      eventType: "run_started",
      createdAt: "2026-07-13T00:00:01.000Z",
    });

    const fastPath = watchers.catchUpAttachedByChild("fair-child", {
      watcherLimit: 100,
      eventLimitPerWatcher: 10,
    });
    assert.equal(fastPath.projectedCount, 100);

    let maintenanceProjected = 0;
    for (let pass = 0; pass < 6; pass += 1) {
      maintenanceProjected += watchers.catchUpAttached({ watcherLimit: 50, eventLimitPerWatcher: 10 }).projectedCount;
    }
    assert.equal(maintenanceProjected, watcherCount - 100);
    for (let index = 0; index < watcherCount; index += 1) {
      const suffix = String(index).padStart(3, "0");
      assert.equal(watchers.get(`fair-watcher-${suffix}`).lastConsumedSequence, 1);
      assert.equal(events.listByRun(`fair-parent-${suffix}`, 10).length, 1);
    }
  });

  it("recovers an attached watcher from durable state after restart", () => {
    const dbPath = createDbPath();
    const first = createRepos(dbPath);
    seedRun(first.runs, "parent-run");
    seedRun(first.runs, "child-run");
    appendChildEvent(first.events, { eventId: "child-started", eventType: "run_started" });
    first.watchers.create({ watcherId: "watcher-restart", parentRunId: "parent-run", childRunId: "child-run" });
    first.watchers.catchUpWatcher("watcher-restart");
    first.db.close();

    const restarted = createRepos(dbPath);
    appendChildEvent(restarted.events, { eventId: "child-completed", eventType: "run_completed" });
    const summary = restarted.watchers.catchUpAttached({ watcherLimit: 10, eventLimitPerWatcher: 10 });
    assert.equal(summary.projectedCount, 1);
    assert.equal(restarted.watchers.get("watcher-restart").lastConsumedSequence, 2);
    assert.deepEqual(
      restarted.events.listByRun("parent-run").map((event) => event.payload?.childEventId),
      ["child-started", "child-completed"],
    );
    restarted.db.close();
  });

  it("persists a monotonic revision across same-millisecond ABA changes from two connections", () => {
    const dbPath = createDbPath();
    const first = createRepos(dbPath);
    seedRun(first.runs, "parent-run");
    seedRun(first.runs, "child-run");
    const created = first.watchers.create({
      watcherId: "watcher-aba",
      parentRunId: "parent-run",
      childRunId: "child-run",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const second = createRepos(dbPath);
    const sameMillisecond = "2026-07-13T00:00:01.000Z";

    const detachedOnce = first.watchers.detach("watcher-aba", sameMillisecond);
    const attachedOnce = second.watchers.reattach("watcher-aba", sameMillisecond);
    const detachedTwice = first.watchers.detach("watcher-aba", sameMillisecond);
    const attachedTwice = second.watchers.reattach("watcher-aba", sameMillisecond);

    assert.deepEqual(
      [created.revision, detachedOnce.revision, attachedOnce.revision, detachedTwice.revision, attachedTwice.revision],
      [1, 2, 3, 4, 5],
    );
    assert.equal(attachedTwice.updatedAt, sameMillisecond);
    second.db.close();
    first.db.close();
  });

  it("allows exactly one SQL-CAS winner and treats only the achieved state as converged", () => {
    const dbPath = createDbPath();
    const first = createRepos(dbPath);
    seedRun(first.runs, "parent-run");
    seedRun(first.runs, "child-run");
    first.watchers.create({
      watcherId: "watcher-cas",
      parentRunId: "parent-run",
      childRunId: "child-run",
      createdAt: "2026-07-13T00:00:00.000Z",
    });
    const second = createRepos(dbPath);
    const firstSnapshot = first.watchers.get("watcher-cas");
    const secondSnapshot = second.watchers.get("watcher-cas");
    const sameMillisecond = "2026-07-13T00:00:01.000Z";

    const winner = first.db.transaction("immediate", () =>
      first.watchers.detachIfRevision("watcher-cas", "parent-run", firstSnapshot.revision, sameMillisecond),
    );
    const duplicate = second.db.transaction("immediate", () =>
      second.watchers.detachIfRevision("watcher-cas", "parent-run", secondSnapshot.revision, sameMillisecond),
    );

    assert.equal(winner.outcome, "applied");
    assert.equal(winner.watcher.revision, 2);
    assert.equal(duplicate.outcome, "converged");
    assert.equal(duplicate.watcher.revision, 2);
    assert.throws(
      () =>
        second.db.transaction("immediate", () =>
          second.watchers.reattachIfRevision("watcher-cas", "parent-run", secondSnapshot.revision, sameMillisecond),
        ),
      /changed from revision 1 to 2/,
    );

    const reattached = second.db.transaction("immediate", () =>
      second.watchers.reattachIfRevision("watcher-cas", "parent-run", 2, sameMillisecond),
    );
    assert.equal(reattached.outcome, "applied");
    assert.equal(reattached.watcher.revision, 3);
    assert.equal(first.watchers.get("watcher-cas").revision, 3);
    second.db.close();
    first.db.close();
  });

  it("backfills deterministic per-run sequences in the migration", () => {
    const dbPath = createDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE durable_runs (run_id TEXT PRIMARY KEY);
      CREATE TABLE durable_run_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        step_key TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
      );
      INSERT INTO durable_runs (run_id) VALUES ('legacy-run');
      INSERT INTO durable_run_events
        (event_id, run_id, event_type, step_key, payload_json, created_at)
      VALUES
        ('event-z', 'legacy-run', 'run_started', NULL, '{}', '2026-07-13T00:00:00.000Z'),
        ('event-a', 'legacy-run', 'run_waiting', NULL, '{}', '2026-07-13T00:00:00.000Z'),
        ('event-m', 'legacy-run', 'run_completed', NULL, '{}', '2026-07-13T00:00:01.000Z');
    `);

    __sqliteInternals.applySchemaMigrationForTest(152, raw);
    const rows = raw.prepare("SELECT event_id, sequence FROM durable_run_events ORDER BY sequence ASC").all() as Array<{
      event_id: string;
      sequence: number;
    }>;
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { event_id: "event-a", sequence: 1 },
        { event_id: "event-z", sequence: 2 },
        { event_id: "event-m", sequence: 3 },
      ],
    );
    const state = raw
      .prepare("SELECT last_sequence FROM durable_run_event_sequences WHERE run_id = 'legacy-run'")
      .get() as { last_sequence: number };
    assert.equal(state.last_sequence, 3);
    raw.close();
  });
});

function expectOneProjection(first: number, second: number): void {
  assert.deepEqual(
    [first, second].sort((left, right) => left - right),
    [0, 1],
  );
}
