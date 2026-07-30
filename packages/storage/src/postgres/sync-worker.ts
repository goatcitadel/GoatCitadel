import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { Pool, types } from "pg";
import type { PostgresConnectionOptions } from "./client.js";
import type { PostgresWorkerRequest, PostgresWorkerResponse } from "./protocol.js";
import { sanitizeParamsForServerEncoding } from "./server-encoding.js";
import { buildPostgresConnectionStringStartupConfig, buildPostgresStartupOptions } from "./startup-options.js";

types.setTypeParser(20, parsePostgresInt8);
types.setTypeParser(21, (value) => Number(value));
types.setTypeParser(23, (value) => Number(value));
types.setTypeParser(1700, parsePostgresNumeric);
types.setTypeParser(700, (value) => Number(value));
types.setTypeParser(701, (value) => Number(value));

export function parsePostgresNumeric(value: string): number {
  return Number(value);
}

/**
 * OID 20 is int8 (64-bit bigint) — revision counters, sequences, and row
 * counts. `Number()` silently loses precision past `MAX_SAFE_INTEGER`, so
 * fail loud instead of returning a corrupted value.
 */
export function parsePostgresInt8(value: string): number {
  const parsed = BigInt(value);
  if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`PostgreSQL int8 value is outside the JavaScript safe integer range: ${value}`);
  }
  return Number(parsed);
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
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

export interface PostgresSyncWorkerPool extends PostgresSyncWorkerQueryExecutor {
  connect(): Promise<PostgresSyncWorkerTransactionClient>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface PostgresSyncWorkerRuntime {
  pool: PostgresSyncWorkerPool;
  transactions: Map<string, PostgresSyncWorkerTransactionClient>;
  transactionSessionIds: Map<string, string>;
  sessions: Map<string, PostgresSyncWorkerTransactionClient>;
  checkedOutClients: Map<PostgresSyncWorkerTransactionClient, PostgresSyncWorkerCheckedOutClientState>;
  onCheckedOutClientError?: (error: Error, owner: PostgresSyncWorkerCheckedOutClientOwner) => void;
  serverEncodingPromise?: Promise<string | undefined>;
}

export interface PostgresSyncWorkerCheckedOutClientOwner {
  kind: "session" | "transaction";
  id: string;
}

interface PostgresSyncWorkerCheckedOutClientState {
  owner: PostgresSyncWorkerCheckedOutClientOwner;
  listener: (error: Error) => void;
  error?: Error;
}

export function createPostgresSyncWorkerRuntime(
  options: PostgresConnectionOptions,
  input: {
    pool?: PostgresSyncWorkerPool;
    onPoolError?: (error: Error) => void;
    onCheckedOutClientError?: (error: Error, owner: PostgresSyncWorkerCheckedOutClientOwner) => void;
  } = {},
): PostgresSyncWorkerRuntime {
  const pool =
    input.pool ?? (new Pool(buildPostgresSyncWorkerPoolConfig(options)) as unknown as PostgresSyncWorkerPool);
  pool.on("error", (error) => {
    reportPostgresSyncWorkerPoolError(error, input.onPoolError);
  });
  return {
    pool,
    transactions: new Map(),
    transactionSessionIds: new Map(),
    sessions: new Map(),
    checkedOutClients: new Map(),
    onCheckedOutClientError: input.onCheckedOutClientError,
  };
}

/**
 * `pg.Pool` emits `error` when an idle connection fails in the background. An
 * error listener is mandatory: without one, EventEmitter terminates the sync
 * worker and the Gateway's synchronous storage client remains permanently
 * fatal even after Postgres is reachable again. The pool has already removed
 * the failed idle client before this callback and reconnects on a later query.
 */
export function reportPostgresSyncWorkerPoolError(error: Error, reporter?: (error: Error) => void): void {
  if (reporter) {
    try {
      reporter(error);
      return;
    } catch (reportingError) {
      emitPostgresSyncWorkerPoolWarning(error, reportingError);
      return;
    }
  }
  emitPostgresSyncWorkerPoolWarning(error);
}

function emitPostgresSyncWorkerPoolWarning(error: Error, reportingError?: unknown): void {
  const databaseCode = readPostgresErrorCode(error);
  const reportingSuffix = reportingError
    ? `; custom reporter failed: ${reportingError instanceof Error ? reportingError.message : String(reportingError)}`
    : "";
  process.emitWarning(
    `Postgres sync pool discarded a failed idle connection${databaseCode ? ` (${databaseCode})` : ""}: ${error.message}${reportingSuffix}`,
    { code: "GOATCITADEL_POSTGRES_IDLE_CONNECTION_ERROR" },
  );
}

function readPostgresErrorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/**
 * A checked-out pg client no longer has the pool's idle error listener. Own an
 * explicit listener for the full pinned-session/transaction checkout so a
 * restart cannot surface as an unhandled EventEmitter `error` in the worker.
 * Transactions are never replayed: a failed checkout is fenced, destroyed on
 * release, and a later independent request may obtain a fresh pool client.
 */
export function ownPostgresSyncWorkerCheckedOutClient(
  runtime: PostgresSyncWorkerRuntime,
  client: PostgresSyncWorkerTransactionClient,
  owner: PostgresSyncWorkerCheckedOutClientOwner,
): void {
  if (runtime.checkedOutClients.has(client)) {
    return;
  }
  const state: PostgresSyncWorkerCheckedOutClientState = {
    owner,
    listener: (error) => {
      state.error = error;
      reportPostgresSyncWorkerCheckedOutClientError(error, owner, runtime.onCheckedOutClientError);
    },
  };
  runtime.checkedOutClients.set(client, state);
  try {
    client.on("error", state.listener);
  } catch (error) {
    runtime.checkedOutClients.delete(client);
    client.release(true);
    throw error;
  }
}

export function releasePostgresSyncWorkerCheckedOutClient(
  runtime: PostgresSyncWorkerRuntime,
  client: PostgresSyncWorkerTransactionClient,
  destroy?: boolean,
): void {
  const state = runtime.checkedOutClients.get(client);
  let destroyClient = destroy === true || state?.error !== undefined;
  if (state) {
    try {
      client.off("error", state.listener);
    } catch (error) {
      destroyClient = true;
      reportPostgresSyncWorkerCheckedOutClientError(
        error instanceof Error ? error : new Error(String(error)),
        state.owner,
        runtime.onCheckedOutClientError,
      );
    } finally {
      runtime.checkedOutClients.delete(client);
    }
  }
  client.release(destroyClient ? true : destroy);
}

export function reportPostgresSyncWorkerCheckedOutClientError(
  error: Error,
  owner: PostgresSyncWorkerCheckedOutClientOwner,
  reporter?: (error: Error, owner: PostgresSyncWorkerCheckedOutClientOwner) => void,
): void {
  if (reporter) {
    try {
      reporter(error, owner);
      return;
    } catch (reportingError) {
      emitPostgresSyncWorkerCheckedOutClientWarning(error, owner, reportingError);
      return;
    }
  }
  emitPostgresSyncWorkerCheckedOutClientWarning(error, owner);
}

function emitPostgresSyncWorkerCheckedOutClientWarning(
  error: Error,
  owner: PostgresSyncWorkerCheckedOutClientOwner,
  reportingError?: unknown,
): void {
  const databaseCode = readPostgresErrorCode(error);
  const reportingSuffix = reportingError
    ? `; custom reporter failed: ${reportingError instanceof Error ? reportingError.message : String(reportingError)}`
    : "";
  process.emitWarning(
    `Postgres sync worker fenced failed checked-out ${owner.kind} ${owner.id}${databaseCode ? ` (${databaseCode})` : ""}: ${error.message}${reportingSuffix}`,
    { code: "GOATCITADEL_POSTGRES_CHECKED_OUT_CONNECTION_ERROR" },
  );
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
      ownPostgresSyncWorkerCheckedOutClient(runtime, client, { kind: "session", id: request.sessionId });
      runtime.sessions.set(request.sessionId, client);
      return true;
    }
    case "session_end": {
      const client = getPinnedSessionClient(runtime, request.sessionId);
      if (Array.from(runtime.transactionSessionIds.values()).includes(request.sessionId)) {
        throw new Error(`Postgres pinned session ${request.sessionId} still owns an active transaction`);
      }
      runtime.sessions.delete(request.sessionId);
      releasePostgresSyncWorkerCheckedOutClient(runtime, client, request.destroy);
      return true;
    }
    case "tx_begin": {
      if (runtime.transactions.has(request.txId) || runtime.transactionSessionIds.has(request.txId)) {
        throw new Error(`Postgres transaction ${request.txId} is already active`);
      }
      const client = request.sessionId
        ? getPinnedSessionClient(runtime, request.sessionId)
        : await runtime.pool.connect();
      if (!request.sessionId) {
        ownPostgresSyncWorkerCheckedOutClient(runtime, client, { kind: "transaction", id: request.txId });
      }
      assertPostgresSyncWorkerCheckedOutClientUsable(runtime, client);
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
          releasePostgresSyncWorkerCheckedOutClient(runtime, client);
        }
        throw error;
      }
      runtime.transactions.set(request.txId, client);
      return true;
    }
    case "tx_commit": {
      const client = getTransactionClient(runtime, request.txId);
      let destroyClient = false;
      try {
        assertPostgresSyncWorkerCheckedOutClientUsable(runtime, client);
        await client.query("COMMIT");
      } catch (error) {
        destroyClient = true;
        markPostgresSyncWorkerCheckedOutClientFailed(runtime, client, error);
        throw error;
      } finally {
        const isPinnedSessionTransaction = runtime.transactionSessionIds.delete(request.txId);
        runtime.transactions.delete(request.txId);
        if (!isPinnedSessionTransaction) {
          releasePostgresSyncWorkerCheckedOutClient(runtime, client, destroyClient);
        }
      }
      return true;
    }
    case "tx_rollback": {
      const client = getTransactionClient(runtime, request.txId);
      let destroyClient = false;
      try {
        assertPostgresSyncWorkerCheckedOutClientUsable(runtime, client);
        await client.query("ROLLBACK");
      } catch (error) {
        destroyClient = true;
        markPostgresSyncWorkerCheckedOutClientFailed(runtime, client, error);
        throw error;
      } finally {
        const isPinnedSessionTransaction = runtime.transactionSessionIds.delete(request.txId);
        runtime.transactions.delete(request.txId);
        if (!isPinnedSessionTransaction) {
          releasePostgresSyncWorkerCheckedOutClient(runtime, client, destroyClient);
        }
      }
      return true;
    }
    case "close": {
      let closeError: unknown;
      for (const [txId, client] of runtime.transactions.entries()) {
        let destroyClient = false;
        try {
          assertPostgresSyncWorkerCheckedOutClientUsable(runtime, client);
          await client.query("ROLLBACK");
        } catch (error) {
          destroyClient = true;
          closeError ??= error;
        } finally {
          const isPinnedSessionTransaction = runtime.transactionSessionIds.delete(txId);
          runtime.transactions.delete(txId);
          if (!isPinnedSessionTransaction) {
            releasePostgresSyncWorkerCheckedOutClient(runtime, client, destroyClient);
          }
        }
      }
      for (const [sessionId, client] of runtime.sessions.entries()) {
        runtime.sessions.delete(sessionId);
        releasePostgresSyncWorkerCheckedOutClient(runtime, client, true);
      }
      try {
        await runtime.pool.end();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError !== undefined) {
        throw closeError;
      }
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
    const client = getTransactionClient(runtime, txId);
    assertPostgresSyncWorkerCheckedOutClientUsable(runtime, client);
    return client;
  }
  if (sessionId) {
    const client = getPinnedSessionClient(runtime, sessionId);
    assertPostgresSyncWorkerCheckedOutClientUsable(runtime, client);
    return client;
  }
  return runtime.pool;
}

function assertPostgresSyncWorkerCheckedOutClientUsable(
  runtime: PostgresSyncWorkerRuntime,
  client: PostgresSyncWorkerTransactionClient,
): void {
  const failure = runtime.checkedOutClients.get(client)?.error;
  if (failure) {
    throw failure;
  }
}

function markPostgresSyncWorkerCheckedOutClientFailed(
  runtime: PostgresSyncWorkerRuntime,
  client: PostgresSyncWorkerTransactionClient,
  error: unknown,
): void {
  const state = runtime.checkedOutClients.get(client);
  if (state && state.error === undefined) {
    state.error = error instanceof Error ? error : new Error(String(error));
  }
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
