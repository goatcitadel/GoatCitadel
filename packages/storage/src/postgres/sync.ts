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

const DEFAULT_SYNC_TIMEOUT_MS = 60_000;

export interface PostgresPinnedSessionControls {
  destroyOnRelease(): void;
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

  public constructor(private readonly options: PostgresConnectionOptions) {
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
      void this.worker.terminate();
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
      void this.worker.terminate();
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
      void this.worker.terminate();
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
    this.worker.postMessage({ request, port: port2, signal }, [port2]);
    const waitResult = Atomics.wait(state, 0, 0, DEFAULT_SYNC_TIMEOUT_MS);
    const received = receiveMessageOnPort(port1);
    port1.close();

    if (waitResult === "timed-out") {
      throw new Error(`Timed out waiting for Postgres response (${request.kind}).`);
    }
    const response = received?.message as PostgresWorkerResponse | undefined;
    if (!response) {
      throw this.fatalError ?? new Error("Postgres sync worker did not return a response.");
    }
    if (!response.ok) {
      throw deserializeWorkerError(response.error);
    }
    return response.result;
  }
}

class PostgresStatementAdapter implements DbStatement {
  public constructor(
    private readonly client: PostgresSyncDatabaseClient,
    private readonly originalSql: string,
  ) {}

  public run(...params: unknown[]): DbRunResult {
    const translated = translateSql(this.originalSql, params);
    return this.client.executeRun(translated.sql, translated.params);
  }

  public get<T = unknown>(...params: unknown[]): T | undefined {
    const translated = translateSql(this.originalSql, params);
    return this.client.executeGet<T>(translated.sql, translated.params);
  }

  public all<T = unknown>(...params: unknown[]): T[] {
    const translated = translateSql(this.originalSql, params);
    return this.client.executeAll<T>(translated.sql, translated.params);
  }
}

function translateSql(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  // Prepared statements without bound values are also used for generated
  // migration SQL. Preserve their text verbatim: PostgreSQL regular
  // expressions can legitimately contain `?` (for example, a negative
  // lookahead), and treating that character as a SQLite-style placeholder
  // silently changes the regex inside the quoted SQL literal.
  if (params.length === 0) {
    return { sql, params };
  }
  const namedMatch = /@([a-zA-Z_][a-zA-Z0-9_]*)/.test(sql);
  if (namedMatch) {
    const first = params[0];
    const record = isRecord(first) ? first : {};
    const values: unknown[] = [];
    let index = 0;
    return {
      sql: sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name) => {
        index += 1;
        values.push(record[name]);
        return `$${index}`;
      }),
      params: values,
    };
  }

  let index = 0;
  return {
    sql: sql.replace(/\?/g, () => {
      index += 1;
      return `$${index}`;
    }),
    params,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCloseTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === "Timed out waiting for Postgres response (close).";
}

export const __postgresSyncInternals = {
  translateSql,
  resolveWorkerUrl,
  resolveWorkerExecArgv,
  deserializeWorkerError,
  isRecord,
  isCloseTimeoutError,
};
