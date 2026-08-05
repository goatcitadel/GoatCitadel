import path from "node:path";
import {
  Storage,
  createLocalAsyncStorage,
  createPostgresRemoteStorage,
  createPostgresSyncCompatibilityStorage,
  type AsyncStorage,
  type PostgresSyncWaitDiagnostic,
} from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "./config.js";
import { resolveGatewayPostgresConnectionOptions } from "./postgres-runtime-config.js";

export interface CreateGatewayStorageOptions {
  onPostgresSyncWait?: (diagnostic: PostgresSyncWaitDiagnostic) => void;
}

const POSTGRES_STARTUP_MIGRATION_WAIT_TIMEOUT_MS = 180_000;

/**
 * Construct the one Promise-based storage boundary used by every Gateway
 * runtime. PostgreSQL defaults to the worker-owned remote facade so database
 * waits cannot block the Gateway event loop. The disabled flag retains one
 * release of package-owned synchronous compatibility without importing the
 * sync client into apps/gateway.
 */
export function createGatewayStorage(
  config: GatewayRuntimeConfig,
  options: CreateGatewayStorageOptions = {},
): AsyncStorage {
  const transcriptsDir = path.resolve(config.rootDir, config.assistant.transcriptsDir);
  const auditDir = path.resolve(config.rootDir, config.assistant.auditDir);

  if (config.assistant.database.driver === "postgres") {
    const connection = resolveGatewayPostgresConnectionOptions(config, {
      applicationName: config.assistant.database.postgres.asyncGatewayEnabled
        ? "goatcitadel-gateway-async"
        : "goatcitadel-gateway-sync-rollback",
    });
    if (config.assistant.database.postgres.asyncGatewayEnabled) {
      return createPostgresRemoteStorage({
        connection,
        migrationsTable: config.assistant.database.postgres.migrationsTable,
        transcriptsDir,
        auditDir,
        startupWaitTimeoutMs: POSTGRES_STARTUP_MIGRATION_WAIT_TIMEOUT_MS,
      });
    }

    return createLocalAsyncStorage(
      createPostgresSyncCompatibilityStorage({
        connection,
        migrationsTable: config.assistant.database.postgres.migrationsTable,
        transcriptsDir,
        auditDir,
        onWait: options.onPostgresSyncWait,
      }),
    );
  }

  return createLocalAsyncStorage(
    new Storage({
      dbPath: config.dbPath,
      transcriptsDir,
      auditDir,
      tuning: config.assistant.database.sqlite,
    }),
  );
}
