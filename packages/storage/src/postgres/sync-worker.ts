import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { Pool, types } from "pg";
import type { PostgresConnectionOptions } from "./client.js";
import type { PostgresWorkerRequest, PostgresWorkerResponse } from "./protocol.js";
import { sanitizeParamsForServerEncoding } from "./server-encoding.js";
import { buildPostgresConnectionStringStartupConfig, buildPostgresStartupOptions } from "./startup-options.js";

types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(21, (value) => Number(value));
types.setTypeParser(23, (value) => Number(value));
types.setTypeParser(1700, parsePostgresNumeric);
types.setTypeParser(700, (value) => Number(value));
types.setTypeParser(701, (value) => Number(value));

export function parsePostgresNumeric(value: string): number {
  return Number(value);
}

export interface PostgresSyncWorkerQueryExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{
    rowCount: number | null;
    rows: T[];
  }>;
}

export interface PostgresSyncWorkerTransactionClient extends PostgresSyncWorkerQueryExecutor {
  release(destroy?: boolean): void;
}

export interface PostgresSyncWorkerPool extends PostgresSyncWorkerQueryExecutor {
  connect(): Promise<PostgresSyncWorkerTransactionClient>;
  end(): Promise<void>;
}

export interface PostgresSyncWorkerRuntime {
  pool: PostgresSyncWorkerPool;
  transactions: Map<string, PostgresSyncWorkerTransactionClient>;
  transactionSessionIds: Map<string, string>;
  sessions: Map<string, PostgresSyncWorkerTransactionClient>;
  serverEncodingPromise?: Promise<string | undefined>;
}

export function createPostgresSyncWorkerRuntime(
  options: PostgresConnectionOptions,
  input: {
    pool?: PostgresSyncWorkerPool;
  } = {},
): PostgresSyncWorkerRuntime {
  return {
    pool: input.pool ?? (new Pool(buildPostgresSyncWorkerPoolConfig(options)) as unknown as PostgresSyncWorkerPool),
    transactions: new Map(),
    transactionSessionIds: new Map(),
    sessions: new Map(),
  };
}

export interface PostgresSyncWorkerMessageSource {
  on(event: "message", listener: (message: unknown) => void): unknown;
}

export function registerPostgresSyncWorkerMessageHandler(
  workerPort: PostgresSyncWorkerMessageSource,
  runtime: PostgresSyncWorkerRuntime,
): void {
  let responseTail = Promise.resolve();
  workerPort.on("message", (message) => {
    // The host protocol is synchronous, but a timed-out host request can send
    // cleanup while the original worker operation is still settling. Preserve
    // message order so BEGIN/COMMIT cannot overlap session_end, rollback, or
    // close on the same client. A failed response port must not poison the tail.
    responseTail = responseTail
      .then(() => respondToPostgresSyncWorkerMessage(runtime, message as PostgresSyncWorkerMessage))
      .catch(() => undefined);
  });
}

export interface PostgresSyncWorkerMessage {
  request: PostgresWorkerRequest;
  port: Pick<MessagePort, "postMessage" | "close">;
  signal: SharedArrayBuffer;
}

export async function respondToPostgresSyncWorkerMessage(
  runtime: PostgresSyncWorkerRuntime,
  message: PostgresSyncWorkerMessage,
): Promise<void> {
  const { request, port, signal } = message;
  const state = new Int32Array(signal);
  let response: PostgresWorkerResponse;
  try {
    response = {
      ok: true,
      result: await handlePostgresSyncWorkerRequest(runtime, request),
    };
  } catch (error) {
    const sql = request.kind === "query" || request.kind === "exec" ? request.sql : undefined;
    response = {
      ok: false,
      error: serializePostgresSyncWorkerError(error, sql),
    };
  }

  port.postMessage(response);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0, 1);
  port.close();
}

export async function handlePostgresSyncWorkerRequest(
  runtime: PostgresSyncWorkerRuntime,
  request: PostgresWorkerRequest,
): Promise<unknown> {
  switch (request.kind) {
    case "query": {
      const executor = getRequestExecutor(runtime, request.txId, request.sessionId);
      const result = await executor.query(
        request.sql,
        sanitizeParamsForServerEncoding(request.params, await getServerEncoding(runtime, executor), request.sql),
      );
      if (request.mode === "run") {
        return {
          changes: result.rowCount ?? 0,
          lastInsertRowid: undefined,
        };
      }
      if (request.mode === "one") {
        return result.rows[0];
      }
      return result.rows;
    }
    case "exec": {
      const executor = getRequestExecutor(runtime, request.txId, request.sessionId);
      const result = await executor.query(request.sql);
      return {
        changes: result.rowCount ?? 0,
        lastInsertRowid: undefined,
      };
    }
    case "session_begin": {
      if (runtime.sessions.has(request.sessionId)) {
        throw new Error(`Postgres pinned session ${request.sessionId} is already active`);
      }
      const client = await runtime.pool.connect();
      runtime.sessions.set(request.sessionId, client);
      return true;
    }
    case "session_end": {
      const client = getPinnedSessionClient(runtime, request.sessionId);
      if (Array.from(runtime.transactionSessionIds.values()).includes(request.sessionId)) {
        throw new Error(`Postgres pinned session ${request.sessionId} still owns an active transaction`);
      }
      runtime.sessions.delete(request.sessionId);
      client.release(request.destroy);
      return true;
    }
    case "tx_begin": {
      if (runtime.transactions.has(request.txId) || runtime.transactionSessionIds.has(request.txId)) {
        throw new Error(`Postgres transaction ${request.txId} is already active`);
      }
      const client = request.sessionId
        ? getPinnedSessionClient(runtime, request.sessionId)
        : await runtime.pool.connect();
      if (request.sessionId) {
        // Reserve ownership before BEGIN yields. Otherwise session_end can run
        // concurrently, release the pinned client, and leave a late BEGIN as an
        // orphan transaction on that released connection.
        runtime.transactionSessionIds.set(request.txId, request.sessionId);
      }
      try {
        await client.query("BEGIN");
      } catch (error) {
        // Release the checked-out client so a failed BEGIN does not leak it from the pool.
        // Repeated failures would otherwise exhaust the pool and block all DB access for the
        // worker, not just transactions.
        if (request.sessionId) {
          runtime.transactionSessionIds.delete(request.txId);
        } else {
          client.release();
        }
        throw error;
      }
      runtime.transactions.set(request.txId, client);
      return true;
    }
    case "tx_commit": {
      const client = getTransactionClient(runtime, request.txId);
      try {
        await client.query("COMMIT");
      } finally {
        const isPinnedSessionTransaction = runtime.transactionSessionIds.delete(request.txId);
        runtime.transactions.delete(request.txId);
        if (!isPinnedSessionTransaction) {
          client.release();
        }
      }
      return true;
    }
    case "tx_rollback": {
      const client = getTransactionClient(runtime, request.txId);
      try {
        await client.query("ROLLBACK");
      } finally {
        const isPinnedSessionTransaction = runtime.transactionSessionIds.delete(request.txId);
        runtime.transactions.delete(request.txId);
        if (!isPinnedSessionTransaction) {
          client.release();
        }
      }
      return true;
    }
    case "close": {
      for (const [txId, client] of runtime.transactions.entries()) {
        try {
          await client.query("ROLLBACK");
        } finally {
          const isPinnedSessionTransaction = runtime.transactionSessionIds.delete(txId);
          runtime.transactions.delete(txId);
          if (!isPinnedSessionTransaction) {
            client.release();
          }
        }
      }
      for (const [sessionId, client] of runtime.sessions.entries()) {
        runtime.sessions.delete(sessionId);
        client.release(true);
      }
      await runtime.pool.end();
      return true;
    }
  }
}

function getRequestExecutor(
  runtime: PostgresSyncWorkerRuntime,
  txId: string | undefined,
  sessionId: string | undefined,
): PostgresSyncWorkerQueryExecutor {
  if (txId) {
    return getTransactionClient(runtime, txId);
  }
  if (sessionId) {
    return getPinnedSessionClient(runtime, sessionId);
  }
  return runtime.pool;
}

function getTransactionClient(runtime: PostgresSyncWorkerRuntime, txId: string): PostgresSyncWorkerTransactionClient {
  const client = runtime.transactions.get(txId);
  if (!client) {
    throw new Error(`Missing active Postgres transaction ${txId}`);
  }
  return client;
}

function getPinnedSessionClient(
  runtime: PostgresSyncWorkerRuntime,
  sessionId: string,
): PostgresSyncWorkerTransactionClient {
  const client = runtime.sessions.get(sessionId);
  if (!client) {
    throw new Error(`Missing active Postgres pinned session ${sessionId}`);
  }
  return client;
}

export function buildPostgresSyncWorkerPoolConfig(options: PostgresConnectionOptions) {
  if (options.connectionString?.trim()) {
    return {
      ...buildPostgresConnectionStringStartupConfig(options.connectionString),
      max: options.pool?.max ?? 10,
      min: options.pool?.min ?? 0,
      idleTimeoutMillis: options.pool?.idleTimeoutMs ?? 30_000,
      connectionTimeoutMillis: options.pool?.connectionTimeoutMs ?? 5_000,
      application_name: options.applicationName ?? "goatcitadel-sync-worker",
      ssl: options.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
    };
  }

  return {
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 5432,
    database: options.database,
    user: options.user,
    password: options.password,
    options: buildPostgresStartupOptions(),
    max: options.pool?.max ?? 10,
    min: options.pool?.min ?? 0,
    idleTimeoutMillis: options.pool?.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.pool?.connectionTimeoutMs ?? 5_000,
    application_name: options.applicationName ?? "goatcitadel-sync-worker",
    ssl: options.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
  };
}

async function getServerEncoding(
  runtime: PostgresSyncWorkerRuntime,
  executor: PostgresSyncWorkerQueryExecutor = runtime.pool,
): Promise<string | undefined> {
  if (!runtime.serverEncodingPromise) {
    runtime.serverEncodingPromise = executor
      .query<{ server_encoding: string }>("SELECT current_setting('server_encoding') AS server_encoding")
      .then((result) => result.rows[0]?.server_encoding)
      .catch(() => undefined);
  }
  return runtime.serverEncodingPromise;
}

export function serializePostgresSyncWorkerError(error: unknown, sql?: string) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sql ? `${error.message}\nSQL: ${sql}` : error.message,
      stack: error.stack,
    };
  }
  return {
    name: "Error",
    message: sql ? `${String(error)}\nSQL: ${sql}` : String(error),
  };
}

const runtime = parentPort && createPostgresSyncWorkerRuntime(workerData as PostgresConnectionOptions);

if (parentPort && runtime) registerPostgresSyncWorkerMessageHandler(parentPort, runtime);
