import type { PostgresConnectionOptions } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "./config.js";

export interface GatewayPostgresResolveOptions {
  applicationName?: string;
  connectionStringOverride?: string;
  databaseOverride?: string;
}

export function isBundledPostgresMode(config: GatewayRuntimeConfig): boolean {
  return (
    config.assistant.database.driver === "postgres" &&
    config.assistant.database.postgres.mode === "bundled" &&
    config.assistant.database.bundledPostgres.enabled
  );
}

export function resolveGatewayPostgresConnectionOptions(
  config: GatewayRuntimeConfig,
  options: GatewayPostgresResolveOptions = {},
): PostgresConnectionOptions {
  const postgres = config.assistant.database.postgres;
  const connectionString =
    options.connectionStringOverride?.trim() ||
    postgres.connectionString?.trim() ||
    readNamedEnv(postgres.connectionStringEnv);
  const bundledMode = isBundledPostgresMode(config);
  const host = postgres.host?.trim() || (bundledMode && !connectionString ? "127.0.0.1" : undefined);
  const port =
    host && bundledMode && !postgres.host?.trim() ? config.assistant.database.bundledPostgres.port : postgres.port;
  const database = options.databaseOverride?.trim() || postgres.database || "goatcitadel";
  const user = postgres.user?.trim() || (bundledMode && !connectionString ? "postgres" : undefined);
  const password = postgres.password ?? readNamedEnv(postgres.passwordEnv);

  return {
    connectionString: connectionString || undefined,
    host,
    port,
    database,
    user,
    password,
    sslMode: postgres.ssl,
    applicationName: options.applicationName ?? "goatcitadel-gateway",
    pool: {
      min: postgres.pool.min,
      max: postgres.pool.max,
      idleTimeoutMs: postgres.pool.idleTimeoutMs,
      connectionTimeoutMs: postgres.pool.connectionTimeoutMs,
    },
  };
}

export function resolveGatewayPostgresConnectionString(
  config: GatewayRuntimeConfig,
  options: Omit<GatewayPostgresResolveOptions, "applicationName"> = {},
): string | undefined {
  const resolved = resolveGatewayPostgresConnectionOptions(config, options);
  if (resolved.connectionString?.trim()) {
    return resolved.connectionString.trim();
  }
  if (!resolved.host || !resolved.database) {
    return undefined;
  }
  const auth = resolved.user
    ? `${encodeURIComponent(resolved.user)}${resolved.password ? `:${encodeURIComponent(resolved.password)}` : ""}@`
    : "";
  return `postgresql://${auth}${resolved.host}:${resolved.port ?? 5432}/${resolved.database}`;
}

function readNamedEnv(name: string | undefined): string | undefined {
  if (!name?.trim()) {
    return undefined;
  }
  return process.env[name.trim()]?.trim() || undefined;
}
