import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client, type Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  buildPostgresMigrationLockSql,
  buildPostgresMigrationTryLockSql,
  buildPostgresMigrationUnlockSql,
  buildPostgresPoolConfig,
  parsePostgresMigrationTryLockResult,
  PostgresDatabaseClient,
} from "./postgres/client.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

type QueryRows = QueryResultRow[];
type QueryResponse = QueryRows | Error | ((sql: string, params?: readonly unknown[]) => QueryRows);

interface QueryCall {
  sql: string;
  params?: readonly unknown[];
}

class FakePool {
  public readonly calls: QueryCall[] = [];
  public readonly responses: QueryResponse[];
  public ended = false;
  public client?: FakePoolClient;
  public nextClient?: FakePoolClient;

  public constructor(responses: QueryResponse[] = []) {
    this.responses = [...responses];
  }

  public async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    this.calls.push({ sql, params });
    const response = this.responses.shift() ?? [];
    if (response instanceof Error) {
      throw response;
    }
    const rows = typeof response === "function" ? response(sql, params) : response;
    return { rows: rows as T[] };
  }

  public async connect(): Promise<PoolClient> {
    this.client = this.nextClient ?? new FakePoolClient();
    return this.client as unknown as PoolClient;
  }

  public async end(): Promise<void> {
    this.ended = true;
  }
}

class FakePoolClient {
  public readonly calls: QueryCall[] = [];
  public released = false;
  public releaseArgument?: boolean | Error;

  public constructor(
    private readonly respond: (sql: string, params?: readonly unknown[]) => QueryRows | Error = () => [],
    private readonly transactionOpen = false,
    private readonly existingAdvisoryLock = false,
    private readonly transactionProbeAcquired = true,
    private readonly releaseError?: Error,
  ) {}

  public async query(sql: string, params?: readonly unknown[]): Promise<{ rows: QueryRows }> {
    this.calls.push({ sql, params });
    if (sql.includes("advisory_xact_lock")) {
      return { rows: [{ transaction_probe_acquired: this.transactionProbeAcquired }] };
    }
    if (sql.includes("AS transaction_open")) {
      return {
        rows: [
          {
            transaction_open: this.transactionOpen,
            existing_advisory_lock: this.existingAdvisoryLock,
          },
        ],
      };
    }
    const response = this.respond(sql, params);
    if (response instanceof Error) {
      throw response;
    }
    return { rows: response };
  }

  public release(argument?: boolean | Error): void {
    this.released = true;
    this.releaseArgument = argument;
    if (this.releaseError) {
      throw this.releaseError;
    }
  }
}

function asPool(pool: FakePool): Pool {
  return pool as unknown as Pool;
}

function createHealthSession(responses: QueryRows[], identityOids: string[] = []): FakePoolClient {
  const queued = [...responses];
  const queuedIdentityOids = [...identityOids];
  return new FakePoolClient((sql, params) => {
    if (sql.includes("pg_try_advisory_lock")) {
      return [{ lock_key: "123", locked: true }];
    }
    if (sql.includes("pg_advisory_unlock")) {
      return [{ unlocked: true }];
    }
    if (sql.includes("pg_advisory_lock")) {
      return [{ lock_key: "123" }];
    }
    if (sql.includes("quote_ident")) {
      return [{ relation: null }];
    }
    if (sql.includes("AS existing_temp_relation")) {
      return [{ existing_temp_relation: null, existing_temp_type: null }];
    }
    if (sql.includes("AS current_schema_is_temp")) {
      return [
        {
          current_schema_is_temp: false,
          current_schema_name: "public",
          current_schema_oid: "2200",
          current_schema_owned_by_current_user: true,
          current_schema_has_exclusive_create_authority: true,
          existing_unowned_relation: null,
        },
      ];
    }
    if (sql.includes("pg_catalog.set_config")) {
      return [{ migration_search_path: params?.[0] }];
    }
    if (sql.includes("FROM pg_catalog.pg_namespace AS namespace") && !sql.includes("AS current_schema_is_temp")) {
      return [
        {
          current_schema_name: "public",
          current_schema_oid: queuedIdentityOids.shift() ?? "2200",
          current_schema_owned_by_current_user: true,
          current_schema_has_exclusive_create_authority: true,
          existing_unowned_relation: null,
        },
      ];
    }
    if (sql.trim() === "SELECT 1 AS ok") {
      return [{ ok: 1 }];
    }
    if (sql.includes("SELECT version, name FROM")) {
      return queued.shift() ?? [];
    }
    if (sql.includes("information_schema.")) {
      return queued.shift() ?? [];
    }
    return [];
  });
}

describe("PostgresDatabaseClient", () => {
  it("preserves connection-string startup options before enforcing UTF-8", () => {
    const config = buildPostgresPoolConfig({
      connectionString: " postgres://operator:secret@example.test/goatcitadel?options=-csearch_path%3Dworkspace_a ",
      database: "ignored",
      applicationName: "pool-contract",
    });
    assert.deepEqual(config, {
      application_name: "pool-contract",
      options: "-csearch_path=workspace_a -c client_encoding=UTF8",
      max: 10,
      min: 0,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      connectionString:
        "postgres://operator:secret@example.test/goatcitadel?options=-csearch_path%3Dworkspace_a+-c+client_encoding%3DUTF8",
      ssl: undefined,
    });
    assert.equal(
      (new Client(config) as unknown as { connectionParameters: { options?: string } }).connectionParameters.options,
      config.options,
    );
  });

  it("builds and validates a nonblocking migration lock attempt", () => {
    const sql = buildPostgresMigrationTryLockSql("$1");

    assert.match(sql, /pg_try_advisory_lock/);
    assert.doesNotMatch(sql, /\bpg_advisory_lock\b/);
    assert.match(sql, /pg_catalog\.concat\(/);
    assert.doesNotMatch(sql, /\|\|/);
    for (const lockSql of [buildPostgresMigrationLockSql("$1"), sql, buildPostgresMigrationUnlockSql("$1")]) {
      for (const functionName of [
        "hashtextextended",
        "current_database",
        "current_schema",
        "chr",
        "pg_advisory_lock",
        "pg_try_advisory_lock",
        "pg_advisory_unlock",
      ]) {
        if (lockSql.includes(`${functionName}(`)) {
          assert.match(lockSql, new RegExp(`pg_catalog\\.${functionName}\\(`));
        }
      }
    }
    assert.deepEqual(parsePostgresMigrationTryLockResult({ lock_key: "-123", locked: false }), {
      lockKey: "-123",
      locked: false,
    });
    assert.deepEqual(parsePostgresMigrationTryLockResult({ lock_key: "123", locked: true }), {
      lockKey: "123",
      locked: true,
    });
    assert.throws(
      () => parsePostgresMigrationTryLockResult({ lock_key: "123", locked: "true" }),
      /valid acquisition result/,
    );
  });

  it("queries through the pool with cached server-encoding sanitization", async () => {
    const pool = new FakePool([[{ server_encoding: "WIN1252" }], [{ id: 1, payload: "stored" }], []]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const rows = await client.query<{ id: number; payload: string }>(
      "INSERT INTO demo(payload) VALUES ($1) RETURNING id, payload",
      ["plain 🧠"],
    );
    assert.deepEqual(rows, [{ id: 1, payload: "stored" }]);
    assert.equal(pool.calls[0]!.sql, "SELECT current_setting('server_encoding') AS server_encoding");
    assert.deepEqual(pool.calls[1]!.params, ["plain \\uD83E\\uDDE0"]);

    assert.equal(await client.queryOne("SELECT * FROM empty"), undefined);
    assert.equal(
      pool.calls.filter((call) => call.sql === "SELECT current_setting('server_encoding') AS server_encoding").length,
      1,
    );
  });

  it("commits successful transactions and rolls back failing transactions", async () => {
    const successPool = new FakePool();
    const successClient = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(successPool) });
    const result = await successClient.transaction(async (transactionClient) => {
      await transactionClient.query("SELECT inside");
      return "committed";
    });
    assert.equal(result, "committed");
    assert.deepEqual(
      successPool.client?.calls.map((call) => call.sql),
      ["BEGIN", "SELECT inside", "COMMIT"],
    );
    assert.equal(successPool.client?.released, true);

    const failurePool = new FakePool();
    const failureClient = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(failurePool) });
    await assert.rejects(
      () =>
        failureClient.transaction(async () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.deepEqual(
      failurePool.client?.calls.map((call) => call.sql),
      ["BEGIN", "ROLLBACK"],
    );
    assert.equal(failurePool.client?.released, true);
    assert.equal(failurePool.client?.releaseArgument, false);
  });

  it("retires pinned and non-pinned connections when rollback fails without masking the primary error", async () => {
    const createRollbackFailureClient = (includeMigrationLock: boolean) =>
      new FakePoolClient((sql) => {
        if (includeMigrationLock && sql.includes("pg_advisory_lock")) {
          return [{ lock_key: "789" }];
        }
        if (includeMigrationLock && sql.includes("pg_advisory_unlock")) {
          return [{ unlocked: true }];
        }
        if (sql === "FAIL MIGRATION") {
          return new Error("migration query failed");
        }
        if (sql === "ROLLBACK") {
          return new Error("rollback failed");
        }
        return [];
      });

    const pinnedPool = new FakePool();
    pinnedPool.nextClient = createRollbackFailureClient(true);
    const pinnedClient = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pinnedPool) });
    await assert.rejects(
      pinnedClient.withMigrationLock(async (migrationClient) => {
        await pinnedClient.transaction(async (transactionClient) => {
          await transactionClient.query("FAIL MIGRATION");
        }, migrationClient);
      }),
      /migration query failed/,
    );
    assert.equal(pinnedPool.client?.releaseArgument, true);
    assert.match(pinnedPool.client?.calls.at(-1)?.sql ?? "", /pg_advisory_unlock/);

    const nonPinnedPool = new FakePool();
    nonPinnedPool.nextClient = createRollbackFailureClient(false);
    const nonPinnedClient = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(nonPinnedPool) });
    await assert.rejects(
      nonPinnedClient.transaction(async (transactionClient) => {
        await transactionClient.query("FAIL MIGRATION");
      }),
      /migration query failed/,
    );
    assert.equal(nonPinnedPool.client?.releaseArgument, true);
  });

  it("pins migration work to the advisory-lock session and retires it when unlock fails", async () => {
    const successPool = new FakePool();
    successPool.nextClient = new FakePoolClient((sql) => {
      if (sql.includes("pg_advisory_lock")) {
        return [{ lock_key: "123" }];
      }
      if (sql.includes("pg_advisory_unlock")) {
        return [{ unlocked: true }];
      }
      return [];
    });
    const successClient = new PostgresDatabaseClient(
      { database: "goatcitadel" },
      { pool: asPool(successPool), migrationsTable: "migration_ledger" },
    );

    const result = await successClient.withMigrationLock(async (pinnedClient) => {
      await pinnedClient.query("SELECT pinned work");
      return "done";
    });

    assert.equal(result, "done");
    assert.deepEqual(successPool.calls, []);
    assert.deepEqual(
      successPool.client?.calls.map((call) =>
        call.sql.includes("advisory_xact_lock")
          ? "transaction-probe"
          : call.sql.includes("AS transaction_open")
            ? "transaction-check"
            : call.sql.includes("pg_advisory_lock")
              ? "lock"
              : call.sql.includes("pg_advisory_unlock")
                ? "unlock"
                : call.sql,
      ),
      ["transaction-probe", "transaction-check", "lock", "SELECT pinned work", "unlock"],
    );
    assert.equal(successPool.client?.releaseArgument, false);

    const failedPool = new FakePool();
    failedPool.nextClient = new FakePoolClient((sql) => {
      if (sql.includes("pg_advisory_lock")) {
        return [{ lock_key: "456" }];
      }
      if (sql.includes("pg_advisory_unlock")) {
        return new Error("unlock failed");
      }
      return [];
    });
    const failedClient = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(failedPool) });

    await assert.rejects(
      failedClient.withMigrationLock(async () => {
        throw new Error("migration failed");
      }),
      /migration failed/,
    );
    assert.equal(failedPool.client?.releaseArgument, true);
  });

  it("rejects and retires a migration session that was already inside a transaction", async () => {
    const pool = new FakePool();
    pool.nextClient = new FakePoolClient(() => [], true);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });
    let callbackCalled = false;

    await assert.rejects(
      client.withMigrationLock(async () => {
        callbackCalled = true;
      }),
      /already inside a transaction before lock acquisition/,
    );

    assert.equal(callbackCalled, false);
    assert.equal(pool.client?.releaseArgument, true);
    assert.equal(
      pool.client?.calls.some((call) => call.sql.includes("pg_advisory_lock")),
      false,
    );
  });

  it("rejects and retires a migration session that already held an advisory lock", async () => {
    const pool = new FakePool();
    pool.nextClient = new FakePoolClient(() => [], false, true);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await assert.rejects(
      client.withMigrationLock(async () => undefined),
      /already held an advisory lock/,
    );

    assert.equal(pool.client?.releaseArgument, true);
    assert.equal(
      pool.client?.calls.some((call) => call.sql.includes("pg_advisory_lock")),
      false,
    );
  });

  it("fails quickly and retires the session when the transaction probe lock is unavailable", async () => {
    const pool = new FakePool();
    pool.nextClient = new FakePoolClient(() => [], false, false, false);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await assert.rejects(
      client.withMigrationLock(async () => undefined),
      /probe lock is held by another session/,
    );

    assert.equal(pool.client?.releaseArgument, true);
    assert.equal(pool.client?.calls.length, 1);
  });

  it("manages migration bookkeeping through the configured table", async () => {
    const pool = new FakePool([
      [],
      [],
      [{ server_encoding: "UTF8" }],
      [
        { version: 1, name: "one" },
        { version: "2", name: "two" },
      ],
      [],
    ]);
    const client = new PostgresDatabaseClient(
      { database: "goatcitadel" },
      { pool: asPool(pool), migrationsTable: "custom_migrations" },
    );

    await client.ensureMigrationsTable();
    assert.match(pool.calls[0]!.sql, /CREATE TABLE IF NOT EXISTS "custom_migrations"/);

    const versions = await client.getAppliedMigrationVersions();
    assert.deepEqual([...versions], [1, 2]);
    assert.match(pool.calls[3]!.sql, /SELECT version, name FROM "custom_migrations"/);

    await client.markMigrationApplied(3, "third");
    assert.match(pool.calls.at(-1)?.sql ?? "", /INSERT INTO "custom_migrations"/);
    assert.deepEqual(pool.calls.at(-1)?.params, [3, "third"]);

    const explicitClient = new FakePoolClient();
    await client.markMigrationApplied(4, "fourth", explicitClient as unknown as PoolClient);
    assert.deepEqual(explicitClient.calls[0]!.params, [4, "fourth"]);
  });

  it("quotes the configured migration ledger as one identifier and rejects invalid identifiers", async () => {
    const pool = new FakePool();
    const client = new PostgresDatabaseClient(
      { database: "goatcitadel" },
      { pool: asPool(pool), migrationsTable: 'custom.schema_"migrations' },
    );

    await client.ensureMigrationsTable();
    assert.match(pool.calls[0]?.sql ?? "", /CREATE TABLE IF NOT EXISTS "custom\.schema_""migrations"/);

    const boundaryPool = new FakePool();
    const boundaryName = "a".repeat(63);
    const boundaryClient = new PostgresDatabaseClient(
      { database: "goatcitadel" },
      { pool: asPool(boundaryPool), migrationsTable: boundaryName },
    );
    await boundaryClient.ensureMigrationsTable();
    assert.match(boundaryPool.calls[0]?.sql ?? "", new RegExp(`CREATE TABLE IF NOT EXISTS "${boundaryName}"`));

    for (const migrationsTable of ["", "invalid\0identifier", "a".repeat(64), "é".repeat(32)]) {
      assert.throws(
        () =>
          new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(new FakePool()), migrationsTable }),
        /must be a non-empty identifier without NUL characters and at most 63 UTF-8 bytes/,
      );
    }
  });

  it("reports migration drift and required schema drift in health checks", async () => {
    const repairMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 28);
    assert.ok(repairMigration);
    const pool = new FakePool();
    pool.nextClient = createHealthSession([
      [
        { version: 1, name: "stale_initial_name" },
        { version: repairMigration.version, name: repairMigration.name },
        { version: 999, name: "future_unknown" },
      ],
      [{ table_name: "agent_commitments" }],
      [],
      [{ column_name: "speed_mode" }],
      [{ column_name: "heartbeat_enabled" }],
    ]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await client.healthCheck();
    assert.equal(result.reachable, true);
    assert.equal(result.migrationVersion, 999);
    assert.equal(typeof result.latencyMs, "number");
    assert.deepEqual(result.issues, [
      "schema drift: migration 1 is stale_initial_name, expected runtime_event_and_cutover_tables",
      "schema drift: unknown migration version 999 (future_unknown)",
      "schema drift: operator_profiles table is missing",
      "schema drift: memory_items.workspace_id is missing",
      "schema drift: chat_session_prefs.subagent_policy is missing",
      "schema drift: session_autonomy_prefs.heartbeat_interval_seconds is missing",
      "schema drift: session_autonomy_prefs.active_hours_json is missing",
    ]);
  });

  it("skips required schema checks before the chat prefs repair migration is present", async () => {
    const pool = new FakePool();
    pool.nextClient = createHealthSession([[{ version: 1, name: POSTGRES_MIGRATIONS[0]!.name }]]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await client.healthCheck();

    assert.equal(result.reachable, true);
    assert.deepEqual(result.issues, []);
    assert.equal(
      pool.client?.calls.some((call) => call.sql.includes("information_schema.columns")),
      false,
    );
  });

  it("returns degraded without blocking when migration work owns the advisory lock", async () => {
    const pool = new FakePool();
    pool.nextClient = new FakePoolClient((sql) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return [{ lock_key: "123", locked: false }];
      }
      if (sql.includes("pg_advisory_lock")) {
        return new Error("health check used the blocking migration lock");
      }
      return [];
    });
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await client.healthCheck();

    assert.equal(result.reachable, true);
    assert.equal(result.migrationVersion, undefined);
    assert.match(result.issues[0] ?? "", /migration work is in progress/);
    assert.equal(
      pool.client?.calls.some((call) => call.sql.includes("pg_advisory_lock")),
      false,
    );
    assert.equal(
      pool.client?.calls.some((call) => call.sql === "BEGIN" || call.sql.includes("pg_advisory_unlock")),
      false,
    );
    assert.equal(pool.client?.releaseArgument, false);
  });

  it("fails contended health closed when releasing the clean session fails", async () => {
    const pool = new FakePool();
    pool.nextClient = new FakePoolClient(
      (sql) => {
        if (sql.includes("pg_try_advisory_lock")) {
          return [{ lock_key: "123", locked: false }];
        }
        return [];
      },
      false,
      false,
      true,
      new Error("health session release failed"),
    );
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await client.healthCheck();

    assert.equal(result.reachable, false);
    assert.deepEqual(result.issues, ["health session release failed"]);
  });

  it("returns unreachable health results and closes pools cleanly", async () => {
    const pool = new FakePool();
    pool.nextClient = new FakePoolClient(() => new Error("offline"));
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await client.healthCheck();
    assert.equal(result.reachable, false);
    assert.deepEqual(result.issues, ["offline"]);

    await client.close();
    assert.equal(pool.ended, true);
  });

  it("fails health closed when the migration schema identity changes before commit", async () => {
    const pool = new FakePool();
    pool.nextClient = createHealthSession([], ["2200", "2200", "9999"]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await client.healthCheck();

    assert.equal(result.reachable, false);
    assert.match(result.issues[0] ?? "", /migration schema "public" changed after preflight/);
    assert.equal(pool.client?.releaseArgument, true);
  });

  it("constructs owned pools for connection strings and discrete host options", async () => {
    const clients = [
      new PostgresDatabaseClient({
        database: "ignored",
        connectionString: " postgres://user:pass@localhost:5432/goatcitadel ",
        sslMode: "require",
        applicationName: "coverage-test",
        pool: {
          min: 1,
          max: 2,
          idleTimeoutMs: 3,
          connectionTimeoutMs: 4,
        },
      }),
      new PostgresDatabaseClient({
        database: "goatcitadel",
        host: "localhost",
        port: 5433,
        user: "goat",
        password: "secret",
        sslMode: "disable",
      }),
      new PostgresDatabaseClient({
        database: "goatcitadel",
        sslMode: "prefer",
      }),
    ];

    await Promise.all(clients.map((client) => client.close()));
  });
});
