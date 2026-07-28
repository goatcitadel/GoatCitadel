import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRuntimeConfig } from "./config.js";

const mocks = vi.hoisted(() => {
  class FakePostgresSyncDatabaseClient {
    public close(): void {
      mocks.closeCalls += 1;
      if (mocks.closeError) {
        throw mocks.closeError;
      }
    }
  }

  class FakeStorage {
    public constructor(public readonly input: Record<string, unknown>) {
      mocks.storageInputs.push(input);
      if (mocks.storageError) {
        throw mocks.storageError;
      }
    }
  }

  return {
    applyPostgresMigrationsSync: vi.fn(),
    closeCalls: 0,
    closeError: undefined as Error | undefined,
    connectionOptions: { database: "goatcitadel" },
    resolveGatewayPostgresConnectionOptions: vi.fn(),
    storageError: undefined as Error | undefined,
    storageInputs: [] as Array<Record<string, unknown>>,
    FakePostgresSyncDatabaseClient,
    FakeStorage,
  };
});

vi.mock("@goatcitadel/storage", () => ({
  applyPostgresMigrationsSync: mocks.applyPostgresMigrationsSync,
  PostgresSyncDatabaseClient: mocks.FakePostgresSyncDatabaseClient,
  Storage: mocks.FakeStorage,
}));

vi.mock("./postgres-runtime-config.js", () => ({
  resolveGatewayPostgresConnectionOptions: mocks.resolveGatewayPostgresConnectionOptions,
}));

import { createGatewayStorage } from "./storage-factory.js";

const config = {
  rootDir: "C:\\goatcitadel-runtime",
  assistant: {
    transcriptsDir: "data/transcripts",
    auditDir: "data/audit",
    database: {
      driver: "postgres",
      postgres: { migrationsTable: "schema_migrations" },
    },
  },
} as GatewayRuntimeConfig;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyPostgresMigrationsSync.mockReset();
  mocks.closeCalls = 0;
  mocks.closeError = undefined;
  mocks.storageError = undefined;
  mocks.storageInputs.length = 0;
  mocks.resolveGatewayPostgresConnectionOptions.mockReturnValue(mocks.connectionOptions);
});

describe("createGatewayStorage", () => {
  it("closes the Postgres worker and rethrows the original migration error", () => {
    const migrationError = new Error("migration ledger mismatch");
    mocks.applyPostgresMigrationsSync.mockImplementation(() => {
      throw migrationError;
    });

    expect(() => createGatewayStorage(config)).toThrow(migrationError);
    expect(mocks.closeCalls).toBe(1);
    expect(mocks.storageInputs).toEqual([]);
  });

  it("does not let a cleanup error mask the original migration error", () => {
    const migrationError = new Error("migration ledger mismatch");
    mocks.closeError = new Error("worker close failed");
    mocks.applyPostgresMigrationsSync.mockImplementation(() => {
      throw migrationError;
    });

    expect(() => createGatewayStorage(config)).toThrow(migrationError);
    expect(mocks.closeCalls).toBe(1);
  });

  it("closes the Postgres worker when Storage construction fails before ownership transfer", () => {
    const storageError = new Error("storage construction failed");
    mocks.storageError = storageError;

    expect(() => createGatewayStorage(config)).toThrow(storageError);
    expect(mocks.closeCalls).toBe(1);
    expect(mocks.storageInputs).toHaveLength(1);
  });

  it("hands the live Postgres client to Storage without closing it after successful migrations", () => {
    const storage = createGatewayStorage(config) as unknown as InstanceType<typeof mocks.FakeStorage>;

    expect(storage).toBeInstanceOf(mocks.FakeStorage);
    expect(mocks.closeCalls).toBe(0);
    expect(mocks.storageInputs).toHaveLength(1);
    expect(mocks.storageInputs[0]).toMatchObject({
      db: expect.any(mocks.FakePostgresSyncDatabaseClient),
      transcriptsDir: expect.stringContaining("data\\transcripts"),
      auditDir: expect.stringContaining("data\\audit"),
    });
  });
});
