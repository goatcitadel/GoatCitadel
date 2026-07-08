import { performance } from "node:perf_hooks";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import { POSTGRES_MIGRATIONS } from "./migrations.js";
import { sanitizeParamsForServerEncoding } from "./server-encoding.js";

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

export class PostgresDatabaseClient {
  private readonly pool: Pool;
  private readonly migrationsTable: string;
  private serverEncodingPromise?: Promise<string | undefined>;

  public constructor(
    options: PostgresConnectionOptions,
    input?: {
      migrationsTable?: string;
      pool?: Pool;
    },
  ) {
    this.pool = input?.pool ?? new Pool(buildPoolConfig(options));
    this.migrationsTable = input?.migrationsTable ?? "schema_migrations";
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

  public async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async ensureMigrationsTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.migrationsTable} (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  public async getAppliedMigrationVersions(): Promise<Set<number>> {
    return new Set((await this.getAppliedMigrations()).keys());
  }

  public async getAppliedMigrations(): Promise<Map<number, string>> {
    await this.ensureMigrationsTable();
    const rows = await this.query<{ version: number; name: string }>(
      `SELECT version, name FROM ${this.migrationsTable} ORDER BY version ASC`,
    );
    return new Map(rows.map((row) => [Number(row.version), row.name]));
  }

  public async markMigrationApplied(version: number, name: string, client?: PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      `
        INSERT INTO ${this.migrationsTable} (version, name, applied_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (version) DO NOTHING
      `,
      [version, name],
    );
  }

  public async healthCheck(): Promise<PostgresHealthCheck> {
    const started = performance.now();
    const issues: string[] = [];
    try {
      await this.ensureMigrationsTable();
      await this.queryOne("SELECT 1 AS ok");
      const appliedMigrations = await this.query<{ version: number; name: string }>(
        `SELECT version, name FROM ${this.migrationsTable} ORDER BY version ASC`,
      );
      const latestVersion = appliedMigrations.reduce((max, row) => Math.max(max, Number(row.version)), 0);
      issues.push(...findMigrationNameDrift(appliedMigrations));
      issues.push(...(await this.findRequiredSchemaIssues(latestVersion, appliedMigrations)));
      return {
        reachable: true,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
        migrationVersion: latestVersion,
        issues,
      };
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      return {
        reachable: false,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
        issues,
      };
    }
  }

  private async findRequiredSchemaIssues(
    latestVersion: number,
    appliedMigrations: ReadonlyArray<{ version: number; name: string }>,
  ): Promise<string[]> {
    const issues: string[] = [];
    const runtimeSchemaRepairApplied =
      latestVersion >= 7 ||
      appliedMigrations.some((migration) => migration.name === "canonical_runtime_schema_repairs");
    if (runtimeSchemaRepairApplied) {
      issues.push(...(await this.findMissingTables(["agent_commitments", "operator_profiles"])));
      issues.push(...(await this.findMissingColumns("memory_items", ["workspace_id"])));
    }

    const chatPrefsRepairApplied =
      latestVersion >= 28 || appliedMigrations.some((migration) => migration.name === "chat_operator_control_prefs");
    if (chatPrefsRepairApplied) {
      issues.push(...(await this.findMissingColumns("chat_session_prefs", ["speed_mode", "subagent_policy"])));
    }

    const autonomyHeartbeatRepairApplied =
      latestVersion >= 71 ||
      appliedMigrations.some((migration) => migration.name === "session_autonomy_heartbeat_prefs");
    if (autonomyHeartbeatRepairApplied) {
      issues.push(
        ...(await this.findMissingColumns("session_autonomy_prefs", [
          "heartbeat_enabled",
          "heartbeat_interval_seconds",
          "active_hours_json",
        ])),
      );
    }

    return issues;
  }

  private async findMissingTables(tableNames: readonly string[]): Promise<string[]> {
    if (tableNames.length === 0) {
      return [];
    }
    const tablePlaceholders = tableNames.map((_, index) => `$${index + 1}`).join(", ");
    const rows = await this.query<{ table_name: string }>(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN (${tablePlaceholders})
    `,
      tableNames,
    );
    const present = new Set(rows.map((row) => row.table_name));
    const missing = tableNames.filter((table) => !present.has(table));
    return missing.map((table) => `schema drift: ${table} table is missing`);
  }

  private async findMissingColumns(tableName: string, columnNames: readonly string[]): Promise<string[]> {
    if (columnNames.length === 0) {
      return [];
    }
    const columnPlaceholders = columnNames.map((_, index) => `$${index + 2}`).join(", ");
    const rows = await this.query<{ column_name: string }>(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name IN (${columnPlaceholders})
    `,
      [tableName, ...columnNames],
    );
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
