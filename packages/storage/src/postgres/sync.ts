import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import {
  assertSynchronousTransactionResult,
  type DatabaseClient,
  type DbRunResult,
  type DbStatement,
  type DbTransactionMode,
} from "../db.js";
import type { PostgresConnectionOptions } from "./client.js";
import type { PostgresWorkerRequest, PostgresWorkerResponse, SerializedWorkerError } from "./protocol.js";
import { isRecord, translateSqlForPostgres } from "./sql-translation.js";

const DEFAULT_SYNC_TIMEOUT_MS = 60_000;
const MIN_SYNC_TIMEOUT_MS = 1_000;
const MAX_SYNC_TIMEOUT_MS = 300_000;

export interface PostgresPinnedSessionControls {
  destroyOnRelease(): void;
}

/**
 * Transaction controls reserved for a worker-owned compatibility boundary.
 * The Gateway main thread must never call these methods directly.
 */
export interface PostgresWorkerCompatibilityTransactionControls {
  begin(transactionId: string, mode: DbTransactionMode): void;
  commit(transactionId: string): void;
  rollback(transactionId: string): void;
}

export type PostgresSyncWaitOutcome = "completed" | "failed" | "timed_out";

export interface PostgresSyncWaitDiagnostic {
  operationKind: string;
  transactionPosture: "none" | "active";
  sessionPosture: "none" | "pinned";
  outcome: PostgresSyncWaitOutcome;
  durationMs: number;
}

export interface PostgresSyncDatabaseClientObservability {
  onWait?: (diagnostic: PostgresSyncWaitDiagnostic) => void;
  now?: () => number;
  /**
   * Compatibility wait ceiling. Gateway runtime callers retain the bounded
   * default; startup migration owners may opt into the longer readiness
   * window because no HTTP event loop is serving yet.
   */
  waitTimeoutMs?: number;
}

export class PostgresSyncDatabaseClient implements DatabaseClient {
  public readonly dialect = "postgres" as const;
  private readonly worker: Worker;
  private activeTransactionId?: string;
  private activeSessionId?: string;
  private activeSessionMustBeDestroyed = false;
  private nestedTransactionDepth = 0;
  private fatalError?: Error;
  private closed = false;

  public constructor(
    private readonly options: PostgresConnectionOptions,
    private readonly observability: PostgresSyncDatabaseClientObservability = {},
  ) {
    const workerUrl = resolveWorkerUrl();
    const workerExecArgv = resolveWorkerExecArgv(workerUrl);
    this.worker = new Worker(workerUrl, {
      workerData: options,
      ...(workerExecArgv ? { execArgv: workerExecArgv } : {}),
    });
    this.worker.on("error", (error) => {
      this.fatalError = error;
    });
    this.worker.on("exit", (code) => {
      if (code !== 0 && !this.fatalError) {
        this.fatalError = new Error(`Postgres sync worker exited with code ${code}`);
      }
    });
  }

  public prepare(sql: string): DbStatement {
    return new PostgresStatementAdapter(this, sql);
  }

  public exec(sql: string): void {
    this.requestSync({
      kind: "exec",
      sql,
      txId: this.activeTransactionId,
      sessionId: this.activeSessionId,
    });
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    try {
      this.requestSync({ kind: "close" });
    } catch (error) {
      if (!isCloseTimeoutError(error)) {
        throw error;
      }
      this.fatalError = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.closed = true;
      this.retireWorker();
    }
  }

  public transaction<T>(mode: DbTransactionMode, callback: () => T): T {
    if (!this.activeTransactionId) {
      const txId = randomUUID();
      this.requestSync({
        kind: "tx_begin",
        txId,
        mode,
        sessionId: this.activeSessionId,
      });
      this.activeTransactionId = txId;
      try {
        const result = callback();
        assertSynchronousTransactionResult(result);
        this.requestSync({
          kind: "tx_commit",
          txId,
        });
        return result;
      } catch (error) {
        try {
          this.requestSync({
            kind: "tx_rollback",
            txId,
          });
        } catch {
          if (this.activeSessionId) {
            this.activeSessionMustBeDestroyed = true;
          }
        }
        throw error;
      } finally {
        this.activeTransactionId = undefined;
      }
    }

    const savepointName = `gc_nested_${(this.nestedTransactionDepth += 1)}`;
    this.exec(`SAVEPOINT ${savepointName}`);
    try {
      const result = callback();
      assertSynchronousTransactionResult(result);
      this.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      this.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      this.exec(`RELEASE SAVEPOINT ${savepointName}`);
      throw error;
    } finally {
      this.nestedTransactionDepth = Math.max(0, this.nestedTransactionDepth - 1);
    }
  }

  /** @internal Worker-owned compatibility use only. */
  public beginCompatibilityTransaction(transactionId: string, mode: DbTransactionMode): void {
    if (this.activeTransactionId) {
      throw new Error("A compatibility transaction is already active.");
    }
    this.requestSync({
      kind: "tx_begin",
      txId: transactionId,
      mode,
      sessionId: this.activeSessionId,
    });
    this.activeTransactionId = transactionId;
  }

  /** @internal Worker-owned compatibility use only. */
  public commitCompatibilityTransaction(transactionId: string): void {
    this.assertCompatibilityTransaction(transactionId);
    try {
      this.requestSync({ kind: "tx_commit", txId: transactionId });
    } finally {
      this.activeTransactionId = undefined;
      this.nestedTransactionDepth = 0;
    }
  }

  /** @internal Worker-owned compatibility use only. */
  public rollbackCompatibilityTransaction(transactionId: string): void {
    this.assertCompatibilityTransaction(transactionId);
    try {
      this.requestSync({ kind: "tx_rollback", txId: transactionId });
    } finally {
      this.activeTransactionId = undefined;
      this.nestedTransactionDepth = 0;
    }
  }

  public withPinnedSession<T>(callback: (controls: PostgresPinnedSessionControls) => T): T {
    if (this.activeSessionId || this.activeTransactionId) {
      throw new Error("Postgres pinned sessions cannot be nested or opened inside a transaction.");
    }
    const sessionId = randomUUID();
    try {
      this.requestSync({ kind: "session_begin", sessionId });
    } catch (error) {
      // A host timeout cannot prove whether the worker checked out and retained
      // the client before its response was lost. Do not race session_end against
      // an in-flight begin; retire the worker so the server releases any socket.
      this.closed = true;
      this.fatalError = error instanceof Error ? error : new Error(String(error));
      this.retireWorker();
      throw error;
    }
    this.activeSessionId = sessionId;
    this.activeSessionMustBeDestroyed = false;
    let result: T | undefined;
    let primaryError: unknown;
    let hasPrimaryError = false;

    try {
      result = callback({
        destroyOnRelease: () => {
          this.activeSessionMustBeDestroyed = true;
        },
      });
      assertSynchronousTransactionResult(result);
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
    } finally {
      this.activeSessionId = undefined;
    }

    try {
      this.requestSync({ kind: "session_end", sessionId, destroy: this.activeSessionMustBeDestroyed });
    } catch (error) {
      this.closed = true;
      this.fatalError = error instanceof Error ? error : new Error(String(error));
      this.retireWorker();
      if (!hasPrimaryError) {
        primaryError = error;
        hasPrimaryError = true;
      }
    }
    this.activeSessionMustBeDestroyed = false;

    if (hasPrimaryError) {
      throw primaryError;
    }
    return result as T;
  }

  private retireWorker(): void {
    // Worker termination is asynchronous while DatabaseClient.close() is a
    // synchronous contract. Once close has been requested, do not let a slow
    // coverage-instrumented worker keep the host process alive indefinitely.
    this.worker.unref();
    void this.worker.terminate();
  }

  private assertCompatibilityTransaction(transactionId: string): void {
    if (!this.activeTransactionId || this.activeTransactionId !== transactionId) {
      throw new Error(`Compatibility transaction ${transactionId} is not active.`);
    }
  }

  public executeRun(sql: string, params: unknown[]): DbRunResult {
    return this.requestSync({
      kind: "query",
      sql,
      params,
      mode: "run",
      txId: this.activeTransactionId,
      sessionId: this.activeSessionId,
    }) as DbRunResult;
  }

  public executeGet<T = unknown>(sql: string, params: unknown[]): T | undefined {
    return this.requestSync({
      kind: "query",
      sql,
      params,
      mode: "one",
      txId: this.activeTransactionId,
      sessionId: this.activeSessionId,
    }) as T | undefined;
  }

  public executeAll<T = unknown>(sql: string, params: unknown[]): T[] {
    return this.requestSync({
      kind: "query",
      sql,
      params,
      mode: "all",
      txId: this.activeTransactionId,
      sessionId: this.activeSessionId,
    }) as T[];
  }

  private requestSync(request: PostgresWorkerRequest): unknown {
    if (this.closed) {
      throw new Error("Postgres database client is already closed.");
    }
    if (this.fatalError) {
      throw this.fatalError;
    }

    const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const state = new Int32Array(signal);
    const { port1, port2 } = new MessageChannel();
    const startedAt = this.observability?.now?.() ?? performance.now();
    let outcome: PostgresSyncWaitOutcome = "failed";
    this.worker.postMessage({ request, port: port2, signal }, [port2]);
    const waitResult = Atomics.wait(state, 0, 0, resolveSyncWaitTimeoutMs(this.observability?.waitTimeoutMs));
    const received = receiveMessageOnPort(port1);
    port1.close();

    if (waitResult === "timed-out") {
      outcome = "timed_out";
      this.observeWait(request, startedAt, outcome);
      throw new Error(`Timed out waiting for Postgres response (${request.kind}).`);
    }
    const response = received?.message as PostgresWorkerResponse | undefined;
    if (!response) {
      this.observeWait(request, startedAt, outcome);
      throw this.fatalError ?? new Error("Postgres sync worker did not return a response.");
    }
    if (!response.ok) {
      this.observeWait(request, startedAt, outcome);
      throw deserializeWorkerError(response.error);
    }
    outcome = "completed";
    this.observeWait(request, startedAt, outcome);
    return response.result;
  }

  private observeWait(request: PostgresWorkerRequest, startedAt: number, outcome: PostgresSyncWaitOutcome): void {
    const finishedAt = this.observability?.now?.() ?? performance.now();
    try {
      this.observability?.onWait?.({
        operationKind: request.kind === "query" ? `query:${request.mode}` : request.kind,
        transactionPosture: ("txId" in request && request.txId) || this.activeTransactionId ? "active" : "none",
        sessionPosture: ("sessionId" in request && request.sessionId) || this.activeSessionId ? "pinned" : "none",
        outcome,
        durationMs: Math.max(0, finishedAt - startedAt),
      });
    } catch {
      // Diagnostics are best-effort and must never affect storage semantics.
    }
  }
}

class PostgresStatementAdapter implements DbStatement {
  public constructor(
    private readonly client: PostgresSyncDatabaseClient,
    private readonly originalSql: string,
  ) {}

  public run(...params: unknown[]): DbRunResult {
    const translated = translateSqlForPostgres(this.originalSql, params);
    return this.client.executeRun(translated.sql, translated.params);
  }

  public get<T = unknown>(...params: unknown[]): T | undefined {
    const translated = translateSqlForPostgres(this.originalSql, params);
    return this.client.executeGet<T>(translated.sql, translated.params);
  }

  public all<T = unknown>(...params: unknown[]): T[] {
    const translated = translateSqlForPostgres(this.originalSql, params);
    return this.client.executeAll<T>(translated.sql, translated.params);
  }
}

function resolveWorkerUrl(current = new URL(import.meta.url), fileExists = fileUrlExists): URL {
  if (!current.pathname.endsWith(".ts")) {
    return new URL("./sync-worker.js", current);
  }

  const compiledWorker = new URL("../../dist/postgres/sync-worker.js", current);
  return fileExists(compiledWorker) ? compiledWorker : new URL("./sync-worker.ts", current);
}

function fileUrlExists(url: URL): boolean {
  return url.protocol === "file:" && existsSync(url);
}

function resolveWorkerExecArgv(workerUrl: URL, execArgv = process.execArgv): string[] | undefined {
  if (!workerUrl.pathname.endsWith(".ts")) {
    return undefined;
  }

  const workerExecArgv: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index];
    const nextArg = execArgv[index + 1];
    if ((arg === "--require" || arg === "-r" || arg === "--import") && isTsxLoaderArg(nextArg)) {
      workerExecArgv.push(arg, nextArg);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--require=") && isTsxLoaderArg(arg.slice("--require=".length))) {
      workerExecArgv.push(arg);
      continue;
    }
    if (arg?.startsWith("--import=") && isTsxLoaderArg(arg.slice("--import=".length))) {
      workerExecArgv.push(arg);
    }
  }

  return workerExecArgv.length > 0 ? workerExecArgv : undefined;
}

function isTsxLoaderArg(value: string | undefined): value is string {
  const normalized = value?.replaceAll("\\", "/");
  return (
    normalized?.endsWith("/tsx/dist/preflight.cjs") === true || normalized?.endsWith("/tsx/dist/loader.mjs") === true
  );
}

function deserializeWorkerError(error: SerializedWorkerError): Error {
  const next = new Error(error.message);
  next.name = error.name;
  next.stack = error.stack;
  return next;
}

function isCloseTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === "Timed out waiting for Postgres response (close).";
}

function resolveSyncWaitTimeoutMs(configured: number | undefined): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_SYNC_TIMEOUT_MS;
  }
  return Math.max(MIN_SYNC_TIMEOUT_MS, Math.min(MAX_SYNC_TIMEOUT_MS, Math.floor(configured)));
}

export const __postgresSyncInternals = {
  translateSql: translateSqlForPostgres,
  resolveWorkerUrl,
  resolveWorkerExecArgv,
  deserializeWorkerError,
  isRecord,
  isCloseTimeoutError,
  resolveSyncWaitTimeoutMs,
};
