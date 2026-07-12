import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { DatabaseClient } from "../db.js";
import { assertValidAppliedMigrationLedger, assertValidMigrationDefinitions } from "../migration-ledger-validation.js";
import {
  assertPostgresMigrationLockReleased,
  buildPostgresMigrationTryLockSql,
  buildPostgresMigrationUnlockSql,
  parsePostgresMigrationTryLockResult,
  PostgresDatabaseClient,
} from "./client.js";
import {
  assertPostgresHistoryRepairTempRelationAvailable,
  assertPostgresHistoryRepairTempViewOwnsResolution,
  assertPostgresHistoryRepairRegistryIntegrity,
  assertPostgresMigrationCurrentSchemaIsDurable,
  assertPostgresMigrationLedgerNotShadowed,
  assertPostgresMigrationSessionIsIdle,
  assertPostgresMigrationTransactionProbeAcquired,
  assertPostgresMigrationSchemaIdentityMatches,
  assertPostgresMigrationSearchPathConfigured,
  assertPostgresMigrationSessionHasNoTempObjects,
  buildPostgresMigrationLedgerGuardLockSql,
  buildPostgresMigrationSchemaIdentityCheckSql,
  buildPostgresMigrationSearchPath,
  buildPostgresMigrationSetLocalSearchPathSql,
  buildPostgresMigrationTransactionDatabaseClassificationSql,
  buildPostgresQualifiedMigrationLedger,
  buildPostgresMigrationLedgerTempShadowPreflightSql,
  buildPostgresHistoryRepairTempViewSql,
  isPostgresHistoryRepairMigration,
  normalizePostgresMigrationLedgerForHistoricalRepair,
  parsePostgresMigrationActiveTransactionIds,
  selectPostgresMigrationPreexistingTransactionIds,
  classifyPostgresMigrationTransactionDatabase,
  POSTGRES_HISTORY_REPAIR_TEMP_RELATION_PREFLIGHT_SQL,
  POSTGRES_HISTORY_REPAIR_TEMP_VIEW_DROP_SQL,
  POSTGRES_HISTORY_REPAIR_TEMP_VIEW_RESOLUTION_SQL,
  PostgresMigrationSessionContaminationError,
  POSTGRES_MIGRATION_ACTIVE_TRANSACTION_PREFLIGHT_SQL,
  POSTGRES_MIGRATION_SESSION_TRANSACTION_CHECK_SQL,
  POSTGRES_MIGRATION_SESSION_TRANSACTION_PROBE_SQL,
  POSTGRES_MIGRATION_TRANSACTION_EPOCH_BARRIER_SQL,
  POSTGRES_MIGRATION_CURRENT_SCHEMA_PREFLIGHT_SQL,
  POSTGRES_MIGRATION_TEMP_OBJECT_PREFLIGHT_SQL,
  type PostgresMigrationSchemaIdentity,
  quotePostgresIdentifier,
  requiresPostgresHistoryRepairLedgerBridge,
} from "./migration-ledger-compatibility.js";
import { POSTGRES_MIGRATIONS, type PostgresMigration, type PostgresMigrationBatchStatement } from "./migrations.js";
import type { PostgresPinnedSessionControls } from "./sync.js";

const POSTGRES_MIGRATION_LOCK_RETRY_MS = 100;
const POSTGRES_MIGRATION_QUIESCENCE_RETRY_MS = 50;
const POSTGRES_MIGRATION_QUIESCENCE_TIMEOUT_MS = 5_000;
const POSTGRES_MIGRATION_LOCK_RETRY_STATE = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface PostgresMigrationRunResult {
  appliedVersions: number[];
  latestVersion: number;
}

export async function runPostgresMigrations(
  client: PostgresDatabaseClient,
  migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS,
): Promise<PostgresMigrationRunResult> {
  assertValidPostgresMigrationRegistry(migrations);
  return client.withMigrationLock(async (pinnedClient) => {
    const migrationSchema = await client.assertMigrationsTableNotShadowed(pinnedClient);
    await client.awaitMigrationSchemaQuiescence(pinnedClient);
    const { applied, compatibility } = await client.transaction(async (tx) => {
      await client.configureMigrationTransaction(tx, migrationSchema, false);
      const appliedRows = await client.getAppliedMigrationRows(tx, migrationSchema);
      const normalizedCompatibility = normalizePostgresMigrationLedgerForHistoricalRepair({
        definitions: migrations,
        appliedRows,
      });
      const result = {
        compatibility: normalizedCompatibility,
        applied: assertValidAppliedMigrationLedger(migrations, normalizedCompatibility.appliedRows, "Postgres"),
      };
      await client.assertMigrationSchemaIdentity(tx, migrationSchema);
      return result;
    }, pinnedClient);
    const newlyApplied: number[] = [];

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }
      if (migration.batchedStatements) {
        await runBatchedMigration(client, pinnedClient, migrationSchema, migration, migration.batchedStatements);
        await client.transaction(async (tx) => {
          await client.configureMigrationTransaction(tx, migrationSchema, false);
          await markApplied(tx, client, migrationSchema, migration.version, migration.name);
          if (compatibility.requiresHistoryRepairValidation && isPostgresHistoryRepairMigration(migration)) {
            await assertStrictPostgresLedger(client, tx, migrationSchema, migrations);
          }
          await client.assertMigrationSchemaIdentity(tx, migrationSchema);
        }, pinnedClient);
        newlyApplied.push(migration.version);
        continue;
      }
      await client.transaction(async (tx) => {
        const bridgeRequired = requiresPostgresHistoryRepairLedgerBridge(client.getMigrationsTableName(), migration);
        await client.configureMigrationTransaction(tx, migrationSchema, bridgeRequired);
        const bridgeActive = await executePostgresAtomicMigration(
          tx,
          migrationSchema,
          client.getMigrationsTableName(),
          migration,
        );
        await markApplied(tx, client, migrationSchema, migration.version, migration.name);
        if (compatibility.requiresHistoryRepairValidation && isPostgresHistoryRepairMigration(migration)) {
          await assertStrictPostgresLedger(client, tx, migrationSchema, migrations);
        }
        if (bridgeActive) {
          await tx.query(POSTGRES_HISTORY_REPAIR_TEMP_VIEW_DROP_SQL);
        }
        await client.assertMigrationSchemaIdentity(tx, migrationSchema);
      }, pinnedClient);
      newlyApplied.push(migration.version);
    }

    return {
      appliedVersions: newlyApplied,
      latestVersion: migrations[migrations.length - 1]?.version ?? 0,
    };
  });
}

async function executePostgresAtomicMigration(
  tx: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  migrationsTable: string,
  migration: PostgresMigration,
): Promise<boolean> {
  if (!requiresPostgresHistoryRepairLedgerBridge(migrationsTable, migration)) {
    await tx.query(migration.sql);
    return false;
  }

  const preflight = await tx.query<{ relation: string | null }>(POSTGRES_HISTORY_REPAIR_TEMP_RELATION_PREFLIGHT_SQL);
  assertPostgresHistoryRepairTempRelationAvailable(preflight.rows[0]);
  await tx.query(buildPostgresHistoryRepairTempViewSql(migrationsTable, migrationSchema));
  const resolution = await tx.query<{ bridge_active: boolean | null }>(
    POSTGRES_HISTORY_REPAIR_TEMP_VIEW_RESOLUTION_SQL,
  );
  assertPostgresHistoryRepairTempViewOwnsResolution(resolution.rows[0]);
  await tx.query(migration.sql);
  return true;
}

async function assertStrictPostgresLedger(
  client: PostgresDatabaseClient,
  pinnedClient: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  migrations: readonly PostgresMigration[],
): Promise<void> {
  const appliedRows = await client.getAppliedMigrationRows(pinnedClient, migrationSchema);
  assertValidAppliedMigrationLedger(migrations, appliedRows, "Postgres");
}

function assertValidPostgresMigrationRegistry(migrations: readonly PostgresMigration[]): void {
  assertValidMigrationDefinitions(migrations, "Postgres");
  for (const migration of migrations) {
    assertMigrationDefinitionIsExecutable(migration);
    assertPostgresMigrationIntegrity(migration);
  }
  assertPostgresHistoryRepairRegistryIntegrity(migrations);
}

async function runBatchedMigration(
  client: PostgresDatabaseClient,
  pinnedClient: PoolClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  migration: PostgresMigration,
  statements: readonly PostgresMigrationBatchStatement[],
): Promise<void> {
  let changedRows: number;
  do {
    changedRows = 0;
    for (const statement of statements) {
      changedRows += await client.transaction(async (tx) => {
        await client.configureMigrationTransaction(tx, migrationSchema, false);
        const result = await tx.query(statement.sql);
        const affectedRows = assertAffectedRowCount(migration, statement, result.rowCount);
        await client.assertMigrationSchemaIdentity(tx, migrationSchema);
        return affectedRows;
      }, pinnedClient);
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

async function markApplied(
  tx: PoolClient,
  client: PostgresDatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity,
  version: number,
  name: string,
): Promise<void> {
  await client.markMigrationApplied(version, name, tx, migrationSchema);
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
  quotePostgresIdentifier(migrationsTable);
  assertValidPostgresMigrationRegistry(migrations);
  if (db.dialect === "postgres") {
    const pinnedDb = requirePinnedSessionDatabase(db);
    pinnedDb.withPinnedSession((controls) => {
      applyPostgresMigrationsSyncWithLock(db, migrationsTable, migrations, controls);
    });
    return;
  }
  applyPostgresMigrationsSyncLocked(db, migrationsTable, migrations);
}

function applyPostgresMigrationsSyncWithLock(
  db: DatabaseClient,
  migrationsTable: string,
  migrations: readonly PostgresMigration[],
  controls: PostgresPinnedSessionControls,
): void {
  let lockKey: string;
  try {
    const transactionProbe = db
      .prepare(POSTGRES_MIGRATION_SESSION_TRANSACTION_PROBE_SQL)
      .get<{ transaction_probe_acquired: boolean }>();
    assertPostgresMigrationTransactionProbeAcquired(transactionProbe);
    const transactionState = db
      .prepare(POSTGRES_MIGRATION_SESSION_TRANSACTION_CHECK_SQL)
      .get<{ transaction_open: boolean; existing_advisory_lock: boolean }>();
    assertPostgresMigrationSessionIsIdle(transactionState);
    lockKey = acquirePostgresMigrationLockSync(db, migrationsTable);
  } catch (error) {
    controls.destroyOnRelease();
    throw error;
  }

  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    const migrationSchema = assertSyncMigrationsTableNotShadowed(db, migrationsTable);
    waitForPostgresMigrationSchemaQuiescenceSync(db);
    applyPostgresMigrationsSyncLocked(db, migrationsTable, migrations, migrationSchema);
  } catch (error) {
    controls.destroyOnRelease();
    primaryError = error;
    hasPrimaryError = true;
  }

  try {
    const unlockRow = db.prepare(buildPostgresMigrationUnlockSql("@lockKey")).get({ lockKey });
    assertPostgresMigrationLockReleased(unlockRow);
  } catch (error) {
    controls.destroyOnRelease();
    if (!hasPrimaryError) {
      primaryError = error;
      hasPrimaryError = true;
    }
  }

  if (hasPrimaryError) {
    throw primaryError;
  }
}

function assertSyncMigrationsTableNotShadowed(
  db: DatabaseClient,
  migrationsTable: string,
): PostgresMigrationSchemaIdentity {
  const row = db
    .prepare(buildPostgresMigrationLedgerTempShadowPreflightSql("@migrationsTable"))
    .get({ migrationsTable });
  assertPostgresMigrationLedgerNotShadowed(row, migrationsTable);
  const tempObjects = db.prepare(POSTGRES_MIGRATION_TEMP_OBJECT_PREFLIGHT_SQL).get<{
    existing_temp_relation: string | null;
    existing_temp_type: string | null;
  }>();
  assertPostgresMigrationSessionHasNoTempObjects(tempObjects);
  const currentSchema = db.prepare(POSTGRES_MIGRATION_CURRENT_SCHEMA_PREFLIGHT_SQL).get<{
    current_schema_is_temp: boolean;
    current_schema_name: string;
    current_schema_oid: string;
    current_schema_owned_by_current_user: boolean;
    current_schema_has_exclusive_create_authority: boolean;
    existing_unowned_relation: string | null;
  }>();
  return assertPostgresMigrationCurrentSchemaIsDurable(currentSchema);
}

function acquirePostgresMigrationLockSync(db: DatabaseClient, migrationsTable: string): string {
  const tryLock = db.prepare(buildPostgresMigrationTryLockSql("@migrationsTable"));
  for (;;) {
    const attempt = parsePostgresMigrationTryLockResult(tryLock.get({ migrationsTable }));
    if (attempt.locked) {
      return attempt.lockKey;
    }
    Atomics.wait(POSTGRES_MIGRATION_LOCK_RETRY_STATE, 0, 0, POSTGRES_MIGRATION_LOCK_RETRY_MS);
  }
}

function waitForPostgresMigrationSchemaQuiescenceSync(db: DatabaseClient): void {
  const barrier = parsePostgresMigrationActiveTransactionIds(
    db.prepare(POSTGRES_MIGRATION_TRANSACTION_EPOCH_BARRIER_SQL).all<{ active_xid: string }>(),
  );
  if (barrier.length !== 1) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction-epoch barrier did not return exactly one transaction id.",
    );
  }
  const snapshot = parsePostgresMigrationActiveTransactionIds(
    db.prepare(POSTGRES_MIGRATION_ACTIVE_TRANSACTION_PREFLIGHT_SQL).all<{ active_xid: string }>(),
  );
  const pending = new Set(selectPostgresMigrationPreexistingTransactionIds(barrier[0]!, snapshot));
  const deadline = Date.now() + POSTGRES_MIGRATION_QUIESCENCE_TIMEOUT_MS;
  while (pending.size > 0) {
    for (const transactionId of [...pending]) {
      const result = db.prepare(buildPostgresMigrationTransactionDatabaseClassificationSql("@transactionId")).get<{
        transaction_status: string;
        observed_database_count: string;
        current_database_observed: boolean;
      }>({ transactionId });
      const classification = classifyPostgresMigrationTransactionDatabase(result);
      if (classification === "complete" || classification === "other") {
        pending.delete(transactionId);
      }
    }
    if (pending.size === 0) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new PostgresMigrationSessionContaminationError(
        `Postgres migration schema did not become quiescent before timeout; active transactions: ${[...pending].join(
          ", ",
        )}.`,
      );
    }
    Atomics.wait(POSTGRES_MIGRATION_LOCK_RETRY_STATE, 0, 0, POSTGRES_MIGRATION_QUIESCENCE_RETRY_MS);
  }
}

function applyPostgresMigrationsSyncLocked(
  db: DatabaseClient,
  migrationsTable: string,
  migrations: readonly PostgresMigration[],
  migrationSchema?: PostgresMigrationSchemaIdentity,
): void {
  // Quote the table name as a Postgres identifier (double-quote, doubling any
  // embedded quotes) so it is splice-safe even though it is interpolated into DDL.
  const quotedMigrationsTable = quotePostgresIdentifier(migrationsTable);
  const migrationLedger =
    db.dialect === "postgres" && migrationSchema
      ? buildPostgresQualifiedMigrationLedger(migrationSchema, migrationsTable)
      : quotedMigrationsTable;
  const { applied, compatibility } = db.transaction("immediate", () => {
    configurePostgresMigrationTransactionSync(db, migrationSchema, migrationsTable, false);
    if (db.dialect !== "postgres") {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${quotedMigrationsTable} (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }
    const appliedRows = db.prepare(`SELECT version, name FROM ${migrationLedger} ORDER BY version ASC`).all() as Array<{
      version: number;
      name: string;
    }>;
    const normalizedAppliedRows = appliedRows.map((row) => ({ version: Number(row.version), name: row.name }));
    const normalizedCompatibility =
      db.dialect === "postgres"
        ? normalizePostgresMigrationLedgerForHistoricalRepair({
            definitions: migrations,
            appliedRows: normalizedAppliedRows,
          })
        : { appliedRows: normalizedAppliedRows, requiresHistoryRepairValidation: false };
    const result = {
      compatibility: normalizedCompatibility,
      applied: assertValidAppliedMigrationLedger(migrations, normalizedCompatibility.appliedRows, "Postgres"),
    };
    assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
    return result;
  });

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    if (migration.batchedStatements) {
      runBatchedMigrationSync(db, migrationSchema, migrationsTable, migration, migration.batchedStatements);
      db.transaction("immediate", () => {
        configurePostgresMigrationTransactionSync(db, migrationSchema, migrationsTable, false);
        markMigrationAppliedSync(db, migrationLedger, migration);
        if (compatibility.requiresHistoryRepairValidation && isPostgresHistoryRepairMigration(migration)) {
          assertStrictPostgresLedgerSync(db, migrationLedger, migrations);
        }
        assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
      });
      continue;
    }
    db.transaction("immediate", () => {
      const bridgeRequired =
        db.dialect === "postgres" && requiresPostgresHistoryRepairLedgerBridge(migrationsTable, migration);
      configurePostgresMigrationTransactionSync(db, migrationSchema, migrationsTable, bridgeRequired);
      const bridgeActive = executePostgresAtomicMigrationSync(db, migrationSchema, migrationsTable, migration);
      markMigrationAppliedSync(db, migrationLedger, migration);
      if (compatibility.requiresHistoryRepairValidation && isPostgresHistoryRepairMigration(migration)) {
        assertStrictPostgresLedgerSync(db, migrationLedger, migrations);
      }
      if (bridgeActive) {
        db.exec(POSTGRES_HISTORY_REPAIR_TEMP_VIEW_DROP_SQL);
      }
      assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
    });
  }
}

function markMigrationAppliedSync(
  db: DatabaseClient,
  quotedMigrationsTable: string,
  migration: PostgresMigration,
): void {
  db.prepare(
    `INSERT INTO ${quotedMigrationsTable} (version, name, applied_at) ` + "VALUES (@version, @name, CURRENT_TIMESTAMP)",
  ).run({
    version: migration.version,
    name: migration.name,
  });
}

function configurePostgresMigrationTransactionSync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
  migrationsTable: string,
  historyRepairBridge: boolean,
): void {
  if (db.dialect !== "postgres") {
    return;
  }
  if (!migrationSchema) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction is missing its validated durable schema.",
    );
  }
  const searchPath = buildPostgresMigrationSearchPath(migrationSchema, historyRepairBridge);
  const row = db
    .prepare(buildPostgresMigrationSetLocalSearchPathSql("@searchPath"))
    .get<{ migration_search_path: string }>({ searchPath });
  assertPostgresMigrationSearchPathConfigured(row, searchPath);
  assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
  const qualifiedMigrationsTable = buildPostgresQualifiedMigrationLedger(migrationSchema, migrationsTable);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${qualifiedMigrationsTable} (
      version pg_catalog.int4 PRIMARY KEY,
      name pg_catalog.text NOT NULL,
      applied_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.now()
    );
  `);
  db.exec(buildPostgresMigrationLedgerGuardLockSql(qualifiedMigrationsTable));
  assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
}

function assertPostgresMigrationTransactionSchemaIdentitySync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
): void {
  if (db.dialect !== "postgres") {
    return;
  }
  if (!migrationSchema) {
    throw new PostgresMigrationSessionContaminationError(
      "Postgres migration transaction is missing its validated durable schema.",
    );
  }
  const identity = db.prepare(buildPostgresMigrationSchemaIdentityCheckSql("@schemaName")).get<{
    current_schema_name: string;
    current_schema_oid: string;
    current_schema_owned_by_current_user: boolean;
    current_schema_has_exclusive_create_authority: boolean;
    existing_unowned_relation: string | null;
  }>({ schemaName: migrationSchema.name });
  assertPostgresMigrationSchemaIdentityMatches(identity, migrationSchema);
}

function executePostgresAtomicMigrationSync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
  migrationsTable: string,
  migration: PostgresMigration,
): boolean {
  if (db.dialect !== "postgres" || !requiresPostgresHistoryRepairLedgerBridge(migrationsTable, migration)) {
    db.exec(migration.sql);
    return false;
  }

  const preflight = db.prepare(POSTGRES_HISTORY_REPAIR_TEMP_RELATION_PREFLIGHT_SQL).get<{ relation: string | null }>();
  assertPostgresHistoryRepairTempRelationAvailable(preflight);
  db.exec(buildPostgresHistoryRepairTempViewSql(migrationsTable, migrationSchema));
  const resolution = db
    .prepare(POSTGRES_HISTORY_REPAIR_TEMP_VIEW_RESOLUTION_SQL)
    .get<{ bridge_active: boolean | null }>();
  assertPostgresHistoryRepairTempViewOwnsResolution(resolution);
  db.exec(migration.sql);
  return true;
}

function assertStrictPostgresLedgerSync(
  db: DatabaseClient,
  quotedMigrationsTable: string,
  migrations: readonly PostgresMigration[],
): void {
  const appliedRows = db
    .prepare(`SELECT version, name FROM ${quotedMigrationsTable} ORDER BY version ASC`)
    .all() as Array<{ version: number; name: string }>;
  assertValidAppliedMigrationLedger(
    migrations,
    appliedRows.map((row) => ({ version: Number(row.version), name: row.name })),
    "Postgres",
  );
}

interface PinnedSessionDatabaseClient extends DatabaseClient {
  withPinnedSession<T>(callback: (controls: PostgresPinnedSessionControls) => T): T;
}

function requirePinnedSessionDatabase(db: DatabaseClient): PinnedSessionDatabaseClient {
  const candidate = db as Partial<PinnedSessionDatabaseClient>;
  if (typeof candidate.withPinnedSession !== "function") {
    throw new Error("Postgres migrations require a database client with pinned-session support.");
  }
  return candidate as PinnedSessionDatabaseClient;
}

function runBatchedMigrationSync(
  db: DatabaseClient,
  migrationSchema: PostgresMigrationSchemaIdentity | undefined,
  migrationsTable: string,
  migration: PostgresMigration,
  statements: readonly PostgresMigrationBatchStatement[],
): void {
  let changedRows: number;
  do {
    changedRows = 0;
    for (const statement of statements) {
      changedRows += db.transaction("immediate", () => {
        configurePostgresMigrationTransactionSync(db, migrationSchema, migrationsTable, false);
        const affectedRows = assertAffectedRowCount(migration, statement, db.prepare(statement.sql).run().changes);
        assertPostgresMigrationTransactionSchemaIdentitySync(db, migrationSchema);
        return affectedRows;
      });
    }
  } while (changedRows > 0);
}
