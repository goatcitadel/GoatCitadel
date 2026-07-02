import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { Pool, types } from "pg";
import type { PostgresConnectionOptions } from "./client.js";
import type { PostgresWorkerRequest, PostgresWorkerResponse } from "./protocol.js";
import { sanitizeParamsForServerEncoding } from "./server-encoding.js";

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
  release(): void;
}

export interface PostgresSyncWorkerPool extends PostgresSyncWorkerQueryExecutor {
  connect(): Promise<PostgresSyncWorkerTransactionClient>;
  end(): Promise<void>;
}

export interface PostgresSyncWorkerRuntime {
  pool: PostgresSyncWorkerPool;
  transactions: Map<string, PostgresSyncWorkerTransactionClient>;
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
  };
}

export interface PostgresSyncWorkerMessageSource {
  on(event: "message", listener: (message: unknown) => void): unknown;
}

export function registerPostgresSyncWorkerMessageHandler(
  workerPort: PostgresSyncWorkerMessageSource,
  runtime: PostgresSyncWorkerRuntime,
): void {
  workerPort.on("message", (message) => {
    void respondToPostgresSyncWorkerMessage(runtime, message as PostgresSyncWorkerMessage);
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
      const executor = request.txId ? getTransactionClient(runtime, request.txId) : runtime.pool;
      const result = await executor.query(
        request.sql,
        sanitizeParamsForServerEncoding(request.params, await getServerEncoding(runtime), request.sql),
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
      const executor = request.txId ? getTransactionClient(runtime, request.txId) : runtime.pool;
      const result = await executor.query(request.sql);
      return {
        changes: result.rowCount ?? 0,
        lastInsertRowid: undefined,
      };
    }
    case "tx_begin": {
      if (runtime.transactions.has(request.txId)) {
        throw new Error(`Postgres transaction ${request.txId} is already active`);
      }
      const client = await runtime.pool.connect();
      try {
        await client.query("BEGIN");
      } catch (error) {
        // Release the checked-out client so a failed BEGIN does not leak it from the pool.
        // Repeated failures would otherwise exhaust the pool and block all DB access for the
        // worker, not just transactions.
        client.release();
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
        runtime.transactions.delete(request.txId);
        client.release();
      }
      return true;
    }
    case "tx_rollback": {
      const client = getTransactionClient(runtime, request.txId);
      try {
        await client.query("ROLLBACK");
      } finally {
        runtime.transactions.delete(request.txId);
        client.release();
      }
      return true;
    }
    case "close": {
      for (const [txId, client] of runtime.transactions.entries()) {
        try {
          await client.query("ROLLBACK");
        } finally {
          runtime.transactions.delete(txId);
          client.release();
        }
      }
      await runtime.pool.end();
      return true;
    }
  }
}

function getTransactionClient(runtime: PostgresSyncWorkerRuntime, txId: string): PostgresSyncWorkerTransactionClient {
  const client = runtime.transactions.get(txId);
  if (!client) {
    throw new Error(`Missing active Postgres transaction ${txId}`);
  }
  return client;
}

export function buildPostgresSyncWorkerPoolConfig(options: PostgresConnectionOptions) {
  if (options.connectionString?.trim()) {
    return {
      connectionString: options.connectionString.trim(),
      options: "-c client_encoding=UTF8",
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
    options: "-c client_encoding=UTF8",
    max: options.pool?.max ?? 10,
    min: options.pool?.min ?? 0,
    idleTimeoutMillis: options.pool?.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.pool?.connectionTimeoutMs ?? 5_000,
    application_name: options.applicationName ?? "goatcitadel-sync-worker",
    ssl: options.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
  };
}

async function getServerEncoding(runtime: PostgresSyncWorkerRuntime): Promise<string | undefined> {
  if (!runtime.serverEncodingPromise) {
    runtime.serverEncodingPromise = runtime.pool
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
