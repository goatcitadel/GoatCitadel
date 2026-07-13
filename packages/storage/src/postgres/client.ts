import { performance } from "node:perf_hooks";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import { POSTGRES_MIGRATIONS } from "./migrations.js";
import {
  assertPostgresMigrationCurrentSchemaIsDurable,
  assertPostgresMigrationLedgerNotShadowed,
  assertPostgresMigrationSessionIsIdle,
  assertPostgresMigrationTransactionProbeAcquired,
  assertPostgresMigrationSchemaIdentityMatches,
  assertPostgresMigrationSearchPathConfigured,
  assertPostgresMigrationSessionHasNoTempObjects,
  buildPostgresMigrationLedgerTempShadowPreflightSql,
  buildPostgresMigrationLedgerGuardLockSql,
  buildPostgresMigrationSchemaIdentityCheckSql,
  buildPostgresMigrationSearchPath,
  buildPostgresMigrationSetLocalSearchPathSql,
  buildPostgresMigrationTransactionDatabaseClassificationSql,
  buildPostgresQualifiedMigrationLedger,
  parsePostgresMigrationActiveTransactionIds,
  selectPostgresMigrationPreexistingTransactionIds,
  classifyPostgresMigrationTransactionDatabase,
  type PostgresMigrationSchemaIdentity,
  PostgresMigrationSessionContaminationError,
  POSTGRES_MIGRATION_ACTIVE_TRANSACTION_PREFLIGHT_SQL,
  POSTGRES_MIGRATION_SESSION_TRANSACTION_CHECK_SQL,
  POSTGRES_MIGRATION_SESSION_TRANSACTION_PROBE_SQL,
  POSTGRES_MIGRATION_TRANSACTION_EPOCH_BARRIER_SQL,
  POSTGRES_MIGRATION_CURRENT_SCHEMA_PREFLIGHT_SQL,
  POSTGRES_MIGRATION_TEMP_OBJECT_PREFLIGHT_SQL,
  quotePostgresIdentifier,
} from "./migration-ledger-compatibility.js";
import { sanitizeParamsForServerEncoding } from "./server-encoding.js";

const POSTGRES_MIGRATION_QUIESCENCE_RETRY_MS = 50;
const POSTGRES_MIGRATION_QUIESCENCE_TIMEOUT_MS = 5_000;

export type PostgresSslMode = "disable" | "prefer" | "require";

export interface PostgresConnectionOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database: string;
  user?: string;
  password?: string;
  sslMode?: PostgresSslMode;
  applicationName?: string;
  pool?: Partial<{
    min: number;
    max: number;
    idleTimeoutMs: number;
    connectionTimeoutMs: number;
  }>;
}

export interface PostgresHealthCheck {
  reachable: boolean;
  latencyMs?: number;
  migrationVersion?: number;
  issues: string[];
}

export interface PostgresMigrationLockOptions {
  waitForLock?: boolean;
}

class PostgresMigrationLockUnavailableError extends Error {
  public constructor() {
    super("Postgres migration work is in progress; health inspection was skipped.");
    this.name = "PostgresMigrationLockUnavailableError";
  }
}

export function buildPostgresMigrationLockSql(parameter: string): string {
  return `
    WITH migration_lock AS (
      SELECT pg_catalog.hashtextextended(
        pg_catalog.concat(
          pg_catalog.current_database(),
          pg_catalog.chr(31),
          COALESCE(pg_catalog.current_schema(), ''),
          pg_catalog.chr(31),
          ${parameter}::pg_catalog.text
        ),
        0
      ) AS lock_key
    )
    SELECT lock_key::pg_catalog.text AS lock_key, pg_catalog.pg_advisory_lock(lock_key) AS locked
    FROM migration_lock
  `;
}

export function buildPostgresMigrationTryLockSql(parameter: string): string {
  return `
    WITH migration_lock AS (
      SELECT pg_catalog.hashtextextended(
        pg_catalog.concat(
          pg_catalog.current_database(),
          pg_catalog.chr(31),
          COALESCE(pg_catalog.current_schema(), ''),
          pg_catalog.chr(31),
          ${parameter}::pg_catalog.text
        ),
        0
      ) AS lock_key
    )
    SELECT lock_key::pg_catalog.text AS lock_key, pg_catalog.pg_try_advisory_lock(lock_key) AS locked
    FROM migration_lock
  `;
}

export function buildPostgresMigrationUnlockSql(parameter: string): string {
  return `SELECT pg_catalog.pg_advisory_unlock(${parameter}::pg_catalog.int8) AS unlocked`;
}

export function parsePostgresMigrationLockKey(row: unknown): string {
  const lockKey =
    typeof row === "object" && row !== null && "lock_key" in row ? (row as { lock_key?: unknown }).lock_key : undefined;
  if (typeof lockKey !== "string" || !/^-?\d+$/.test(lockKey)) {
    throw new Error("Postgres migration lock acquisition did not return a valid lock key.");
  }
  return lockKey;
}

export function parsePostgresMigrationTryLockResult(row: unknown): { lockKey: string; locked: boolean } {
  const lockKey = parsePostgresMigrationLockKey(row);
  const locked =
    typeof row === "object" && row !== null && "locked" in row ? (row as { locked?: unknown }).locked : undefined;
  if (typeof locked !== "boolean") {
    throw new Error("Postgres migration lock attempt did not return a valid acquisition result.");
  }
  return { lockKey, locked };
}

export function assertPostgresMigrationLockReleased(row: unknown): void {
  const unlocked =
    typeof row === "object" && row !== null && "unlocked" in row ? (row as { unlocked?: unknown }).unlocked : undefined;
  if (unlocked !== true) {
    throw new Error("Postgres migration advisory lock was not released by its owning session.");
  }
}

export class PostgresDatabaseClient {
  private readonly pool: Pool;
  private readonly migrationsTable: string;
  private readonly quotedMigrationsTable: string;
  private readonly unsafeTransactionClients = new WeakSet<PoolClient>();
  private serverEncodingPromise?: Promise<string | undefined>;

  public constructor(
    options: PostgresConnectionOptions,
    input?: {
      migrationsTable?: string;
      pool?: Pool;
    },
  ) {
    this.migrationsTable = input?.migrationsTable ?? "schema_migrations";
    this.quotedMigrationsTable = quotePostgresIdentifier(this.migrationsTable);
    this.pool = input?.pool ?? new Pool(buildPoolConfig(options));
  }

  public async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(sql, await this.sanitizeParams(sql, params));
    return result.rows;
  }

  public async queryOne<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  public async transaction<T>(callback: (client: PoolClient) => Promise<T>, pinnedClient?: PoolClient): Promise<T> {
    const client = pinnedClient ?? (await this.pool.connect());
    const ownsClient = pinnedClient === undefined;
    let rollbackFailed = false;
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
        if (!ownsClient) {
          this.unsafeTransactionClients.add(client);
        }
      }
      throw error;
    } finally {
      if (ownsClient) {
        client.release(rollbackFailed);
      }
    }
  }

  public async ensureMigrationsTable(
    pinnedClient?: PoolClient,
    migrationSchema?: PostgresMigrationSchemaIdentity,
  ): Promise<void> {
    const executor = pinnedClient ?? this.pool;
    const migrationsTable = migrationSchema
      ? buildPostgresQualifiedMigrationLedger(migrationSchema, this.migrationsTable)
      : this.quotedMigrationsTable;
    await executor.query(`
      CREATE TABLE IF NOT EXISTS ${migrationsTable} (
        version pg_catalog.int4 PRIMARY KEY,
        name pg_catalog.text NOT NULL,
        applied_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.now()
      )
    `);
  }

  public async getAppliedMigrationVersions(pinnedClient?: PoolClient): Promise<Set<number>> {
    return new Set((await this.getAppliedMigrations(pinnedClient)).keys());
  }

  public getMigrationsTableName(): string {
    return this.migrationsTable;
  }

  public async assertMigrationsTableNotShadowed(pinnedClient: PoolClient): Promise<PostgresMigrationSchemaIdentity> {
    const result = await pinnedClient.query<{ relation: string | null }>(
      buildPostgresMigrationLedgerTempShadowPreflightSql("$1"),
      [this.migrationsTable],
    );
    assertPostgresMigrationLedgerNotShadowed(result.rows[0], this.migrationsTable);
    const tempObjects = await pinnedClient.query<{
      existing_temp_relation: string | null;
      existing_temp_type: string | null;
    }>(POSTGRES_MIGRATION_TEMP_OBJECT_PREFLIGHT_SQL);
    assertPostgresMigrationSessionHasNoTempObjects(tempObjects.rows[0]);
    const currentSchema = await pinnedClient.query<{
      current_schema_is_temp: boolean;
      current_schema_name: string;
      current_schema_oid: string;
      current_schema_owned_by_current_user: boolean;
      current_schema_has_exclusive_create_authority: boolean;
      existing_unowned_relation: string | null;
    }>(POSTGRES_MIGRATION_CURRENT_SCHEMA_PREFLIGHT_SQL);
    return assertPostgresMigrationCurrentSchemaIsDurable(currentSchema.rows[0]);
  }

  public async awaitMigrationSchemaQuiescence(pinnedClient: PoolClient): Promise<void> {
    const barrier = await pinnedClient.query<{ active_xid: string }>(POSTGRES_MIGRATION_TRANSACTION_EPOCH_BARRIER_SQL);
    const barrierTransactionIds = parsePostgresMigrationActiveTransactionIds(barrier.rows);
    if (barrierTransactionIds.length !== 1) {
      throw new PostgresMigrationSessionContaminationError(
        "Postgres migration transaction-epoch barrier did not return exactly one transaction id.",
      );
    }
    const snapshot = await pinnedClient.query<{ active_xid: string }>(
      POSTGRES_MIGRATION_ACTIVE_TRANSACTION_PREFLIGHT_SQL,
    );
    const pending = new Set(
      selectPostgresMigrationPreexistingTransactionIds(
        barrierTransactionIds[0]!,
        parsePostgresMigrationActiveTransactionIds(snapshot.rows),
      ),
    );
    const deadline = performance.now() + POSTGRES_MIGRATION_QUIESCENCE_TIMEOUT_MS;
    while (pending.size > 0) {
      for (const transactionId of [...pending]) {
        const result = await pinnedClient.query<{
          transaction_status: string;
          observed_database_count: string;
          current_database_observed: boolean;
        }>(buildPostgresMigrationTransactionDatabaseClassificationSql("$1"), [transactionId]);
        const classification = classifyPostgresMigrationTransactionDatabase(result.rows[0]);
        if (classification === "complete" || classification === "other") {
          pending.delete(transactionId);
        }
      }
      if (pending.size === 0) {
        break;
      }
      if (performance.now() >= deadline) {
        throw new PostgresMigrationSessionContaminationError(
          `Postgres migration schema did not become quiescent before timeout; active transactions: ${[...pending].join(
            ", ",
          )}.`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, POSTGRES_MIGRATION_QUIESCENCE_RETRY_MS));
    }
  }

  public async configureMigrationTransaction(
    pinnedClient: PoolClient,
    migrationSchema: PostgresMigrationSchemaIdentity,
    historyRepairBridge: boolean,
  ): Promise<void> {
    const searchPath = buildPostgresMigrationSearchPath(migrationSchema, historyRepairBridge);
    const configured = await pinnedClient.query<{ migration_search_path: string }>(
      buildPostgresMigrationSetLocalSearchPathSql("$1"),
      [searchPath],
    );
    assertPostgresMigrationSearchPathConfigured(configured.rows[0], searchPath);
    await this.assertMigrationSchemaIdentity(pinnedClient, migrationSchema);
    await this.ensureMigrationsTable(pinnedClient, migrationSchema);
    const qualifiedMigrationsTable = buildPostgresQualifiedMigrationLedger(migrationSchema, this.migrationsTable);
    await pinnedClient.query(buildPostgresMigrationLedgerGuardLockSql(qualifiedMigrationsTable));
    await this.assertMigrationSchemaIdentity(pinnedClient, migrationSchema);
  }

  public async assertMigrationSchemaIdentity(
    pinnedClient: PoolClient,
    migrationSchema: PostgresMigrationSchemaIdentity,
  ): Promise<void> {
    const identity = await pinnedClient.query<{
      current_schema_name: string;
      current_schema_oid: string;
      current_schema_owned_by_current_user: boolean;
      current_schema_has_exclusive_create_authority: boolean;
      existing_unowned_relation: string | null;
    }>(buildPostgresMigrationSchemaIdentityCheckSql("$1"), [migrationSchema.name]);
    assertPostgresMigrationSchemaIdentityMatches(identity.rows[0], migrationSchema);
  }

  public async getAppliedMigrations(
    pinnedClient?: PoolClient,
    migrationSchema?: PostgresMigrationSchemaIdentity,
  ): Promise<Map<number, string>> {
    return new Map(
      (await this.getAppliedMigrationRows(pinnedClient, migrationSchema)).map((row) => [Number(row.version), row.name]),
    );
  }

  public async getAppliedMigrationRows(
    pinnedClient?: PoolClient,
    migrationSchema?: PostgresMigrationSchemaIdentity,
  ): Promise<Array<{ version: number; name: string }>> {
    await this.ensureMigrationsTable(pinnedClient, migrationSchema);
    const migrationsTable = migrationSchema
      ? buildPostgresQualifiedMigrationLedger(migrationSchema, this.migrationsTable)
      : this.quotedMigrationsTable;
    const sql = `SELECT version, name FROM ${migrationsTable} ORDER BY version ASC`;
    const rows = pinnedClient
      ? (await pinnedClient.query<{ version: number; name: string }>(sql)).rows
      : await this.query<{ version: number; name: string }>(sql);
    return rows.map((row) => ({ version: Number(row.version), name: row.name }));
  }

  public async withMigrationLock<T>(
    callback: (pinnedClient: PoolClient) => Promise<T>,
    options: PostgresMigrationLockOptions = {},
  ): Promise<T> {
    const pinnedClient = await this.pool.connect();
    let destroySession = false;
    let lockKey: string | undefined;
    let result: T | undefined;
    let primaryError: unknown;
    let hasPrimaryError = false;

    try {
      const transactionProbe = await pinnedClient.query<{ transaction_probe_acquired: boolean }>(
        POSTGRES_MIGRATION_SESSION_TRANSACTION_PROBE_SQL,
      );
      assertPostgresMigrationTransactionProbeAcquired(transactionProbe.rows[0]);
      const transactionState = await pinnedClient.query<{
        transaction_open: boolean;
        existing_advisory_lock: boolean;
      }>(POSTGRES_MIGRATION_SESSION_TRANSACTION_CHECK_SQL);
      assertPostgresMigrationSessionIsIdle(transactionState.rows[0]);
      if (options.waitForLock === false) {
        const lockResult = await pinnedClient.query<{ lock_key: string; locked: boolean }>(
          buildPostgresMigrationTryLockSql("$1"),
          [this.migrationsTable],
        );
        const attempt = parsePostgresMigrationTryLockResult(lockResult.rows[0]);
        if (!attempt.locked) {
          throw new PostgresMigrationLockUnavailableError();
        }
        lockKey = attempt.lockKey;
      } else {
        const lockResult = await pinnedClient.query<{ lock_key: string }>(buildPostgresMigrationLockSql("$1"), [
          this.migrationsTable,
        ]);
        lockKey = parsePostgresMigrationLockKey(lockResult.rows[0]);
      }
    } catch (error) {
      destroySession = !(error instanceof PostgresMigrationLockUnavailableError);
      primaryError = error;
      hasPrimaryError = true;
    }

    if (!hasPrimaryError) {
      try {
        result = await callback(pinnedClient);
      } catch (error) {
        destroySession = true;
        primaryError = error;
        hasPrimaryError = true;
      }
    }

    if (this.unsafeTransactionClients.delete(pinnedClient)) {
      destroySession = true;
    }

    if (lockKey !== undefined) {
      try {
        const unlockResult = await pinnedClient.query<{ unlocked: boolean }>(buildPostgresMigrationUnlockSql("$1"), [
          lockKey,
        ]);
        assertPostgresMigrationLockReleased(unlockResult.rows[0]);
      } catch (error) {
        destroySession = true;
        if (!hasPrimaryError) {
          primaryError = error;
          hasPrimaryError = true;
        }
      }
    }

    try {
      pinnedClient.release(destroySession);
    } catch (error) {
      if (!hasPrimaryError || primaryError instanceof PostgresMigrationLockUnavailableError) {
        primaryError = error;
        hasPrimaryError = true;
      }
    }

    if (hasPrimaryError) {
      throw primaryError;
    }
    return result as T;
  }

  public async markMigrationApplied(
    version: number,
    name: string,
    client?: PoolClient,
    migrationSchema?: PostgresMigrationSchemaIdentity,
  ): Promise<void> {
    const executor = client ?? this.pool;
    const migrationsTable = migrationSchema
      ? buildPostgresQualifiedMigrationLedger(migrationSchema, this.migrationsTable)
      : this.quotedMigrationsTable;
    await executor.query(
      `
        INSERT INTO ${migrationsTable} (version, name, applied_at)
        VALUES ($1, $2, pg_catalog.now())
      `,
      [version, name],
    );
  }

  public async healthCheck(): Promise<PostgresHealthCheck> {
    const started = performance.now();
    const issues: string[] = [];
    let result: PostgresHealthCheck;
    try {
      result = await this.withMigrationLock(
        async (pinnedClient) => {
          const migrationSchema = await this.assertMigrationsTableNotShadowed(pinnedClient);
          return this.transaction(async (tx) => {
            await this.configureMigrationTransaction(tx, migrationSchema, false);
            await tx.query("SELECT 1 AS ok");
            const appliedMigrations = await this.getAppliedMigrationRows(tx, migrationSchema);
            const latestVersion = appliedMigrations.reduce((max, row) => Math.max(max, Number(row.version)), 0);
            issues.push(...findMigrationNameDrift(appliedMigrations));
            issues.push(...(await this.findRequiredSchemaIssues(latestVersion, appliedMigrations, tx)));
            await this.assertMigrationSchemaIdentity(tx, migrationSchema);
            return {
              reachable: true,
              latencyMs: Math.round((performance.now() - started) * 100) / 100,
              migrationVersion: latestVersion,
              issues,
            };
          }, pinnedClient);
        },
        { waitForLock: false },
      );
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      result = {
        reachable: error instanceof PostgresMigrationLockUnavailableError,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
        issues,
      };
    }
    return result;
  }

  private async findRequiredSchemaIssues(
    latestVersion: number,
    appliedMigrations: ReadonlyArray<{ version: number; name: string }>,
    pinnedClient: PoolClient,
  ): Promise<string[]> {
    const issues: string[] = [];
    const runtimeSchemaRepairApplied =
      latestVersion >= 7 ||
      appliedMigrations.some((migration) => migration.name === "canonical_runtime_schema_repairs");
    if (runtimeSchemaRepairApplied) {
      issues.push(...(await this.findMissingTables(["agent_commitments", "operator_profiles"], pinnedClient)));
      issues.push(...(await this.findMissingColumns("memory_items", ["workspace_id"], pinnedClient)));
    }

    const chatPrefsRepairApplied =
      latestVersion >= 28 || appliedMigrations.some((migration) => migration.name === "chat_operator_control_prefs");
    if (chatPrefsRepairApplied) {
      issues.push(
        ...(await this.findMissingColumns("chat_session_prefs", ["speed_mode", "subagent_policy"], pinnedClient)),
      );
    }

    const autonomyHeartbeatRepairApplied =
      latestVersion >= 71 ||
      appliedMigrations.some((migration) => migration.name === "session_autonomy_heartbeat_prefs");
    if (autonomyHeartbeatRepairApplied) {
      issues.push(
        ...(await this.findMissingColumns(
          "session_autonomy_prefs",
          ["heartbeat_enabled", "heartbeat_interval_seconds", "active_hours_json"],
          pinnedClient,
        )),
      );
    }

    return issues;
  }

  private async findMissingTables(tableNames: readonly string[], pinnedClient: PoolClient): Promise<string[]> {
    if (tableNames.length === 0) {
      return [];
    }
    const tablePlaceholders = tableNames.map((_, index) => `$${index + 1}`).join(", ");
    const rows = (
      await pinnedClient.query<{ table_name: string }>(
        `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = pg_catalog.current_schema()
        AND table_name IN (${tablePlaceholders})
    `,
        [...tableNames],
      )
    ).rows;
    const present = new Set(rows.map((row) => row.table_name));
    const missing = tableNames.filter((table) => !present.has(table));
    return missing.map((table) => `schema drift: ${table} table is missing`);
  }

  private async findMissingColumns(
    tableName: string,
    columnNames: readonly string[],
    pinnedClient: PoolClient,
  ): Promise<string[]> {
    if (columnNames.length === 0) {
      return [];
    }
    const columnPlaceholders = columnNames.map((_, index) => `$${index + 2}`).join(", ");
    const rows = (
      await pinnedClient.query<{ column_name: string }>(
        `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = pg_catalog.current_schema()
        AND table_name = $1
        AND column_name IN (${columnPlaceholders})
    `,
        [tableName, ...columnNames],
      )
    ).rows;
    const present = new Set(rows.map((row) => row.column_name));
    const missing = columnNames.filter((column) => !present.has(column));
    return missing.map((column) => `schema drift: ${tableName}.${column} is missing`);
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  private async sanitizeParams(sql: string, params: readonly unknown[]): Promise<unknown[]> {
    return sanitizeParamsForServerEncoding(params, await this.getServerEncoding(), sql);
  }

  private async getServerEncoding(): Promise<string | undefined> {
    if (!this.serverEncodingPromise) {
      this.serverEncodingPromise = this.pool
        .query<{ server_encoding: string }>("SELECT current_setting('server_encoding') AS server_encoding")
        .then((result) => result.rows[0]?.server_encoding)
        .catch(() => undefined);
    }
    return this.serverEncodingPromise;
  }
}

function findMigrationNameDrift(appliedMigrations: ReadonlyArray<{ version: number; name: string }>): string[] {
  const expectedByVersion = new Map(POSTGRES_MIGRATIONS.map((migration) => [migration.version, migration.name]));
  const issues: string[] = [];
  for (const applied of appliedMigrations) {
    const version = Number(applied.version);
    const expectedName = expectedByVersion.get(version);
    if (!expectedName) {
      issues.push(`schema drift: unknown migration version ${version} (${applied.name})`);
      continue;
    }
    if (applied.name !== expectedName) {
      issues.push(`schema drift: migration ${version} is ${applied.name}, expected ${expectedName}`);
    }
  }
  return issues;
}

function buildPoolConfig(options: PostgresConnectionOptions): PoolConfig {
  const base: PoolConfig = {
    application_name: options.applicationName ?? "goatcitadel",
    options: "-c client_encoding=UTF8",
    max: options.pool?.max ?? 10,
    min: options.pool?.min ?? 0,
    idleTimeoutMillis: options.pool?.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.pool?.connectionTimeoutMs ?? 5_000,
  };

  if (options.connectionString?.trim()) {
    return {
      ...base,
      connectionString: options.connectionString.trim(),
      ssl: mapSslMode(options.sslMode),
    };
  }

  return {
    ...base,
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 5432,
    database: options.database,
    user: options.user,
    password: options.password,
    ssl: mapSslMode(options.sslMode),
  };
}

function mapSslMode(mode: PostgresSslMode | undefined): PoolConfig["ssl"] {
  switch (mode) {
    case "require":
      return { rejectUnauthorized: false };
    case "disable":
    case "prefer":
    default:
      return undefined;
  }
}
