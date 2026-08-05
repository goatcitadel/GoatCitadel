import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRuntimeConfig } from "./config.js";

const mocks = vi.hoisted(() => {
  class FakeStorage {
    public constructor(public readonly input: Record<string, unknown>) {
      mocks.sqliteStorageInputs.push(input);
    }
  }

  return {
    connectionOptions: { database: "goatcitadel" },
    createLocalAsyncStorage: vi.fn((storage: unknown) => ({ kind: "local", storage })),
    createPostgresRemoteStorage: vi.fn((input: unknown) => ({ kind: "remote", input })),
    createPostgresSyncCompatibilityStorage: vi.fn((input: unknown) => ({ kind: "sync-compat", input })),
    resolveGatewayPostgresConnectionOptions: vi.fn(),
    sqliteStorageInputs: [] as Array<Record<string, unknown>>,
    FakeStorage,
  };
});

vi.mock("@goatcitadel/storage", () => ({
  Storage: mocks.FakeStorage,
  createLocalAsyncStorage: mocks.createLocalAsyncStorage,
  createPostgresRemoteStorage: mocks.createPostgresRemoteStorage,
  createPostgresSyncCompatibilityStorage: mocks.createPostgresSyncCompatibilityStorage,
}));

vi.mock("./postgres-runtime-config.js", () => ({
  resolveGatewayPostgresConnectionOptions: mocks.resolveGatewayPostgresConnectionOptions,
}));

import { createGatewayStorage } from "./storage-factory.js";

const postgresConfig = {
  rootDir: "C:\\goatcitadel-runtime",
  dbPath: "C:\\goatcitadel-runtime\\data\\goatcitadel.db",
  assistant: {
    transcriptsDir: "data/transcripts",
    auditDir: "data/audit",
    database: {
      driver: "postgres",
      sqlite: {},
      postgres: { migrationsTable: "schema_migrations", asyncGatewayEnabled: true },
    },
  },
} as GatewayRuntimeConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sqliteStorageInputs.length = 0;
  mocks.resolveGatewayPostgresConnectionOptions.mockReturnValue(mocks.connectionOptions);
});

describe("createGatewayStorage", () => {
  it("uses worker-owned async PostgreSQL storage by default", () => {
    const storage = createGatewayStorage(postgresConfig);

    expect(storage).toMatchObject({ kind: "remote" });
    expect(mocks.resolveGatewayPostgresConnectionOptions).toHaveBeenCalledWith(postgresConfig, {
      applicationName: "goatcitadel-gateway-async",
    });
    expect(mocks.createPostgresRemoteStorage).toHaveBeenCalledWith({
      connection: mocks.connectionOptions,
      migrationsTable: "schema_migrations",
      transcriptsDir: path.resolve(postgresConfig.rootDir, "data/transcripts"),
      auditDir: path.resolve(postgresConfig.rootDir, "data/audit"),
      startupWaitTimeoutMs: 180_000,
    });
    expect(mocks.createPostgresSyncCompatibilityStorage).not.toHaveBeenCalled();
    expect(mocks.createLocalAsyncStorage).not.toHaveBeenCalled();
  });

  it("keeps the explicit one-release PostgreSQL rollback path package-owned", () => {
    const rollbackConfig = structuredClone(postgresConfig);
    rollbackConfig.assistant.database.postgres.asyncGatewayEnabled = false;
    const onWait = vi.fn();

    const storage = createGatewayStorage(rollbackConfig, { onPostgresSyncWait: onWait });

    expect(storage).toMatchObject({ kind: "local" });
    expect(mocks.resolveGatewayPostgresConnectionOptions).toHaveBeenCalledWith(rollbackConfig, {
      applicationName: "goatcitadel-gateway-sync-rollback",
    });
    expect(mocks.createPostgresSyncCompatibilityStorage).toHaveBeenCalledWith({
      connection: mocks.connectionOptions,
      migrationsTable: "schema_migrations",
      transcriptsDir: path.resolve(rollbackConfig.rootDir, "data/transcripts"),
      auditDir: path.resolve(rollbackConfig.rootDir, "data/audit"),
      onWait,
    });
    expect(mocks.createPostgresRemoteStorage).not.toHaveBeenCalled();
    expect(mocks.createLocalAsyncStorage).toHaveBeenCalledWith(expect.objectContaining({ kind: "sync-compat" }));
  });

  it("adapts SQLite storage to the same Promise-only boundary", () => {
    const sqliteConfig = structuredClone(postgresConfig);
    sqliteConfig.assistant.database.driver = "sqlite";

    const storage = createGatewayStorage(sqliteConfig);

    expect(storage).toMatchObject({ kind: "local" });
    expect(mocks.sqliteStorageInputs).toEqual([
      {
        dbPath: sqliteConfig.dbPath,
        transcriptsDir: path.resolve(sqliteConfig.rootDir, "data/transcripts"),
        auditDir: path.resolve(sqliteConfig.rootDir, "data/audit"),
        tuning: sqliteConfig.assistant.database.sqlite,
      },
    ]);
    expect(mocks.resolveGatewayPostgresConnectionOptions).not.toHaveBeenCalled();
    expect(mocks.createPostgresRemoteStorage).not.toHaveBeenCalled();
  });
});
