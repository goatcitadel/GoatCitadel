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

export interface DatabaseClient {
  readonly dialect: "sqlite" | "postgres";
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  close(): void;
  transaction<T>(mode: DbTransactionMode, callback: () => T): T;
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
