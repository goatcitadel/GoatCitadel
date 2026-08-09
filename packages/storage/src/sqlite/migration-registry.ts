import type { DatabaseSync } from "node:sqlite";
import {
  assertValidAppliedMigrationLedger,
  assertValidMigrationDefinitions,
  type AppliedMigrationLedgerRow,
} from "../migration-ledger-validation.js";

export interface SqliteMigration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

export interface SqliteMigrationGroup {
  name: string;
  migrations: SqliteMigration[];
}

export function createSqliteMigrationRegistry(groups: readonly SqliteMigrationGroup[]): SqliteMigration[] {
  const migrations = groups.flatMap((group) => group.migrations);
  assertValidSqliteMigrationRegistry(migrations);
  return migrations;
}

export function runSqliteMigrations(db: DatabaseSync, migrations: readonly SqliteMigration[]): void {
  // Validate code-owned definitions before creating even the bookkeeping table.
  // This makes malformed registries fail without mutating a fresh database.
  assertValidSqliteMigrationRegistry(migrations);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const listApplied = db.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC");
  const appliedRows = listApplied.all() as unknown as AppliedMigrationLedgerRow[];
  // Validate every applied row before invoking any migration callback. In
  // particular, a missing earlier version must not commit before a later name
  // mismatch or unknown lineage is discovered.
  const applied = assertValidAppliedMigrationLedger(migrations, appliedRows, "SQLite");
  const markApplied = db.prepare(`
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES (@version, @name, @appliedAt)
  `);

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      // Another process can change any ledger row after the initial snapshot
      // while this connection waits for the SQLite write lock. Revalidate the
      // complete lineage under that lock before invoking a callback.
      const lockedApplied = assertValidAppliedMigrationLedger(
        migrations,
        listApplied.all() as unknown as AppliedMigrationLedgerRow[],
        "SQLite",
      );
      if (lockedApplied.has(migration.version)) {
        db.exec("COMMIT");
        applied.set(migration.version, migration.name);
        continue;
      }
      migration.up(db);
      markApplied.run({
        version: migration.version,
        name: migration.name,
        appliedAt: new Date().toISOString(),
      });
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        // The migration failure remains authoritative. A secondary cleanup
        // failure must not replace the error that explains why startup stopped.
        void rollbackError;
      }
      throw error;
    }
  }

  // Even an initially complete snapshot can become stale without entering the
  // loop above. Take one final brief write lock so startup never reports success
  // for a concurrently introduced unknown or divergent ledger row.
  db.exec("BEGIN IMMEDIATE");
  try {
    assertValidAppliedMigrationLedger(
      migrations,
      listApplied.all() as unknown as AppliedMigrationLedgerRow[],
      "SQLite",
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      void rollbackError;
    }
    throw error;
  }
}

function assertValidSqliteMigrationRegistry(migrations: readonly SqliteMigration[]): void {
  assertValidMigrationDefinitions(migrations, "SQLite");
  for (const migration of migrations) {
    if (typeof migration.up !== "function") {
      throw new Error(`SQLite migration ${migration.version} (${migration.name}) must define a callable up callback.`);
    }
  }
}
