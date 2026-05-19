import fs from "node:fs";
import path from "node:path";
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

// SECURITY (codex finding #2): When running against the bundled Postgres,
// resolve the per-install superuser password from
// `data/secrets/postgres-bundled-password` (kept in sync by
// `ensureBundledPostgresPassword` in bundled-postgres-runtime.ts). This is
// read-only sync so the function can stay synchronous; the password file
// is tiny and only read at process startup / pool creation.
function readBundledPostgresPasswordSync(config: GatewayRuntimeConfig): string | undefined {
  if (!isBundledPostgresMode(config)) {
    return undefined;
  }
  try {
    const filePath = path.resolve(config.rootDir, "data/secrets/postgres-bundled-password");
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return raw.length >= 16 ? raw : undefined;
  } catch {
    return undefined;
  }
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
  const bundledPassword = bundledMode && !connectionString ? readBundledPostgresPasswordSync(config) : undefined;
  const password = postgres.password ?? readNamedEnv(postgres.passwordEnv) ?? bundledPassword;

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
