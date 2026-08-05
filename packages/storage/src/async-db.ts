import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type {
  DatabaseClient,
  DatabaseOnlineBackupOptions,
  DbBindParams,
  DbRunResult,
  DbTransactionMode,
} from "./db.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { translateSqlForPostgres } from "./postgres/sql-translation.js";

export interface AsyncDbStatement {
  run(...params: DbBindParams[]): Promise<DbRunResult>;
  get<T = unknown>(...params: DbBindParams[]): Promise<T | undefined>;
  all<T = unknown>(...params: DbBindParams[]): Promise<T[]>;
}

export interface AsyncDatabaseClient {
  readonly dialect: "sqlite" | "postgres";
  prepare(sql: string): AsyncDbStatement;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  transaction<T>(mode: DbTransactionMode, callback: (db: AsyncDatabaseClient) => Promise<T>): Promise<T>;
  backupTo?(destinationPath: string, options?: DatabaseOnlineBackupOptions): Promise<void>;
}

/**
 * Promise adapter for SQLite. Operations are serialized so an async callback
 * cannot interleave unrelated statements into an open transaction.
 */
export class SqliteAsyncDatabaseClient implements AsyncDatabaseClient {
  public readonly dialect = "sqlite" as const;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;

  public constructor(private readonly db: DatabaseClient) {
    if (db.dialect !== "sqlite") {
      throw new TypeError("SqliteAsyncDatabaseClient requires a SQLite DatabaseClient");
    }
  }

  public prepare(sql: string): AsyncDbStatement {
    return new SqliteAsyncStatement(this, sql);
  }

  public exec(sql: string): Promise<void> {
    return this.enqueue(() => this.db.exec(sql));
  }

  public async transaction<T>(mode: DbTransactionMode, callback: (db: AsyncDatabaseClient) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const begin = mode === "deferred" ? "BEGIN" : mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN EXCLUSIVE";
      this.db.exec(begin);
      const transactionDb = new SqlitePinnedAsyncDatabaseClient(this.db);
      try {
        const result = await callback(transactionDb);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the original callback/database failure.
        }
        throw error;
      }
    });
  }

  public close(): Promise<void> {
    if (this.closed) {
      return this.operationTail;
    }
    this.closed = true;
    return this.enqueueUnchecked(() => this.db.close());
  }

  public backupTo(destinationPath: string, options?: DatabaseOnlineBackupOptions): Promise<void> {
    if (!this.db.backupTo) {
      return Promise.reject(new Error("The configured SQLite storage client does not support online snapshots"));
    }
    return this.enqueue(() => this.db.backupTo!(destinationPath, options));
  }

  public executeStatement<T>(
    operation: (statement: ReturnType<DatabaseClient["prepare"]>) => T,
    sql: string,
  ): Promise<T> {
    return this.enqueue(() => operation(this.db.prepare(sql)));
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("SQLite async database client is already closed."));
    }
    return this.enqueueUnchecked(operation);
  }

  private enqueueUnchecked<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class SqliteAsyncStatement implements AsyncDbStatement {
  public constructor(
    private readonly owner: SqliteAsyncDatabaseClient,
    private readonly sql: string,
  ) {}

  public run(...params: DbBindParams[]): Promise<DbRunResult> {
    return this.owner.executeStatement((statement) => statement.run(...params), this.sql);
  }

  public get<T = unknown>(...params: DbBindParams[]): Promise<T | undefined> {
    return this.owner.executeStatement((statement) => statement.get<T>(...params), this.sql);
  }

  public all<T = unknown>(...params: DbBindParams[]): Promise<T[]> {
    return this.owner.executeStatement((statement) => statement.all<T>(...params), this.sql);
  }
}

class SqlitePinnedAsyncDatabaseClient implements AsyncDatabaseClient {
  public readonly dialect = "sqlite" as const;

  public constructor(private readonly db: DatabaseClient) {}

  public prepare(sql: string): AsyncDbStatement {
    const statement = this.db.prepare(sql);
    return {
      run: async (...params) => statement.run(...params),
      get: async <T = unknown>(...params: DbBindParams[]) => statement.get<T>(...params),
      all: async <T = unknown>(...params: DbBindParams[]) => statement.all<T>(...params),
    };
  }

  public async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  public async transaction<T>(): Promise<T> {
    throw new Error("Nested SQLite async transactions are not supported; reuse the provided transaction client.");
  }

  public async close(): Promise<void> {
    throw new Error("A transaction-scoped SQLite client cannot close its owning database.");
  }
}

/** Native Promise-backed PostgreSQL adapter. It never creates a sync worker. */
export class PostgresAsyncDatabaseClient implements AsyncDatabaseClient {
  public readonly dialect = "postgres" as const;

  public constructor(
    private readonly client: PostgresDatabaseClient,
    private readonly pinnedClient?: PoolClient,
    private readonly ownsClient = true,
  ) {}

  public prepare(sql: string): AsyncDbStatement {
    return new PostgresAsyncStatement(this, sql);
  }

  public async exec(sql: string): Promise<void> {
    await this.client.execute(sql, [], this.pinnedClient);
  }

  public async transaction<T>(_mode: DbTransactionMode, callback: (db: AsyncDatabaseClient) => Promise<T>): Promise<T> {
    if (!this.pinnedClient) {
      return this.client.transaction(async (pinnedClient) =>
        callback(new PostgresAsyncDatabaseClient(this.client, pinnedClient, false)),
      );
    }

    const savepoint = `gc_async_nested_${randomUUID().replaceAll("-", "")}`;
    await this.pinnedClient.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await callback(this);
      await this.pinnedClient.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await this.pinnedClient.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await this.pinnedClient.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (!this.ownsClient) {
      throw new Error("A transaction-scoped PostgreSQL client cannot close its owning pool.");
    }
    await this.client.close();
  }

  public async execute<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const translated = translateSqlForPostgres(sql, params);
    return this.client.execute<T>(translated.sql, translated.params, this.pinnedClient);
  }
}

class PostgresAsyncStatement implements AsyncDbStatement {
  public constructor(
    private readonly owner: PostgresAsyncDatabaseClient,
    private readonly sql: string,
  ) {}

  public async run(...params: DbBindParams[]): Promise<DbRunResult> {
    const result = await this.owner.execute(this.sql, params);
    return { changes: result.rowCount, lastInsertRowid: undefined };
  }

  public async get<T = unknown>(...params: DbBindParams[]): Promise<T | undefined> {
    const result = await this.owner.execute(this.sql, params);
    return result.rows[0] as T | undefined;
  }

  public async all<T = unknown>(...params: DbBindParams[]): Promise<T[]> {
    const result = await this.owner.execute(this.sql, params);
    return result.rows as T[];
  }
}
