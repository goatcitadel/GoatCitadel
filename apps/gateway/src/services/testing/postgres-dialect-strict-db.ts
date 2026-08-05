import path from "node:path";
import { createDatabase, type DatabaseClient } from "@goatcitadel/storage";

/**
 * Wraps a fully migrated sqlite client in a postgres-dialect facade whose
 * `exec` rejects transaction-control and PRAGMA statements the way the real
 * Postgres driver does (`BEGIN IMMEDIATE` fails with `syntax error at or near
 * "IMMEDIATE"`; raw BEGIN/COMMIT on the pooled sync client would bypass its
 * transaction bookkeeping). Data statements still execute against sqlite, so
 * the full service path runs; only dialect-unsafe raw exec calls blow up.
 */
export function createPostgresDialectStrictDb(rootDir: string): DatabaseClient {
  const inner = createDatabase({ dbPath: path.join(rootDir, "backing.sqlite") });
  const compatibilityTransactions = inner as DatabaseClient & {
    beginCompatibilityTransaction(transactionId: string, mode: "deferred" | "immediate" | "exclusive"): void;
    commitCompatibilityTransaction(transactionId: string): void;
    rollbackCompatibilityTransaction(transactionId: string): void;
  };
  return {
    dialect: "postgres",
    // Lazy prepare: some repositories eagerly prepare postgres-flavored SQL in
    // their constructors (e.g. tsquery message search); the sqlite backing can
    // only host those statements if they are never executed, and the replay
    // path never runs them.
    prepare: (sql) => {
      let stmt: ReturnType<DatabaseClient["prepare"]> | undefined;
      // The facade deliberately exercises PostgreSQL branches while SQLite
      // supplies deterministic local rows. Row-lock clauses and the
      // transaction-local lock_timeout guard have no SQLite equivalent and are
      // already provided by its enclosing transaction, so neutralize only
      // those statements for the backing engine. Keep every other
      // PostgreSQL-shaped statement intact so dialect drift still fails loud.
      const sqliteBackingSql = /^\s*SELECT\s+set_config\('lock_timeout'/iu.test(sql)
        ? "SELECT @lockTimeout AS lock_timeout_noop"
        : sql.replace(/\s+FOR\s+UPDATE(?:\s+SKIP\s+LOCKED)?/giu, "");
      const resolve = () => (stmt ??= inner.prepare(sqliteBackingSql));
      return {
        run: (...params: unknown[]) => resolve().run(...params),
        get: (...params: unknown[]) => resolve().get(...params),
        all: (...params: unknown[]) => resolve().all(...params),
      };
    },
    exec: (sql) => {
      if (/^\s*(?:SAVEPOINT|RELEASE\s+SAVEPOINT|ROLLBACK\s+TO\s+SAVEPOINT)\s+gc_async_storage_\d+\s*$/iu.test(sql)) {
        inner.exec(sql);
        return;
      }
      const leadingKeyword =
        sql
          .trim()
          .split(/[\s;(]+/, 1)[0]
          ?.toUpperCase() ?? "";
      if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "PRAGMA", "END"].includes(leadingKeyword)) {
        throw new Error(
          `syntax error at or near "${sql.trim().split(/\s+/)[1] ?? leadingKeyword}" — ` +
            `sqlite-dialect exec reached the postgres driver; use the driver-aware transaction helper ` +
            `(runImmediateTransaction / db.transaction) instead of raw "${sql.trim().slice(0, 40)}"`,
        );
      }
      inner.exec(sql);
    },
    close: () => inner.close(),
    transaction: (mode, callback) => inner.transaction(mode, callback),
    // Preserve the internal controls used by the Promise-native local storage
    // adapter. They delegate to the SQLite backing client while the facade's
    // public exec() guard continues to reject dialect-unsafe transaction SQL.
    beginCompatibilityTransaction: (transactionId: string, mode: "deferred" | "immediate" | "exclusive") =>
      compatibilityTransactions.beginCompatibilityTransaction(transactionId, mode),
    commitCompatibilityTransaction: (transactionId: string) =>
      compatibilityTransactions.commitCompatibilityTransaction(transactionId),
    rollbackCompatibilityTransaction: (transactionId: string) =>
      compatibilityTransactions.rollbackCompatibilityTransaction(transactionId),
  } as DatabaseClient;
}
