import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import type { DatabaseClient, DbRunResult, DbStatement, DbTransactionMode } from "../db.js";
import type { PostgresConnectionOptions } from "./client.js";
import type { PostgresWorkerRequest, PostgresWorkerResponse, SerializedWorkerError } from "./protocol.js";

const DEFAULT_SYNC_TIMEOUT_MS = 60_000;

export class PostgresSyncDatabaseClient implements DatabaseClient {
  public readonly dialect = "postgres" as const;
  private readonly worker: Worker;
  private activeTransactionId?: string;
  private nestedTransactionDepth = 0;
  private fatalError?: Error;
  private closed = false;

  public constructor(private readonly options: PostgresConnectionOptions) {
    this.worker = new Worker(resolveWorkerUrl(), {
      workerData: options,
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
    });
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    try {
      this.requestSync({ kind: "close" });
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
      });
      this.activeTransactionId = txId;
      try {
        const result = callback();
        this.requestSync({
          kind: "tx_commit",
          txId,
        });
        return result;
      } catch (error) {
        this.requestSync({
          kind: "tx_rollback",
          txId,
        });
        throw error;
      } finally {
        this.activeTransactionId = undefined;
      }
    }

    const savepointName = `gc_nested_${this.nestedTransactionDepth += 1}`;
    this.exec(`SAVEPOINT ${savepointName}`);
    try {
      const result = callback();
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

  public executeRun(sql: string, params: unknown[]): DbRunResult {
    return this.requestSync({
      kind: "query",
      sql,
      params,
      mode: "run",
      txId: this.activeTransactionId,
    }) as DbRunResult;
  }

  public executeGet<T = unknown>(sql: string, params: unknown[]): T | undefined {
    return this.requestSync({
      kind: "query",
      sql,
      params,
      mode: "one",
      txId: this.activeTransactionId,
    }) as T | undefined;
  }

  public executeAll<T = unknown>(sql: string, params: unknown[]): T[] {
    return this.requestSync({
      kind: "query",
      sql,
      params,
      mode: "all",
      txId: this.activeTransactionId,
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

function resolveWorkerUrl(): URL {
  const current = new URL(import.meta.url);
  const useTsSource = current.pathname.endsWith(".ts");
  return new URL(useTsSource ? "./sync-worker.ts" : "./sync-worker.js", import.meta.url);
}

function deserializeWorkerError(error: SerializedWorkerError): Error {
  const next = new Error(error.message);
  next.name = error.name;
  next.stack = error.stack;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
