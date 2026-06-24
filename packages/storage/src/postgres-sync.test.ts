import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { DbRunResult } from "./db.js";
import { PostgresSyncDatabaseClient, __postgresSyncInternals } from "./postgres/sync.js";
import {
  buildPostgresSyncWorkerPoolConfig,
  handlePostgresSyncWorkerRequest,
  serializePostgresSyncWorkerError,
  type PostgresSyncWorkerRuntime,
} from "./postgres/sync-worker.js";

function createClientHarness() {
  const calls: Array<{ mode: "run" | "get" | "all"; sql: string; params: unknown[] }> = [];
  const client = Object.create(PostgresSyncDatabaseClient.prototype) as PostgresSyncDatabaseClient & {
    executeRun: (sql: string, params: unknown[]) => DbRunResult;
    executeGet: <T = unknown>(sql: string, params: unknown[]) => T | undefined;
    executeAll: <T = unknown>(sql: string, params: unknown[]) => T[];
  };
  client.executeRun = (sql, params) => {
    calls.push({ mode: "run", sql, params });
    return { changes: 2 };
  };
  client.executeGet = <T = unknown>(sql: string, params: unknown[]) => {
    calls.push({ mode: "get", sql, params });
    return { ok: true } as T;
  };
  client.executeAll = <T = unknown>(sql: string, params: unknown[]) => {
    calls.push({ mode: "all", sql, params });
    return [{ ok: true }] as T[];
  };
  return { client, calls };
}

type SyncHarnessInternals = {
  dialect: "postgres";
  worker: {
    postMessage: ReturnType<typeof mock.fn>;
    terminate: ReturnType<typeof mock.fn>;
  };
  closed: boolean;
  fatalError?: Error;
  activeTransactionId?: string;
  nestedTransactionDepth: number;
};

function createSyncHarness(
  respond: (
    request: unknown,
  ) => { ok: true; result: unknown } | { ok: false; error: { name: string; message: string; stack?: string } },
): { client: PostgresSyncDatabaseClient; internals: SyncHarnessInternals; requests: unknown[] } {
  const requests: unknown[] = [];
  const client = Object.create(PostgresSyncDatabaseClient.prototype) as PostgresSyncDatabaseClient;
  const internals = client as unknown as SyncHarnessInternals;
  internals.dialect = "postgres";
  internals.worker = {
    postMessage: mock.fn((message: unknown) => {
      const typedMessage = message as {
        request: unknown;
        port: { postMessage: (response: unknown) => void };
        signal: SharedArrayBuffer;
      };
      requests.push(typedMessage.request);
      typedMessage.port.postMessage(respond(typedMessage.request));
      const state = new Int32Array(typedMessage.signal);
      Atomics.store(state, 0, 1);
      Atomics.notify(state, 0, 1);
    }),
    terminate: mock.fn(async () => 0),
  };
  internals.closed = false;
  internals.nestedTransactionDepth = 0;
  return { client, internals, requests };
}

describe("PostgresSyncDatabaseClient statement adapter", () => {
  it("constructs a worker-backed client without issuing a request", async () => {
    const client = new PostgresSyncDatabaseClient({ database: "coverage-constructor" });
    const internals = client as unknown as {
      worker: { terminate: () => Promise<number> };
    };

    assert.equal(client.dialect, "postgres");
    await internals.worker.terminate();
  });

  it("routes exec, query helpers, transactions, worker errors, and close operations through the sync request path", () => {
    const { client, internals, requests } = createSyncHarness((request) => {
      const typedRequest = request as { kind: string; mode?: string };
      if (typedRequest.kind === "query" && typedRequest.mode === "run") {
        return { ok: true, result: { changes: 1 } };
      }
      if (typedRequest.kind === "query" && typedRequest.mode === "one") {
        return { ok: true, result: { row: "one" } };
      }
      if (typedRequest.kind === "query" && typedRequest.mode === "all") {
        return { ok: true, result: [{ row: "all" }] };
      }
      return { ok: true, result: undefined };
    });

    assert.equal(client.dialect, "postgres");
    client.exec("SELECT 1");
    assert.deepEqual(client.prepare("UPDATE tasks SET title = ?").run("done"), { changes: 1 });
    assert.deepEqual(client.executeGet("SELECT * FROM tasks WHERE task_id = ?", ["task-1"]), { row: "one" });
    assert.deepEqual(client.executeAll("SELECT * FROM tasks WHERE status = ?", ["open"]), [{ row: "all" }]);
    assert.equal(
      client.transaction("immediate", () => {
        client.exec("SELECT 2");
        return "committed";
      }),
      "committed",
    );
    assert.equal(
      client.transaction("immediate", () =>
        client.transaction("immediate", () => {
          client.exec("SELECT nested");
          return "nested";
        }),
      ),
      "nested",
    );
    assert.throws(
      () =>
        client.transaction("immediate", () =>
          client.transaction("immediate", () => {
            throw new Error("nested rollback me");
          }),
        ),
      /nested rollback me/,
    );
    assert.throws(
      () =>
        client.transaction("immediate", () => {
          throw new Error("rollback me");
        }),
      /rollback me/,
    );
    client.close();
    client.close();
    assert.equal(internals.worker.terminate.mock.callCount(), 1);
    assert.throws(() => client.exec("SELECT 3"), /already closed/);
    assert.deepEqual(
      requests.map((request) => (request as { kind: string }).kind),
      [
        "exec",
        "query",
        "query",
        "query",
        "tx_begin",
        "exec",
        "tx_commit",
        "tx_begin",
        "exec",
        "exec",
        "exec",
        "tx_commit",
        "tx_begin",
        "exec",
        "exec",
        "exec",
        "tx_rollback",
        "tx_begin",
        "tx_rollback",
        "close",
      ],
    );

    const errored = createSyncHarness(() => ({
      ok: false,
      error: { name: "QueryError", message: "bad query", stack: "stack line" },
    })).client;
    assert.throws(() => errored.exec("SELECT bad"), /bad query/);

    const fatal = createSyncHarness(() => ({ ok: true, result: undefined }));
    fatal.internals.fatalError = new Error("worker failed");
    assert.throws(() => fatal.client.exec("SELECT fatal"), /worker failed/);
  });

  it("reports timed out and missing worker responses", () => {
    const timedOut = createSyncHarness(() => ({ ok: true, result: undefined }));
    const waitMock = mock.method(Atomics, "wait", () => "timed-out");
    try {
      assert.throws(() => timedOut.client.exec("SELECT timeout"), /Timed out waiting for Postgres response \(exec\)/);
    } finally {
      waitMock.mock.restore();
    }

    const noResponse = createSyncHarness(() => ({ ok: true, result: undefined }));
    noResponse.internals.worker.postMessage = mock.fn((message: unknown) => {
      const typedMessage = message as { signal: SharedArrayBuffer };
      const state = new Int32Array(typedMessage.signal);
      Atomics.store(state, 0, 1);
      Atomics.notify(state, 0, 1);
    });

    assert.throws(() => noResponse.client.exec("SELECT no-response"), /did not return a response/);
  });

  it("terminates the worker when a close response times out", () => {
    const timedOut = createSyncHarness(() => ({ ok: true, result: undefined }));
    const waitMock = mock.method(Atomics, "wait", () => "timed-out");
    try {
      assert.doesNotThrow(() => timedOut.client.close());
    } finally {
      waitMock.mock.restore();
    }

    assert.equal(timedOut.internals.closed, true);
    assert.equal(timedOut.internals.worker.terminate.mock.callCount(), 1);
    assert.match(timedOut.internals.fatalError?.message ?? "", /Timed out waiting for Postgres response \(close\)/);
    assert.throws(() => timedOut.client.exec("SELECT after-close"), /already closed/);
  });

  it("translates positional parameters for run, get, and all calls", () => {
    const { client, calls } = createClientHarness();
    const statement = client.prepare("SELECT * FROM tasks WHERE status = ? AND workspace_id = ?");

    assert.deepEqual(statement.run("review", "default"), { changes: 2 });
    assert.deepEqual(statement.get("review", "default"), { ok: true });
    assert.deepEqual(statement.all("review", "default"), [{ ok: true }]);
    assert.deepEqual(
      calls.map((call) => call.sql),
      [
        "SELECT * FROM tasks WHERE status = $1 AND workspace_id = $2",
        "SELECT * FROM tasks WHERE status = $1 AND workspace_id = $2",
        "SELECT * FROM tasks WHERE status = $1 AND workspace_id = $2",
      ],
    );
    assert.deepEqual(calls[0]?.params, ["review", "default"]);
  });

  it("translates named parameters and falls back to undefined for missing or non-record params", () => {
    const named = __postgresSyncInternals.translateSql(
      "UPDATE tasks SET status = @status WHERE task_id = @taskId AND workspace_id = @workspaceId",
      [{ status: "done", taskId: "task-a" }],
    );
    const missing = __postgresSyncInternals.translateSql("SELECT @value AS value", [["not", "a", "record"]]);

    assert.equal(named.sql, "UPDATE tasks SET status = $1 WHERE task_id = $2 AND workspace_id = $3");
    assert.deepEqual(named.params, ["done", "task-a", undefined]);
    assert.deepEqual(missing.params, [undefined]);
    assert.equal(__postgresSyncInternals.isRecord({ value: true }), true);
    assert.equal(__postgresSyncInternals.isRecord(["not", "record"]), false);
  });

  it("resolves the worker URL and preserves serialized worker error details", () => {
    const workerUrl = __postgresSyncInternals.resolveWorkerUrl();
    const error = __postgresSyncInternals.deserializeWorkerError({
      name: "QueryError",
      message: "bad query",
      stack: "stack line",
    });

    assert.match(workerUrl.pathname, /sync-worker\.(ts|js)$/);
    assert.equal(
      __postgresSyncInternals.resolveWorkerUrl(
        new URL("file:///repo/packages/storage/src/postgres/sync.ts"),
        () => true,
      ).href,
      "file:///repo/packages/storage/dist/postgres/sync-worker.js",
    );
    assert.equal(
      __postgresSyncInternals.resolveWorkerUrl(
        new URL("file:///repo/packages/storage/src/postgres/sync.ts"),
        () => false,
      ).href,
      "file:///repo/packages/storage/src/postgres/sync-worker.ts",
    );
    assert.equal(
      __postgresSyncInternals.resolveWorkerUrl(
        new URL("file:///repo/packages/storage/dist/postgres/sync.js"),
        () => true,
      ).href,
      "file:///repo/packages/storage/dist/postgres/sync-worker.js",
    );
    assert.deepEqual(
      __postgresSyncInternals.resolveWorkerExecArgv(new URL("file:///repo/src/postgres/sync-worker.ts"), [
        "--test",
        "--require",
        "/repo/node_modules/tsx/dist/preflight.cjs",
        "--import",
        "file:///repo/node_modules/tsx/dist/loader.mjs",
        "--inspect",
      ]),
      [
        "--require",
        "/repo/node_modules/tsx/dist/preflight.cjs",
        "--import",
        "file:///repo/node_modules/tsx/dist/loader.mjs",
      ],
    );
    assert.deepEqual(
      __postgresSyncInternals.resolveWorkerExecArgv(new URL("file:///repo/src/postgres/sync-worker.ts"), [
        "--require=/repo/node_modules/tsx/dist/preflight.cjs",
        "--import=file:///repo/node_modules/tsx/dist/loader.mjs",
        "--test",
      ]),
      ["--require=/repo/node_modules/tsx/dist/preflight.cjs", "--import=file:///repo/node_modules/tsx/dist/loader.mjs"],
    );
    assert.equal(
      __postgresSyncInternals.resolveWorkerExecArgv(new URL("file:///repo/dist/postgres/sync-worker.js"), [
        "--require",
        "/repo/node_modules/tsx/dist/preflight.cjs",
      ]),
      undefined,
    );
    assert.equal(error.name, "QueryError");
    assert.equal(error.message, "bad query");
    assert.equal(error.stack, "stack line");
    assert.equal(
      __postgresSyncInternals.isCloseTimeoutError(new Error("Timed out waiting for Postgres response (close).")),
      true,
    );
    assert.equal(
      __postgresSyncInternals.isCloseTimeoutError(new Error("Timed out waiting for Postgres response (query).")),
      false,
    );
  });

  it("covers sync-worker pool config defaults, cached server encoding, and transaction cleanup", async () => {
    const connectionStringConfig = buildPostgresSyncWorkerPoolConfig({
      connectionString: " postgres://user:pass@localhost:5432/db ",
      database: "db",
      applicationName: "worker-test",
      sslMode: "require",
      pool: {
        max: 3,
        min: 1,
        idleTimeoutMs: 1234,
        connectionTimeoutMs: 5678,
      },
    });
    assert.deepEqual(connectionStringConfig, {
      connectionString: "postgres://user:pass@localhost:5432/db",
      options: "-c client_encoding=UTF8",
      max: 3,
      min: 1,
      idleTimeoutMillis: 1234,
      connectionTimeoutMillis: 5678,
      application_name: "worker-test",
      ssl: { rejectUnauthorized: false },
    });

    const hostConfig = buildPostgresSyncWorkerPoolConfig({ database: "goatcitadel" });
    assert.deepEqual(hostConfig, {
      host: "127.0.0.1",
      port: 5432,
      database: "goatcitadel",
      user: undefined,
      password: undefined,
      options: "-c client_encoding=UTF8",
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      application_name: "goatcitadel-sync-worker",
      ssl: undefined,
    });

    const querySql: string[] = [];
    const released: string[] = [];
    const transactionClient = {
      query: mock.fn(async (sql: string) => {
        querySql.push(sql);
        return { rowCount: 1, rows: [] };
      }),
      release: mock.fn(() => {
        released.push("released");
      }),
    };
    const runtime: PostgresSyncWorkerRuntime = {
      pool: {
        query: mock.fn(async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string) => {
          querySql.push(sql);
          if (sql.includes("current_setting")) {
            return { rowCount: 1, rows: [{ server_encoding: "WIN1252" }] as unknown as T[] };
          }
          return { rowCount: null, rows: [{ ok: true }] as unknown as T[] };
        }),
        connect: mock.fn(async () => transactionClient),
        end: mock.fn(async () => undefined),
      },
      transactions: new Map([["tx-existing", transactionClient]]),
    };

    assert.deepEqual(
      await handlePostgresSyncWorkerRequest(runtime, {
        kind: "query",
        mode: "run",
        sql: "INSERT INTO prompt_runs(payload) VALUES (?)",
        params: [{ text: "emoji \u{1f410}" }],
      }),
      { changes: 0, lastInsertRowid: undefined },
    );
    assert.equal(querySql.filter((sql) => sql.includes("current_setting")).length, 1);
    await handlePostgresSyncWorkerRequest(runtime, {
      kind: "query",
      mode: "one",
      sql: "SELECT ? AS payload",
      params: ["cached"],
    });
    assert.equal(querySql.filter((sql) => sql.includes("current_setting")).length, 1);

    await assert.rejects(
      handlePostgresSyncWorkerRequest(runtime, {
        kind: "tx_begin",
        txId: "tx-existing",
        mode: "deferred",
      }),
      /already active/,
    );
    await assert.rejects(
      handlePostgresSyncWorkerRequest(runtime, {
        kind: "exec",
        txId: "missing-tx",
        sql: "SELECT 1",
      }),
      /Missing active Postgres transaction missing-tx/,
    );

    assert.equal(await handlePostgresSyncWorkerRequest(runtime, { kind: "close" }), true);
    assert.equal(runtime.transactions.size, 0);
    assert.equal(released.length, 1);

    assert.deepEqual(serializePostgresSyncWorkerError("plain failure", "SELECT bad"), {
      name: "Error",
      message: "plain failure\nSQL: SELECT bad",
    });
  });
});
