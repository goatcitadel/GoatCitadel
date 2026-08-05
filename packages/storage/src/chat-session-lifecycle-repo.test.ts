import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import { NotFoundError } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";

describe("ChatSessionLifecycleRepository SQLite", () => {
  it("creates metadata, generation one, and initialization evidence from one exact intent", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const lifecycle = new ChatSessionLifecycleRepository(db);

    const outcome = lifecycle.initialize({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      actorId: "operator-a",
      idempotencyKey: "lifecycle:init:session-a",
      correlationId: "correlation:init:session-a",
      metadataTimestamp: "2026-07-15T00:00:00.000Z",
    });

    assert.equal(outcome.disposition, "initialized");
    assert.equal(outcome.generation, 1);
    assert.deepEqual(
      {
        ...(db
          .prepare(
            `SELECT meta.workspace_id, meta.lifecycle_intent_id, control.generation, control.owner_kind,
                  control.lease_state, event.reason_code, event.idempotency_key
           FROM chat_session_meta meta
           JOIN chat_session_control_grants control
             ON control.session_id = meta.session_id AND control.is_current = 1
           JOIN chat_session_control_events event
             ON event.session_id = meta.session_id AND event.event_sequence = 1
           WHERE meta.session_id = 'session-a'`,
          )
          .get() as Record<string, unknown>),
      },
      {
        workspace_id: "workspace-a",
        lifecycle_intent_id: outcome.intent.intentId,
        generation: 1,
        owner_kind: "operator",
        lease_state: "operator_active",
        reason_code: "session_initialized",
        idempotency_key: "lifecycle:init:session-a",
      },
    );
    db.close();
  });

  it("accepts an exact lifecycle bootstrap after the intent freshness window has elapsed", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const createdAt = (
      db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS created_at").get() as { created_at: string }
    ).created_at;
    const hash = "a".repeat(64);
    db.prepare(
      `INSERT INTO chat_session_lifecycle_intents (
         intent_id, session_incarnation_id, workspace_id, session_id, intent_kind,
         expected_generation, next_generation, expected_revision, actor_kind, actor_id,
         idempotency_key, request_sha256, correlation_id, event_id, created_at
       ) VALUES (
         'intent-delayed', 'intent-delayed', 'workspace-a', 'session-delayed', 'initialize',
         NULL, 1, NULL, 'system', 'system',
         'lifecycle:init:session-delayed', @hash, 'correlation:session-delayed',
         'event:session-delayed', @createdAt
       )`,
    ).run({ hash, createdAt });

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);

    db.prepare(
      `INSERT INTO chat_session_meta (
         session_id, workspace_id, revision, lifecycle_intent_id, created_at, updated_at
       ) VALUES (
         'session-delayed', 'workspace-a', 1, 'intent-delayed', @createdAt, @createdAt
       )`,
    ).run({ createdAt });
    assert.deepEqual(
      {
        ...(db
          .prepare(
            `SELECT generation, owner_kind, lease_state, transition_idempotency_key
             FROM chat_session_control_grants WHERE session_id = 'session-delayed'`,
          )
          .get() as Record<string, unknown>),
      },
      {
        generation: 1,
        owner_kind: "operator",
        lease_state: "operator_active",
        transition_idempotency_key: "lifecycle:init:session-delayed",
      },
    );
    db.close();
  });

  it("rejects implicit synthesis, raw inserts, workspace replacement, and intent reuse", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const meta = new ChatSessionMetaRepository(db);
    assert.throws(() => meta.ensure("missing-session"), NotFoundError);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO chat_session_meta(session_id, workspace_id, created_at, updated_at)
             VALUES ('raw-session', 'workspace-a', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')`,
          )
          .run(),
      /lifecycle intent/iu,
    );

    const created = meta.ensure("session-a", "2026-07-15T00:00:00.000Z", "workspace-a");
    assert.equal(created.workspaceId, "workspace-a");
    assert.throws(
      () =>
        db.prepare("UPDATE chat_session_meta SET workspace_id = 'workspace-b' WHERE session_id = 'session-a'").run(),
      /workspace.*immutable/iu,
    );
    assert.throws(() => meta.ensure("session-a", "2026-07-15T00:00:01.000Z", "workspace-b"), /workspace/iu);
    assert.throws(
      () => db.prepare(`UPDATE chat_session_meta SET lifecycle_intent_id = NULL WHERE session_id = 'session-a'`).run(),
      /lifecycle intent/iu,
    );
    db.close();
  });

  it("terminalizes before delete and reactivates only at exact terminal N plus one", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    const lifecycle = new ChatSessionLifecycleRepository(db);
    lifecycle.initialize({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      actorId: "operator-a",
      idempotencyKey: "lifecycle:init:session-a",
      correlationId: "correlation:init:session-a",
    });

    assert.throws(
      () => db.prepare("DELETE FROM chat_session_meta WHERE session_id = 'session-a'").run(),
      /terminal lifecycle evidence/iu,
    );
    const prepared = lifecycle.deleteTree(
      {
        workspaceId: "workspace-a",
        rootSessionId: "session-a",
        expectedRootRevision: 1,
        actorId: "operator-a",
        idempotencyKey: "lifecycle:delete:session-a",
        correlationId: "correlation:delete:session-a",
      },
      () => undefined,
    );
    assert.deepEqual(
      prepared.nodes.map((node) => node.sessionId),
      ["session-a"],
    );
    assert.equal(db.prepare("SELECT 1 FROM chat_session_meta WHERE session_id = 'session-a'").get(), undefined);
    assert.deepEqual(
      db
        .prepare(
          `SELECT generation, is_current, lease_state
           FROM chat_session_control_grants WHERE session_id = 'session-a' ORDER BY generation`,
        )
        .all()
        .map((row) => ({ ...(row as Record<string, unknown>) })),
      [{ generation: 1, is_current: 0, lease_state: "deleted" }],
    );

    const reactivated = lifecycle.reactivate({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      expectedTerminalGeneration: 1,
      actorId: "operator-a",
      idempotencyKey: "lifecycle:reactivate:session-a:2",
      correlationId: "correlation:reactivate:session-a:2",
    });
    assert.equal(reactivated.disposition, "reactivated");
    assert.equal(reactivated.generation, 2);
    assert.throws(
      () =>
        lifecycle.reactivate({
          workspaceId: "workspace-a",
          sessionId: "session-a",
          expectedTerminalGeneration: 1,
          actorId: "operator-a",
          idempotencyKey: "lifecycle:reactivate:session-a:duplicate",
          correlationId: "correlation:reactivate:session-a:duplicate",
        }),
      /activation replay|live metadata|current owner/iu,
    );
    db.close();
  });

  it("keeps transport-only rows outside controllable lifecycle", () => {
    const db = createDatabase({ dbPath: ":memory:" });
    db.prepare(
      `INSERT INTO sessions(session_id, session_key, kind, channel, account, last_activity_at, updated_at)
       VALUES ('transport-only', 'discord:test:transport-only', 'dm', 'discord', 'test',
               '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO chat_messages(message_id, session_id, role, actor_type, actor_id, content, timestamp, created_at)
       VALUES ('message-transport-only', 'transport-only', 'user', 'user', 'discord-user', 'hello',
               '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')`,
    ).run();

    assert.equal(db.prepare("SELECT 1 FROM chat_session_meta WHERE session_id = 'transport-only'").get(), undefined);
    assert.equal(
      db.prepare("SELECT 1 FROM chat_session_control_grants WHERE session_id = 'transport-only'").get(),
      undefined,
    );
    db.close();
  });

  it("rolls back a whole deletion tree when a descendant is missing or crosses workspaces", () => {
    for (const variant of ["missing", "cross-workspace"] as const) {
      const db = createDatabase({ dbPath: ":memory:" });
      const lifecycle = new ChatSessionLifecycleRepository(db);
      lifecycle.initialize({
        workspaceId: "workspace-a",
        sessionId: "parent",
        actorId: "operator-a",
        idempotencyKey: `lifecycle:init:parent:${variant}`,
        correlationId: `correlation:init:parent:${variant}`,
      });
      if (variant === "cross-workspace") {
        lifecycle.initialize({
          workspaceId: "workspace-b",
          sessionId: "child",
          actorId: "operator-a",
          idempotencyKey: "lifecycle:init:child:cross-workspace",
          correlationId: "correlation:init:child:cross-workspace",
        });
      }
      for (const sessionId of ["parent", "child"]) {
        db.prepare(
          `INSERT INTO sessions (
             session_id, session_key, kind, channel, account, last_activity_at, updated_at
           ) VALUES (@sessionId, @sessionKey, 'thread', 'mission', 'local',
                     '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')`,
        ).run({ sessionId, sessionKey: `mission:local:${sessionId}` });
      }
      db.prepare(
        `INSERT INTO chat_side_chats (
           side_chat_id, parent_session_id, child_session_id, workspace_id,
           created_from_surface, created_at, updated_at
         ) VALUES ('side-1', 'parent', 'child', 'workspace-a', 'chat',
                   '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z')`,
      ).run();

      assert.throws(
        () =>
          lifecycle.deleteTree(
            {
              workspaceId: "workspace-a",
              rootSessionId: "parent",
              expectedRootRevision: 1,
              actorId: "operator-a",
              idempotencyKey: `lifecycle:delete:parent:${variant}`,
              correlationId: `correlation:delete:parent:${variant}`,
            },
            () => undefined,
          ),
        variant === "missing" ? /not found/iu : /crosses workspaces/iu,
      );
      assert.equal(
        (
          db.prepare("SELECT is_current FROM chat_session_control_grants WHERE session_id = 'parent'").get() as {
            is_current: number;
          }
        ).is_current,
        1,
      );
      assert.equal(
        (
          db
            .prepare("SELECT COUNT(*) AS count FROM chat_session_control_events WHERE reason_code = 'session_deleted'")
            .get() as { count: number }
        ).count,
        0,
      );
      db.close();
    }
  });

  it("permits exactly one winner when two workers reactivate the same terminal generation", async () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-lifecycle-race-${randomUUID()}.db`);
    const db = createDatabase({ dbPath });
    const lifecycle = new ChatSessionLifecycleRepository(db);
    lifecycle.initialize({
      workspaceId: "workspace-a",
      sessionId: "session-race",
      actorId: "operator-a",
      idempotencyKey: "lifecycle:init:session-race",
      correlationId: "correlation:init:session-race",
    });
    db.transaction("immediate", () => {
      lifecycle.deleteTree(
        {
          workspaceId: "workspace-a",
          rootSessionId: "session-race",
          expectedRootRevision: 1,
          actorId: "operator-a",
          idempotencyKey: "lifecycle:delete:session-race",
          correlationId: "correlation:delete:session-race",
        },
        () => undefined,
      );
    });
    db.close();

    try {
      const results = await runLifecycleRace(dbPath, ["left", "right"]);
      assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
      assert.equal(results.filter((result) => !result.ok).length, 1, JSON.stringify(results));
      const verify = createDatabase({ dbPath });
      assert.deepEqual(
        {
          ...(verify
            .prepare(
              `SELECT meta.workspace_id, control.generation, control.is_current, control.owner_kind,
                      event.reason_code
               FROM chat_session_meta meta
               JOIN chat_session_control_grants control
                 ON control.session_id = meta.session_id AND control.is_current = 1
               JOIN chat_session_control_events event
                 ON event.session_id = meta.session_id AND event.reason_code = 'session_reactivated'
               WHERE meta.session_id = 'session-race'`,
            )
            .get() as Record<string, unknown>),
        },
        {
          workspace_id: "workspace-a",
          generation: 2,
          is_current: 1,
          owner_kind: "operator",
          reason_code: "session_reactivated",
        },
      );
      verify.close();
    } finally {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    }
  });
});

interface LifecycleRaceResult {
  ok: boolean;
  generation?: number;
  disposition?: string;
  error?: string;
}

async function runLifecycleRace(
  dbPath: string,
  contenders: readonly [string, string],
): Promise<[LifecycleRaceResult, LifecycleRaceResult]> {
  const startSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = contenders.map((contender) => runLifecycleWorker(dbPath, contender, startSignal)) as [
    ReturnType<typeof runLifecycleWorker>,
    ReturnType<typeof runLifecycleWorker>,
  ];
  await Promise.all(workers.map((worker) => worker.ready));
  const state = new Int32Array(startSignal);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0, workers.length);
  return Promise.all(workers.map((worker) => worker.result)) as Promise<[LifecycleRaceResult, LifecycleRaceResult]>;
}

function runLifecycleWorker(
  dbPath: string,
  contender: string,
  startSignal: SharedArrayBuffer,
): { ready: Promise<void>; result: Promise<LifecycleRaceResult> } {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(LIFECYCLE_WORKER_SOURCE, {
    eval: true,
    workerData: {
      dbPath,
      contender,
      startSignal,
      repositoryModuleUrl: new URL(`./chat-session-lifecycle-repo${extension}`, import.meta.url).href,
      sqliteModuleUrl: new URL(`./sqlite${extension}`, import.meta.url).href,
      tsxApiUrl: import.meta.resolve("tsx/esm/api"),
    },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let resolveResult!: (value: LifecycleRaceResult) => void;
  let rejectResult!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<LifecycleRaceResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { kind: "ready" } | { kind: "result"; result: LifecycleRaceResult }) => {
    if (message.kind === "ready") resolveReady();
    else resolveResult(message.result);
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`SQLite lifecycle race worker exited with code ${code}`);
      rejectReady(error);
      rejectResult(error);
    }
  });
  return { ready, result };
}

const LIFECYCLE_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    let db;
    try {
      const { tsImport } = await import(workerData.tsxApiUrl);
      const { ChatSessionLifecycleRepository } = await tsImport(
        workerData.repositoryModuleUrl,
        workerData.repositoryModuleUrl,
      );
      const { createDatabase } = await tsImport(workerData.sqliteModuleUrl, workerData.sqliteModuleUrl);
      db = createDatabase({ dbPath: workerData.dbPath });
      parentPort.postMessage({ kind: "ready" });
      const state = new Int32Array(workerData.startSignal);
      Atomics.wait(state, 0, 0);
      const value = new ChatSessionLifecycleRepository(db).reactivate({
        workspaceId: "workspace-a",
        sessionId: "session-race",
        expectedTerminalGeneration: 1,
        actorId: "operator-" + workerData.contender,
        idempotencyKey: "lifecycle:reactivate:session-race:" + workerData.contender,
        correlationId: "correlation:reactivate:session-race:" + workerData.contender,
      });
      parentPort.postMessage({
        kind: "result",
        result: { ok: true, generation: value.generation, disposition: value.disposition },
      });
    } catch (error) {
      parentPort.postMessage({
        kind: "result",
        result: { ok: false, error: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      if (db) db.close();
    }
  })();
`;
