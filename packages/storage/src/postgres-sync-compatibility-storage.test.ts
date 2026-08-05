import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseClient } from "./db.js";
import type { Storage } from "./index.js";
import {
  __postgresSyncCompatibilityStorageInternals,
  createPostgresSyncCompatibilityStorage,
  type PostgresSyncCompatibilityStorageDependencies,
} from "./postgres/sync-compatibility-storage.js";

class FakeDatabaseClient implements DatabaseClient {
  public readonly dialect = "postgres" as const;
  public closed = false;
  public closeError?: Error;

  public prepare() {
    return {
      run: () => ({ changes: 0 }),
      get: <T = unknown>() => undefined as T | undefined,
      all: <T = unknown>() => [] as T[],
    };
  }

  public exec(): void {}

  public close(): void {
    this.closed = true;
    if (this.closeError) throw this.closeError;
  }

  public transaction<T>(_mode: "deferred" | "immediate" | "exclusive", callback: () => T): T {
    return callback();
  }
}

test("sync compatibility factory owns migrations, startup timeout, and Storage construction", () => {
  const clients: FakeDatabaseClient[] = [];
  const constructions: Array<{ applicationName?: string; waitTimeoutMs?: number }> = [];
  const expectedStorage = { compatibility: true } as unknown as Storage;
  const dependencies: PostgresSyncCompatibilityStorageDependencies = {
    createDatabaseClient: (connection, observability) => {
      constructions.push({
        applicationName: connection.applicationName,
        waitTimeoutMs: observability.waitTimeoutMs,
      });
      const client = new FakeDatabaseClient();
      clients.push(client);
      return client;
    },
    applyMigrations: (_db, options) => assert.equal(options.migrationsTable, "custom_migrations"),
    createStorage: (options) => {
      assert.equal(options.db, clients[1]);
      assert.equal(options.transcriptsDir, "transcripts");
      assert.equal(options.auditDir, "audit");
      return expectedStorage;
    },
  };

  const result = createPostgresSyncCompatibilityStorage(
    {
      connection: { database: "test", applicationName: "runtime-app" },
      migrationsTable: "custom_migrations",
      transcriptsDir: "transcripts",
      auditDir: "audit",
    },
    dependencies,
  );

  assert.equal(result, expectedStorage);
  assert.equal(clients[0]?.closed, true);
  assert.equal(clients[1]?.closed, false);
  assert.deepEqual(constructions, [
    {
      applicationName: "goatcitadel-gateway-migrations",
      waitTimeoutMs: __postgresSyncCompatibilityStorageInternals.POSTGRES_STARTUP_MIGRATION_WAIT_TIMEOUT_MS,
    },
    { applicationName: "runtime-app", waitTimeoutMs: undefined },
  ]);
});

test("sync compatibility factory retains migration and cleanup failures", () => {
  const migrationFailure = new Error("migration failed");
  const cleanupFailure = new Error("cleanup failed");
  const database = new FakeDatabaseClient();
  database.closeError = cleanupFailure;

  assert.throws(
    () =>
      createPostgresSyncCompatibilityStorage(
        {
          connection: { database: "test" },
          migrationsTable: "schema_migrations",
          transcriptsDir: "transcripts",
          auditDir: "audit",
        },
        {
          createDatabaseClient: () => database,
          applyMigrations: () => {
            throw migrationFailure;
          },
          createStorage: () => {
            throw new Error("must not construct storage");
          },
        },
      ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [migrationFailure, cleanupFailure]);
      assert.equal(error.cause, migrationFailure);
      return true;
    },
  );
});
