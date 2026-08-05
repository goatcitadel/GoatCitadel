import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AsyncDatabaseClient, AsyncDbStatement } from "./async-db.js";
import type { DatabaseOnlineBackupOptions, DbBindParams, DbRunResult, DbTransactionMode } from "./db.js";
import type { Storage } from "./index.js";
import type {
  PostCommitChildStageAuthority,
  PostCommitChildStageCallbackOutcome,
  PostCommitChildStageInput,
  PostCommitChildStageOutcome,
  PostCommitChildStageSettlementOutcome,
} from "./session-mutation-admission-repo.js";
import type { SystemSettingRecord } from "./system-settings-repo.js";

export type AsyncStorageMethod<Method> = Method extends (...args: infer Args) => infer Result
  ? (...args: Args) => Promise<Awaited<Result>>
  : never;

export interface AsyncImmediateTransactionMethod {
  <T>(callback: () => T | Promise<T>): Promise<Awaited<T>>;
}

/**
 * Convert the public method surface of a repository tree to an awaited API.
 * Values returned by repository methods retain their domain types; only calls
 * and nested repository/root objects are converted.
 */
export type DeepAsyncRepository<Repository> = Repository extends (...args: infer Args) => infer Result
  ? (...args: Args) => Promise<Awaited<Result>>
  : Repository extends object
    ? {
        readonly [Key in keyof Repository]: Key extends "runImmediateTransaction"
          ? AsyncImmediateTransactionMethod
          : Repository[Key] extends (...args: infer Args) => infer Result
            ? (...args: Args) => Promise<Awaited<Result>>
            : Repository[Key] extends object
              ? DeepAsyncRepository<Repository[Key]>
              : Repository[Key];
      }
    : Repository;

type AsyncSystemSettingsRepository = Omit<DeepAsyncRepository<Storage["systemSettings"]>, "get" | "set"> & {
  get<T = unknown>(key: string): Promise<SystemSettingRecord<T> | undefined>;
  set<T>(key: string, value: T, now?: string): Promise<SystemSettingRecord<T>>;
};

type AsyncSessionMutationAdmissionRepository = Omit<
  DeepAsyncRepository<Storage["sessionMutationAdmissions"]>,
  | "runPostCommitChildStage"
  | "beginPostCommitChildStageInCurrentTransaction"
  | "finishPostCommitChildStageInCurrentTransaction"
> & {
  runPostCommitChildStage<T>(
    input: PostCommitChildStageInput,
    callback: (
      authority: PostCommitChildStageAuthority,
    ) => PostCommitChildStageCallbackOutcome<T> | Promise<PostCommitChildStageCallbackOutcome<T>>,
  ): Promise<PostCommitChildStageOutcome<T>>;
};

/**
 * Gateway SQL keeps statement construction synchronous while every statement
 * operation is awaited. This mirrors AsyncDatabaseClient and prevents a
 * non-cloneable DbStatement object from crossing the Postgres worker boundary.
 */
export type AsyncGatewaySqlRepository = Omit<
  DeepAsyncRepository<Storage["gatewaySql"]>,
  "dialect" | "prepare" | "runImmediateTransaction"
> & {
  readonly dialect: Storage["gatewaySql"]["dialect"];
  prepare(sql: string): AsyncDbStatement;
  runImmediateTransaction: AsyncImmediateTransactionMethod;
};

type AsyncStorageShape = Omit<
  DeepAsyncRepository<Storage>,
  "db" | "gatewaySql" | "runImmediateTransaction" | "sessionMutationAdmissions" | "systemSettings"
> & {
  readonly gatewaySql: AsyncGatewaySqlRepository;
  readonly sessionMutationAdmissions: AsyncSessionMutationAdmissionRepository;
  readonly systemSettings: AsyncSystemSettingsRepository;
};

/** Promise-only compatibility surface for the existing Storage repository graph. */
export type AsyncStorage = AsyncStorageShape & {
  readonly db: AsyncDatabaseClient;
  waitUntilReady(): Promise<void>;
  runImmediateTransaction: AsyncImmediateTransactionMethod;
};

interface LocalTransactionContext {
  id: string;
  depth: number;
}

/**
 * Adapt the synchronous SQLite Storage graph to the Promise-only boundary.
 * Every operation is serialized, while calls issued by the active async
 * transaction retain ownership and execute against its open connection.
 */
export function createSqliteAsyncStorage(storage: Storage): AsyncStorage {
  if (storage.db.dialect !== "sqlite") {
    throw new TypeError("createSqliteAsyncStorage requires SQLite-backed Storage");
  }
  return createLocalAsyncStorage(storage);
}

/**
 * One-release compatibility adapter for a local synchronous Storage graph.
 * PostgreSQL callers should prefer the remote worker boundary; this adapter
 * exists only for the explicitly selected rollback path.
 */
export function createLocalAsyncStorage(storage: Storage): AsyncStorage {
  if (storage.db.dialect !== "sqlite" && storage.db.dialect !== "postgres") {
    throw new TypeError(`Unsupported local storage dialect: ${String(storage.db.dialect)}`);
  }
  return new LocalAsyncStorageClient(storage).proxy();
}

class LocalAsyncStorageClient {
  private readonly transactionContext = new AsyncLocalStorage<LocalTransactionContext>();
  private operationTail: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private closed = false;
  private savepointCounter = 0;

  public constructor(private readonly storage: Storage) {}

  public proxy(): AsyncStorage {
    return new Proxy<Record<string, unknown>>(
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
    ) as unknown as AsyncStorage;
  }

  private async waitUntilReady(): Promise<void> {
    if (this.closed) throw new Error("Local async storage client is already closed.");
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
      const callback = assertTransactionCallback(path, args);
      return this.runTransaction("immediate", callback);
    }
    return this.schedule(() => invokePath(this.storage, path, args));
  }

  private databaseProxy(): AsyncDatabaseClient {
    return {
      dialect: this.storage.db.dialect,
      prepare: (sql: string) => this.statementProxy(sql),
      exec: (sql: string) => this.schedule(() => this.storage.db.exec(sql)),
      close: () => this.close(),
      transaction: <T>(mode: DbTransactionMode, callback: (db: AsyncDatabaseClient) => Promise<T>) =>
        this.runTransaction(mode, () => callback(this.databaseProxy())),
      backupTo: (destinationPath: string, options?: DatabaseOnlineBackupOptions) => {
        if (!this.storage.db.backupTo) {
          return Promise.reject(new Error("The configured SQLite storage client does not support online snapshots"));
        }
        return this.schedule(() => this.storage.db.backupTo!(destinationPath, options));
      },
    };
  }

  private gatewaySqlProxy(): AsyncGatewaySqlRepository {
    return new Proxy<Record<string, unknown>>(
      {},
      {
        get: (_target, property) => {
          if (property === "dialect") return this.storage.gatewaySql.dialect;
          if (property === "prepare") return (sql: string) => this.gatewaySqlStatementProxy(sql);
          if (property === "runImmediateTransaction") {
            return <T>(callback: () => T | Promise<T>) => this.runTransaction("immediate", callback);
          }
          if (typeof property !== "string") return undefined;
          return (...args: unknown[]) => this.schedule(() => invokePath(this.storage, ["gatewaySql", property], args));
        },
      },
    ) as unknown as AsyncGatewaySqlRepository;
  }

  private sessionMutationAdmissionsProxy(): AsyncSessionMutationAdmissionRepository {
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
    ) as unknown as AsyncSessionMutationAdmissionRepository;
  }

  private runPostCommitChildStage<T>(
    input: PostCommitChildStageInput,
    callback: (
      authority: PostCommitChildStageAuthority,
    ) => PostCommitChildStageCallbackOutcome<T> | Promise<PostCommitChildStageCallbackOutcome<T>>,
  ): Promise<PostCommitChildStageOutcome<T>> {
    return this.runTransaction("immediate", async () => {
      const authority = (await this.schedule(() =>
        invokePath(
          this.storage,
          ["sessionMutationAdmissions", "beginPostCommitChildStageInCurrentTransaction"],
          [input],
        ),
      )) as PostCommitChildStageAuthority;
      const callbackOutcome = await callback(authority);
      const settlement = (await this.schedule(() =>
        invokePath(
          this.storage,
          ["sessionMutationAdmissions", "finishPostCommitChildStageInCurrentTransaction"],
          [input, authority, callbackOutcome.disposition],
        ),
      )) as PostCommitChildStageSettlementOutcome;
      return { ...settlement, value: callbackOutcome.value };
    });
  }

  private statementProxy(sql: string): AsyncDbStatement {
    return {
      run: (...params: DbBindParams[]): Promise<DbRunResult> =>
        this.schedule(() => this.storage.db.prepare(sql).run(...params)),
      get: <T = unknown>(...params: DbBindParams[]): Promise<T | undefined> =>
        this.schedule(() => this.storage.db.prepare(sql).get<T>(...params)),
      all: <T = unknown>(...params: DbBindParams[]): Promise<T[]> =>
        this.schedule(() => this.storage.db.prepare(sql).all<T>(...params)),
    };
  }

  private gatewaySqlStatementProxy(sql: string): AsyncDbStatement {
    return {
      run: (...params: DbBindParams[]): Promise<DbRunResult> =>
        this.schedule(() => this.storage.gatewaySql.prepare(sql).run(...params)),
      get: <T = unknown>(...params: DbBindParams[]): Promise<T | undefined> =>
        this.schedule(() => this.storage.gatewaySql.prepare(sql).get<T>(...params)),
      all: <T = unknown>(...params: DbBindParams[]): Promise<T[]> =>
        this.schedule(() => this.storage.gatewaySql.prepare(sql).all<T>(...params)),
    };
  }

  private runTransaction<T>(mode: DbTransactionMode, callback: () => T | Promise<T>): Promise<Awaited<T>> {
    const current = this.transactionContext.getStore();
    if (current) {
      return this.executeTransaction(mode, { id: current.id, depth: current.depth + 1 }, callback);
    }
    return this.schedule(() => this.executeTransaction(mode, { id: randomUUID(), depth: 0 }, callback));
  }

  private async executeTransaction<T>(
    mode: DbTransactionMode,
    context: LocalTransactionContext,
    callback: () => T | Promise<T>,
  ): Promise<Awaited<T>> {
    const savepoint = context.depth > 0 ? `gc_async_storage_${(this.savepointCounter += 1)}` : undefined;
    const database = asCompatibilityTransactionDatabase(this.storage.db);
    if (savepoint) database.exec(`SAVEPOINT ${savepoint}`);
    else database.beginCompatibilityTransaction(context.id, mode);
    try {
      const result = await this.transactionContext.run(context, callback);
      if (savepoint) database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      else database.commitCompatibilityTransaction(context.id);
      return result as Awaited<T>;
    } catch (error) {
      try {
        if (savepoint) {
          database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
          database.rollbackCompatibilityTransaction(context.id);
        }
      } catch {
        // Preserve the callback/commit error.
      }
      throw error;
    }
  }

  private schedule<T>(operation: () => T | Promise<T>): Promise<Awaited<T>> {
    if (this.closed) {
      return Promise.reject(new Error("Local async storage client is already closed."));
    }
    if (this.transactionContext.getStore()) {
      return Promise.resolve().then(operation) as Promise<Awaited<T>>;
    }
    return this.enqueueUnchecked(operation);
  }

  private enqueueUnchecked<T>(operation: () => T | Promise<T>): Promise<Awaited<T>> {
    const result = this.operationTail.then(operation, operation) as Promise<Awaited<T>>;
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.enqueueUnchecked(() => this.storage.close());
    return this.closePromise;
  }
}

function assertTransactionCallback(path: string[], args: unknown[]): () => unknown | Promise<unknown> {
  if (args.length !== 1 || typeof args[0] !== "function") {
    throw new TypeError(`${path.join(".")} requires exactly one transaction callback`);
  }
  return args[0] as () => unknown | Promise<unknown>;
}

function invokePath(root: object, path: string[], args: unknown[]): unknown {
  if (path.length < 1) throw new Error("Async storage invocation path must identify a method.");
  let receiver: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (!receiver || typeof receiver !== "object") {
      throw new Error(`Async storage path is unavailable: ${path.join(".")}`);
    }
    receiver = (receiver as Record<string, unknown>)[segment];
  }
  const methodName = path.at(-1)!;
  if (!receiver || typeof receiver !== "object") {
    throw new Error(`Async storage receiver is unavailable: ${path.join(".")}`);
  }
  const method = (receiver as Record<string, unknown>)[methodName];
  if (typeof method !== "function") {
    throw new Error(`Async storage method is unavailable: ${path.join(".")}`);
  }
  return method.apply(receiver, args);
}

interface CompatibilityTransactionDatabase {
  exec(sql: string): void;
  beginCompatibilityTransaction(transactionId: string, mode: DbTransactionMode): void;
  commitCompatibilityTransaction(transactionId: string): void;
  rollbackCompatibilityTransaction(transactionId: string): void;
}

function asCompatibilityTransactionDatabase(database: object): CompatibilityTransactionDatabase {
  const candidate = database as Partial<CompatibilityTransactionDatabase>;
  if (
    typeof candidate.exec !== "function" ||
    typeof candidate.beginCompatibilityTransaction !== "function" ||
    typeof candidate.commitCompatibilityTransaction !== "function" ||
    typeof candidate.rollbackCompatibilityTransaction !== "function"
  ) {
    throw new Error("Local async storage requires compatibility transaction controls.");
  }
  return candidate as CompatibilityTransactionDatabase;
}
