import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PostgresDatabaseClient } from "@goatcitadel/storage";
import { setBootCheckpoint } from "./boot-tracker.js";
import type { GatewayRuntimeConfig } from "./config.js";
import { isBundledPostgresMode, resolveGatewayPostgresConnectionOptions } from "./postgres-runtime-config.js";

export const POSTGRES_IMAGE = "postgres:16-alpine";
const READY_POLL_MS = 500;
// SECURITY (codex finding #2): Path (relative to gateway rootDir) where the
// generated bundled-Postgres superuser password is persisted. File is
// written with mode 0o600. Existing data directories that were initialised
// with trust auth before this change keep trust auth (the postgres image
// only honours POSTGRES_HOST_AUTH_METHOD when a fresh data directory is
// initialised) — the password file is still resolved and passed in the
// connection string but trust auth ignores it harmlessly.
const BUNDLED_POSTGRES_PASSWORD_FILE = "data/secrets/postgres-bundled-password";

export function bundledPostgresPasswordFilePath(config: GatewayRuntimeConfig): string {
  return path.resolve(config.rootDir, BUNDLED_POSTGRES_PASSWORD_FILE);
}

export async function readBundledPostgresPassword(config: GatewayRuntimeConfig): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(bundledPostgresPasswordFilePath(config), "utf8");
    const trimmed = raw.trim();
    return trimmed.length >= 16 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function ensureBundledPostgresPassword(config: GatewayRuntimeConfig): Promise<string> {
  const existing = await readBundledPostgresPassword(config);
  if (existing) {
    return existing;
  }
  const password = randomBytes(24).toString("base64url");
  const filePath = bundledPostgresPasswordFilePath(config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Write with mode 0o600 — read-only for owner, no access for group/other.
  // On Windows the chmod is best-effort, but the file lives under
  // `data/secrets/` which the operator should already restrict at the OS
  // level for the gateway's runtime account.
  await fs.writeFile(filePath, password, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Windows / fs without chmod support — best-effort only.
  }
  return password;
}

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

  setBootCheckpoint("bundled-pg:probe-starting");
  const maintenanceOptions = resolveGatewayPostgresConnectionOptions(config, {
    applicationName: "goatcitadel-bundled-probe",
    databaseOverride: "postgres",
  });
  const probe = await probeBundledPostgresRuntime(config, maintenanceOptions);
  process.stderr.write(
    `[boot-tracker] probe result reachable=${probe.reachable} matchesExpectedRoot=${probe.matchesExpectedRoot} dataDirectory=${JSON.stringify(probe.dataDirectory)}\n`,
  );
  setBootCheckpoint("bundled-pg:probe-returned");
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

  // SECURITY (codex finding #3): If an operator explicitly configured a
  // native bundled Postgres (via `assistant.database.bundledPostgres.binDir`)
  // and that startup fails, we must NOT silently fall back to the Docker
  // backend. Native bound 127.0.0.1 by design; the Docker backend
  // (`--publish ${port}:5432`, `trust` auth) used to bind all interfaces
  // and accepted unauthenticated connections — that's a security-posture
  // downgrade that should never happen behind the operator's back. Fail
  // closed instead and surface the native error.
  const nativeConfigured = isNativeBundledPostgresConfigured(config);
  setBootCheckpoint(`bundled-pg:try-native-start (nativeConfigured=${nativeConfigured})`);
  try {
    const nativeRuntime = await tryStartNativeBundledPostgres(config);
    setBootCheckpoint(`bundled-pg:try-native-returned (got-runtime=${Boolean(nativeRuntime)})`);
    if (nativeRuntime) {
      setBootCheckpoint("bundled-pg:waitForBundledPostgres");
      await waitForBundledPostgres(config);
      setBootCheckpoint("bundled-pg:ensureDatabaseExists");
      await ensureDatabaseExists(config);
      setBootCheckpoint("bundled-pg:native-path-complete");
      return nativeRuntime;
    }
  } catch (error) {
    if (nativeConfigured) {
      throw normalizeError(error);
    }
    // Native binaries were not configured; the error here means we did
    // not even attempt native startup. Fall through to Docker as a
    // best-effort default.
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

function isNativeBundledPostgresConfigured(config: GatewayRuntimeConfig): boolean {
  return Boolean(config.assistant.database.bundledPostgres.binDir?.trim());
}

/**
 * Inspect `<dataDir>/postmaster.pid` and return the postmaster PID if (and
 * only if) it points to a process that is currently alive. Returns undefined
 * for missing file, parse failure, or stale PIDs (process gone).
 *
 * postmaster.pid's first line is the postmaster PID. We use `process.kill(pid, 0)`
 * to test liveness — that sends no signal, just probes existence:
 *   - success → process is alive (PID is real)
 *   - ESRCH    → process does not exist (stale pid file)
 *   - EPERM    → process exists but we lack permission to signal it (still alive)
 *   - anything else → treat as "unknown, assume not alive" so we fall through to pg_ctl
 *
 * This is the standard cross-platform "is process alive?" pattern; it works
 * on Windows as well as POSIX since Node maps process.kill(pid, 0) onto
 * OpenProcess + ExitCode checks under the hood.
 */
function readLivePostmasterPid(dataDir: string): number | undefined {
  let raw: string;
  try {
    raw = fsSync.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8");
  } catch {
    return undefined;
  }
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    return undefined;
  }
  const pid = Number.parseInt(firstLine, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return undefined;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      return pid;
    }
    return undefined;
  }
}

async function tryStartNativeBundledPostgres(
  config: GatewayRuntimeConfig,
): Promise<BundledPostgresRuntimeHandle | undefined> {
  setBootCheckpoint("native-pg:resolveCommands");
  const commands = resolveNativePostgresCommands(config);
  if (!commands) {
    setBootCheckpoint("native-pg:no-commands-skipping");
    return undefined;
  }

  setBootCheckpoint("native-pg:mkdir-dataDir");
  const dataDir = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  const initialized = fsSync.existsSync(path.join(dataDir, "PG_VERSION"));
  if (!initialized) {
    setBootCheckpoint("native-pg:initdb-running (SYNC)");
    execFileSync(commands.initdb, ["-D", dataDir, "-U", "postgres", "-A", "trust", "--encoding", "UTF8"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    setBootCheckpoint("native-pg:initdb-returned");
  }

  // Keep the native Postgres log outside PGDATA on Windows. When the log file
  // lives inside the cluster directory, crash recovery can hit sharing
  // violations while syncing the data directory if indexing, antivirus, or
  // backup software touches that file mid-startup.
  const logFile = path.resolve(config.rootDir, config.assistant.dataDir, "logs", "goatcitadel-postgres.log");
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  // Calling `pg_ctl start` on Windows against a data directory whose
  // postmaster.pid points to a live process causes pg_ctl to block for
  // ~120s before reporting the existing server. Skip the start call entirely
  // in that case — the existing postgres is what we want anyway, and
  // `waitForBundledPostgres` will confirm reachability with its own retry loop.
  const livePid = readLivePostmasterPid(dataDir);
  if (livePid !== undefined) {
    process.stderr.write(`[bundled-pg] postmaster.pid points to live PID ${livePid}; skipping pg_ctl start\n`);
    setBootCheckpoint("native-pg:reuse-existing-postgres");
    return {
      strategy: "native",
      // We did NOT start this postgres (it was already running when we
      // arrived), so do not stop it on shutdown — mirrors the "probe matched"
      // early-return path in ensureBundledPostgresRuntime which also doesn't
      // manage postgres lifecycle.
      stop: async () => {},
    };
  }

  setBootCheckpoint("native-pg:pg_ctl-start-running");
  try {
    // `-W` (--no-wait): pg_ctl returns immediately after spawning postgres
    // instead of waiting for postgres to become reachable. We've observed
    // pg_ctl's default `-w` wait hanging for the full 120s gateway-health
    // window on Windows even after postgres has bound the port and logged
    // "database system is ready to accept connections". The subsequent
    // `waitForBundledPostgres` poll loop is what actually validates
    // readiness via TCP and a `SHOW data_directory` query, so we don't lose
    // any reliability by skipping pg_ctl's own ping — and we cut tens of
    // seconds off cold-start dev boots.
    execFileSync(
      commands.pgCtl,
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "start",
        "-W",
        "-o",
        `-h 127.0.0.1 -p ${config.assistant.database.bundledPostgres.port}`,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    setBootCheckpoint("native-pg:pg_ctl-start-returned-ok");
  } catch (error) {
    setBootCheckpoint(
      `native-pg:pg_ctl-start-threw (msg=${error instanceof Error ? error.message.slice(0, 200).replace(/\n/g, " ") : "non-error"})`,
    );
    if (
      !(await canReachExpectedBundledPostgres(
        config,
        resolveGatewayPostgresConnectionOptions(config, {
          applicationName: "goatcitadel-bundled-native-fallback",
          databaseOverride: "postgres",
        }),
      ))
    ) {
      throw await buildNativeStartError(config, logFile, error);
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

  // SECURITY (codex finding #2): The bundled Postgres container previously
  // bound `--publish ${port}:5432`, which Docker maps to all host
  // interfaces (`0.0.0.0:${port}->5432`) by default. Combined with
  // `POSTGRES_HOST_AUTH_METHOD=trust`, this exposed an unauthenticated
  // superuser Postgres on the network.
  //
  // Two layers of mitigation now apply:
  //   1. `--publish 127.0.0.1:${port}:5432` keeps the instance off the
  //      network entirely (matches the native adapter's `-h 127.0.0.1`).
  //   2. A per-install random password (persisted under
  //      `data/secrets/postgres-bundled-password`, mode 0o600) is passed
  //      via `POSTGRES_PASSWORD` AND `POSTGRES_HOST_AUTH_METHOD=scram-sha-256`,
  //      so any local-process compromise that reaches the port still has
  //      to read the password file (which the gateway's runtime account
  //      restricts) before connecting as the postgres superuser.
  //
  // Note: the postgres image only honours `POSTGRES_HOST_AUTH_METHOD` and
  // `POSTGRES_PASSWORD` when initialising a FRESH data directory. Existing
  // dataDirs that were initialised with trust auth keep trust auth — the
  // password is harmlessly passed but ignored. Operators who want
  // scram-sha-256 on an existing cluster must recreate the data dir.
  const bundledPassword = await ensureBundledPostgresPassword(config);
  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      containerName,
      "--publish",
      `127.0.0.1:${config.assistant.database.bundledPostgres.port}:5432`,
      "--volume",
      `${dataDir}:/var/lib/postgresql/data`,
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
      "--env",
      `POSTGRES_PASSWORD=${bundledPassword}`,
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

/**
 * Probe a (potentially already-running) bundled Postgres at the configured
 * address.
 *
 * Probe errors are logged to stderr so when a transient first-attempt failure
 * later triggers the pg_ctl fallback path, the operator can see the real
 * underlying reason without rebuilding with extra diagnostics. (Historical
 * note: on Windows the very first probe in a freshly-spawned gateway process
 * occasionally fails even though postgres is healthy and listening; the
 * existing `waitForBundledPostgres` polling loop covers that case by
 * re-probing every 500ms — but only if we get to it without first blocking
 * on a synchronous pg_ctl start. See readLivePostmasterPid below for how we
 * avoid that pg_ctl-start hang when a live postgres is already present.)
 */
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
  } catch (error) {
    process.stderr.write(
      `[bundled-pg] probe failed: ${
        error instanceof Error
          ? `${error.message.split("\n")[0]} (code=${(error as NodeJS.ErrnoException).code ?? "unknown"})`
          : String(error)
      }\n`,
    );
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

async function buildNativeStartError(config: GatewayRuntimeConfig, logFile: string, error: unknown): Promise<Error> {
  const port = config.assistant.database.bundledPostgres.port;
  const messageParts = [
    `Native bundled Postgres failed to start on 127.0.0.1:${port}.`,
    extractProcessErrorDetail(error),
  ];
  const logTail = await readLogTail(logFile, 50);
  if (logTail) {
    messageParts.push(`Last lines from ${logFile}:\n${logTail}`);
  } else {
    messageParts.push(`No Postgres log output was available at ${logFile}.`);
  }
  messageParts.push(
    "Set GOATCITADEL_BUNDLED_POSTGRES_PORT to a free port and restart. On Windows, check reserved ranges with: netsh interface ipv4 show excludedportrange protocol=tcp",
  );
  const wrapped = new Error(messageParts.filter(Boolean).join("\n\n"));
  (wrapped as Error & { cause?: unknown }).cause = error;
  return wrapped;
}

function extractProcessErrorDetail(error: unknown): string | undefined {
  const candidate = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  const details = [stringifyErrorField(candidate.message)];
  const stdout = stringifyErrorField(candidate.stdout);
  const stderr = stringifyErrorField(candidate.stderr);
  if (stdout) {
    details.push(`stdout:\n${stdout}`);
  }
  if (stderr) {
    details.push(`stderr:\n${stderr}`);
  }
  return details.filter(Boolean).join("\n\n") || undefined;
}

function stringifyErrorField(value: unknown): string | undefined {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8").trim() || undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  return undefined;
}

async function readLogTail(filePath: string, maxLines: number): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n") || undefined;
  } catch {
    return undefined;
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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

export const __bundledPostgresRuntimeInternals = {
  isDockerPostgresDataDirectory,
  quoteIdentifier,
  readLogTail,
  resolveNativePostgresCommands,
  sameFilesystemPath,
};
