import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { DatabaseClient } from "../db.js";
import { PostgresDatabaseClient } from "./client.js";
import { POSTGRES_MIGRATIONS, type PostgresMigration, type PostgresMigrationBatchStatement } from "./migrations.js";

export interface PostgresMigrationRunResult {
  appliedVersions: number[];
  latestVersion: number;
}

export async function runPostgresMigrations(
  client: PostgresDatabaseClient,
  migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS,
): Promise<PostgresMigrationRunResult> {
  await client.ensureMigrationsTable();
  const applied = await client.getAppliedMigrations();
  const newlyApplied: number[] = [];

  for (const migration of migrations) {
    assertMigrationDefinitionIsExecutable(migration);
    assertPostgresMigrationIntegrity(migration);
    if (applied.has(migration.version)) {
      assertAppliedMigrationNameMatches(migration, applied.get(migration.version));
      continue;
    }
    if (migration.batchedStatements) {
      await runBatchedMigration(client, migration, migration.batchedStatements);
      await client.transaction(async (tx) => {
        await markApplied(tx, client, migration.version, migration.name);
      });
      newlyApplied.push(migration.version);
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

async function runBatchedMigration(
  client: PostgresDatabaseClient,
  migration: PostgresMigration,
  statements: readonly PostgresMigrationBatchStatement[],
): Promise<void> {
  let changedRows: number;
  do {
    changedRows = 0;
    for (const statement of statements) {
      changedRows += await client.transaction(async (tx) => {
        const result = await tx.query(statement.sql);
        return assertAffectedRowCount(migration, statement, result.rowCount);
      });
    }
  } while (changedRows > 0);
}

function assertMigrationDefinitionIsExecutable(migration: PostgresMigration): void {
  const hasAtomicSql = migration.sql.trim().length > 0;
  const statements = migration.batchedStatements;
  if (!statements) {
    if (!hasAtomicSql) {
      throw new Error(
        `Postgres migration ${migration.version} (${migration.name}) must define atomic SQL or batched statements.`,
      );
    }
    return;
  }
  if (hasAtomicSql) {
    throw new Error(
      `Postgres migration ${migration.version} (${migration.name}) cannot define both atomic SQL and batched statements.`,
    );
  }
  if (statements.length === 0) {
    throw new Error(
      `Postgres migration ${migration.version} (${migration.name}) must define at least one batched statement.`,
    );
  }
  const names = new Set<string>();
  for (const statement of statements) {
    const name = statement.name.trim();
    if (!name || !statement.sql.trim()) {
      throw new Error(
        `Postgres migration ${migration.version} (${migration.name}) contains an unnamed or empty batched statement.`,
      );
    }
    if (names.has(name)) {
      throw new Error(
        `Postgres migration ${migration.version} (${migration.name}) contains duplicate batched statement name "${name}".`,
      );
    }
    names.add(name);
  }
}

export function assertPostgresMigrationIntegrity(migration: PostgresMigration): void {
  if (!migration.integritySha256) {
    return;
  }
  const content = migration.batchedStatements
    ? `batched\n${migration.batchedStatements
        .map((statement) => `${statement.name}\n${normalizeMigrationSql(statement.sql)}`)
        .join("\n-- goatcitadel migration batch --\n")}`
    : `atomic\n${normalizeMigrationSql(migration.sql)}`;
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== migration.integritySha256) {
    throw new Error(
      `Postgres migration ${migration.version} (${migration.name}) integrity hash mismatch: expected ${migration.integritySha256}, found ${actual}.`,
    );
  }
}

function normalizeMigrationSql(sql: string): string {
  return sql.replace(/\r\n/g, "\n").trim();
}

function assertAffectedRowCount(
  migration: PostgresMigration,
  statement: PostgresMigrationBatchStatement,
  value: unknown,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Postgres batched migration ${migration.version} (${migration.name}) statement "${statement.name}" did not report a valid affected-row count.`,
    );
  }
  return value;
}

// Migrations are immutable once authored, so a ledger row whose name differs
// from the code's migration at the same version means the database was
// migrated by a divergent branch lineage. "Version already applied" then no
// longer implies "this migration ran": skipping would silently drop schema
// changes (this is how cron_jobs lost its run-evidence columns), and running
// blindly could conflict with whatever the other lineage applied. Fail closed
// so the operator reconciles the ledger deliberately.
function assertAppliedMigrationNameMatches(migration: PostgresMigration, appliedName: string | undefined): void {
  if (appliedName === undefined || appliedName === migration.name) {
    return;
  }
  throw new Error(
    `Postgres migration ledger mismatch at version ${migration.version}: database recorded "${appliedName}" but this build defines "${migration.name}". ` +
      `Refusing to treat "${migration.name}" as applied. Verify which schema changes actually ran, apply any missing ones, ` +
      `then correct the schema_migrations row for version ${migration.version}.`,
  );
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
  // Quote the table name as a Postgres identifier (double-quote, doubling any
  // embedded quotes) so it is splice-safe even though it is interpolated into DDL.
  const quotedMigrationsTable = `"${migrationsTable.replace(/"/g, '""')}"`;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${quotedMigrationsTable} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const appliedRows = db
    .prepare(`SELECT version, name FROM ${quotedMigrationsTable} ORDER BY version ASC`)
    .all() as Array<{ version: number; name: string }>;
  const applied = new Map(appliedRows.map((row) => [Number(row.version), row.name]));
  const markAppliedStmt = db.prepare(`
    INSERT INTO ${quotedMigrationsTable} (version, name, applied_at)
    VALUES (@version, @name, CURRENT_TIMESTAMP)
    ON CONFLICT (version) DO NOTHING
  `);

  for (const migration of migrations) {
    assertMigrationDefinitionIsExecutable(migration);
    assertPostgresMigrationIntegrity(migration);
    if (applied.has(migration.version)) {
      assertAppliedMigrationNameMatches(migration, applied.get(migration.version));
      continue;
    }
    if (migration.batchedStatements) {
      runBatchedMigrationSync(db, migration, migration.batchedStatements);
      db.transaction("immediate", () => {
        markAppliedStmt.run({
          version: migration.version,
          name: migration.name,
        });
      });
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

function runBatchedMigrationSync(
  db: DatabaseClient,
  migration: PostgresMigration,
  statements: readonly PostgresMigrationBatchStatement[],
): void {
  let changedRows: number;
  do {
    changedRows = 0;
    for (const statement of statements) {
      changedRows += db.transaction("immediate", () =>
        assertAffectedRowCount(migration, statement, db.prepare(statement.sql).run().changes),
      );
    }
  } while (changedRows > 0);
}
