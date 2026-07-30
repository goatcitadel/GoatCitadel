import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import {
  buildPostgresSyncWorkerPoolConfig,
  createPostgresSyncWorkerRuntime,
  handlePostgresSyncWorkerRequest,
  registerPostgresSyncWorkerMessageHandler,
  reportPostgresSyncWorkerPoolError,
  respondToPostgresSyncWorkerMessage,
  serializePostgresSyncWorkerError,
  type PostgresSyncWorkerPool,
  type PostgresSyncWorkerRuntime,
  type PostgresSyncWorkerTransactionClient,
} from "./postgres/sync-worker.js";
import type { PostgresWorkerResponse } from "./postgres/protocol.js";

test("builds Postgres worker pool config for connection strings and discrete options", () => {
  const fromConnectionString = buildPostgresSyncWorkerPoolConfig({
    connectionString:
      " postgres://user:pass@example.test/db?options=-csearch_path%3Dtenant_proof+-cstatement_timeout%3D5000 ",
    database: "ignored",
    sslMode: "require",
    applicationName: "coverage-worker",
    pool: {
      min: 2,
      max: 7,
      idleTimeoutMs: 123,
      connectionTimeoutMs: 456,
    },
  });

  assert.deepEqual(fromConnectionString, {
    connectionString:
      "postgres://user:pass@example.test/db?options=-csearch_path%3Dtenant_proof+-cstatement_timeout%3D5000+-c+client_encoding%3DUTF8",
    options: "-csearch_path=tenant_proof -cstatement_timeout=5000 -c client_encoding=UTF8",
    max: 7,
    min: 2,
    idleTimeoutMillis: 123,
    connectionTimeoutMillis: 456,
    application_name: "coverage-worker",
    ssl: { rejectUnauthorized: false },
  });
  assert.equal(
    (new Client(fromConnectionString) as unknown as { connectionParameters: { options?: string } }).connectionParameters
      .options,
    fromConnectionString.options,
  );

  const fromDiscreteOptions = buildPostgresSyncWorkerPoolConfig({
    database: "goatcitadel",
    user: "operator",
    password: "secret",
  });

  assert.deepEqual(fromDiscreteOptions, {
    host: "127.0.0.1",
    port: 5432,
    database: "goatcitadel",
    user: "operator",
    password: "secret",
    options: "-c client_encoding=UTF8",
    max: 10,
    min: 0,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "goatcitadel-sync-worker",
    ssl: undefined,
  });

  assert.deepEqual(
    buildPostgresSyncWorkerPoolConfig({
      connectionString: "postgres://user:pass@example.test/minimal",
      database: "ignored",
    }),
    {
      connectionString: "postgres://user:pass@example.test/minimal",
      options: "-c client_encoding=UTF8",
      max: 10,
      min: 0,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: "goatcitadel-sync-worker",
      ssl: undefined,
    },
  );

  assert.deepEqual(
    buildPostgresSyncWorkerPoolConfig({
      host: "db.internal",
      port: 15432,
      database: "goatcitadel",
      user: "operator",
      password: "secret",
      sslMode: "require",
      applicationName: "custom-worker",
      pool: {
        min: 1,
        max: 4,
        idleTimeoutMs: 111,
        connectionTimeoutMs: 222,
      },
    }),
    {
      host: "db.internal",
      port: 15432,
      database: "goatcitadel",
      user: "operator",
      password: "secret",
      options: "-c client_encoding=UTF8",
      max: 4,
      min: 1,
      idleTimeoutMillis: 111,
      connectionTimeoutMillis: 222,
      application_name: "custom-worker",
      ssl: { rejectUnauthorized: false },
    },
  );
});

test("contains an idle pool connection failure and keeps later queries recoverable", async () => {
  let poolErrorListener: ((error: Error) => void) | undefined;
  const reported: Error[] = [];
  let queryCount = 0;
  const pool: PostgresSyncWorkerPool = {
    ...createFakePool({
      onQuery: async (sql) => {
        queryCount += 1;
        if (sql.includes("current_setting")) {
          return { rowCount: 1, rows: [{ server_encoding: "UTF8" }] };
        }
        return { rowCount: 1, rows: [{ recovered: true }] };
      },
    }),
    on(event, listener) {
      assert.equal(event, "error");
      poolErrorListener = listener;
      return pool;
    },
  };
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool,
      onPoolError: (error) => reported.push(error),
    },
  );
  const connectionFailure = Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
  });

  assert.ok(poolErrorListener);
  assert.doesNotThrow(() => poolErrorListener?.(connectionFailure));
  assert.deepEqual(reported, [connectionFailure]);
  assert.deepEqual(
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "query",
      sql: "SELECT true AS recovered",
      params: [],
      mode: "one",
    }),
    { recovered: true },
  );
  assert.equal(queryCount, 2);
});

test("keeps pool failure reporter errors contained while preserving the original diagnostic", async () => {
  let resolveWarning!: (warning: Error) => void;
  const warningObserved = new Promise<Error>((resolve) => {
    resolveWarning = resolve;
  });
  const onWarning = (warning: Error): void => resolveWarning(warning);
  process.once("warning", onWarning);
  try {
    const connectionFailure = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    assert.doesNotThrow(() =>
      reportPostgresSyncWorkerPoolError(connectionFailure, () => {
        throw new Error("reporter unavailable");
      }),
    );
    const warning = await warningObserved;
    assert.equal((warning as Error & { code?: string }).code, "GOATCITADEL_POSTGRES_IDLE_CONNECTION_ERROR");
    assert.match(warning.message, /connection reset/);
    assert.match(warning.message, /reporter unavailable/);
  } finally {
    process.off("warning", onWarning);
  }
});

test("handles query modes with cached server encoding and pool execution", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onQuery: async (sql, params) => {
          calls.push({ sql, params });
          if (sql.includes("current_setting")) {
            return { rowCount: 1, rows: [{ server_encoding: "UTF8" }] };
          }
          return {
            rowCount: 3,
            rows: [{ id: "first" }, { id: "second" }, { id: "third" }],
          };
        },
      }),
    },
  );

  const allRows = await handlePostgresSyncWorkerRequest(runtime, {
    kind: "query",
    sql: "SELECT $1::text AS value",
    params: ["alpha"],
    mode: "all",
  });
  const oneRow = await handlePostgresSyncWorkerRequest(runtime, {
    kind: "query",
    sql: "SELECT $1::text AS value",
    params: ["bravo"],
    mode: "one",
  });
  const runResult = await handlePostgresSyncWorkerRequest(runtime, {
    kind: "query",
    sql: "UPDATE tasks SET title = $1",
    params: ["done"],
    mode: "run",
  });
  const execResult = await handlePostgresSyncWorkerRequest(runtime, {
    kind: "exec",
    sql: "VACUUM",
  });

  assert.deepEqual(allRows, [{ id: "first" }, { id: "second" }, { id: "third" }]);
  assert.deepEqual(oneRow, { id: "first" });
  assert.deepEqual(runResult, { changes: 3, lastInsertRowid: undefined });
  assert.deepEqual(execResult, { changes: 3, lastInsertRowid: undefined });
  assert.equal(calls.filter((call) => call.sql.includes("current_setting")).length, 1);
  assert.equal(calls.at(-1)?.sql, "VACUUM");
});

test("handles empty query results and null row counts", async () => {
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onQuery: async (sql) => {
          if (sql.includes("current_setting")) {
            return { rowCount: 1, rows: [{ server_encoding: "UTF8" }] };
          }
          return { rowCount: null, rows: [] };
        },
      }),
    },
  );

  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "query",
      sql: "SELECT * FROM missing",
      params: [],
      mode: "one",
    }),
    undefined,
  );
  assert.deepEqual(
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "query",
      sql: "UPDATE missing SET ok = true",
      params: [],
      mode: "run",
    }),
    { changes: 0, lastInsertRowid: undefined },
  );
  assert.deepEqual(await handlePostgresSyncWorkerRequest(runtime, { kind: "exec", sql: "VACUUM" }), {
    changes: 0,
    lastInsertRowid: undefined,
  });
});

test("falls back when server encoding detection fails", async () => {
  const calls: string[] = [];
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onQuery: async (sql) => {
          calls.push(sql);
          if (sql.includes("current_setting")) {
            throw new Error("settings unavailable");
          }
          return { rowCount: 1, rows: [{ ok: true }] };
        },
      }),
    },
  );

  const rows = await handlePostgresSyncWorkerRequest(runtime, {
    kind: "query",
    sql: "SELECT true AS ok",
    params: [],
    mode: "all",
  });

  assert.deepEqual(rows, [{ ok: true }]);
  assert.equal(calls.filter((sql) => sql.includes("current_setting")).length, 1);
});

test("manages worker transaction lifecycle with commit rollback close and missing transaction errors", async () => {
  const firstClient = createFakeTransactionClient([{ id: "tx-one" }], 5);
  const secondClient = createFakeTransactionClient([], 1);
  const thirdClient = createFakeTransactionClient([], 1);
  const clients = [firstClient, secondClient, thirdClient];
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onConnect: async () => {
          const client = clients.shift();
          assert.ok(client);
          return client;
        },
      }),
    },
  );

  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, { kind: "tx_begin", txId: "tx-1", mode: "immediate" }),
    true,
  );
  assert.equal(runtime.transactions.has("tx-1"), true);
  assert.deepEqual(
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "query",
      sql: "SELECT * FROM task WHERE id = $1",
      params: ["task-1"],
      mode: "one",
      txId: "tx-1",
    }),
    { id: "tx-one" },
  );
  assert.equal(await handlePostgresSyncWorkerRequest(runtime, { kind: "tx_commit", txId: "tx-1" }), true);
  assert.equal(firstClient.released, true);
  assert.equal(runtime.transactions.has("tx-1"), false);
  assert.deepEqual(
    firstClient.calls.map((call) => call.sql),
    [
      "BEGIN",
      "SELECT current_setting('server_encoding') AS server_encoding",
      "SELECT * FROM task WHERE id = $1",
      "COMMIT",
    ],
  );

  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, { kind: "tx_begin", txId: "tx-2", mode: "exclusive" }),
    true,
  );
  assert.equal(await handlePostgresSyncWorkerRequest(runtime, { kind: "tx_rollback", txId: "tx-2" }), true);
  assert.equal(secondClient.released, true);
  assert.deepEqual(
    secondClient.calls.map((call) => call.sql),
    ["BEGIN", "ROLLBACK"],
  );

  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, { kind: "tx_begin", txId: "tx-3", mode: "deferred" }),
    true,
  );
  assert.equal(await handlePostgresSyncWorkerRequest(runtime, { kind: "close" }), true);
  assert.equal(thirdClient.released, true);
  assert.deepEqual(
    thirdClient.calls.map((call) => call.sql),
    ["BEGIN", "ROLLBACK"],
  );

  await assert.rejects(
    handlePostgresSyncWorkerRequest(runtime, {
      kind: "exec",
      sql: "DELETE FROM task",
      txId: "missing",
    }),
    /Missing active Postgres transaction missing/,
  );
});

test("pins queries and independently committed transactions to one worker session", async () => {
  const pinnedClient = createFakeTransactionClient([{ source: "pinned" }], 1);
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onConnect: async () => pinnedClient,
      }),
    },
  );

  assert.equal(await handlePostgresSyncWorkerRequest(runtime, { kind: "session_begin", sessionId: "session-1" }), true);
  assert.deepEqual(
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "query",
      sql: "SELECT pinned",
      params: [],
      mode: "one",
      sessionId: "session-1",
    }),
    { source: "pinned" },
  );
  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "tx_begin",
      txId: "session-tx-1",
      mode: "immediate",
      sessionId: "session-1",
    }),
    true,
  );
  await handlePostgresSyncWorkerRequest(runtime, {
    kind: "exec",
    sql: "UPDATE pinned",
    txId: "session-tx-1",
    sessionId: "session-1",
  });
  assert.equal(await handlePostgresSyncWorkerRequest(runtime, { kind: "tx_commit", txId: "session-tx-1" }), true);
  assert.equal(pinnedClient.released, false);
  assert.equal(runtime.sessions.get("session-1"), pinnedClient);
  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "session_end",
      sessionId: "session-1",
      destroy: true,
    }),
    true,
  );
  assert.equal(pinnedClient.released, true);
  assert.deepEqual(pinnedClient.releaseArguments, [true]);
  assert.deepEqual(
    pinnedClient.calls.map((call) => call.sql),
    [
      "SELECT current_setting('server_encoding') AS server_encoding",
      "SELECT pinned",
      "BEGIN",
      "UPDATE pinned",
      "COMMIT",
    ],
  );
});

test("fences a failed checked-out pinned session and reconnects through the pool after release", async () => {
  const pinnedClient = createFakeTransactionClient([{ source: "pinned" }], 1);
  const observed: Array<{ error: Error; owner: { kind: "session" | "transaction"; id: string } }> = [];
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onConnect: async () => pinnedClient,
        onQuery: async (sql) =>
          sql.includes("current_setting")
            ? { rowCount: 1, rows: [{ server_encoding: "UTF8" }] }
            : { rowCount: 1, rows: [{ recovered: true }] },
      }),
      onCheckedOutClientError: (error, owner) => observed.push({ error, owner }),
    },
  );

  assert.equal(await handlePostgresSyncWorkerRequest(runtime, { kind: "session_begin", sessionId: "session-1" }), true);
  assert.equal(pinnedClient.errorListenerCount(), 1);
  const connectionFailure = Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
  });
  pinnedClient.emitError(connectionFailure);

  assert.deepEqual(observed, [{ error: connectionFailure, owner: { kind: "session", id: "session-1" } }]);
  await assert.rejects(
    handlePostgresSyncWorkerRequest(runtime, {
      kind: "query",
      sql: "SELECT pinned",
      params: [],
      mode: "one",
      sessionId: "session-1",
    }),
    connectionFailure,
  );
  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, { kind: "session_end", sessionId: "session-1", destroy: false }),
    true,
  );
  assert.deepEqual(pinnedClient.releaseArguments, [true]);
  assert.equal(pinnedClient.errorListenerCount(), 0);
  assert.deepEqual(
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "query",
      sql: "SELECT true AS recovered",
      params: [],
      mode: "one",
    }),
    { recovered: true },
  );
});

test("fails a checked-out transaction without replay and permits a later pool query", async () => {
  const transactionClient = createFakeTransactionClient();
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onConnect: async () => transactionClient,
        onQuery: async (sql) =>
          sql.includes("current_setting")
            ? { rowCount: 1, rows: [{ server_encoding: "UTF8" }] }
            : { rowCount: 1, rows: [{ recovered: true }] },
      }),
      onCheckedOutClientError: () => undefined,
    },
  );

  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, { kind: "tx_begin", txId: "tx-restart", mode: "immediate" }),
    true,
  );
  assert.equal(transactionClient.errorListenerCount(), 1);
  const connectionFailure = new Error("connection terminated while checked out");
  transactionClient.emitError(connectionFailure);
  await assert.rejects(
    handlePostgresSyncWorkerRequest(runtime, {
      kind: "query",
      sql: "UPDATE work SET state = 'done'",
      params: [],
      mode: "run",
      txId: "tx-restart",
    }),
    connectionFailure,
  );
  await assert.rejects(
    handlePostgresSyncWorkerRequest(runtime, { kind: "tx_rollback", txId: "tx-restart" }),
    connectionFailure,
  );
  assert.deepEqual(transactionClient.releaseArguments, [true]);
  assert.equal(transactionClient.errorListenerCount(), 0);
  assert.deepEqual(
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "query",
      sql: "SELECT true AS recovered",
      params: [],
      mode: "one",
    }),
    { recovered: true },
  );
});

test("keeps a pinned session reserved while BEGIN is still in flight", async () => {
  const pinnedClient = createFakeTransactionClient();
  const originalQuery = pinnedClient.query.bind(pinnedClient);
  let resolveBeginStarted!: () => void;
  let releaseBegin!: () => void;
  const beginStarted = new Promise<void>((resolve) => {
    resolveBeginStarted = resolve;
  });
  const beginGate = new Promise<void>((resolve) => {
    releaseBegin = resolve;
  });
  pinnedClient.query = async <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => {
    if (sql === "BEGIN") {
      pinnedClient.calls.push({ sql, params });
      resolveBeginStarted();
      await beginGate;
      return { rowCount: 0, rows: [] as T[] };
    }
    return originalQuery<T>(sql, params);
  };

  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onConnect: async () => pinnedClient,
      }),
    },
  );

  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, { kind: "session_begin", sessionId: "session-race" }),
    true,
  );
  const begin = handlePostgresSyncWorkerRequest(runtime, {
    kind: "tx_begin",
    txId: "tx-race",
    mode: "immediate",
    sessionId: "session-race",
  });
  await beginStarted;
  const endOutcome = await handlePostgresSyncWorkerRequest(runtime, {
    kind: "session_end",
    sessionId: "session-race",
    destroy: false,
  }).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  releaseBegin();
  await begin;

  assert.equal(endOutcome.status, "rejected");
  if (endOutcome.status === "rejected") {
    assert.match(String(endOutcome.error), /still owns an active transaction/);
  }
  assert.equal(pinnedClient.released, false);
  assert.equal(runtime.sessions.get("session-race"), pinnedClient);
  assert.equal(runtime.transactions.get("tx-race"), pinnedClient);
  assert.equal(runtime.transactionSessionIds.get("tx-race"), "session-race");

  assert.equal(await handlePostgresSyncWorkerRequest(runtime, { kind: "tx_rollback", txId: "tx-race" }), true);
  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "session_end",
      sessionId: "session-race",
      destroy: false,
    }),
    true,
  );
  assert.deepEqual(pinnedClient.releaseArguments, [false]);
});

test("clears a pinned-session reservation when BEGIN fails", async () => {
  const pinnedClient = createFakeTransactionClient();
  pinnedClient.query = async () => {
    throw new Error("BEGIN failed");
  };
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onConnect: async () => pinnedClient,
      }),
    },
  );

  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, { kind: "session_begin", sessionId: "session-failed-begin" }),
    true,
  );
  await assert.rejects(
    handlePostgresSyncWorkerRequest(runtime, {
      kind: "tx_begin",
      txId: "tx-failed-begin",
      mode: "immediate",
      sessionId: "session-failed-begin",
    }),
    /BEGIN failed/,
  );
  assert.equal(runtime.transactions.has("tx-failed-begin"), false);
  assert.equal(runtime.transactionSessionIds.has("tx-failed-begin"), false);
  assert.equal(runtime.sessions.get("session-failed-begin"), pinnedClient);
  assert.equal(pinnedClient.released, false);

  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "session_end",
      sessionId: "session-failed-begin",
      destroy: true,
    }),
    true,
  );
  assert.deepEqual(pinnedClient.releaseArguments, [true]);
});

test("rejects duplicate Postgres worker transaction ids without replacing the active client", async () => {
  const firstClient = createFakeTransactionClient();
  let connectCount = 0;
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onConnect: async () => {
          connectCount += 1;
          return firstClient;
        },
      }),
    },
  );

  assert.equal(
    await handlePostgresSyncWorkerRequest(runtime, { kind: "tx_begin", txId: "tx-dupe", mode: "deferred" }),
    true,
  );
  await assert.rejects(
    handlePostgresSyncWorkerRequest(runtime, { kind: "tx_begin", txId: "tx-dupe", mode: "deferred" }),
    /already active/,
  );
  assert.equal(connectCount, 1);
  assert.equal(runtime.transactions.get("tx-dupe"), firstClient);
  assert.equal(firstClient.released, false);

  assert.equal(await handlePostgresSyncWorkerRequest(runtime, { kind: "tx_rollback", txId: "tx-dupe" }), true);
  assert.equal(firstClient.released, true);
});

test("posts success and serialized error responses to sync message ports", async () => {
  const successRuntime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onQuery: async (sql) => {
          if (sql.includes("current_setting")) {
            return { rowCount: 1, rows: [{ server_encoding: "UTF8" }] };
          }
          return { rowCount: 1, rows: [{ ok: true }] };
        },
      }),
    },
  );

  const success = await postToWorkerHandler(successRuntime, {
    kind: "query",
    sql: "SELECT true AS ok",
    params: [],
    mode: "one",
  });

  assert.deepEqual(success, { ok: true, result: { ok: true } });

  const errorRuntime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onQuery: async (sql) => {
          throw new TypeError(`cannot run ${sql}`);
        },
      }),
    },
  );

  const failure = await postToWorkerHandler(errorRuntime, {
    kind: "exec",
    sql: "BROKEN SQL",
  });

  assert.equal(failure.ok, false);
  assert.equal(failure.error.name, "TypeError");
  assert.match(failure.error.message, /cannot run BROKEN SQL\nSQL: BROKEN SQL/);

  assert.deepEqual(serializePostgresSyncWorkerError("plain failure"), {
    name: "Error",
    message: "plain failure",
  });
  assert.deepEqual(serializePostgresSyncWorkerError("plain failure", "SELECT 1"), {
    name: "Error",
    message: "plain failure\nSQL: SELECT 1",
  });

  const queryFailure = await postToWorkerHandler(errorRuntime, {
    kind: "query",
    sql: "BROKEN QUERY",
    params: [],
    mode: "all",
  });
  assert.equal(queryFailure.ok, false);
  assert.match(queryFailure.error.message, /cannot run BROKEN QUERY\nSQL: BROKEN QUERY/);
});

test("registers a message handler that delegates to the response helper", async () => {
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onQuery: async () => ({ rowCount: 1, rows: [] }),
      }),
    },
  );
  let listener: ((message: unknown) => void) | undefined;
  registerPostgresSyncWorkerMessageHandler(
    {
      on(event, callback) {
        assert.equal(event, "message");
        listener = callback as (message: unknown) => void;
        return this;
      },
    },
    runtime,
  );

  assert.ok(listener);
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(signal);
  const messages: PostgresWorkerResponse[] = [];
  listener({
    request: { kind: "exec", sql: "ANALYZE" },
    signal,
    port: {
      postMessage(message: PostgresWorkerResponse) {
        messages.push(message);
      },
      close() {},
    },
  });

  await waitForState(state);
  assert.deepEqual(messages, [{ ok: true, result: { changes: 1, lastInsertRowid: undefined } }]);
});

test("queues registered session cleanup behind an in-flight pinned BEGIN", async () => {
  const pinnedClient = createFakeTransactionClient();
  const originalQuery = pinnedClient.query.bind(pinnedClient);
  const beginStarted = createDeferred();
  const beginGate = createDeferred();
  pinnedClient.query = async <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => {
    if (sql === "BEGIN") {
      pinnedClient.calls.push({ sql, params });
      beginStarted.resolve();
      await beginGate.promise;
      return { rowCount: 0, rows: [] as T[] };
    }
    return originalQuery<T>(sql, params);
  };
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    { pool: createFakePool({ onConnect: async () => pinnedClient }) },
  );
  await handlePostgresSyncWorkerRequest(runtime, { kind: "session_begin", sessionId: "queued-session" });
  const listener = captureRegisteredWorkerListener(runtime);

  const begin = dispatchRegisteredWorkerRequest(listener, {
    kind: "tx_begin",
    txId: "queued-tx",
    mode: "immediate",
    sessionId: "queued-session",
  });
  await beginStarted.promise;
  const end = dispatchRegisteredWorkerRequest(listener, {
    kind: "session_end",
    sessionId: "queued-session",
    destroy: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const endWaitedForBegin = end.state[0] === 0;
  beginGate.resolve();
  await waitForState(begin.state);
  await waitForState(end.state);

  assert.equal(endWaitedForBegin, true);
  assert.deepEqual(begin.messages, [{ ok: true, result: true }]);
  assert.equal(end.messages[0]?.ok, false);
  if (end.messages[0]?.ok === false) {
    assert.match(end.messages[0].error.message, /still owns an active transaction/);
  }
  assert.equal(pinnedClient.released, false);
  assert.equal(runtime.sessions.get("queued-session"), pinnedClient);
  assert.equal(runtime.transactions.get("queued-tx"), pinnedClient);

  await handlePostgresSyncWorkerRequest(runtime, { kind: "tx_rollback", txId: "queued-tx" });
  await handlePostgresSyncWorkerRequest(runtime, {
    kind: "session_end",
    sessionId: "queued-session",
    destroy: false,
  });
});

test("queues rollback and session cleanup behind an in-flight pinned COMMIT", async () => {
  const pinnedClient = createFakeTransactionClient();
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    { pool: createFakePool({ onConnect: async () => pinnedClient }) },
  );
  await handlePostgresSyncWorkerRequest(runtime, { kind: "session_begin", sessionId: "commit-session" });
  await handlePostgresSyncWorkerRequest(runtime, {
    kind: "tx_begin",
    txId: "commit-tx",
    mode: "immediate",
    sessionId: "commit-session",
  });

  const originalQuery = pinnedClient.query.bind(pinnedClient);
  const commitStarted = createDeferred();
  const commitGate = createDeferred();
  pinnedClient.query = async <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => {
    if (sql === "COMMIT") {
      pinnedClient.calls.push({ sql, params });
      commitStarted.resolve();
      await commitGate.promise;
      return { rowCount: 0, rows: [] as T[] };
    }
    return originalQuery<T>(sql, params);
  };
  const listener = captureRegisteredWorkerListener(runtime);
  const commit = dispatchRegisteredWorkerRequest(listener, { kind: "tx_commit", txId: "commit-tx" });
  await commitStarted.promise;
  const rollback = dispatchRegisteredWorkerRequest(listener, { kind: "tx_rollback", txId: "commit-tx" });
  const end = dispatchRegisteredWorkerRequest(listener, {
    kind: "session_end",
    sessionId: "commit-session",
    destroy: true,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cleanupWaitedForCommit = rollback.state[0] === 0 && end.state[0] === 0 && !pinnedClient.released;
  commitGate.resolve();
  await waitForState(commit.state);
  await waitForState(rollback.state);
  await waitForState(end.state);

  assert.equal(cleanupWaitedForCommit, true);
  assert.deepEqual(commit.messages, [{ ok: true, result: true }]);
  assert.equal(rollback.messages[0]?.ok, false);
  if (rollback.messages[0]?.ok === false) {
    assert.match(rollback.messages[0].error.message, /Missing active Postgres transaction commit-tx/);
  }
  assert.deepEqual(end.messages, [{ ok: true, result: true }]);
  assert.deepEqual(
    pinnedClient.calls.map((call) => call.sql),
    ["BEGIN", "COMMIT"],
  );
  assert.deepEqual(pinnedClient.releaseArguments, [true]);
  assert.equal(runtime.sessions.size, 0);
  assert.equal(runtime.transactions.size, 0);
  assert.equal(runtime.transactionSessionIds.size, 0);
});

test("queues worker close behind an in-flight pinned BEGIN", async () => {
  const pinnedClient = createFakeTransactionClient();
  const originalQuery = pinnedClient.query.bind(pinnedClient);
  const beginStarted = createDeferred();
  const beginGate = createDeferred();
  pinnedClient.query = async <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => {
    if (sql === "BEGIN") {
      pinnedClient.calls.push({ sql, params });
      beginStarted.resolve();
      await beginGate.promise;
      return { rowCount: 0, rows: [] as T[] };
    }
    return originalQuery<T>(sql, params);
  };
  let poolEndCount = 0;
  const pool = createFakePool({ onConnect: async () => pinnedClient });
  pool.end = async () => {
    poolEndCount += 1;
  };
  const runtime = createPostgresSyncWorkerRuntime({ database: "goatcitadel" }, { pool });
  await handlePostgresSyncWorkerRequest(runtime, { kind: "session_begin", sessionId: "close-session" });
  const listener = captureRegisteredWorkerListener(runtime);
  const begin = dispatchRegisteredWorkerRequest(listener, {
    kind: "tx_begin",
    txId: "close-tx",
    mode: "immediate",
    sessionId: "close-session",
  });
  await beginStarted.promise;
  const close = dispatchRegisteredWorkerRequest(listener, { kind: "close" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closeWaitedForBegin = close.state[0] === 0 && !pinnedClient.released;
  beginGate.resolve();
  await waitForState(begin.state);
  await waitForState(close.state);

  assert.equal(closeWaitedForBegin, true);
  assert.deepEqual(begin.messages, [{ ok: true, result: true }]);
  assert.deepEqual(close.messages, [{ ok: true, result: true }]);
  assert.deepEqual(
    pinnedClient.calls.map((call) => call.sql),
    ["BEGIN", "ROLLBACK"],
  );
  assert.deepEqual(pinnedClient.releaseArguments, [true]);
  assert.equal(poolEndCount, 1);
  assert.equal(runtime.sessions.size, 0);
  assert.equal(runtime.transactions.size, 0);
  assert.equal(runtime.transactionSessionIds.size, 0);
});

test("keeps the registered request queue live after response delivery fails", async () => {
  const calls: string[] = [];
  const runtime = createPostgresSyncWorkerRuntime(
    { database: "goatcitadel" },
    {
      pool: createFakePool({
        onQuery: async (sql) => {
          calls.push(sql);
          return { rowCount: 1, rows: [] };
        },
      }),
    },
  );
  const listener = captureRegisteredWorkerListener(runtime);
  listener({
    request: { kind: "exec", sql: "FIRST" },
    signal: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    port: {
      postMessage() {
        throw new Error("response port closed");
      },
      close() {},
    },
  });
  const second = dispatchRegisteredWorkerRequest(listener, { kind: "exec", sql: "SECOND" });
  await waitForState(second.state);

  assert.deepEqual(second.messages, [{ ok: true, result: { changes: 1, lastInsertRowid: undefined } }]);
  assert.deepEqual(calls, ["FIRST", "SECOND"]);
});

async function postToWorkerHandler(
  runtime: PostgresSyncWorkerRuntime,
  request: Parameters<typeof respondToPostgresSyncWorkerMessage>[1]["request"],
): Promise<PostgresWorkerResponse> {
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(signal);
  const messages: PostgresWorkerResponse[] = [];

  await respondToPostgresSyncWorkerMessage(runtime, {
    request,
    signal,
    port: {
      postMessage(message: PostgresWorkerResponse) {
        messages.push(message);
      },
      close() {},
    },
  });

  assert.equal(state[0], 1);
  assert.equal(messages.length, 1);
  return messages[0]!;
}

async function waitForState(state: Int32Array): Promise<void> {
  const started = Date.now();
  while (state[0] !== 1) {
    if (Date.now() - started > 5_000) {
      throw new Error("Timed out waiting for sync worker response state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function captureRegisteredWorkerListener(runtime: PostgresSyncWorkerRuntime): (message: unknown) => void {
  let listener: ((message: unknown) => void) | undefined;
  registerPostgresSyncWorkerMessageHandler(
    {
      on(event, callback) {
        assert.equal(event, "message");
        listener = callback as (message: unknown) => void;
        return this;
      },
    },
    runtime,
  );
  assert.ok(listener);
  return listener;
}

function dispatchRegisteredWorkerRequest(
  listener: (message: unknown) => void,
  request: Parameters<typeof respondToPostgresSyncWorkerMessage>[1]["request"],
): { state: Int32Array; messages: PostgresWorkerResponse[] } {
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(signal);
  const messages: PostgresWorkerResponse[] = [];
  listener({
    request,
    signal,
    port: {
      postMessage(message: PostgresWorkerResponse) {
        messages.push(message);
      },
      close() {},
    },
  });
  return { state, messages };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createFakePool(
  input: {
    onQuery?: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
    onConnect?: () => Promise<PostgresSyncWorkerTransactionClient>;
  } = {},
): PostgresSyncWorkerPool {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const result = await (input.onQuery?.(sql, params) ?? Promise.resolve({ rowCount: 0, rows: [] }));
      return {
        rowCount: result.rowCount,
        rows: result.rows as T[],
      };
    },
    async connect() {
      return input.onConnect?.() ?? createFakeTransactionClient();
    },
    async end() {},
    on() {
      return undefined;
    },
  };
}

function createFakeTransactionClient(
  rows: Array<Record<string, unknown>> = [],
  rowCount = rows.length,
): PostgresSyncWorkerTransactionClient & {
  calls: Array<{ sql: string; params?: unknown[] }>;
  released: boolean;
  releaseArguments: Array<boolean | undefined>;
  emitError(error: Error): void;
  errorListenerCount(): number;
} {
  const errorListeners = new Set<(error: Error) => void>();
  const client = {
    calls: [] as Array<{ sql: string; params?: unknown[] }>,
    released: false,
    releaseArguments: [] as Array<boolean | undefined>,
    async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) {
      client.calls.push({ sql, params });
      return { rowCount, rows: rows as T[] };
    },
    release(destroy?: boolean) {
      client.released = true;
      client.releaseArguments.push(destroy);
    },
    on(event: "error", listener: (error: Error) => void) {
      assert.equal(event, "error");
      errorListeners.add(listener);
      return client;
    },
    off(event: "error", listener: (error: Error) => void) {
      assert.equal(event, "error");
      errorListeners.delete(listener);
      return client;
    },
    emitError(error: Error) {
      for (const listener of errorListeners) listener(error);
    },
    errorListenerCount() {
      return errorListeners.size;
    },
  };
  return client;
}
