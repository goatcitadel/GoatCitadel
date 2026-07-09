import type { DatabaseSync } from "node:sqlite";

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
  return groups.flatMap((group) => group.migrations);
}

export function runSqliteMigrations(db: DatabaseSync, migrations: readonly SqliteMigration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => row.version));
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
      migration.up(db);
      markApplied.run({
        version: migration.version,
        name: migration.name,
        appliedAt: new Date().toISOString(),
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
