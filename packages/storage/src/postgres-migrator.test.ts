import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { createDatabase } from "./sqlite.js";
import type { DatabaseClient, DbRunResult, DbStatement } from "./db.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import {
  assertLegacyCompoundV124Catalog,
  assertLegacyCompoundV124LedgerRepairResult,
  assertPostgresMigrationCurrentSchemaIsDurable,
  assertPostgresMigrationSessionIsIdle,
  assertPostgresMigrationTransactionProbeAcquired,
  buildPostgresMigrationLedgerGuardLockSql,
  buildPostgresMigrationLedgerTempShadowPreflightSql,
  buildPostgresMigrationSchemaIdentityCheckSql,
  buildPostgresMigrationTransactionDatabaseClassificationSql,
  classifyLegacyCompoundV124Ledger,
  classifyPostgresMigrationTransactionDatabase,
  normalizePostgresMigrationLedgerForHistoricalRepair,
  parsePostgresMigrationActiveTransactionIds,
  selectPostgresMigrationPreexistingTransactionIds,
  POSTGRES_HISTORY_REPAIR_TEMP_VIEW_RESOLUTION_SQL,
  POSTGRES_LEGACY_COMPOUND_V124_CATALOG_SQL,
  POSTGRES_MIGRATION_CURRENT_SCHEMA_PREFLIGHT_SQL,
  POSTGRES_MIGRATION_ACTIVE_TRANSACTION_PREFLIGHT_SQL,
  POSTGRES_MIGRATION_SESSION_TRANSACTION_CHECK_SQL,
  POSTGRES_MIGRATION_SESSION_TRANSACTION_PROBE_SQL,
  POSTGRES_MIGRATION_TRANSACTION_EPOCH_BARRIER_SQL,
} from "./postgres/migration-ledger-compatibility.js";
import { applyPostgresMigrationsSync, runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS, type PostgresMigration } from "./postgres/migrations.js";

interface QueryCall {
  sql: string;
  params?: readonly unknown[];
}

type QueryRows = QueryResultRow[];
type QueryResponse = QueryRows | Error;
type TransactionResponse = number | null | Error;

class FakePool {
  public readonly calls: QueryCall[] = [];
  public readonly clients: FakePoolClient[] = [];
  private readonly responses: QueryResponse[];
  private readonly transactionResponses: TransactionResponse[];
  private readonly appliedRows: QueryRows;
  private readonly tempMigrationRelation: string | null;
  private readonly configuredTempMigrationRelation: string | null;
  private readonly existingTempRelation: string | null;
  private readonly bridgeOwnsUnqualifiedName: boolean;
  private readonly currentSchemaIsTemp: boolean;
  private readonly currentSchemaName: string;
  private readonly currentSchemaOid: string;

  public constructor(
    responses: QueryResponse[] = [],
    transactionResponses: TransactionResponse[] = [],
    tempMigrationRelation: string | null = null,
    configuredTempMigrationRelation: string | null = null,
    bridgeOwnsUnqualifiedName = true,
    currentSchemaIsTemp = false,
    existingTempRelation: string | null = null,
    currentSchemaName = "public",
    currentSchemaOid = "2200",
  ) {
    this.responses = [...responses];
    this.transactionResponses = [...transactionResponses];
    this.tempMigrationRelation = tempMigrationRelation;
    this.configuredTempMigrationRelation = configuredTempMigrationRelation;
    this.existingTempRelation = existingTempRelation;
    this.bridgeOwnsUnqualifiedName = bridgeOwnsUnqualifiedName;
    this.currentSchemaIsTemp = currentSchemaIsTemp;
    this.currentSchemaName = currentSchemaName;
    this.currentSchemaOid = currentSchemaOid;
    this.appliedRows =
      [...responses]
        .reverse()
        .find(
          (response): response is QueryRows =>
            Array.isArray(response) &&
            response.some((row) => typeof row === "object" && row !== null && "version" in row),
        ) ?? [];
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
    return { rows: response as T[] };
  }

  public async connect(): Promise<PoolClient> {
    const client = new FakePoolClient(
      this.transactionResponses,
      this.appliedRows,
      this.tempMigrationRelation,
      this.configuredTempMigrationRelation,
      this.bridgeOwnsUnqualifiedName,
      this.currentSchemaIsTemp,
      this.existingTempRelation,
      this.currentSchemaName,
      this.currentSchemaOid,
    );
    this.clients.push(client);
    return client as unknown as PoolClient;
  }

  public async end(): Promise<void> {
    // no-op for migrator tests
  }
}

class FakePoolClient {
  public readonly calls: QueryCall[] = [];
  public released = false;
  public destroyed = false;

  public constructor(
    private readonly transactionResponses: TransactionResponse[],
    private readonly appliedRows: QueryRows = [],
    private readonly tempMigrationRelation: string | null = null,
    private readonly configuredTempMigrationRelation: string | null = null,
    private readonly bridgeOwnsUnqualifiedName = true,
    private readonly currentSchemaIsTemp = false,
    private readonly existingTempRelation: string | null = null,
    private readonly currentSchemaName = "public",
    private readonly currentSchemaOid = "2200",
  ) {}

  public async query(sql: string, params?: readonly unknown[]): Promise<{ rows: QueryRows; rowCount: number | null }> {
    this.calls.push({ sql, params });
    if (sql.includes("advisory_xact_lock")) {
      return { rows: [{ transaction_probe_acquired: true }], rowCount: 1 };
    }
    if (sql.includes("AS transaction_open")) {
      return {
        rows: [{ transaction_open: false, existing_advisory_lock: false }],
        rowCount: 1,
      };
    }
    if (sql.includes("pg_advisory_lock")) {
      return { rows: [{ lock_key: "123456" }], rowCount: 1 };
    }
    if (sql.includes("pg_advisory_unlock")) {
      return { rows: [{ unlocked: true }], rowCount: 1 };
    }
    if (sql.includes("quote_ident")) {
      return { rows: [{ relation: this.configuredTempMigrationRelation }], rowCount: 1 };
    }
    if (sql.includes("AS existing_temp_relation")) {
      return {
        rows: [{ existing_temp_relation: this.existingTempRelation, existing_temp_type: null }],
        rowCount: 1,
      };
    }
    if (sql.includes("AS current_schema_is_temp")) {
      return {
        rows: [
          {
            current_schema_is_temp: this.currentSchemaIsTemp,
            current_schema_name: this.currentSchemaName,
            current_schema_oid: this.currentSchemaOid,
            current_schema_owned_by_current_user: true,
            current_schema_has_exclusive_create_authority: true,
            existing_unowned_relation: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("AS bridge_active")) {
      return { rows: [{ bridge_active: this.bridgeOwnsUnqualifiedName }], rowCount: 1 };
    }
    if (sql.includes("to_regclass('pg_temp.schema_migrations')")) {
      return { rows: [{ relation: this.tempMigrationRelation }], rowCount: 1 };
    }
    if (sql.includes("pg_catalog.set_config")) {
      return { rows: [{ migration_search_path: params?.[0] }], rowCount: 1 };
    }
    if (sql.includes("pg_catalog.pg_current_xact_id")) {
      return { rows: [{ active_xid: "100" }], rowCount: 1 };
    }
    if (sql.includes("FROM pg_catalog.pg_namespace AS namespace") && !sql.includes("AS current_schema_is_temp")) {
      return {
        rows: [
          {
            current_schema_name: this.currentSchemaName,
            current_schema_oid: this.currentSchemaOid,
            current_schema_owned_by_current_user: true,
            current_schema_has_exclusive_create_authority: true,
            existing_unowned_relation: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT version, name FROM")) {
      return { rows: this.appliedRows, rowCount: this.appliedRows.length };
    }
    if (sql.trim() === "BATCH SCRUB") {
      let response: TransactionResponse = 0;
      if (this.transactionResponses.length > 0) {
        response = this.transactionResponses.shift() as TransactionResponse;
      }
      if (response instanceof Error) {
        throw response;
      }
      return { rows: [], rowCount: response };
    }
    return { rows: [], rowCount: null };
  }

  public release(destroy = false): void {
    this.released = true;
    this.destroyed = destroy;
  }
}

class InterruptingStatement implements DbStatement {
  public constructor(
    private readonly delegate: DbStatement,
    private readonly beforeRun: () => void,
  ) {}

  public run(...params: unknown[]): DbRunResult {
    this.beforeRun();
    return this.delegate.run(...params);
  }

  public get<T = unknown>(...params: unknown[]): T | undefined {
    return this.delegate.get<T>(...params);
  }

  public all<T = unknown>(...params: unknown[]): T[] {
    return this.delegate.all<T>(...params);
  }
}

class PinnedSessionDatabase implements DatabaseClient {
  public readonly dialect = "postgres" as const;
  public readonly events: string[] = [];
  public destroyed = false;
  public migrationSessionTransactionOpen = false;
  public migrationSessionAdvisoryLockOpen = false;
  public migrationTransactionProbeAcquired = true;
  private remainingLockContentions: number;
  private readonly schemaIdentityOidResponses: string[] = [];
  private readonly activeTransactionSnapshots: string[][] = [];
  private readonly transactionStatusResponses: string[] = [];

  public constructor(
    private readonly delegate: DatabaseClient,
    private readonly unlockFails = false,
    lockContentions = 0,
    private readonly handleExec?: (sql: string) => boolean,
    private readonly configuredTempMigrationRelation: string | null = null,
    private readonly bridgeTempMigrationRelation: string | null = null,
    private readonly bridgeOwnsUnqualifiedName = true,
    private readonly currentSchemaIsTemp = false,
    private readonly existingTempRelation: string | null = null,
    private readonly currentSchemaName = "public",
    private readonly currentSchemaOid = "2200",
  ) {
    this.remainingLockContentions = lockContentions;
  }

  public withPinnedSession<T>(callback: (controls: { destroyOnRelease(): void }) => T): T {
    this.events.push("session_begin");
    try {
      return callback({
        destroyOnRelease: () => {
          this.destroyed = true;
        },
      });
    } finally {
      this.events.push("session_end");
    }
  }

  public queueSchemaIdentityOids(...oids: string[]): void {
    this.schemaIdentityOidResponses.push(...oids);
  }

  public queueMigrationActivity(activeTransactionIds: string[], ...transactionStatuses: string[]): void {
    this.activeTransactionSnapshots.push(activeTransactionIds);
    this.transactionStatusResponses.push(...transactionStatuses);
  }

  public prepare(sql: string): DbStatement {
    if (sql.includes("advisory_xact_lock")) {
      return createStaticStatement(() => ({ transaction_probe_acquired: this.migrationTransactionProbeAcquired }));
    }
    if (sql.includes("AS transaction_open")) {
      return createStaticStatement(() => ({
        transaction_open: this.migrationSessionTransactionOpen,
        existing_advisory_lock: this.migrationSessionAdvisoryLockOpen,
      }));
    }
    if (sql.includes("pg_catalog.pg_current_xact_id")) {
      return createStaticStatement(() => ({ active_xid: "100" }));
    }
    if (sql.includes("AS active_xid")) {
      const activeTransactionIds = this.activeTransactionSnapshots.shift() ?? [];
      return {
        run: () => ({ changes: 0 }),
        get: () => undefined,
        all: <T = unknown>() => activeTransactionIds.map((activeXid) => ({ active_xid: activeXid }) as T),
      };
    }
    if (sql.includes("observed_database_count")) {
      return createStaticStatement(() => {
        const transactionStatus = this.transactionStatusResponses.shift() ?? "committed";
        return {
          transaction_status: transactionStatus,
          observed_database_count: transactionStatus === "in progress" ? "1" : "0",
          current_database_observed: transactionStatus === "in progress",
        };
      });
    }
    if (sql.includes("quote_ident")) {
      return createStaticStatement(() => ({ relation: this.configuredTempMigrationRelation }));
    }
    if (sql.includes("AS existing_temp_relation")) {
      return createStaticStatement(() => ({
        existing_temp_relation: this.existingTempRelation,
        existing_temp_type: null,
      }));
    }
    if (sql.includes("AS current_schema_is_temp")) {
      return createStaticStatement(() => ({
        current_schema_is_temp: this.currentSchemaIsTemp,
        current_schema_name: this.currentSchemaName,
        current_schema_oid: this.currentSchemaOid,
        current_schema_owned_by_current_user: true,
        current_schema_has_exclusive_create_authority: true,
        existing_unowned_relation: null,
      }));
    }
    if (sql.includes("pg_catalog.set_config")) {
      return {
        run: () => ({ changes: 0 }),
        get: <T = unknown>(params?: unknown) => {
          const searchPath =
            typeof params === "object" && params !== null && "searchPath" in params
              ? (params as { searchPath?: unknown }).searchPath
              : undefined;
          return { migration_search_path: searchPath } as T;
        },
        all: () => [],
      };
    }
    if (sql.includes("FROM pg_catalog.pg_namespace AS namespace") && !sql.includes("AS current_schema_is_temp")) {
      return createStaticStatement(() => ({
        current_schema_name: this.currentSchemaName,
        current_schema_oid: this.schemaIdentityOidResponses.shift() ?? this.currentSchemaOid,
        current_schema_owned_by_current_user: true,
        current_schema_has_exclusive_create_authority: true,
        existing_unowned_relation: null,
      }));
    }
    if (sql.includes("AS bridge_active")) {
      return createStaticStatement(() => ({ bridge_active: this.bridgeOwnsUnqualifiedName }));
    }
    if (sql.includes("to_regclass('pg_temp.schema_migrations')")) {
      return createStaticStatement(() => ({ relation: this.bridgeTempMigrationRelation }));
    }
    if (sql.includes("pg_try_advisory_lock")) {
      return createStaticStatement(() => {
        if (this.remainingLockContentions > 0) {
          this.remainingLockContentions -= 1;
          this.events.push("lock_wait");
          return { lock_key: "123", locked: false };
        }
        this.events.push("lock");
        return { lock_key: "123", locked: true };
      });
    }
    if (sql.includes("pg_advisory_lock")) {
      return createStaticStatement(() => {
        this.events.push("lock");
        return { lock_key: "123" };
      });
    }
    if (sql.includes("pg_advisory_unlock")) {
      return createStaticStatement(() => {
        this.events.push("unlock");
        if (this.unlockFails) {
          throw new Error("unlock failed");
        }
        return { unlocked: true };
      });
    }
    return this.delegate.prepare(this.normalizePostgresSql(sql));
  }

  public exec(sql: string): void {
    if (this.handleExec?.(sql)) {
      return;
    }
    if (/^\s*LOCK TABLE\b/i.test(sql)) {
      return;
    }
    if (sql.trim() === "FAIL MIGRATION") {
      throw new Error("migration primary failure");
    }
    this.delegate.exec(this.normalizePostgresSql(sql));
  }

  public close(): void {
    this.delegate.close();
  }

  public transaction<T>(mode: "deferred" | "immediate" | "exclusive", callback: () => T): T {
    return this.delegate.transaction(mode, callback);
  }

  private normalizePostgresSql(sql: string): string {
    const quotedCurrentSchema = `"${this.currentSchemaName.replaceAll('"', '""')}"`;
    return sql
      .replaceAll(`${quotedCurrentSchema}.`, "")
      .replaceAll("pg_catalog.int4", "INTEGER")
      .replaceAll("pg_catalog.text", "TEXT")
      .replaceAll("pg_catalog.timestamptz", "TIMESTAMPTZ")
      .replaceAll("pg_catalog.now()", "CURRENT_TIMESTAMP");
  }
}

function createStaticStatement(getValue: () => unknown): DbStatement {
  return {
    run: () => ({ changes: 0 }),
    get: <T = unknown>() => getValue() as T,
    all: <T = unknown>() => [getValue() as T],
  };
}

const createdDatabases: Array<{ db: DatabaseClient; dbPath: string }> = [];

afterEach(() => {
  const cleanupErrors: unknown[] = [];
  const databases = createdDatabases.splice(0).reverse();
  for (const { db } of databases) {
    try {
      db.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const { dbPath } of databases) {
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Failed to close or remove temporary Postgres migrator test databases.");
  }
});

function asPool(pool: FakePool): Pool {
  return pool as unknown as Pool;
}

function migrations(): PostgresMigration[] {
  return [
    {
      version: 1,
      name: "create_existing",
      sql: "CREATE TABLE existing_table(id INTEGER PRIMARY KEY)",
    },
    {
      version: 2,
      name: "create_new",
      sql: "CREATE TABLE new_table(id INTEGER PRIMARY KEY)",
    },
  ];
}

function batchedMigration(sql = "BATCH SCRUB"): PostgresMigration {
  return {
    version: 1,
    name: "bounded_scrub",
    sql: "",
    batchedStatements: [{ name: "scrub_rows", sql }],
  };
}

function createTempDatabase(prefix: string): DatabaseClient {
  const dbPath = path.join(os.tmpdir(), `${prefix}-${randomUUID()}.db`);
  const db = createDatabase({ dbPath });
  createdDatabases.push({ db, dbPath });
  return db;
}

function createOneTimeInterruptingDatabase(db: DatabaseClient, statementMarker: string): DatabaseClient {
  let matchingRuns = 0;
  let interrupted = false;
  return {
    dialect: db.dialect,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.includes(statementMarker)) {
        return statement;
      }
      return new InterruptingStatement(statement, () => {
        matchingRuns += 1;
        if (!interrupted && matchingRuns === 2) {
          interrupted = true;
          throw new Error("simulated batched migration interruption");
        }
      });
    },
    exec(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
    transaction(mode, callback) {
      return db.transaction(mode, callback);
    },
  };
}

describe("Postgres migration ledger compatibility", () => {
  const definitions = POSTGRES_MIGRATIONS.filter((migration) => [32, 33, 47].includes(migration.version));

  it("pins guard-critical concatenation, equality, and regex operations to pg_catalog", () => {
    const shadowSql = buildPostgresMigrationLedgerTempShadowPreflightSql("$1");
    assert.match(shadowSql, /pg_catalog\.concat\(/);
    assert.doesNotMatch(shadowSql, /\|\|/);
    assert.match(POSTGRES_HISTORY_REPAIR_TEMP_VIEW_RESOLUTION_SQL, /OPERATOR\(pg_catalog\.=\)/);
    assert.equal(POSTGRES_MIGRATION_CURRENT_SCHEMA_PREFLIGHT_SQL.match(/OPERATOR\(pg_catalog\.=\)/g)?.length, 12);
    assert.match(POSTGRES_MIGRATION_CURRENT_SCHEMA_PREFLIGHT_SQL, /OPERATOR\(pg_catalog\.~\)/);
    const identitySql = buildPostgresMigrationSchemaIdentityCheckSql("$1");
    assert.match(identitySql, /FROM pg_catalog\.pg_namespace AS namespace/);
    assert.doesNotMatch(identitySql, /FOR KEY SHARE/);
    assert.equal(
      buildPostgresMigrationLedgerGuardLockSql('"public"."schema_migrations"'),
      'LOCK TABLE "public"."schema_migrations" IN ACCESS SHARE MODE',
    );
    assert.match(POSTGRES_MIGRATION_TRANSACTION_EPOCH_BARRIER_SQL, /pg_catalog\.pg_current_xact_id/);
    assert.match(POSTGRES_MIGRATION_SESSION_TRANSACTION_PROBE_SQL, /pg_catalog\.pg_try_advisory_xact_lock/);
    assert.match(POSTGRES_MIGRATION_SESSION_TRANSACTION_CHECK_SQL, /FROM pg_catalog\.pg_locks/);
    assert.doesNotThrow(() => assertPostgresMigrationTransactionProbeAcquired({ transaction_probe_acquired: true }));
    assert.throws(
      () => assertPostgresMigrationTransactionProbeAcquired({ transaction_probe_acquired: false }),
      /probe lock is held by another session/,
    );
    assert.doesNotThrow(() =>
      assertPostgresMigrationSessionIsIdle({ transaction_open: false, existing_advisory_lock: false }),
    );
    assert.throws(
      () => assertPostgresMigrationSessionIsIdle({ transaction_open: true, existing_advisory_lock: false }),
      /already inside a transaction before lock acquisition/,
    );
    assert.throws(
      () => assertPostgresMigrationSessionIsIdle({ transaction_open: false, existing_advisory_lock: true }),
      /already held an advisory lock/,
    );
    assert.match(POSTGRES_MIGRATION_ACTIVE_TRANSACTION_PREFLIGHT_SQL, /pg_catalog\.pg_snapshot_xip/);
    assert.match(POSTGRES_MIGRATION_ACTIVE_TRANSACTION_PREFLIGHT_SQL, /pg_catalog\.pg_current_snapshot/);
    const classificationSql = buildPostgresMigrationTransactionDatabaseClassificationSql("$1");
    assert.match(classificationSql, /pg_catalog\.pg_stat_activity/);
    assert.match(classificationSql, /pg_catalog\.pg_prepared_xacts/);
    assert.match(classificationSql, /pg_catalog\.current_database/);
    assert.match(classificationSql, /pg_catalog\.pg_xact_status/);
    assert.deepEqual(parsePostgresMigrationActiveTransactionIds([{ active_xid: "42" }, { active_xid: "42" }]), ["42"]);
    assert.deepEqual(selectPostgresMigrationPreexistingTransactionIds("4294967400", ["4294967290", "4294967500"]), [
      "4294967290",
    ]);
    assert.equal(
      classifyPostgresMigrationTransactionDatabase({
        transaction_status: "in progress",
        observed_database_count: "1",
        current_database_observed: true,
      }),
      "current",
    );
    assert.equal(
      classifyPostgresMigrationTransactionDatabase({
        transaction_status: "in progress",
        observed_database_count: "1",
        current_database_observed: false,
      }),
      "other",
    );
    assert.equal(
      classifyPostgresMigrationTransactionDatabase({
        transaction_status: "in progress",
        observed_database_count: "0",
        current_database_observed: false,
      }),
      "unknown",
    );
    assert.equal(
      classifyPostgresMigrationTransactionDatabase({
        transaction_status: "committed",
        observed_database_count: "0",
        current_database_observed: false,
      }),
      "complete",
    );
    assert.throws(
      () => parsePostgresMigrationActiveTransactionIds([{ active_xid: "not-an-xid" }]),
      /invalid transaction id/,
    );
  });

  it("rejects reserved system schemas as migration owners", () => {
    for (const currentSchemaName of ["information_schema", "pg_catalog", "pg_toast"]) {
      assert.throws(
        () =>
          assertPostgresMigrationCurrentSchemaIsDurable({
            current_schema_is_temp: false,
            current_schema_name: currentSchemaName,
            current_schema_oid: "11",
            current_schema_owned_by_current_user: true,
            current_schema_has_exclusive_create_authority: true,
            existing_unowned_relation: null,
          }),
        /system schema .* cannot own GoatCitadel migration state/,
      );
    }
    assert.deepEqual(
      assertPostgresMigrationCurrentSchemaIsDurable({
        current_schema_is_temp: false,
        current_schema_name: "quoted.schema",
        current_schema_oid: "2200",
        current_schema_owned_by_current_user: true,
        current_schema_has_exclusive_create_authority: true,
        existing_unowned_relation: null,
      }),
      { name: "quoted.schema", oid: "2200" },
    );
  });

  it("requires the effective migration role to own the durable schema", () => {
    assert.throws(
      () =>
        assertPostgresMigrationCurrentSchemaIsDurable({
          current_schema_is_temp: false,
          current_schema_name: "application_schema",
          current_schema_oid: "2200",
          current_schema_owned_by_current_user: false,
          current_schema_has_exclusive_create_authority: true,
          existing_unowned_relation: null,
        }),
      /migration role must own schema "application_schema"/,
    );
  });

  it("rejects shared schema CREATE authority and relations owned by another role", () => {
    const baseRow = {
      current_schema_is_temp: false,
      current_schema_name: "application_schema",
      current_schema_oid: "2200",
      current_schema_owned_by_current_user: true,
      current_schema_has_exclusive_create_authority: true,
      existing_unowned_relation: null,
    };
    assert.throws(
      () =>
        assertPostgresMigrationCurrentSchemaIsDurable({
          ...baseRow,
          current_schema_has_exclusive_create_authority: false,
        }),
      /grants CREATE to another role or PUBLIC/,
    );
    assert.throws(
      () =>
        assertPostgresMigrationCurrentSchemaIsDurable({
          ...baseRow,
          existing_unowned_relation: "hostile_shape",
        }),
      /contains relation "hostile_shape" owned by another role/,
    );
  });

  it("normalizes only the exact pre-v47 Postgres alias cohort", () => {
    const cases: Array<{
      label: string;
      appliedRows: Array<{ version: number; name: string }>;
      expectedNames: string[];
      expectedRepair: boolean;
    }> = [
      {
        label: "interrupted after version 32",
        appliedRows: [{ version: 32, name: "cron_jobs_workdir_and_context_from" }],
        expectedNames: ["state_validation_quarantine"],
        expectedRepair: true,
      },
      {
        label: "complete legacy cohort",
        appliedRows: [
          { version: 32, name: "cron_jobs_workdir_and_context_from" },
          { version: 33, name: "cron_jobs_last_run_output_and_run_id" },
        ],
        expectedNames: ["state_validation_quarantine", "cron_jobs_workdir_context_from_run_output_run_id"],
        expectedRepair: true,
      },
      {
        label: "orphaned version 33 alias",
        appliedRows: [
          { version: 32, name: "state_validation_quarantine" },
          { version: 33, name: "cron_jobs_last_run_output_and_run_id" },
        ],
        expectedNames: ["state_validation_quarantine", "cron_jobs_last_run_output_and_run_id"],
        expectedRepair: false,
      },
      {
        label: "repair already recorded",
        appliedRows: [
          { version: 32, name: "cron_jobs_workdir_and_context_from" },
          { version: 47, name: "state_validation_quarantine_history_repair" },
        ],
        expectedNames: ["cron_jobs_workdir_and_context_from", "state_validation_quarantine_history_repair"],
        expectedRepair: false,
      },
      {
        label: "arbitrary alias",
        appliedRows: [{ version: 32, name: "almost_state_validation_quarantine" }],
        expectedNames: ["almost_state_validation_quarantine"],
        expectedRepair: false,
      },
    ];

    for (const testCase of cases) {
      const originalRows = testCase.appliedRows.map((row) => ({ ...row }));
      const result = normalizePostgresMigrationLedgerForHistoricalRepair({
        definitions,
        appliedRows: testCase.appliedRows,
      });

      assert.deepEqual(
        result.appliedRows.map((row) => row.name),
        testCase.expectedNames,
        testCase.label,
      );
      assert.equal(result.requiresHistoryRepairValidation, testCase.expectedRepair, testCase.label);
      assert.deepEqual(testCase.appliedRows, originalRows, `${testCase.label} mutated the source rows`);
    }
  });

  it("refuses compatibility when any canonical repair identity is absent or drifted", () => {
    for (const driftedDefinitions of [
      definitions.filter((definition) => definition.version !== 47),
      definitions.map((definition) =>
        definition.version === 32 ? { ...definition, name: "drifted_version_32" } : definition,
      ),
      definitions.map((definition) =>
        definition.version === 33 ? { ...definition, name: "drifted_version_33" } : definition,
      ),
      definitions.map((definition) =>
        definition.version === 47 ? { ...definition, name: "drifted_version_47" } : definition,
      ),
      definitions.map((definition) =>
        definition.version === 47 ? { ...definition, sql: `${definition.sql}\nSELECT 1;` } : definition,
      ),
    ]) {
      const result = normalizePostgresMigrationLedgerForHistoricalRepair({
        definitions: driftedDefinitions,
        appliedRows: [{ version: 32, name: "cron_jobs_workdir_and_context_from" }],
      });
      assert.equal(result.requiresHistoryRepairValidation, false);
      assert.equal(result.appliedRows[0]?.name, "cron_jobs_workdir_and_context_from");
    }
  });

  it("classifies only the exact deployed compound-engineering v124 ledger for repair", () => {
    const canonicalPrefix = POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 123).map((migration) => ({
      version: migration.version,
      name: migration.name,
    }));
    const exactCandidate = [...canonicalPrefix, { version: 124, name: "compound_engineering_foundation" }];
    const originalRows = exactCandidate.map((row) => ({ ...row }));

    assert.equal(
      classifyLegacyCompoundV124Ledger({ definitions: POSTGRES_MIGRATIONS, appliedRows: exactCandidate }),
      "exact-candidate",
    );
    assert.deepEqual(exactCandidate, originalRows, "classification must not mutate the ledger snapshot");
    assert.equal(
      classifyLegacyCompoundV124Ledger({
        definitions: POSTGRES_MIGRATIONS,
        appliedRows: POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 124).map((migration) => ({
          version: migration.version,
          name: migration.name,
        })),
      }),
      "none",
    );

    for (const appliedRows of [
      exactCandidate.slice(1),
      [...exactCandidate, { version: 125, name: "notification_routing" }],
      exactCandidate.map((row) => (row.version === 123 ? { ...row, name: "drifted-prefix" } : row)),
    ]) {
      assert.equal(
        classifyLegacyCompoundV124Ledger({ definitions: POSTGRES_MIGRATIONS, appliedRows }),
        "invalid-candidate",
      );
    }

    assert.equal(
      classifyLegacyCompoundV124Ledger({
        definitions: POSTGRES_MIGRATIONS.map((migration) =>
          migration.version === 129 ? { ...migration, sql: `${migration.sql}\nSELECT 1;` } : migration,
        ),
        appliedRows: exactCandidate,
      }),
      "invalid-candidate",
    );
    assert.equal(
      classifyLegacyCompoundV124Ledger({
        definitions: POSTGRES_MIGRATIONS.map((migration) =>
          migration.batchedStatements
            ? {
                ...migration,
                batchedStatements: migration.batchedStatements.map((statement, index) =>
                  index === 0 ? { ...statement, sql: `${statement.sql}\n-- drift` } : statement,
                ),
              }
            : migration,
        ),
        appliedRows: exactCandidate,
      }),
      "invalid-candidate",
    );
  });

  it("fails closed on malformed legacy compound catalog and CAS repair results", () => {
    assert.match(POSTGRES_LEGACY_COMPOUND_V124_CATALOG_SQL, /personal_ops_notes/);
    assert.match(POSTGRES_LEGACY_COMPOUND_V124_CATALOG_SQL, /idx_personal_ops_notes_workspace_updated/);
    assert.doesNotThrow(() => assertLegacyCompoundV124Catalog({ matches_expected: true }));
    assert.throws(() => assertLegacyCompoundV124Catalog({ matches_expected: false }), /catalog does not match/);
    assert.doesNotThrow(() =>
      assertLegacyCompoundV124LedgerRepairResult([
        { version: 129, name: "compound_engineering_foundation", applied_at: "2026-07-28T00:00:00Z" },
      ]),
    );
    assert.throws(() => assertLegacyCompoundV124LedgerRepairResult([]), /did not update exactly one canonical row/);
  });
});

describe("Postgres migrator", () => {
  it("rejects a malformed async registry before touching the pool or schema", async () => {
    const malformedRegistries: Array<{
      migrations: PostgresMigration[];
      message: RegExp;
    }> = [
      {
        migrations: [
          { version: 2, name: "partial_start", sql: "SELECT 1" },
          { version: 4, name: "gap", sql: "SELECT 1" },
        ],
        message: /expected version 3 after 2, found 4/,
      },
      {
        migrations: [
          { version: 2, name: "first", sql: "SELECT 1" },
          { version: 2, name: "duplicate", sql: "SELECT 1" },
        ],
        message: /expected version 3 after 2, found 2/,
      },
      {
        migrations: [
          { version: 2, name: "later", sql: "SELECT 1" },
          { version: 1, name: "reordered", sql: "SELECT 1" },
        ],
        message: /expected version 3 after 2, found 1/,
      },
      {
        migrations: [
          { version: 1, name: "valid_first", sql: "SELECT 1" },
          { version: 2, name: "empty_later", sql: "" },
        ],
        message: /must define atomic SQL or batched statements/,
      },
      {
        migrations: [
          { version: 1, name: "valid_first", sql: "SELECT 1" },
          { version: 2, name: "drifted_later", sql: "SELECT 2", integritySha256: "0".repeat(64) },
        ],
        message: /integrity hash mismatch/,
      },
    ];

    for (const malformed of malformedRegistries) {
      const pool = new FakePool();
      const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

      await assert.rejects(runPostgresMigrations(client, malformed.migrations), malformed.message);

      assert.deepEqual(pool.calls, []);
      assert.deepEqual(pool.clients, []);
    }
  });

  it("validates every async ledger row before an earlier missing migration can commit", async () => {
    const driftedLedgers: Array<{
      rows: QueryRows;
      message: RegExp;
    }> = [
      {
        rows: [{ version: 2, name: "branch_only_migration" }],
        message: /migration ledger mismatch at version 2/,
      },
      {
        rows: [{ version: 999, name: "future_unknown" }],
        message: /migration ledger contains unknown version 999/,
      },
    ];

    for (const drifted of driftedLedgers) {
      const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], drifted.rows]);
      const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

      await assert.rejects(runPostgresMigrations(client, migrations()), drifted.message);

      assert.equal(pool.clients.length, 1);
      assert.deepEqual(
        pool.clients[0]?.calls.map((call) => call.sql.trim()).filter((sql) => sql === "BEGIN" || sql === "ROLLBACK"),
        ["BEGIN", "ROLLBACK"],
      );
      assert.equal(
        pool.clients[0]?.calls.some((call) => /pg_catalog\.pg_advisory_lock\(/.test(call.sql)),
        true,
      );
      assert.match(pool.clients[0]?.calls.at(-1)?.sql ?? "", /pg_advisory_unlock/);
      assert.equal(pool.clients[0]?.released, true);
    }
  });

  it("runs only unapplied async migrations and marks them inside the transaction", async () => {
    const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], [{ version: 1, name: "create_existing" }]]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await runPostgresMigrations(client, migrations());

    assert.deepEqual(result, { appliedVersions: [2], latestVersion: 2 });
    assert.equal(pool.clients.length, 1);
    const calls = pool.clients[0]?.calls ?? [];
    const beginIndex = calls.findIndex((call) => call.sql.trim() === "BEGIN");
    const safeSearchPathIndex = calls.findIndex((call) => call.sql.includes("pg_catalog.set_config"));
    const schemaIdentityCheckIndex = calls.findIndex(
      (call) =>
        call.sql.includes("FROM pg_catalog.pg_namespace AS namespace") &&
        !call.sql.includes("AS current_schema_is_temp"),
    );
    const ledgerGuardLockIndex = calls.findIndex((call) => call.sql.includes("LOCK TABLE"));
    const migrationIndex = calls.findIndex((call) => call.sql === "CREATE TABLE new_table(id INTEGER PRIMARY KEY)");
    const insertIndex = calls.findIndex((call) => call.sql.includes('INSERT INTO "public"."schema_migrations"'));
    const terminalIdentityCheckIndex = calls.reduce(
      (lastIndex, call, index) =>
        call.sql.includes("FROM pg_catalog.pg_namespace AS namespace") &&
        !call.sql.includes("AS current_schema_is_temp")
          ? index
          : lastIndex,
      -1,
    );
    const finalCommitIndex = calls.reduce(
      (lastIndex, call, index) => (call.sql.trim() === "COMMIT" ? index : lastIndex),
      -1,
    );
    assert.equal(
      calls.some((call) => /pg_catalog\.pg_advisory_lock\(/.test(call.sql)),
      true,
    );
    assert.ok(beginIndex >= 0);
    assert.ok(beginIndex < safeSearchPathIndex);
    assert.equal(calls[safeSearchPathIndex]?.params?.[0], '"public"');
    assert.ok(safeSearchPathIndex < schemaIdentityCheckIndex);
    assert.ok(schemaIdentityCheckIndex < ledgerGuardLockIndex);
    assert.ok(ledgerGuardLockIndex < migrationIndex);
    assert.ok(migrationIndex < insertIndex);
    assert.ok(insertIndex < terminalIdentityCheckIndex);
    assert.ok(terminalIdentityCheckIndex < finalCommitIndex);
    assert.deepEqual(
      calls
        .map((call) => call.sql.trim())
        .filter(
          (sql) => sql === "BEGIN" || sql === "CREATE TABLE new_table(id INTEGER PRIMARY KEY)" || sql === "COMMIT",
        ),
      ["BEGIN", "COMMIT", "BEGIN", "CREATE TABLE new_table(id INTEGER PRIMARY KEY)", "COMMIT"],
    );
    assert.deepEqual(calls[insertIndex]?.params, [2, "create_new"]);
    assert.match(calls.at(-1)?.sql ?? "", /pg_advisory_unlock/);
    assert.deepEqual(pool.calls, []);
    assert.equal(pool.clients[0]?.released, true);
  });

  it("routes the exact frozen v47 repair through a configured custom ledger without rewriting its SQL", async () => {
    const historyRepair = POSTGRES_MIGRATIONS.find((migration) => migration.version === 47);
    assert.ok(historyRepair);
    const pool = new FakePool();
    const client = new PostgresDatabaseClient(
      { database: "goatcitadel" },
      { pool: asPool(pool), migrationsTable: "custom_schema_migrations" },
    );

    await runPostgresMigrations(client, [historyRepair]);

    const calls = pool.clients[0]?.calls ?? [];
    const createViewIndex = calls.findIndex((call) => call.sql.includes("CREATE TEMPORARY VIEW"));
    const frozenSqlIndex = calls.findIndex((call) => call.sql === historyRepair.sql);
    const dropViewIndex = calls.findIndex((call) => call.sql.includes("DROP VIEW pg_temp"));
    const markIndex = calls.findIndex(
      (call) => call.sql.includes("INSERT INTO") && call.params?.[0] === historyRepair.version,
    );
    assert.ok(createViewIndex >= 0);
    assert.ok(createViewIndex < frozenSqlIndex);
    assert.ok(frozenSqlIndex < markIndex);
    assert.ok(markIndex < dropViewIndex);
  });

  it("rejects caller-supplied drift from the frozen v47 definition before touching a custom ledger", async () => {
    const historyRepair = POSTGRES_MIGRATIONS.find((migration) => migration.version === 47);
    assert.ok(historyRepair);
    const driftedRegistries: PostgresMigration[][] = [
      [{ ...historyRepair, sql: `${historyRepair.sql}\nSELECT 1;` }],
      [{ ...historyRepair, name: "drifted_state_validation_quarantine_history_repair" }],
      POSTGRES_MIGRATIONS.filter((migration) => migration.version >= 32 && migration.version <= 47).map((migration) =>
        migration.version === 47
          ? {
              ...migration,
              name: "drifted_state_validation_quarantine_history_repair",
              sql: "SELECT 47",
            }
          : migration,
      ),
    ];

    for (const driftedRegistry of driftedRegistries) {
      const pool = new FakePool();
      const client = new PostgresDatabaseClient(
        { database: "goatcitadel" },
        { pool: asPool(pool), migrationsTable: "custom_schema_migrations" },
      );
      await assert.rejects(
        runPostgresMigrations(client, driftedRegistry),
        /must match the frozen canonical v47 definition/,
      );
      assert.deepEqual(pool.calls, []);
      assert.deepEqual(pool.clients, []);
    }
  });

  it("rejects sync caller drift from frozen v47 before creating the configured ledger", () => {
    const historyRepair = POSTGRES_MIGRATIONS.find((migration) => migration.version === 47);
    assert.ok(historyRepair);
    const db = createTempDatabase("goatcitadel-postgres-v47-definition-drift");
    const postgresDb = new PinnedSessionDatabase(db);

    assert.throws(
      () =>
        applyPostgresMigrationsSync(postgresDb, {
          migrationsTable: "custom_schema_migrations",
          migrations: [{ ...historyRepair, sql: `${historyRepair.sql}\nSELECT 1;` }],
        }),
      /must match the frozen canonical v47 definition/,
    );
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'custom_schema_migrations'").get(),
      undefined,
    );
    assert.deepEqual(postgresDb.events, []);
  });

  it("rejects invalid sync migration identifiers before opening a pinned session", () => {
    const db = createTempDatabase("goatcitadel-postgres-invalid-ledger-identifier");
    const postgresDb = new PinnedSessionDatabase(db);

    for (const migrationsTable of ["", "invalid\0identifier", "a".repeat(64), "é".repeat(32)]) {
      assert.throws(
        () => applyPostgresMigrationsSync(postgresDb, { migrationsTable, migrations: [migrations()[0]!] }),
        /must be a non-empty identifier without NUL characters and at most 63 UTF-8 bytes/,
      );
    }
    assert.deepEqual(postgresDb.events, []);
  });

  it("fails before frozen v47 when the pinned session already owns the temporary bridge name", async () => {
    const historyRepair = POSTGRES_MIGRATIONS.find((migration) => migration.version === 47);
    assert.ok(historyRepair);
    const pool = new FakePool([], [], "schema_migrations");
    const client = new PostgresDatabaseClient(
      { database: "goatcitadel" },
      { pool: asPool(pool), migrationsTable: "custom_schema_migrations" },
    );

    await assert.rejects(
      runPostgresMigrations(client, [historyRepair]),
      /pg_temp\.schema_migrations already exists on the pinned session/,
    );

    const calls = pool.clients[0]?.calls ?? [];
    assert.equal(
      calls.some((call) => call.sql === historyRepair.sql),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.includes("CREATE TEMPORARY VIEW")),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.includes("INSERT INTO") && call.params?.[0] === historyRepair.version),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.trim() === "ROLLBACK"),
      true,
    );
    assert.equal(pool.clients[0]?.destroyed, true);
  });

  it("fails before frozen v47 when search_path does not resolve the temporary bridge first", async () => {
    const historyRepair = POSTGRES_MIGRATIONS.find((migration) => migration.version === 47);
    assert.ok(historyRepair);
    const pool = new FakePool([], [], null, null, false);
    const client = new PostgresDatabaseClient(
      { database: "goatcitadel" },
      { pool: asPool(pool), migrationsTable: "custom_schema_migrations" },
    );

    await assert.rejects(
      runPostgresMigrations(client, [historyRepair]),
      /temporary ledger bridge does not own unqualified schema_migrations resolution/,
    );

    const calls = pool.clients[0]?.calls ?? [];
    assert.equal(
      calls.some((call) => call.sql.includes("CREATE TEMPORARY VIEW")),
      true,
    );
    assert.equal(
      calls.some((call) => call.sql === historyRepair.sql),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.includes("INSERT INTO") && call.params?.[0] === historyRepair.version),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.trim() === "ROLLBACK"),
      true,
    );
  });

  it("does not create a temporary bridge for the default Postgres ledger", async () => {
    const historyRepair = POSTGRES_MIGRATIONS.find((migration) => migration.version === 47);
    assert.ok(historyRepair);
    const pool = new FakePool();
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await runPostgresMigrations(client, [historyRepair]);

    const calls = pool.clients[0]?.calls ?? [];
    assert.equal(calls.filter((call) => call.sql === historyRepair.sql).length, 1);
    assert.equal(
      calls.some((call) => call.sql.includes("to_regclass('pg_temp.schema_migrations')")),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.includes("CREATE TEMPORARY VIEW")),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.includes("DROP VIEW pg_temp")),
      false,
    );
  });

  it("rejects a temporary relation that shadows the configured async migration ledger", async () => {
    const pool = new FakePool([], [], null, "schema_migrations");
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await assert.rejects(
      runPostgresMigrations(client, [migrations()[0]!]),
      /temporary relation .* shadows the configured migrations table/,
    );

    const calls = pool.clients[0]?.calls ?? [];
    assert.equal(
      calls.some((call) => call.sql.trim() === "BEGIN"),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.includes("CREATE TABLE existing_table")),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.includes("INSERT INTO")),
      false,
    );
    assert.equal(pool.clients[0]?.destroyed, true);
  });

  it("rejects a temporary relation that shadows the configured sync migration ledger", () => {
    const db = createTempDatabase("goatcitadel-postgres-temp-ledger-shadow");
    db.exec("DELETE FROM schema_migrations");
    const postgresDb = new PinnedSessionDatabase(db, false, 0, undefined, "schema_migrations");

    assert.throws(
      () => applyPostgresMigrationsSync(postgresDb, { migrations: [migrations()[0]!] }),
      /temporary relation .* shadows the configured migrations table/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get<{ count: number }>()?.count, 0);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'existing_table'").get(),
      undefined,
    );
    assert.equal(postgresDb.destroyed, true);
  });

  it("rejects unrelated temporary payload relations on the async migration session", async () => {
    const pool = new FakePool([], [], null, null, true, false, "pg_temp.existing_table");
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await assert.rejects(
      runPostgresMigrations(client, [migrations()[0]!]),
      /temporary relation .* contaminates the pinned migration session/,
    );

    const calls = pool.clients[0]?.calls ?? [];
    assert.equal(
      calls.some((call) => call.sql.trim() === "BEGIN"),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.includes("CREATE TABLE existing_table")),
      false,
    );
    assert.equal(pool.clients[0]?.destroyed, true);
  });

  it("rejects unrelated temporary payload relations on the sync migration session", () => {
    const db = createTempDatabase("goatcitadel-postgres-temp-payload-shadow");
    db.exec("DELETE FROM schema_migrations");
    const postgresDb = new PinnedSessionDatabase(
      db,
      false,
      0,
      undefined,
      null,
      null,
      true,
      false,
      "pg_temp.existing_table",
    );

    assert.throws(
      () => applyPostgresMigrationsSync(postgresDb, { migrations: [migrations()[0]!] }),
      /temporary relation .* contaminates the pinned migration session/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get<{ count: number }>()?.count, 0);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'existing_table'").get(),
      undefined,
    );
    assert.equal(postgresDb.destroyed, true);
  });

  it("rejects a temporary current schema before async migration state can become ephemeral", async () => {
    const pool = new FakePool([], [], null, null, true, true);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await assert.rejects(
      runPostgresMigrations(client, [migrations()[0]!]),
      /temporary current schema cannot own the migrations table/,
    );

    const calls = pool.clients[0]?.calls ?? [];
    assert.equal(
      calls.some((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS")),
      false,
    );
    assert.equal(
      calls.some((call) => call.sql.trim() === "BEGIN"),
      false,
    );
    assert.equal(pool.clients[0]?.destroyed, true);
  });

  it("rejects a temporary current schema before sync migration state can become ephemeral", () => {
    const db = createTempDatabase("goatcitadel-postgres-temp-current-schema");
    db.exec("DELETE FROM schema_migrations");
    const postgresDb = new PinnedSessionDatabase(db, false, 0, undefined, null, null, true, true);

    assert.throws(
      () => applyPostgresMigrationsSync(postgresDb, { migrations: [migrations()[0]!] }),
      /temporary current schema cannot own the migrations table/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get<{ count: number }>()?.count, 0);
    assert.equal(postgresDb.destroyed, true);
  });

  it("rolls back sync migration effects when the durable schema changes before commit", () => {
    const db = createTempDatabase("goatcitadel-postgres-schema-identity-race");
    db.exec("DELETE FROM schema_migrations");
    const postgresDb = new PinnedSessionDatabase(db);
    postgresDb.queueSchemaIdentityOids("2200", "2200", "2200", "2200", "2200", "9999");

    assert.throws(
      () =>
        applyPostgresMigrationsSync(postgresDb, {
          migrations: [
            {
              version: 1,
              name: "schema_identity_race",
              sql: "CREATE TABLE schema_identity_race_effect (effect_id INTEGER)",
            },
          ],
        }),
      /migration schema "public" changed after preflight/,
    );

    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_identity_race_effect'").get(),
      undefined,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get<{ count: number }>()?.count, 0);
    assert.equal(postgresDb.destroyed, true);
  });

  it("accepts a partial async registry whose first version is not one and whose names repeat", async () => {
    const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], []]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });
    const partialMigrations: PostgresMigration[] = [
      { version: 7, name: "repair_lineage", sql: "SELECT 7" },
      { version: 8, name: "repair_lineage", sql: "SELECT 8" },
    ];

    const result = await runPostgresMigrations(client, partialMigrations);

    assert.deepEqual(result, { appliedVersions: [7, 8], latestVersion: 8 });
    assert.equal(pool.clients.length, 1);
    assert.deepEqual(
      pool.clients[0]?.calls
        .filter((call) => call.sql.includes('INSERT INTO "public"."schema_migrations"'))
        .map((call) => call.params),
      [
        [7, "repair_lineage"],
        [8, "repair_lineage"],
      ],
    );
  });

  it("commits bounded async migration statements independently and records the ledger only after a zero pass", async () => {
    const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], []], [2, 1, 0]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await runPostgresMigrations(client, [batchedMigration()]);

    assert.deepEqual(result, { appliedVersions: [1], latestVersion: 1 });
    assert.equal(pool.clients.length, 1);
    const calls = pool.clients[0]?.calls.map((call) => call.sql.trim()) ?? [];
    assert.deepEqual(
      calls.filter((sql) => ["BEGIN", "BATCH SCRUB", "COMMIT"].includes(sql)),
      [
        "BEGIN",
        "COMMIT",
        "BEGIN",
        "BATCH SCRUB",
        "COMMIT",
        "BEGIN",
        "BATCH SCRUB",
        "COMMIT",
        "BEGIN",
        "BATCH SCRUB",
        "COMMIT",
        "BEGIN",
        "COMMIT",
      ],
    );
    assert.equal(
      calls.some((sql) => /pg_catalog\.pg_advisory_lock\(/.test(sql)),
      true,
    );
    assert.match(calls.at(-1) ?? "", /pg_advisory_unlock/);
    assert.equal(pool.clients[0]?.released, true);
  });

  it("does not record an interrupted async batched migration after earlier batches committed", async () => {
    const pool = new FakePool(
      [[], [], [{ server_encoding: "UTF8" }], []],
      [2, new Error("simulated async batch failure")],
    );
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await assert.rejects(runPostgresMigrations(client, [batchedMigration()]), /simulated async batch failure/);

    assert.equal(pool.clients.length, 1);
    assert.deepEqual(
      pool.clients[0]?.calls
        .map((call) => call.sql.trim())
        .filter((sql) => ["BEGIN", "BATCH SCRUB", "COMMIT", "ROLLBACK"].includes(sql)),
      ["BEGIN", "COMMIT", "BEGIN", "BATCH SCRUB", "COMMIT", "BEGIN", "BATCH SCRUB", "ROLLBACK"],
    );
    assert.equal(
      pool.clients[0]?.calls.some((call) => call.sql.includes('INSERT INTO "schema_migrations"')),
      false,
    );
    assert.match(pool.clients[0]?.calls.at(-1)?.sql ?? "", /pg_advisory_unlock/);
    assert.equal(pool.clients[0]?.released, true);
  });

  it("fails closed when an async batched statement does not report an affected-row count", async () => {
    const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], []], [null]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await assert.rejects(
      runPostgresMigrations(client, [batchedMigration()]),
      /did not report a valid affected-row count/,
    );

    assert.deepEqual(
      pool.clients[0]?.calls
        .map((call) => call.sql.trim())
        .filter((sql) => ["BEGIN", "BATCH SCRUB", "COMMIT", "ROLLBACK"].includes(sql)),
      ["BEGIN", "COMMIT", "BEGIN", "BATCH SCRUB", "ROLLBACK"],
    );
    assert.match(pool.clients[0]?.calls.at(-1)?.sql ?? "", /pg_advisory_unlock/);
  });

  it("rejects when an applied async migration version was recorded under a different name", async () => {
    const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], [{ version: 1, name: "branch_only_migration" }]]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    await assert.rejects(
      runPostgresMigrations(client, migrations()),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("version 1") &&
        error.message.includes("branch_only_migration") &&
        error.message.includes("create_existing"),
    );
    assert.equal(pool.clients.length, 1);
    assert.deepEqual(
      pool.clients[0]?.calls.map((call) => call.sql.trim()).filter((sql) => sql === "BEGIN" || sql === "ROLLBACK"),
      ["BEGIN", "ROLLBACK"],
    );
    assert.match(pool.clients[0]?.calls.at(-1)?.sql ?? "", /pg_advisory_unlock/);
  });

  it("refuses to skip a sync migration whose ledger row was written by a divergent lineage", () => {
    const db = createTempDatabase("goatcitadel-postgres-migrator-drift");
    applyPostgresMigrationsSync(db, {
      migrationsTable: "drift_schema_migrations",
      migrations: [
        { version: 1, name: "create_existing", sql: "CREATE TABLE existing_table(id INTEGER PRIMARY KEY)" },
        { version: 2, name: "branch_only_migration", sql: "CREATE TABLE branch_table(id INTEGER PRIMARY KEY)" },
      ],
    });

    assert.throws(
      () => applyPostgresMigrationsSync(db, { migrationsTable: "drift_schema_migrations", migrations: migrations() }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("version 2") &&
        error.message.includes("branch_only_migration") &&
        error.message.includes("create_new"),
    );

    const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("new_table") as
      | { name: string }
      | undefined;
    assert.equal(tableRow, undefined);
  });

  it("validates every sync ledger row before an earlier missing migration can commit", () => {
    const db = createTempDatabase("goatcitadel-postgres-sync-ledger-preflight");
    const driftedLedgers = [
      {
        migrationsTable: "name_drift_migrations",
        version: 2,
        name: "branch_only_migration",
        expectedMessage: /migration ledger mismatch at version 2/,
        createdTable: "name_drift_early_table",
      },
      {
        migrationsTable: "future_drift_migrations",
        version: 999,
        name: "future_unknown",
        expectedMessage: /migration ledger contains unknown version 999/,
        createdTable: "future_drift_early_table",
      },
    ];

    for (const drifted of driftedLedgers) {
      db.exec(`
        CREATE TABLE ${drifted.migrationsTable} (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.prepare(`INSERT INTO ${drifted.migrationsTable} (version, name) VALUES (?, ?)`).run(
        drifted.version,
        drifted.name,
      );

      assert.throws(
        () =>
          applyPostgresMigrationsSync(db, {
            migrationsTable: drifted.migrationsTable,
            migrations: [
              {
                version: 1,
                name: "missing_earlier",
                sql: `CREATE TABLE ${drifted.createdTable}(id INTEGER PRIMARY KEY)`,
              },
              { version: 2, name: "expected_later", sql: "SELECT 1" },
            ],
          }),
        drifted.expectedMessage,
      );

      assert.equal(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(drifted.createdTable),
        undefined,
      );
      assert.equal(
        db
          .prepare(`SELECT COUNT(*) AS count FROM ${drifted.migrationsTable} WHERE version = 1`)
          .get<{ count: number }>()?.count,
        0,
      );
    }
  });

  it("repairs the exact pre-v47 Postgres ledger aliases and then requires canonical names", () => {
    const db = createTempDatabase("goatcitadel-postgres-v47-ledger-repair");
    const postgresDb = new PinnedSessionDatabase(db);
    const repairSlice = POSTGRES_MIGRATIONS.filter((migration) => migration.version >= 32 && migration.version <= 47);
    db.exec("DELETE FROM schema_migrations");
    const insertApplied = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
    for (const migration of repairSlice.filter((migration) => migration.version < 47)) {
      insertApplied.run(
        migration.version,
        migration.version === 32
          ? "cron_jobs_workdir_and_context_from"
          : migration.version === 33
            ? "cron_jobs_last_run_output_and_run_id"
            : migration.name,
        new Date().toISOString(),
      );
    }

    applyPostgresMigrationsSync(postgresDb, { migrations: repairSlice });

    const repairedRows = db
      .prepare("SELECT version, name FROM schema_migrations WHERE version IN (32, 33, 47) ORDER BY version")
      .all() as Array<{ version: number; name: string }>;
    assert.deepEqual(
      repairedRows.map((row) => ({ version: Number(row.version), name: row.name })),
      [
        { version: 32, name: "state_validation_quarantine" },
        { version: 33, name: "cron_jobs_workdir_context_from_run_output_run_id" },
        { version: 47, name: "state_validation_quarantine_history_repair" },
      ],
    );

    db.prepare("UPDATE schema_migrations SET name = ? WHERE version = 32").run("cron_jobs_workdir_and_context_from");
    assert.throws(
      () => applyPostgresMigrationsSync(postgresDb, { migrations: repairSlice }),
      /migration ledger mismatch at version 32/,
    );
  });

  it("keeps SQLite-backed sync ledgers strict instead of accepting Postgres history aliases", () => {
    const db = createTempDatabase("goatcitadel-sqlite-v47-ledger-strict");
    const repairSlice = POSTGRES_MIGRATIONS.filter((migration) => migration.version >= 32 && migration.version <= 47);
    db.exec("DELETE FROM schema_migrations");
    const insertApplied = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
    for (const migration of repairSlice.filter((migration) => migration.version < 47)) {
      insertApplied.run(
        migration.version,
        migration.version === 32 ? "cron_jobs_workdir_and_context_from" : migration.name,
        new Date().toISOString(),
      );
    }

    assert.throws(
      () => applyPostgresMigrationsSync(db, { migrations: repairSlice }),
      /migration ledger mismatch at version 32/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 47").get<{ count: number }>()?.count,
      0,
    );
  });

  it("does not continue past version 47 unless the compatibility repair becomes canonical", () => {
    const db = createTempDatabase("goatcitadel-postgres-v47-ledger-noop");
    const repairSlice = POSTGRES_MIGRATIONS.filter((migration) => migration.version >= 32 && migration.version <= 48);
    const historyRepair = repairSlice.find((migration) => migration.version === 47);
    assert.ok(historyRepair);
    let suppressRepair = true;
    const postgresDb = new PinnedSessionDatabase(db, false, 0, (sql) => suppressRepair && sql === historyRepair.sql);
    db.exec("DELETE FROM schema_migrations");
    const insertApplied = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
    for (const migration of repairSlice.filter((migration) => migration.version < 47)) {
      insertApplied.run(
        migration.version,
        migration.version === 32
          ? "cron_jobs_workdir_and_context_from"
          : migration.version === 33
            ? "cron_jobs_last_run_output_and_run_id"
            : migration.name,
        new Date().toISOString(),
      );
    }
    assert.throws(
      () => applyPostgresMigrationsSync(postgresDb, { migrations: repairSlice }),
      /migration ledger mismatch at version 32/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 47").get<{ count: number }>()?.count,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 48").get<{ count: number }>()?.count,
      0,
    );

    suppressRepair = false;
    applyPostgresMigrationsSync(postgresDb, { migrations: repairSlice });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version IN (47, 48)").get<{ count: number }>()
        ?.count,
      2,
    );
  });

  it("reports zero latest version for an empty async migration set", async () => {
    const pool = new FakePool([[], [], [{ server_encoding: "UTF8" }], []]);
    const client = new PostgresDatabaseClient({ database: "goatcitadel" }, { pool: asPool(pool) });

    const result = await runPostgresMigrations(client, []);

    assert.deepEqual(result, { appliedVersions: [], latestVersion: 0 });
    assert.equal(pool.clients.length, 1);
    assert.deepEqual(
      pool.clients[0]?.calls.map((call) => call.sql.trim()).filter((sql) => sql === "BEGIN" || sql === "COMMIT"),
      ["BEGIN", "COMMIT"],
    );
    assert.equal(
      pool.clients[0]?.calls.some((call) => /pg_catalog\.pg_advisory_lock\(/.test(call.sql)),
      true,
    );
    assert.match(pool.clients[0]?.calls.at(-1)?.sql ?? "", /pg_advisory_unlock/);
  });

  it("applies sync migrations idempotently through the DatabaseClient transaction API", () => {
    const db = createTempDatabase("goatcitadel-postgres-migrator");
    const testMigrations = migrations();

    applyPostgresMigrationsSync(db, {
      migrationsTable: "custom_schema_migrations",
      migrations: testMigrations,
    });
    applyPostgresMigrationsSync(db, {
      migrationsTable: "custom_schema_migrations",
      migrations: testMigrations,
    });

    const migrationRows = db
      .prepare("SELECT version, name FROM custom_schema_migrations ORDER BY version ASC")
      .all() as Array<{ version: number; name: string }>;
    assert.deepEqual(
      migrationRows.map((row) => ({ version: row.version, name: row.name })),
      [
        { version: 1, name: "create_existing" },
        { version: 2, name: "create_new" },
      ],
    );
    const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("new_table") as
      | { name: string }
      | undefined;
    assert.equal(tableRow?.name, "new_table");
  });

  it("holds the sync migration lock on a pinned session and retires it without masking a primary failure", () => {
    const successDelegate = createTempDatabase("goatcitadel-postgres-sync-pinned-success");
    const successDb = new PinnedSessionDatabase(successDelegate);

    applyPostgresMigrationsSync(successDb, {
      migrationsTable: "sync_pinned_migrations",
      migrations: [{ version: 1, name: "sync_pinned", sql: "CREATE TABLE sync_pinned(id INTEGER PRIMARY KEY)" }],
    });

    assert.deepEqual(successDb.events, ["session_begin", "lock", "unlock", "session_end"]);
    assert.equal(successDb.destroyed, false);

    const failureDelegate = createTempDatabase("goatcitadel-postgres-sync-pinned-failure");
    const failureDb = new PinnedSessionDatabase(failureDelegate, true);

    assert.throws(
      () =>
        applyPostgresMigrationsSync(failureDb, {
          migrationsTable: "sync_pinned_failure_migrations",
          migrations: [{ version: 1, name: "sync_pinned_failure", sql: "FAIL MIGRATION" }],
        }),
      /migration primary failure/,
    );
    assert.deepEqual(failureDb.events, ["session_begin", "lock", "unlock", "session_end"]);
    assert.equal(failureDb.destroyed, true);
  });

  it("rejects and retires a sync migration session that was already inside a transaction", () => {
    const delegate = createTempDatabase("goatcitadel-postgres-sync-open-transaction");
    const db = new PinnedSessionDatabase(delegate);
    db.migrationSessionTransactionOpen = true;

    assert.throws(
      () =>
        applyPostgresMigrationsSync(db, {
          migrationsTable: "sync_open_transaction_migrations",
          migrations: [{ version: 1, name: "sync_open_transaction", sql: "SELECT 1" }],
        }),
      /already inside a transaction before lock acquisition/,
    );

    assert.deepEqual(db.events, ["session_begin", "session_end"]);
    assert.equal(db.destroyed, true);
  });

  it("rejects and retires a sync migration session that already held an advisory lock", () => {
    const delegate = createTempDatabase("goatcitadel-postgres-sync-open-advisory-lock");
    const db = new PinnedSessionDatabase(delegate);
    db.migrationSessionAdvisoryLockOpen = true;

    assert.throws(
      () =>
        applyPostgresMigrationsSync(db, {
          migrationsTable: "sync_open_advisory_lock_migrations",
          migrations: [{ version: 1, name: "sync_open_advisory_lock", sql: "SELECT 1" }],
        }),
      /already held an advisory lock/,
    );

    assert.deepEqual(db.events, ["session_begin", "session_end"]);
    assert.equal(db.destroyed, true);
  });

  it("fails quickly and retires a sync session when the transaction probe lock is unavailable", () => {
    const delegate = createTempDatabase("goatcitadel-postgres-sync-transaction-probe-contention");
    const db = new PinnedSessionDatabase(delegate);
    db.migrationTransactionProbeAcquired = false;

    assert.throws(
      () =>
        applyPostgresMigrationsSync(db, {
          migrationsTable: "sync_transaction_probe_contention_migrations",
          migrations: [{ version: 1, name: "sync_transaction_probe_contention", sql: "SELECT 1" }],
        }),
      /probe lock is held by another session/,
    );

    assert.deepEqual(db.events, ["session_begin", "session_end"]);
    assert.equal(db.destroyed, true);
  });

  it("waits for captured sync transactions to leave the in-progress state before migration work", () => {
    const delegate = createTempDatabase("goatcitadel-postgres-sync-quiescence");
    const db = new PinnedSessionDatabase(delegate);
    db.queueMigrationActivity(["42"], "in progress", "committed");
    const retryWaits: number[] = [];
    const waitMock = mock.method(
      Atomics,
      "wait",
      (_state: Int32Array, _index: number, _value: number, timeout?: number) => {
        retryWaits.push(timeout ?? Number.POSITIVE_INFINITY);
        return "timed-out";
      },
    );

    try {
      applyPostgresMigrationsSync(db, {
        migrationsTable: "sync_quiescence_migrations",
        migrations: [{ version: 1, name: "sync_quiescence", sql: "SELECT 1" }],
      });
    } finally {
      waitMock.mock.restore();
    }

    assert.deepEqual(retryWaits, [50]);
    assert.equal(db.destroyed, false);
  });

  it("retries sync migration lock contention instead of leaving one worker request blocked past its timeout", () => {
    const delegate = createTempDatabase("goatcitadel-postgres-sync-lock-contention");
    const db = new PinnedSessionDatabase(delegate, false, 601);
    const retryWaits: number[] = [];
    const waitMock = mock.method(
      Atomics,
      "wait",
      (_state: Int32Array, _index: number, _value: number, timeout?: number) => {
        retryWaits.push(timeout ?? Number.POSITIVE_INFINITY);
        return "timed-out";
      },
    );

    try {
      applyPostgresMigrationsSync(db, {
        migrationsTable: "sync_contended_migrations",
        migrations: [{ version: 1, name: "sync_contended", sql: "SELECT 1" }],
      });
    } finally {
      waitMock.mock.restore();
    }

    assert.equal(db.events[0], "session_begin");
    assert.equal(db.events.filter((event) => event === "lock_wait").length, 601);
    assert.deepEqual(db.events.slice(-3), ["lock", "unlock", "session_end"]);
    assert.equal(retryWaits.length, 601);
    assert.ok(retryWaits.every((timeout) => timeout > 0 && Number.isFinite(timeout)));
    assert.ok(retryWaits.reduce((total, timeout) => total + timeout, 0) > 60_000);
    assert.equal(db.destroyed, false);
  });

  it("resumes a sync batched migration after an interruption and records it only after convergence", () => {
    const db = createTempDatabase("goatcitadel-postgres-batched-resume");
    db.exec(`
      CREATE TABLE scrub_rows (row_id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO scrub_rows (row_id, payload) VALUES
        (1, 'secret:first'),
        (2, 'secret:second'),
        (3, 'secret:third');
    `);
    const batchSql = `
      UPDATE scrub_rows
      SET payload = '[REDACTED]'
      WHERE row_id IN (
        SELECT row_id
        FROM scrub_rows
        WHERE payload LIKE 'secret:%'
        ORDER BY row_id
        LIMIT 2
      )
    `;
    const interruptingDb = createOneTimeInterruptingDatabase(db, "UPDATE scrub_rows");
    const migration = batchedMigration(batchSql);

    assert.throws(
      () =>
        applyPostgresMigrationsSync(interruptingDb, {
          migrationsTable: "batched_schema_migrations",
          migrations: [migration],
        }),
      /simulated batched migration interruption/,
    );
    assert.deepEqual(
      db
        .prepare("SELECT payload FROM scrub_rows ORDER BY row_id")
        .all<{ payload: string }>()
        .map((row) => row.payload),
      ["[REDACTED]", "[REDACTED]", "secret:third"],
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM batched_schema_migrations").get<{ count: number }>()?.count,
      0,
    );

    applyPostgresMigrationsSync(interruptingDb, {
      migrationsTable: "batched_schema_migrations",
      migrations: [migration],
    });
    applyPostgresMigrationsSync(interruptingDb, {
      migrationsTable: "batched_schema_migrations",
      migrations: [migration],
    });

    assert.deepEqual(
      db
        .prepare("SELECT payload FROM scrub_rows ORDER BY row_id")
        .all<{ payload: string }>()
        .map((row) => row.payload),
      ["[REDACTED]", "[REDACTED]", "[REDACTED]"],
    );
    const applied = db
      .prepare("SELECT version, name FROM batched_schema_migrations")
      .get<{ version: number; name: string }>();
    assert.equal(applied?.version, 1);
    assert.equal(applied?.name, "bounded_scrub");
  });

  it("rejects ambiguous or incomplete batched migration definitions", () => {
    const db = createTempDatabase("goatcitadel-postgres-batched-validation");
    const invalidMigrations: Array<{ migration: PostgresMigration; message: RegExp }> = [
      {
        migration: {
          ...batchedMigration(),
          sql: "SELECT 1",
        },
        message: /cannot define both atomic SQL and batched statements/,
      },
      {
        migration: {
          ...batchedMigration(),
          batchedStatements: [],
        },
        message: /must define at least one batched statement/,
      },
      {
        migration: {
          ...batchedMigration(),
          batchedStatements: [{ name: "scrub_rows", sql: " " }],
        },
        message: /unnamed or empty batched statement/,
      },
      {
        migration: {
          version: 1,
          name: "empty",
          sql: "",
        },
        message: /must define atomic SQL or batched statements/,
      },
      {
        migration: {
          ...batchedMigration(),
          integritySha256: "0".repeat(64),
        },
        message: /integrity hash mismatch/,
      },
      {
        migration: {
          version: 0,
          name: "invalid_version",
          sql: "SELECT 1",
        },
        message: /safe positive integer version/,
      },
    ];

    for (const { migration, message } of invalidMigrations) {
      assert.throws(
        () =>
          applyPostgresMigrationsSync(db, {
            migrationsTable: "invalid_schema_migrations",
            migrations: [migration],
          }),
        message,
      );
    }

    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("invalid_schema_migrations"),
      undefined,
    );
  });

  it("prevalidates the complete sync registry before an earlier migration can create schema", () => {
    const db = createTempDatabase("goatcitadel-postgres-sync-registry-preflight");

    assert.throws(
      () =>
        applyPostgresMigrationsSync(db, {
          migrationsTable: "preflight_schema_migrations",
          migrations: [
            {
              version: 7,
              name: "valid_early",
              sql: "CREATE TABLE should_not_exist(id INTEGER PRIMARY KEY)",
            },
            { version: 8, name: "invalid_later", sql: "" },
          ],
        }),
      /must define atomic SQL or batched statements/,
    );

    assert.equal(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
        .get("preflight_schema_migrations", "should_not_exist"),
      undefined,
    );
  });

  it("rejects a malformed sync sequence before creating the ledger schema", () => {
    const db = createTempDatabase("goatcitadel-postgres-sync-sequence-preflight");
    const malformedSequences = [
      {
        suffix: "gap",
        migrations: [
          { version: 7, name: "partial_start", sql: "SELECT 7" },
          { version: 9, name: "gap", sql: "SELECT 9" },
        ],
        message: /expected version 8 after 7, found 9/,
      },
      {
        suffix: "duplicate",
        migrations: [
          { version: 7, name: "first", sql: "SELECT 7" },
          { version: 7, name: "duplicate", sql: "SELECT 7" },
        ],
        message: /expected version 8 after 7, found 7/,
      },
      {
        suffix: "reordered",
        migrations: [
          { version: 7, name: "later", sql: "SELECT 7" },
          { version: 6, name: "reordered", sql: "SELECT 6" },
        ],
        message: /expected version 8 after 7, found 6/,
      },
    ];

    for (const malformed of malformedSequences) {
      const migrationsTable = `sequence_${malformed.suffix}_migrations`;
      assert.throws(
        () =>
          applyPostgresMigrationsSync(db, {
            migrationsTable,
            migrations: malformed.migrations,
          }),
        malformed.message,
      );
      assert.equal(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(migrationsTable),
        undefined,
      );
    }
  });

  it("quotes a reserved-word migrations table so the sync migrator does not emit invalid DDL", () => {
    const db = createTempDatabase("goatcitadel-postgres-migrator-reserved");

    // `order` is a reserved word; without identifier quoting the CREATE TABLE /
    // SELECT / INSERT statements would be syntax errors.
    assert.doesNotThrow(() =>
      applyPostgresMigrationsSync(db, {
        migrationsTable: "order",
        migrations: migrations(),
      }),
    );

    const migrationRows = db.prepare(`SELECT version, name FROM "order" ORDER BY version ASC`).all() as Array<{
      version: number;
      name: string;
    }>;
    assert.deepEqual(
      migrationRows.map((row) => ({ version: row.version, name: row.name })),
      [
        { version: 1, name: "create_existing" },
        { version: 2, name: "create_new" },
      ],
    );
  });
});
