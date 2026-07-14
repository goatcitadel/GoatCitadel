export interface DbRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export type DbBindParams = unknown;

export interface DbStatement {
  run(...params: DbBindParams[]): DbRunResult;
  get<T = unknown>(...params: DbBindParams[]): T | undefined;
  all<T = unknown>(...params: DbBindParams[]): T[];
}

export type DbTransactionMode = "deferred" | "immediate" | "exclusive";

export interface DatabaseOnlineBackupProgress {
  totalPages: number;
  remainingPages: number;
}

export interface DatabaseOnlineBackupOptions {
  pagesPerBatch?: number;
  onProgress?: (progress: DatabaseOnlineBackupProgress) => void;
}

export interface DatabaseClient {
  readonly dialect: "sqlite" | "postgres";
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  close(): void;
  transaction<T>(mode: DbTransactionMode, callback: () => T): T;
  /**
   * Materialize a transactionally coherent database snapshot while the source
   * connection remains online. SQLite implements this with its online backup
   * API; other drivers and legacy injected clients may omit it.
   */
  backupTo?(destinationPath: string, options?: DatabaseOnlineBackupOptions): Promise<void>;
}

export function assertSynchronousTransactionResult(result: unknown): void {
  if (
    (typeof result === "object" || typeof result === "function") &&
    result !== null &&
    typeof (result as { then?: unknown }).then === "function"
  ) {
    throw new TypeError("transaction() callback must be synchronous; it must not return a Promise");
  }
}
