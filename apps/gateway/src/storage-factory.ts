import path from "node:path";
import { Storage, PostgresSyncDatabaseClient, applyPostgresMigrationsSync } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "./config.js";
import { resolveGatewayPostgresConnectionOptions } from "./postgres-runtime-config.js";

export function createGatewayStorage(config: GatewayRuntimeConfig): Storage {
  if (config.assistant.database.driver === "postgres") {
    const db = new PostgresSyncDatabaseClient(
      resolveGatewayPostgresConnectionOptions(config, {
        applicationName: "goatcitadel-gateway",
      }),
    );
    try {
      applyPostgresMigrationsSync(db, {
        migrationsTable: config.assistant.database.postgres.migrationsTable,
      });
      return new Storage({
        db,
        transcriptsDir: path.resolve(config.rootDir, config.assistant.transcriptsDir),
        auditDir: path.resolve(config.rootDir, config.assistant.auditDir),
      });
    } catch (error) {
      try {
        db.close();
      } catch (cleanupError) {
        // Preserve the actionable migration/startup error. PostgresSyncDatabaseClient.close()
        // retires its worker in a finally block even when the close request itself fails.
        void cleanupError;
      }
      throw error;
    }
  }

  return new Storage({
    dbPath: config.dbPath,
    transcriptsDir: path.resolve(config.rootDir, config.assistant.transcriptsDir),
    auditDir: path.resolve(config.rootDir, config.assistant.auditDir),
    tuning: config.assistant.database.sqlite,
  });
}
