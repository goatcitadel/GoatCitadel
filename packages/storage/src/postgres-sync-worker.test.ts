import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPostgresSyncWorkerPoolConfig,
  createPostgresSyncWorkerRuntime,
  handlePostgresSyncWorkerRequest,
  registerPostgresSyncWorkerMessageHandler,
  respondToPostgresSyncWorkerMessage,
  serializePostgresSyncWorkerError,
  type PostgresSyncWorkerPool,
  type PostgresSyncWorkerRuntime,
  type PostgresSyncWorkerTransactionClient,
} from "./postgres/sync-worker.js";
import type { PostgresWorkerResponse } from "./postgres/protocol.js";

test("builds Postgres worker pool config for connection strings and discrete options", () => {
  const fromConnectionString = buildPostgresSyncWorkerPoolConfig({
    connectionString: " postgres://user:pass@example.test/db ",
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
    connectionString: "postgres://user:pass@example.test/db",
    options: "-c client_encoding=UTF8",
    max: 7,
    min: 2,
    idleTimeoutMillis: 123,
    connectionTimeoutMillis: 456,
    application_name: "coverage-worker",
    ssl: { rejectUnauthorized: false },
  });

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
    ["BEGIN", "SELECT * FROM task WHERE id = $1", "COMMIT"],
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
  };
}

function createFakeTransactionClient(
  rows: Array<Record<string, unknown>> = [],
  rowCount = rows.length,
): PostgresSyncWorkerTransactionClient & {
  calls: Array<{ sql: string; params?: unknown[] }>;
  released: boolean;
} {
  const client = {
    calls: [] as Array<{ sql: string; params?: unknown[] }>,
    released: false,
    async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) {
      client.calls.push({ sql, params });
      return { rowCount, rows: rows as T[] };
    },
    release() {
      client.released = true;
    },
  };
  return client;
}
