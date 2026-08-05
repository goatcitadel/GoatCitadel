import { Storage } from "../index.js";
import type { DatabaseClient } from "../db.js";
import type { PostgresConnectionOptions } from "./client.js";
import { applyPostgresMigrationsSync } from "./migrator.js";
import {
  PostgresSyncDatabaseClient,
  type PostgresSyncDatabaseClientObservability,
  type PostgresSyncWaitDiagnostic,
} from "./sync.js";

const POSTGRES_STARTUP_MIGRATION_WAIT_TIMEOUT_MS = 180_000;

export interface CreatePostgresSyncCompatibilityStorageOptions {
  connection: PostgresConnectionOptions;
  migrationsTable: string;
  transcriptsDir: string;
  auditDir: string;
  onWait?: (diagnostic: PostgresSyncWaitDiagnostic) => void;
}

export interface PostgresSyncCompatibilityStorageDependencies {
  createDatabaseClient(
    connection: PostgresConnectionOptions,
    observability: PostgresSyncDatabaseClientObservability,
  ): DatabaseClient;
  applyMigrations(db: DatabaseClient, options: { migrationsTable: string }): void;
  createStorage(options: { db: DatabaseClient; transcriptsDir: string; auditDir: string }): Storage;
}

const defaultDependencies: PostgresSyncCompatibilityStorageDependencies = {
  createDatabaseClient: (connection, observability) => new PostgresSyncDatabaseClient(connection, observability),
  applyMigrations: (db, options) => applyPostgresMigrationsSync(db, options),
  createStorage: (options) => new Storage(options),
};

/**
 * Package-owned construction for the one-release synchronous PostgreSQL
 * rollback boundary. Runtime applications must not import or instantiate the
 * synchronous database client themselves.
 */
export function createPostgresSyncCompatibilityStorage(
  options: CreatePostgresSyncCompatibilityStorageOptions,
  dependencies: PostgresSyncCompatibilityStorageDependencies = defaultDependencies,
): Storage {
  const migrationDb = dependencies.createDatabaseClient(
    { ...options.connection, applicationName: "goatcitadel-gateway-migrations" },
    {
      onWait: options.onWait,
      waitTimeoutMs: POSTGRES_STARTUP_MIGRATION_WAIT_TIMEOUT_MS,
    },
  );
  try {
    dependencies.applyMigrations(migrationDb, { migrationsTable: options.migrationsTable });
  } catch (error) {
    throw closePreservingFailure(migrationDb, error, "PostgreSQL migration storage cleanup failed");
  }
  migrationDb.close();

  const db = dependencies.createDatabaseClient(options.connection, { onWait: options.onWait });
  try {
    return dependencies.createStorage({
      db,
      transcriptsDir: options.transcriptsDir,
      auditDir: options.auditDir,
    });
  } catch (error) {
    throw closePreservingFailure(db, error, "PostgreSQL runtime storage cleanup failed");
  }
}

function closePreservingFailure(db: DatabaseClient, failure: unknown, message: string): unknown {
  try {
    db.close();
    return failure;
  } catch (cleanupError) {
    return new AggregateError([failure, cleanupError], message, { cause: failure });
  }
}

export const __postgresSyncCompatibilityStorageInternals = {
  POSTGRES_STARTUP_MIGRATION_WAIT_TIMEOUT_MS,
};
