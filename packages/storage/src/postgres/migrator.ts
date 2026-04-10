import type { PoolClient } from "pg";
import type { DatabaseClient } from "../db.js";
import { PostgresDatabaseClient } from "./client.js";
import { POSTGRES_MIGRATIONS, type PostgresMigration } from "./migrations.js";

export interface PostgresMigrationRunResult {
  appliedVersions: number[];
  latestVersion: number;
}

export async function runPostgresMigrations(
  client: PostgresDatabaseClient,
  migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS,
): Promise<PostgresMigrationRunResult> {
  await client.ensureMigrationsTable();
  const applied = await client.getAppliedMigrationVersions();
  const newlyApplied: number[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    await client.transaction(async (tx) => {
      await tx.query(migration.sql);
      await markApplied(tx, client, migration.version, migration.name);
    });
    newlyApplied.push(migration.version);
  }

  return {
    appliedVersions: newlyApplied,
    latestVersion: migrations[migrations.length - 1]?.version ?? 0,
  };
}

async function markApplied(
  tx: PoolClient,
  client: PostgresDatabaseClient,
  version: number,
  name: string,
): Promise<void> {
  await client.markMigrationApplied(version, name, tx);
}

export function applyPostgresMigrationsSync(
  db: DatabaseClient,
  input?: {
    migrationsTable?: string;
    migrations?: readonly PostgresMigration[];
  },
): void {
  const migrationsTable = input?.migrationsTable ?? "schema_migrations";
  const migrations = input?.migrations ?? POSTGRES_MIGRATIONS;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${migrationsTable} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const appliedRows = db.prepare(`SELECT version FROM ${migrationsTable} ORDER BY version ASC`).all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map((row) => row.version));
  const markAppliedStmt = db.prepare(`
    INSERT INTO ${migrationsTable} (version, name, applied_at)
    VALUES (@version, @name, CURRENT_TIMESTAMP)
    ON CONFLICT (version) DO NOTHING
  `);

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.transaction("immediate", () => {
      db.exec(migration.sql);
      markAppliedStmt.run({
        version: migration.version,
        name: migration.name,
      });
    });
  }
}
