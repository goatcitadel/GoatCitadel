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
  return {
    dialect: "postgres",
    // Lazy prepare: some repositories eagerly prepare postgres-flavored SQL in
    // their constructors (e.g. tsquery message search); the sqlite backing can
    // only host those statements if they are never executed, and the replay
    // path never runs them.
    prepare: (sql) => {
      let stmt: ReturnType<DatabaseClient["prepare"]> | undefined;
      // The facade deliberately exercises PostgreSQL branches while SQLite
      // supplies deterministic local rows. Row-lock clauses have no SQLite
      // equivalent and are already provided by its enclosing transaction, so
      // remove only those clauses for the backing engine. Keep every other
      // PostgreSQL-shaped statement intact so dialect drift still fails loud.
      const sqliteBackingSql = sql.replace(/\s+FOR\s+UPDATE(?:\s+SKIP\s+LOCKED)?/giu, "");
      const resolve = () => (stmt ??= inner.prepare(sqliteBackingSql));
      return {
        run: (...params: unknown[]) => resolve().run(...params),
        get: (...params: unknown[]) => resolve().get(...params),
        all: (...params: unknown[]) => resolve().all(...params),
      };
    },
    exec: (sql) => {
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
  };
}
