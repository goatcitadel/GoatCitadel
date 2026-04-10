import { performance } from "node:perf_hooks";
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

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
    const result = await this.pool.query<T>(sql, [...params]);
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
    await this.ensureMigrationsTable();
    const rows = await this.query<{ version: number }>(
      `SELECT version FROM ${this.migrationsTable} ORDER BY version ASC`,
    );
    return new Set(rows.map((row) => Number(row.version)));
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
      const latest = await this.queryOne<{ version: number }>(
        `SELECT version FROM ${this.migrationsTable} ORDER BY version DESC LIMIT 1`,
      );
      return {
        reachable: true,
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
        migrationVersion: latest ? Number(latest.version) : 0,
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

  public async close(): Promise<void> {
    await this.pool.end();
  }
}

function buildPoolConfig(options: PostgresConnectionOptions): PoolConfig {
  const base: PoolConfig = {
    application_name: options.applicationName ?? "goatcitadel",
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
