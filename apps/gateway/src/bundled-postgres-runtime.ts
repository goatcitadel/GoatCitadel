import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PostgresDatabaseClient } from "@goatcitadel/storage";
import type { GatewayRuntimeConfig } from "./config.js";
import { isBundledPostgresMode, resolveGatewayPostgresConnectionOptions } from "./postgres-runtime-config.js";

export const POSTGRES_IMAGE = "postgres:16-alpine";
const READY_POLL_MS = 500;

export interface BundledPostgresRuntimeHandle {
  readonly strategy: "native" | "docker";
  stop(): Promise<void>;
}

export async function ensureBundledPostgresRuntime(
  config: GatewayRuntimeConfig,
): Promise<BundledPostgresRuntimeHandle | undefined> {
  if (!isBundledPostgresMode(config)) {
    return undefined;
  }

  const maintenanceOptions = resolveGatewayPostgresConnectionOptions(config, {
    applicationName: "goatcitadel-bundled-probe",
    databaseOverride: "postgres",
  });
  const probe = await probeBundledPostgresRuntime(config, maintenanceOptions);
  if (probe.matchesExpectedRoot) {
    await ensureDatabaseExists(config);
    return undefined;
  }
  if (probe.reachable) {
    throw new Error(
      `Bundled Postgres port ${config.assistant.database.bundledPostgres.port} is reachable but does not belong to this runtime root. Expected dataDir ${path.resolve(
        config.rootDir,
        config.assistant.database.bundledPostgres.dataDir,
      )}; observed ${probe.dataDirectory ?? "unknown"}. Stop the other Postgres runtime or configure a different bundledPostgres.port.`,
    );
  }

  if (!config.assistant.database.bundledPostgres.autoStart) {
    throw new Error("Bundled Postgres is configured but not reachable, and autoStart is disabled.");
  }

  const nativeRuntime = await tryStartNativeBundledPostgres(config);
  if (nativeRuntime) {
    await waitForBundledPostgres(config);
    await ensureDatabaseExists(config);
    return nativeRuntime;
  }

  const dockerRuntime = await tryStartDockerBundledPostgres(config);
  if (dockerRuntime) {
    await waitForBundledPostgres(config);
    await ensureDatabaseExists(config);
    return dockerRuntime;
  }

  throw new Error(
    "Bundled Postgres is enabled but no managed runtime backend is available. Configure assistant.database.bundledPostgres.binDir with Postgres binaries or start Docker Desktop.",
  );
}

async function tryStartNativeBundledPostgres(
  config: GatewayRuntimeConfig,
): Promise<BundledPostgresRuntimeHandle | undefined> {
  const commands = resolveNativePostgresCommands(config);
  if (!commands) {
    return undefined;
  }

  const dataDir = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  const initialized = fsSync.existsSync(path.join(dataDir, "PG_VERSION"));
  if (!initialized) {
    execFileSync(commands.initdb, ["-D", dataDir, "-U", "postgres", "-A", "trust", "--encoding", "UTF8"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  // Keep the native Postgres log outside PGDATA on Windows. When the log file
  // lives inside the cluster directory, crash recovery can hit sharing
  // violations while syncing the data directory if indexing, antivirus, or
  // backup software touches that file mid-startup.
  const logFile = path.resolve(config.rootDir, config.assistant.dataDir, "logs", "goatcitadel-postgres.log");
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  try {
    execFileSync(
      commands.pgCtl,
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "start",
        "-o",
        `-h 127.0.0.1 -p ${config.assistant.database.bundledPostgres.port}`,
      ],
      {
        encoding: "utf8",
        stdio: "ignore",
      },
    );
  } catch (error) {
    if (
      !(await canReachExpectedBundledPostgres(
        config,
        resolveGatewayPostgresConnectionOptions(config, {
          applicationName: "goatcitadel-bundled-native-fallback",
          databaseOverride: "postgres",
        }),
      ))
    ) {
      throw error;
    }
  }

  return {
    strategy: "native",
    stop: async () => {
      try {
        execFileSync(commands.pgCtl, ["-D", dataDir, "-w", "stop", "-m", "fast"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        // Ignore stop failures during shutdown.
      }
    },
  };
}

async function tryStartDockerBundledPostgres(
  config: GatewayRuntimeConfig,
): Promise<BundledPostgresRuntimeHandle | undefined> {
  if (!canUseDocker()) {
    return undefined;
  }

  const containerName = buildBundledDockerContainerName(config.rootDir);
  const dataDir = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  await fs.mkdir(dataDir, { recursive: true });

  const state = inspectDockerContainerState(containerName);
  if (state === "running") {
    return undefined;
  }

  if (state === "stopped") {
    execFileSync("docker", ["start", containerName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      strategy: "docker",
      stop: async () => {
        try {
          execFileSync("docker", ["stop", containerName], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          // Ignore stop failures during shutdown.
        }
      },
    };
  }

  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      containerName,
      "--publish",
      `${config.assistant.database.bundledPostgres.port}:5432`,
      "--volume",
      `${dataDir}:/var/lib/postgresql/data`,
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "--env",
      "POSTGRES_DB=postgres",
      POSTGRES_IMAGE,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  return {
    strategy: "docker",
    stop: async () => {
      try {
        execFileSync("docker", ["stop", containerName], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        // Ignore stop failures during shutdown.
      }
    },
  };
}

async function waitForBundledPostgres(config: GatewayRuntimeConfig): Promise<void> {
  const timeoutMs = config.assistant.database.bundledPostgres.startTimeoutMs;
  const startedAt = Date.now();
  const options = resolveGatewayPostgresConnectionOptions(config, {
    applicationName: "goatcitadel-bundled-wait",
    databaseOverride: "postgres",
  });

  while (Date.now() - startedAt < timeoutMs) {
    if (await canReachExpectedBundledPostgres(config, options)) {
      return;
    }
    await wait(READY_POLL_MS);
  }

  throw new Error(`Bundled Postgres did not become reachable within ${timeoutMs}ms.`);
}

async function ensureDatabaseExists(config: GatewayRuntimeConfig): Promise<void> {
  const targetDatabase = resolveGatewayPostgresConnectionOptions(config).database;
  if (!targetDatabase || targetDatabase === "postgres") {
    return;
  }

  const maintenance = new PostgresDatabaseClient(
    resolveGatewayPostgresConnectionOptions(config, {
      applicationName: "goatcitadel-bundled-maintenance",
      databaseOverride: "postgres",
    }),
  );
  try {
    const existing = await maintenance.queryOne<{ present: number }>(
      "SELECT 1 AS present FROM pg_database WHERE datname = $1",
      [targetDatabase],
    );
    if (existing?.present === 1) {
      return;
    }
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(targetDatabase)}`);
  } finally {
    await maintenance.close();
  }
}

function resolveNativePostgresCommands(config: GatewayRuntimeConfig): { initdb: string; pgCtl: string } | undefined {
  const configuredBinDir = config.assistant.database.bundledPostgres.binDir?.trim();
  if (!configuredBinDir) {
    return undefined;
  }
  const binDir = path.isAbsolute(configuredBinDir) ? configuredBinDir : path.resolve(config.rootDir, configuredBinDir);
  const exe = process.platform === "win32" ? ".exe" : "";
  const initdb = path.join(binDir, `initdb${exe}`);
  const pgCtl = path.join(binDir, `pg_ctl${exe}`);
  if (!fsSync.existsSync(initdb) || !fsSync.existsSync(pgCtl)) {
    return undefined;
  }
  return { initdb, pgCtl };
}

async function canReachExpectedBundledPostgres(
  config: GatewayRuntimeConfig,
  options: ReturnType<typeof resolveGatewayPostgresConnectionOptions>,
): Promise<boolean> {
  return (await probeBundledPostgresRuntime(config, options)).matchesExpectedRoot;
}

async function probeBundledPostgresRuntime(
  config: GatewayRuntimeConfig,
  options: ReturnType<typeof resolveGatewayPostgresConnectionOptions>,
): Promise<{ reachable: boolean; matchesExpectedRoot: boolean; dataDirectory?: string }> {
  const client = new PostgresDatabaseClient(options);
  try {
    const row = await client.queryOne<{ data_directory: string }>("SHOW data_directory");
    const dataDirectory = row?.data_directory;
    return {
      reachable: true,
      matchesExpectedRoot: dataDirectory ? isExpectedBundledDataDirectory(config, dataDirectory) : false,
      dataDirectory,
    };
  } catch {
    return { reachable: false, matchesExpectedRoot: false };
  } finally {
    await client.close();
  }
}

function isExpectedBundledDataDirectory(config: GatewayRuntimeConfig, actualDataDirectory: string): boolean {
  const expectedNative = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  if (sameFilesystemPath(actualDataDirectory, expectedNative)) {
    return true;
  }
  if (!isDockerPostgresDataDirectory(actualDataDirectory)) {
    return false;
  }
  return inspectDockerContainerState(buildBundledDockerContainerName(config.rootDir)) === "running";
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = path.normalize(value.trim());
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function isDockerPostgresDataDirectory(actualDataDirectory: string): boolean {
  return actualDataDirectory.trim().replaceAll("\\", "/").replace(/\/+$/, "") === "/var/lib/postgresql/data";
}

function canUseDocker(): boolean {
  try {
    execFileSync("docker", ["info"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function inspectDockerContainerState(containerName: string): "missing" | "running" | "stopped" {
  try {
    const output = execFileSync(
      "docker",
      ["ps", "--all", "--filter", `name=^/${containerName}$`, "--format", "{{.State}}"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .trim()
      .toLowerCase();
    if (!output) {
      return "missing";
    }
    if (output.includes("running")) {
      return "running";
    }
    return "stopped";
  } catch {
    return "missing";
  }
}

export function buildBundledDockerContainerName(rootDir: string): string {
  const hash = createHash("sha1").update(rootDir).digest("hex").slice(0, 10);
  const hostname = os
    .hostname()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `goatcitadel-postgres-${hostname || "local"}-${hash}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}
