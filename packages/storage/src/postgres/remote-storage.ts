import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import {
  BudgetExceededError,
  ConfigValidationError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  PayloadTooLargeError,
  PolicyViolationError,
  ToolExecutionError,
  ValidationError,
} from "@goatcitadel/contracts";
import type { AsyncDatabaseClient, AsyncDbStatement } from "../async-db.js";
import type { AsyncGatewaySqlRepository, AsyncStorage } from "../async-storage.js";
import type { DatabaseOnlineBackupOptions, DbBindParams, DbRunResult, DbTransactionMode } from "../db.js";
import type {
  PostCommitChildStageAuthority,
  PostCommitChildStageCallbackOutcome,
  PostCommitChildStageInput,
  PostCommitChildStageOutcome,
  PostCommitChildStageSettlementOutcome,
} from "../session-mutation-admission-repo.js";
import type {
  PostgresRemoteStorageRequest,
  PostgresRemoteStorageRequestDraft,
  PostgresRemoteStorageResponse,
  PostgresRemoteStorageWorkerOptions,
  SerializedRemoteStorageError,
} from "./remote-storage-protocol.js";

interface TransactionContext {
  transactionId: string;
  depth: number;
}

interface RemoteWorkerPort {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: PostgresRemoteStorageResponse) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  unref(): void;
  terminate(): Promise<number>;
}

export type PostgresRemoteStorage = AsyncStorage;

export interface CreatePostgresRemoteStorageOptions {
  workerFactory?: (
    url: URL,
    options: { workerData: PostgresRemoteStorageWorkerOptions; execArgv?: string[] },
  ) => RemoteWorkerPort;
}

/**
 * Promise-returning Storage compatibility proxy. The synchronous repository
 * graph and its Atomics.wait calls live entirely inside the owned worker;
 * Gateway callers must await every method invocation.
 */
export function createPostgresRemoteStorage(
  workerOptions: PostgresRemoteStorageWorkerOptions,
  options: CreatePostgresRemoteStorageOptions = {},
): PostgresRemoteStorage {
  const client = new PostgresRemoteStorageClient(workerOptions, options);
  return client.proxy();
}

class PostgresRemoteStorageClient {
  private readonly worker: RemoteWorkerPort;
  private readonly transactionContext = new AsyncLocalStorage<TransactionContext>();
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private requestId = 0;
  private readySettled = false;
  private closed = false;
  private fatalError?: Error;

  public constructor(workerOptions: PostgresRemoteStorageWorkerOptions, options: CreatePostgresRemoteStorageOptions) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    const workerUrl = resolveRemoteStorageWorkerUrl();
    const execArgv = resolveRemoteStorageWorkerExecArgv(workerUrl);
    this.worker = (options.workerFactory ?? defaultWorkerFactory)(workerUrl, {
      workerData: workerOptions,
      ...(execArgv ? { execArgv } : {}),
    });
    this.worker.on("message", (message) => this.handleMessage(message));
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.fail(new Error(`Postgres remote storage worker exited with code ${code}.`));
      }
    });
  }

  public proxy(): PostgresRemoteStorage {
    const root = new Proxy<Record<string, unknown>>(
      {},
      {
        get: (_target, property) => {
          if (property === "waitUntilReady") return () => this.waitUntilReady();
          if (property === "close") return () => this.close();
          if (property === "db") return this.databaseProxy();
          if (property === "gatewaySql") return this.gatewaySqlProxy();
          if (property === "sessionMutationAdmissions") return this.sessionMutationAdmissionsProxy();
          if (typeof property !== "string") return undefined;
          return this.pathProxy([property]);
        },
      },
    );
    return root as unknown as PostgresRemoteStorage;
  }

  public async waitUntilReady(): Promise<void> {
    await this.readyPromise;
  }

  private pathProxy(path: string[]): object {
    const invoke = (...args: unknown[]) => this.invoke(path, args);
    return new Proxy(invoke, {
      apply: (_target, _thisArg, args) => this.invoke(path, args),
      get: (target, property, receiver) => {
        if (property === "then") return undefined;
        if (property === "bind" || property === "call" || property === "apply") {
          return Reflect.get(target, property, receiver);
        }
        if (typeof property !== "string") return Reflect.get(target, property, receiver);
        return this.pathProxy([...path, property]);
      },
    });
  }

  private invoke(path: string[], args: unknown[]): Promise<unknown> {
    if (path.at(-1) === "runImmediateTransaction") {
      if (args.length !== 1 || typeof args[0] !== "function") {
        return Promise.reject(new TypeError(`${path.join(".")} requires exactly one transaction callback`));
      }
      return this.runTransaction("immediate", args[0] as () => unknown | Promise<unknown>);
    }
    return this.request({ kind: "invoke", path, args });
  }

  private databaseProxy(): AsyncDatabaseClient {
    return {
      dialect: "postgres",
      prepare: (sql: string): AsyncDbStatement => ({
        run: (...args: DbBindParams[]) =>
          this.request({ kind: "statement", mode: "run", sql, args }) as Promise<DbRunResult>,
        get: <T = unknown>(...args: DbBindParams[]) =>
          this.request({ kind: "statement", mode: "get", sql, args }) as Promise<T | undefined>,
        all: <T = unknown>(...args: DbBindParams[]) =>
          this.request({ kind: "statement", mode: "all", sql, args }) as Promise<T[]>,
      }),
      exec: async (sql: string): Promise<void> => {
        await this.request({ kind: "invoke", path: ["db", "exec"], args: [sql] });
      },
      close: async (): Promise<void> => {
        await this.close();
      },
      transaction: <T>(mode: DbTransactionMode, callback: (db: AsyncDatabaseClient) => Promise<T>): Promise<T> =>
        this.runTransaction(mode, () => callback(this.databaseProxy())),
      backupTo: (_destinationPath: string, _options?: DatabaseOnlineBackupOptions): Promise<void> =>
        Promise.reject(new Error("Online SQLite snapshots are not available for PostgreSQL storage")),
    };
  }

  private gatewaySqlProxy(): AsyncGatewaySqlRepository {
    return new Proxy<Record<string, unknown>>(
      {},
      {
        get: (_target, property) => {
          if (property === "dialect") return "postgres";
          if (property === "prepare") return (sql: string) => this.databaseProxy().prepare(sql);
          if (property === "runImmediateTransaction") {
            return <T>(callback: () => T | Promise<T>) => this.runTransaction("immediate", callback);
          }
          if (typeof property !== "string") return undefined;
          return (...args: unknown[]) => this.invoke(["gatewaySql", property], args);
        },
      },
    ) as unknown as AsyncGatewaySqlRepository;
  }

  private sessionMutationAdmissionsProxy(): AsyncStorage["sessionMutationAdmissions"] {
    return new Proxy<Record<string, unknown>>(
      {},
      {
        get: (_target, property) => {
          if (property === "runPostCommitChildStage") {
            return <T>(
              input: PostCommitChildStageInput,
              callback: (
                authority: PostCommitChildStageAuthority,
              ) => PostCommitChildStageCallbackOutcome<T> | Promise<PostCommitChildStageCallbackOutcome<T>>,
            ) => this.runPostCommitChildStage(input, callback);
          }
          if (typeof property !== "string") return undefined;
          return this.pathProxy(["sessionMutationAdmissions", property]);
        },
      },
    ) as unknown as AsyncStorage["sessionMutationAdmissions"];
  }

  private runPostCommitChildStage<T>(
    input: PostCommitChildStageInput,
    callback: (
      authority: PostCommitChildStageAuthority,
    ) => PostCommitChildStageCallbackOutcome<T> | Promise<PostCommitChildStageCallbackOutcome<T>>,
  ): Promise<PostCommitChildStageOutcome<T>> {
    return this.runTransaction("immediate", async () => {
      const authority = (await this.request({
        kind: "invoke",
        path: ["sessionMutationAdmissions", "beginPostCommitChildStageInCurrentTransaction"],
        args: [input],
      })) as PostCommitChildStageAuthority;
      const callbackOutcome = await callback(authority);
      const settlement = (await this.request({
        kind: "invoke",
        path: ["sessionMutationAdmissions", "finishPostCommitChildStageInCurrentTransaction"],
        args: [input, authority, callbackOutcome.disposition],
      })) as PostCommitChildStageSettlementOutcome;
      return { ...settlement, value: callbackOutcome.value };
    });
  }

  private async runTransaction<T>(mode: DbTransactionMode, callback: () => T | Promise<T>): Promise<T> {
    const current = this.transactionContext.getStore();
    const context: TransactionContext = current
      ? { transactionId: current.transactionId, depth: current.depth + 1 }
      : { transactionId: randomUUID(), depth: 0 };
    await this.request(
      {
        kind: "transaction_begin",
        mode,
        depth: context.depth,
      },
      context.transactionId,
    );
    try {
      const result = await this.transactionContext.run(context, callback);
      await this.request({ kind: "transaction_commit", depth: context.depth }, context.transactionId);
      return result;
    } catch (error) {
      try {
        await this.request({ kind: "transaction_rollback", depth: context.depth }, context.transactionId);
      } catch {
        // Preserve the callback/commit error; worker failure rejects later calls.
      }
      throw error;
    }
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request({ kind: "close" });
    } finally {
      this.closed = true;
      this.worker.unref();
      await this.worker.terminate();
      this.fail(new Error("Postgres remote storage client is closed."));
    }
  }

  private async request(
    request: PostgresRemoteStorageRequestDraft,
    transactionId = this.transactionContext.getStore()?.transactionId,
  ): Promise<unknown> {
    await this.readyPromise;
    if (this.closed) throw new Error("Postgres remote storage client is closed.");
    if (this.fatalError) throw this.fatalError;
    const requestId = (this.requestId += 1);
    const message = {
      ...request,
      requestId,
      ...(transactionId ? { transactionId } : {}),
    } as PostgresRemoteStorageRequest;
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.worker.postMessage(message);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(message: PostgresRemoteStorageResponse): void {
    if (message.kind === "ready") {
      this.readySettled = true;
      if (message.ok) this.resolveReady();
      else this.rejectReady(deserializeError(message.error));
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(deserializeError(message.error));
  }

  private fail(error: Error): void {
    this.fatalError ??= error;
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function defaultWorkerFactory(
  url: URL,
  options: { workerData: PostgresRemoteStorageWorkerOptions; execArgv?: string[] },
): RemoteWorkerPort {
  return new Worker(url, options) as unknown as RemoteWorkerPort;
}

function resolveRemoteStorageWorkerUrl(current = new URL(import.meta.url), fileExists = fileUrlExists): URL {
  if (!current.pathname.endsWith(".ts")) return new URL("./remote-storage-worker.js", current);
  const compiledWorker = new URL("../../dist/postgres/remote-storage-worker.js", current);
  return fileExists(compiledWorker) ? compiledWorker : new URL("./remote-storage-worker.ts", current);
}

function fileUrlExists(url: URL): boolean {
  return url.protocol === "file:" && existsSync(url);
}

function resolveRemoteStorageWorkerExecArgv(workerUrl: URL, execArgv = process.execArgv): string[] | undefined {
  if (!workerUrl.pathname.endsWith(".ts")) return undefined;
  const workerExecArgv: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index];
    const nextArg = execArgv[index + 1];
    if ((arg === "--require" || arg === "-r" || arg === "--import") && isTsxLoaderArg(nextArg)) {
      workerExecArgv.push(arg, nextArg);
      index += 1;
    } else if (arg?.startsWith("--require=") && isTsxLoaderArg(arg.slice("--require=".length))) {
      workerExecArgv.push(arg);
    } else if (arg?.startsWith("--import=") && isTsxLoaderArg(arg.slice("--import=".length))) {
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

function deserializeError(error: SerializedRemoteStorageError): Error {
  const next = new Error(error.message);
  const prototype = REMOTE_ERROR_PROTOTYPES[error.name];
  if (prototype) Object.setPrototypeOf(next, prototype);
  next.name = error.name;
  if (error.stack) next.stack = error.stack;
  if (error.properties) Object.assign(next, error.properties);
  return next;
}

const REMOTE_ERROR_PROTOTYPES: Readonly<Record<string, Error>> = {
  Error: Error.prototype,
  TypeError: TypeError.prototype,
  RangeError: RangeError.prototype,
  ReferenceError: ReferenceError.prototype,
  SyntaxError: SyntaxError.prototype,
  URIError: URIError.prototype,
  EvalError: EvalError.prototype,
  NotFoundError: NotFoundError.prototype,
  ValidationError: ValidationError.prototype,
  ConflictError: ConflictError.prototype,
  PolicyViolationError: PolicyViolationError.prototype,
  ToolExecutionError: ToolExecutionError.prototype,
  ExternalServiceError: ExternalServiceError.prototype,
  BudgetExceededError: BudgetExceededError.prototype,
  PayloadTooLargeError: PayloadTooLargeError.prototype,
  ConfigValidationError: ConfigValidationError.prototype,
};

export const __postgresRemoteStorageInternals = {
  resolveRemoteStorageWorkerUrl,
  resolveRemoteStorageWorkerExecArgv,
  deserializeError,
};
