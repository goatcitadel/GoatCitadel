import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRuntimeConfig } from "./config.js";

const mocks = vi.hoisted(() => {
  class FakeNativeClient {
    public close = vi.fn(async () => undefined);
    public constructor(
      public readonly options: unknown,
      public readonly input: unknown,
    ) {
      mocks.nativeClients.push(this);
    }
  }
  class FakePostgresAsyncDatabaseClient {
    public constructor(public readonly native: FakeNativeClient) {}
  }
  class FakeSqliteAsyncDatabaseClient {
    public constructor(public readonly native: unknown) {}
  }
  return {
    createDatabase: vi.fn(() => ({ dialect: "sqlite" })),
    nativeClients: [] as FakeNativeClient[],
    resolve: vi.fn(() => ({ database: "goatcitadel" })),
    runMigrations: vi.fn(async () => ({ appliedVersions: [], latestVersion: 130 })),
    FakeNativeClient,
    FakePostgresAsyncDatabaseClient,
    FakeSqliteAsyncDatabaseClient,
  };
});

vi.mock("@goatcitadel/storage", () => ({
  PostgresAsyncDatabaseClient: mocks.FakePostgresAsyncDatabaseClient,
  PostgresDatabaseClient: mocks.FakeNativeClient,
  SqliteAsyncDatabaseClient: mocks.FakeSqliteAsyncDatabaseClient,
  createDatabase: mocks.createDatabase,
  runPostgresMigrations: mocks.runMigrations,
}));

vi.mock("./postgres-runtime-config.js", () => ({
  resolveGatewayPostgresConnectionOptions: mocks.resolve,
}));

import { createGatewayAsyncDatabase } from "./async-database-factory.js";

const postgresConfig = {
  dbPath: "F:\\runtime\\data\\goatcitadel.db",
  assistant: {
    database: {
      driver: "postgres",
      postgres: { migrationsTable: "schema_migrations" },
      sqlite: {},
    },
  },
} as GatewayRuntimeConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nativeClients.length = 0;
});

describe("createGatewayAsyncDatabase", () => {
  it("runs migrations with the native async PostgreSQL client and never needs the sync worker", async () => {
    const db = await createGatewayAsyncDatabase(postgresConfig);

    expect(db).toBeInstanceOf(mocks.FakePostgresAsyncDatabaseClient);
    expect(mocks.nativeClients).toHaveLength(1);
    expect(mocks.nativeClients[0]?.input).toEqual({ migrationsTable: "schema_migrations" });
    expect(mocks.runMigrations).toHaveBeenCalledWith(mocks.nativeClients[0]);
  });

  it("closes the native pool if async migrations fail", async () => {
    const migrationError = new Error("async migration failed");
    mocks.runMigrations.mockRejectedValueOnce(migrationError);

    await expect(createGatewayAsyncDatabase(postgresConfig)).rejects.toThrow(migrationError);
    expect(mocks.nativeClients[0]?.close).toHaveBeenCalledOnce();
  });

  it("adapts SQLite through resolved Promises", async () => {
    const sqliteConfig = structuredClone(postgresConfig);
    sqliteConfig.assistant.database.driver = "sqlite";

    const db = await createGatewayAsyncDatabase(sqliteConfig);

    expect(db).toBeInstanceOf(mocks.FakeSqliteAsyncDatabaseClient);
    expect(mocks.createDatabase).toHaveBeenCalledWith({
      dbPath: postgresConfig.dbPath,
      tuning: sqliteConfig.assistant.database.sqlite,
    });
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });
});
