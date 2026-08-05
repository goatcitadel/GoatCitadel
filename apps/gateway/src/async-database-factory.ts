import {
  PostgresAsyncDatabaseClient,
  PostgresDatabaseClient,
  SqliteAsyncDatabaseClient,
  createDatabase,
  runPostgresMigrations,
  type AsyncDatabaseClient,
} from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "./config.js";
import { resolveGatewayPostgresConnectionOptions } from "./postgres-runtime-config.js";

/**
 * Construct the native Promise-backed database boundary used by staged async
 * repository conversions. This deliberately never imports or constructs the
 * PostgreSQL sync worker.
 */
export async function createGatewayAsyncDatabase(config: GatewayRuntimeConfig): Promise<AsyncDatabaseClient> {
  if (config.assistant.database.driver === "sqlite") {
    return new SqliteAsyncDatabaseClient(
      createDatabase({
        dbPath: config.dbPath,
        tuning: config.assistant.database.sqlite,
      }),
    );
  }

  const nativeClient = new PostgresDatabaseClient(
    resolveGatewayPostgresConnectionOptions(config, {
      applicationName: "goatcitadel-gateway-async",
    }),
    { migrationsTable: config.assistant.database.postgres.migrationsTable },
  );
  try {
    await runPostgresMigrations(nativeClient);
    return new PostgresAsyncDatabaseClient(nativeClient);
  } catch (error) {
    try {
      await nativeClient.close();
    } catch {
      // Preserve the actionable migration/startup error.
    }
    throw error;
  }
}
