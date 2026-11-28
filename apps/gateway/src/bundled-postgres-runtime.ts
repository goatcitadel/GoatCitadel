/* eslint-disable max-lines -- Bundled PostgreSQL lifecycle, ownership, recovery, and cross-platform process policy stay centralized in this runtime owner. */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { PostgresDatabaseClient } from "@goatcitadel/storage";
import { isBootTrackerVerbose, setBootCheckpoint } from "./boot-tracker.js";
import type { GatewayRuntimeConfig } from "./config.js";
import {
  type NativePostgresCommands,
  discoverNativePostgresCommands,
  highestVersionedNativePostgresCommands,
  nativePostgresCommandsFromPathEnv,
  nativePostgresCommandsInBinDir,
  nativePostgresInstallRoots,
  parseNativePostgresMajor,
} from "./native-postgres-discovery.js";
import {
  AUTO_NATIVE_BIN_DIR,
  isBundledPostgresMode,
  resolveGatewayPostgresConnectionOptions,
} from "./postgres-runtime-config.js";
import { probeBundledPostgresTcpPort, tcpPortAcceptsConnections } from "./bundled-postgres-port-probe.js";
import { NonRetryableStartupError, attachOperatorSummary } from "./startup-errors.js";

export const POSTGRES_IMAGE = "postgres:16-alpine";
const READY_POLL_MS = 500;
const STARTUP_PROBE_HEARTBEAT_MS = 5_000;
const NATIVE_BACKEND_MARKER_FILENAME = ".goatcitadel-native-bundled-postgres";
const RECOVERY_POLL_MS = 3_000;
const RECOVERY_RETRY_MS = 30_000;
const RECOVERY_MAX_ATTEMPTS = 3;
const RECOVERY_START_WAIT_SECONDS = 7;
// SECURITY (codex finding #2): Path (relative to gateway rootDir) where the
// generated bundled-Postgres superuser password is persisted. File is
// written with mode 0o600. Existing data directories that were initialised
// with trust auth before this change keep trust auth (the postgres image
// only honours POSTGRES_HOST_AUTH_METHOD when a fresh data directory is
// initialised) — the password file is still resolved and passed in the
// connection string but trust auth ignores it harmlessly.
const BUNDLED_POSTGRES_PASSWORD_FILE = "data/secrets/postgres-bundled-password";

interface AwaitedProcessResult {
  stdout: string;
  stderr: string;
}

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

interface InstalledNativePostgresRecoveryAuthority {
  readonly dataDir: string;
  readonly logFile: string;
  readonly pgCtl: string;
  readonly port: number;
  readonly systemIdentifier: string;
}

interface BundledPostgresProbeResult {
  reachable: boolean;
  matchesExpectedRoot: boolean;
  dataDirectory?: string;
  failure?: string;
}

interface BundledPostgresProbeOptions {
  logFailure?: boolean;
}

interface WindowsTcpPortExclusion {
  startPort: number;
  endPort: number;
  administered: boolean;
}

interface DockerPostgresSecurityInspection {
  loopbackOnly: boolean;
  trustAuth: boolean;
  details: string[];
}

interface DockerPortBinding {
  hostIp: string;
  hostPort: string;
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
  if (isBootTrackerVerbose()) {
    process.stderr.write(
      `[boot-tracker] probe result reachable=${probe.reachable} matchesExpectedRoot=${probe.matchesExpectedRoot} dataDirectory=${JSON.stringify(probe.dataDirectory)}\n`,
    );
  }
  setBootCheckpoint("bundled-pg:probe-returned");
  if (probe.matchesExpectedRoot) {
    assertReachableBundledDockerPostgresIsHardened(config, probe.dataDirectory);
    await ensureDatabaseExists(config);
    return undefined;
  }
  if (probe.reachable) {
    throw attachOperatorSummary(
      new Error(
        `Bundled Postgres port ${config.assistant.database.bundledPostgres.port} is reachable but does not belong to this runtime root. Expected dataDir ${path.resolve(
          config.rootDir,
          config.assistant.database.bundledPostgres.dataDir,
        )}; observed ${probe.dataDirectory ?? "unknown"}. Stop the other Postgres runtime or configure a different bundledPostgres.port.`,
      ),
      bundledPostgresOperatorSummary("other_database", config.assistant.database.bundledPostgres.port),
    );
  }

  if (!config.assistant.database.bundledPostgres.autoStart) {
    throw new Error("Bundled Postgres is configured but not reachable, and autoStart is disabled.");
  }

  assertBundledPostgresPortIsUsable(config);
  await assertBundledPostgresPortIsNotHeld(config);

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
  let nativeRuntime: BundledPostgresRuntimeHandle | undefined;
  try {
    nativeRuntime = await tryStartNativeBundledPostgres(config);
    setBootCheckpoint(`bundled-pg:try-native-returned (got-runtime=${Boolean(nativeRuntime)})`);
    if (nativeRuntime) {
      try {
        setBootCheckpoint("bundled-pg:waitForBundledPostgres");
        await waitForBundledPostgres(config);
        setBootCheckpoint("bundled-pg:ensureDatabaseExists");
        await ensureDatabaseExists(config);
        setBootCheckpoint("bundled-pg:native-path-complete");
        return nativeRuntime;
      } catch (error) {
        await nativeRuntime.stop().catch(() => {
          // Startup is already failing; preserve the readiness/setup error.
        });
        throw error;
      }
    }
    if (nativeConfigured || isNativeBundledPostgresOwnedCluster(config)) {
      throw new NonRetryableStartupError(buildNativeCommandsUnavailableMessage(config));
    }
  } catch (error) {
    if (nativeConfigured || isNativeBundledPostgresOwnedCluster(config)) {
      throw normalizeError(error);
    }
    // No binDir was pinned, so native was either skipped outright or
    // auto-discovered and failed. Either way the operator did not commit to
    // the native backend, so fall through to Docker as a best-effort default.
  }

  const dockerRuntime = await tryStartDockerBundledPostgres(config);
  if (dockerRuntime) {
    await waitForBundledPostgres(config);
    await ensureDatabaseExists(config);
    return dockerRuntime;
  }

  // Neither a native binDir nor a reachable Docker daemon exists. Nothing about
  // that changes by restarting the gateway, so surface it as non-retryable and
  // let the dev supervisor stop with operator advice instead of burning its
  // restart budget on a loop that can never succeed.
  throw attachOperatorSummary(
    new NonRetryableStartupError(
      [
        "Bundled Postgres is enabled but no managed runtime backend is available.",
        "Docker is NOT required — a local PostgreSQL install is the preferred backend, but none",
        "was found on this host and the Docker fallback is unavailable too. Choose one:",
        "  1. Install PostgreSQL (the server package, which provides initdb and pg_ctl).",
        "     It is discovered automatically on PATH and in the standard install locations.",
        "  2. Point at an install in a non-standard location: set",
        "     assistant.database.bundledPostgres.binDir to the directory holding initdb and pg_ctl.",
        '  3. Use a Postgres you already run: set assistant.database.postgres.mode to "managed" and',
        "     supply connectionString (or host/port/user/password). GoatCitadel then manages no",
        "     database process at all.",
        '  4. Fall back to SQLite: set assistant.database.driver to "sqlite".',
        "  5. Or start Docker Desktop to use the containerised fallback backend.",
      ].join("\n"),
    ),
    bundledPostgresOperatorSummary("no_backend", config.assistant.database.bundledPostgres.port),
  );
}

/**
 * True only when the operator pinned an explicit binDir. Auto-discovery is
 * deliberately excluded: a pinned path is a deliberate choice that must fail
 * closed (see the security note at the call site), whereas a discovered
 * install is best-effort and may fall back to Docker.
 */
function isNativeBundledPostgresConfigured(config: GatewayRuntimeConfig): boolean {
  const binDir = config.assistant.database.bundledPostgres.binDir?.trim();
  return Boolean(binDir) && binDir !== AUTO_NATIVE_BIN_DIR;
}

// The installed launcher marks its own Windows Gateway. Monitor only an
// existing native cluster that was verified during that Gateway's startup.
export function startInstalledNativePostgresRecovery(
  config: GatewayRuntimeConfig,
  canRecover: () => boolean,
): (() => Promise<void>) | undefined {
  if (
    process.platform !== "win32" ||
    process.env.GOATCITADEL_WINDOWS_MANAGED_POSTGRES_RECOVERY !== "1" ||
    process.env.GOATCITADEL_MANAGED_SERVICE !== "gateway" ||
    !isBundledPostgresMode(config) ||
    !config.assistant.database.bundledPostgres.autoStart
  ) {
    return undefined;
  }
  const rootDir = path.resolve(config.rootDir);
  const appDir = process.env.GOATCITADEL_APP_DIR;
  if (
    !appDir ||
    !sameFilesystemPath(rootDir, path.resolve(appDir, "../runtime-root")) ||
    !sameFilesystemPath(appDir, path.resolve(rootDir, "../app"))
  ) {
    return undefined;
  }

  const database = config.assistant.database.bundledPostgres;
  const connection = resolveGatewayPostgresConnectionOptions(config);
  const dataDir = path.resolve(rootDir, database.dataDir);
  const logFile = bundledPostgresLogFilePath(config);
  if (
    connection.connectionString ||
    connection.host !== "127.0.0.1" ||
    connection.port !== database.port ||
    !isDescendantOf(rootDir, dataDir) ||
    !isDescendantOf(rootDir, logFile) ||
    !nativeBackendMarkerExists(dataDir)
  ) {
    return undefined;
  }
  const target = { dataDir, logFile, port: database.port };
  let stopped = false;
  let pending: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let authority: InstalledNativePostgresRecoveryAuthority | undefined;
  let missed = false;
  let attempts = 0;
  let retryAt = 0;

  const check = async () => {
    const postmasterState = await readRecoveryPostmasterState(target);
    if (!authority) {
      if (postmasterState === "running") {
        try {
          authority = await bindInstalledNativePostgresRecovery(config, target);
        } finally {
          // Never adopt a replacement cluster after a failed ownership check.
          if (!authority) stopped = true;
        }
      }
      return;
    }
    if (postmasterState !== "stopped" || !canRecover()) {
      missed = false;
      if (
        attempts &&
        postmasterState === "running" &&
        (await probeBundledPostgresTcpPort(authority.port)) === "accepting"
      ) {
        attempts = 0;
      }
      return;
    }
    if (!missed) {
      missed = true;
      return;
    }
    if (attempts >= RECOVERY_MAX_ATTEMPTS || Date.now() < retryAt) return;
    if (!(await verifyRecoveryCluster(authority))) return;
    if ((await probeBundledPostgresTcpPort(authority.port)) !== "refused") return;
    if ((await readRecoveryPostmasterState(authority)) !== "stopped" || stopped || !canRecover()) return;

    attempts += 1;
    retryAt = Date.now() + RECOVERY_RETRY_MS;
    process.stderr.write("[bundled-pg] Restarting the installed profile's native PostgreSQL.\n");
    try {
      await launchNativeBundledPostgres(authority, ["-w", "-t", String(RECOVERY_START_WAIT_SECONDS)]);
      process.stderr.write("[bundled-pg] The installed profile's native PostgreSQL accepted connections.\n");
    } catch (error) {
      if ((await readRecoveryPostmasterState(authority)) !== "running") throw error;
      // pg_ctl stops waiting even though the postmaster may still be replaying WAL.
      process.stderr.write("[bundled-pg] The installed profile's native PostgreSQL is still starting.\n");
    }
  };

  function schedule(delayMs: number): void {
    timer = setTimeout(() => {
      pending = check()
        .catch(() => {
          process.stderr.write(
            "[bundled-pg] The installed profile's native PostgreSQL recovery check failed. Check the PostgreSQL log.\n",
          );
        })
        .finally(() => {
          pending = undefined;
          if (!stopped) schedule(RECOVERY_POLL_MS);
        });
    }, delayMs);
    timer.unref();
  }

  schedule(0);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}

function isDescendantOf(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readRecoveryPostmasterState({
  dataDir,
  port,
}: {
  dataDir: string;
  port: number;
}): Promise<"running" | "stopped" | "unknown"> {
  const pidFile = path.join(dataDir, "postmaster.pid");
  const stat = await lstatIfPresent(pidFile);
  if (!stat) return "stopped";
  if (!stat.isFile() || stat.size > 4_096) return "unknown";
  const [pidText, recordedDataDir, , recordedPort] = (await fs.readFile(pidFile, "utf8")).split(/\r?\n/u, 4);
  const pid = Number(pidText);
  if (
    !pidText ||
    !/^\d{1,10}$/u.test(pidText) ||
    pid <= 0 ||
    !recordedDataDir ||
    !sameFilesystemPath(recordedDataDir, dataDir) ||
    recordedPort !== String(port)
  ) {
    return "unknown";
  }
  try {
    process.kill(pid, 0);
    return "running";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "stopped" : "unknown";
  }
}

function lstatIfPresent(filePath: string) {
  return fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}

async function bindInstalledNativePostgresRecovery(
  config: GatewayRuntimeConfig,
  target: { dataDir: string; logFile: string; port: number },
): Promise<InstalledNativePostgresRecoveryAuthority | undefined> {
  const { dataDir } = target;
  const commands =
    resolveNativePostgresCommands(config) ??
    (config.assistant.database.bundledPostgres.binDir?.trim() === AUTO_NATIVE_BIN_DIR
      ? discoverNativePostgresCommands()
      : undefined);
  if (!commands || !path.isAbsolute(commands.pgCtl)) return undefined;
  if (!(await verifyRecoveryPaths(target, commands.pgCtl))) return undefined;
  const systemIdentifier = await readNativeClusterIdentifier(dataDir, commands.pgCtl);
  if (!systemIdentifier) return undefined;
  return { ...target, pgCtl: commands.pgCtl, systemIdentifier };
}

async function verifyRecoveryCluster(authority: InstalledNativePostgresRecoveryAuthority): Promise<boolean> {
  return (
    (await verifyRecoveryPaths(authority, authority.pgCtl)) &&
    (await readNativeClusterIdentifier(authority.dataDir, authority.pgCtl)) === authority.systemIdentifier
  );
}

async function verifyRecoveryPaths(
  { dataDir, logFile }: { dataDir: string; logFile: string },
  pgCtl: string,
): Promise<boolean> {
  const logDir = path.dirname(logFile);
  const optionsPath = path.join(dataDir, "postmaster.opts");
  const [realDataDir, realLogDir, marker, options, control, log] = await Promise.all([
    fs.realpath(dataDir),
    fs.realpath(logDir),
    fs.lstat(nativeBackendMarkerPath(dataDir)),
    fs.lstat(optionsPath),
    fs.realpath(path.join(dataDir, "global", "pg_control")),
    lstatIfPresent(logFile),
  ]);
  if (
    !sameFilesystemPath(realDataDir, dataDir) ||
    !sameFilesystemPath(realLogDir, logDir) ||
    !sameFilesystemPath(control, path.join(dataDir, "global", "pg_control")) ||
    !marker.isFile() ||
    !options.isFile() ||
    options.size > 4_096 ||
    (log && !log.isFile())
  ) {
    return false;
  }
  const args = await fs.readFile(optionsPath, "utf8");
  const postgres = /^"?([^"\r\n]+?\.exe)"?(?=\s|$)/iu.exec(args)?.[1];
  return Boolean(postgres && sameFilesystemPath(postgres, path.join(path.dirname(pgCtl), "postgres.exe")));
}

async function readNativeClusterIdentifier(dataDir: string, pgCtl: string): Promise<string | undefined> {
  const pgControlData = path.join(path.dirname(pgCtl), "pg_controldata.exe");
  const { stdout, stderr } = await execFileAwaited(pgControlData, ["-D", dataDir], 3_000, {
    ...process.env,
    LC_ALL: "C",
  });
  return stderr.trim() ? undefined : /^Database system identifier:\s*(\d+)\s*$/mu.exec(stdout)?.[1];
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

function postmasterPidFileExists(dataDir: string): boolean {
  return fsSync.existsSync(path.join(dataDir, "postmaster.pid"));
}

async function tryStartNativeBundledPostgres(
  config: GatewayRuntimeConfig,
): Promise<BundledPostgresRuntimeHandle | undefined> {
  setBootCheckpoint("native-pg:resolveCommands");
  const dataDir = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  const initialized = bundledClusterIsInitialized(dataDir);

  // A usable explicit binDir wins. Auto-discovery only adopts a host install
  // for a data directory we have not initialised yet: an existing cluster may
  // have been created by the Docker backend (postgres:16-alpine writes a Linux
  // cluster that a native host binary cannot start), so silently switching
  // backends under it would break working installs.
  let commands = resolveNativePostgresCommands(config);
  if (
    !commands &&
    config.assistant.database.bundledPostgres.binDir?.trim() === AUTO_NATIVE_BIN_DIR &&
    (!initialized || nativeBackendMarkerExists(dataDir))
  ) {
    commands = discoverNativePostgresCommands();
    if (commands) {
      setBootCheckpoint(`native-pg:auto-discovered (${path.dirname(commands.initdb)})`);
    }
  }
  if (!commands) {
    setBootCheckpoint("native-pg:no-commands-skipping");
    return undefined;
  }

  setBootCheckpoint("native-pg:mkdir-dataDir");
  await fs.mkdir(dataDir, { recursive: true });
  if (!initialized) {
    // Initialise with scram-sha-256 against the generated superuser password
    // rather than trust auth. Native clusters bind loopback-only, but native is
    // now the default backend, so this must not be weaker than the Docker path
    // (which actively refuses trust-auth containers).
    await ensureBundledPostgresPassword(config);
    setBootCheckpoint("native-pg:initdb-running (SYNC)");
    execFileSync(
      commands.initdb,
      [
        "-D",
        dataDir,
        "-U",
        "postgres",
        "-A",
        "scram-sha-256",
        "--pwfile",
        bundledPostgresPasswordFilePath(config),
        "--encoding",
        "UTF8",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    setBootCheckpoint("native-pg:initdb-returned");
    await markNativeBundledPostgresBackend(dataDir);
  }

  // Keep the native Postgres log outside PGDATA on Windows. When the log file
  // lives inside the cluster directory, crash recovery can hit sharing
  // violations while syncing the data directory if indexing, antivirus, or
  // backup software touches that file mid-startup.
  const logFile = bundledPostgresLogFilePath(config);
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
    await markNativeBundledPostgresBackend(dataDir);
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
    // Use -W so the launcher exits promptly. The Gateway probes database
    // readiness separately and PostgreSQL writes diagnostics to its own log.
    await launchNativeBundledPostgres(
      {
        pgCtl: commands.pgCtl,
        dataDir,
        logFile,
        port: config.assistant.database.bundledPostgres.port,
      },
      ["-W"],
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

  await markNativeBundledPostgresBackend(dataDir);

  return {
    strategy: "native",
    stop: async () => {
      const stopTimeoutMs = config.assistant.database.bundledPostgres.stopTimeoutMs;
      const stopTimeoutSeconds = Math.ceil(stopTimeoutMs / 1_000);
      try {
        await execFileAwaited(
          commands.pgCtl,
          ["-D", dataDir, "-w", "-t", String(stopTimeoutSeconds), "stop", "-m", "fast"],
          stopTimeoutMs + 10_000,
        );
      } catch (error) {
        throw reportBundledPostgresStopFailure("native", error);
      }
    },
  };
}

function launchNativeBundledPostgres(
  { pgCtl, dataDir, logFile, port }: { pgCtl: string; dataDir: string; logFile: string; port: number },
  waitArgs: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const launcher = spawn(
      pgCtl,
      ["-D", dataDir, "-l", logFile, "start", ...waitArgs, "-o", `-h 127.0.0.1 -p ${port}`],
      {
        // Windows console broadcasts also reach hidden processes unless detached.
        detached: process.platform === "win32",
        // The postmaster can inherit pg_ctl's handles and keep pipes open.
        stdio: "ignore",
        windowsHide: true,
      },
    );
    launcher.once("error", reject);
    launcher.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(signal ? `pg_ctl start was terminated by ${signal}` : `pg_ctl start exited with code ${code}`),
        );
      }
    });
  });
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
    assertDockerBundledPostgresContainerIsHardened(containerName, config.assistant.database.bundledPostgres.port);
    return {
      strategy: "docker",
      // The container was already running before this process arrived, so
      // leave its lifecycle with the operator just like the native reuse path.
      stop: async () => {},
    };
  }

  if (state === "stopped") {
    assertDockerBundledPostgresContainerIsHardened(containerName, config.assistant.database.bundledPostgres.port);
    execFileSync("docker", ["start", containerName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      strategy: "docker",
      stop: () => stopDockerBundledPostgres(config, containerName),
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
  //      via a temporary Docker env file with `POSTGRES_PASSWORD` AND
  //      `POSTGRES_HOST_AUTH_METHOD=scram-sha-256`, so any local-process
  //      compromise that reaches the port still has to read the password file
  //      (which the gateway's runtime account restricts) before connecting as
  //      the postgres superuser.
  //
  // Note: the postgres image only honours `POSTGRES_HOST_AUTH_METHOD` and
  // `POSTGRES_PASSWORD` when initialising a FRESH data directory. Existing
  // dataDirs that were initialised with trust auth keep trust auth — the
  // password is harmlessly passed but ignored. Operators who want
  // scram-sha-256 on an existing cluster must recreate the data dir.
  const bundledPassword = await ensureBundledPostgresPassword(config);
  const dockerEnvDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-bundled-postgres-env-"));
  const dockerEnvFile = path.join(dockerEnvDir, `${randomBytes(8).toString("hex")}.env`);
  await fs.writeFile(
    dockerEnvFile,
    [
      "POSTGRES_USER=postgres",
      "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
      `POSTGRES_PASSWORD=${bundledPassword}`,
      "POSTGRES_DB=postgres",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    await fs.chmod(dockerEnvFile, 0o600);
  } catch {
    // Windows / fs without chmod support - best-effort only.
  }
  try {
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
        "--env-file",
        dockerEnvFile,
        POSTGRES_IMAGE,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } finally {
    await fs.rm(dockerEnvDir, { recursive: true, force: true });
  }

  return {
    strategy: "docker",
    stop: () => stopDockerBundledPostgres(config, containerName),
  };
}

async function waitForBundledPostgres(config: GatewayRuntimeConfig): Promise<void> {
  const timeoutMs = config.assistant.database.bundledPostgres.startTimeoutMs;
  const startedAt = Date.now();
  let nextHeartbeatAt = startedAt + STARTUP_PROBE_HEARTBEAT_MS;
  let lastProbeDetail: string | undefined;
  const options = resolveGatewayPostgresConnectionOptions(config, {
    applicationName: "goatcitadel-bundled-wait",
    databaseOverride: "postgres",
  });

  while (Date.now() - startedAt < timeoutMs) {
    const probe = await probeBundledPostgresRuntime(config, options, { logFailure: false });
    if (probe.matchesExpectedRoot) {
      return;
    }
    lastProbeDetail =
      probe.failure ??
      (probe.reachable
        ? `configured port is reachable but data directory did not match expected runtime root${
            probe.dataDirectory ? ` (${probe.dataDirectory})` : ""
          }`
        : lastProbeDetail);
    const now = Date.now();
    if (now >= nextHeartbeatAt) {
      const elapsedSec = Math.round((now - startedAt) / 1000);
      const remainingSec = Math.max(0, Math.round((startedAt + timeoutMs - now) / 1000));
      process.stderr.write(
        `[bundled-pg] waiting for bundled Postgres readiness (${elapsedSec}s elapsed, ${remainingSec}s before timeout${
          lastProbeDetail ? `; last probe: ${lastProbeDetail}` : ""
        })\n`,
      );
      nextHeartbeatAt = now + STARTUP_PROBE_HEARTBEAT_MS;
    }
    await wait(READY_POLL_MS);
  }

  const diagnostics = await collectBundledPostgresStartupDiagnostics(config);
  throw attachOperatorSummary(
    new Error(
      `Bundled Postgres did not become reachable within ${timeoutMs}ms.${
        lastProbeDetail ? ` Last probe: ${lastProbeDetail}.` : ""
      }${diagnostics ? `\n\n${diagnostics}` : ""}`,
    ),
    bundledPostgresOperatorSummary("timeout", config.assistant.database.bundledPostgres.port, timeoutMs),
  );
}

async function stopDockerBundledPostgres(config: GatewayRuntimeConfig, containerName: string): Promise<void> {
  const stopTimeoutMs = config.assistant.database.bundledPostgres.stopTimeoutMs;
  const stopTimeoutSeconds = Math.ceil(stopTimeoutMs / 1_000);
  try {
    await execFileAwaited(
      "docker",
      ["stop", "--time", String(stopTimeoutSeconds), containerName],
      stopTimeoutMs + 10_000,
    );
  } catch (error) {
    throw reportBundledPostgresStopFailure("docker", error);
  }
}

function reportBundledPostgresStopFailure(strategy: "native" | "docker", error: unknown): Error {
  const failure = new Error(`Bundled Postgres ${strategy} shutdown failed. ${extractProcessErrorDetail(error)}`, {
    cause: error,
  });
  process.stderr.write(`[bundled-pg] ${failure.message}\n`);
  return failure;
}

function execFileAwaited(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<AwaitedProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        env,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

function bundledPostgresLogFilePath(config: GatewayRuntimeConfig): string {
  return path.resolve(config.rootDir, config.assistant.dataDir, "logs", "goatcitadel-postgres.log");
}

async function collectBundledPostgresStartupDiagnostics(config: GatewayRuntimeConfig): Promise<string | undefined> {
  const nativeLogTail = await readLogTail(bundledPostgresLogFilePath(config), 100);
  const dockerLogTail = await readDockerLogTail(config);
  const recoveryState = inferBundledPostgresRecoveryState(
    config,
    [nativeLogTail, dockerLogTail].filter(Boolean).join("\n"),
  );
  const parts = [`Recovery state: ${recoveryState}.`];
  if (nativeLogTail) {
    parts.push(`Last 100 native PostgreSQL log lines:\n${nativeLogTail}`);
  }
  if (dockerLogTail) {
    parts.push(`Last 100 Docker/PostgreSQL log lines:\n${dockerLogTail}`);
  }
  if (!nativeLogTail && !dockerLogTail) {
    parts.push("No bundled PostgreSQL log output was available.");
  }
  return parts.join("\n\n");
}

async function readDockerLogTail(config: GatewayRuntimeConfig): Promise<string | undefined> {
  try {
    const result = await execFileAwaited(
      "docker",
      ["logs", "--tail", "100", buildBundledDockerContainerName(config.rootDir)],
      10_000,
    );
    return [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || undefined;
  } catch {
    return undefined;
  }
}

function inferBundledPostgresRecoveryState(config: GatewayRuntimeConfig, logText: string): string {
  const normalized = logText.toLowerCase();
  if (/database system is ready to accept connections/u.test(normalized)) {
    return "ready reported but readiness probe failed";
  }
  if (
    /redo starts|redo done|recovery|database system was interrupted|not yet accepting connections/u.test(normalized)
  ) {
    return "recovery in progress or required";
  }
  const dataDir = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  if (readLivePostmasterPid(dataDir) !== undefined) {
    return "postmaster running but readiness probe failed";
  }
  if (bundledClusterIsInitialized(dataDir)) {
    return "cluster initialized; recovery state unknown";
  }
  return "cluster not initialized or state unknown";
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

function resolveNativePostgresCommands(config: GatewayRuntimeConfig): NativePostgresCommands | undefined {
  const configuredBinDir = config.assistant.database.bundledPostgres.binDir?.trim();
  if (!configuredBinDir || configuredBinDir === AUTO_NATIVE_BIN_DIR) {
    return undefined;
  }
  const binDir = path.resolve(config.rootDir, configuredBinDir);
  return nativePostgresCommandsInBinDir(binDir, process.platform) ?? resolvePackagedWindowsPostgres16(config, binDir);
}

function resolvePackagedWindowsPostgres16(config: GatewayRuntimeConfig, missingBinDir: string) {
  const appDir = process.env.GOATCITADEL_APP_DIR?.trim();
  if (
    process.platform !== "win32" ||
    process.arch !== "arm64" ||
    !appDir ||
    !fsSync.existsSync(path.join(appDir, "release-manifest.json")) ||
    !/[/\\]postgresql[/\\]16[/\\]bin$/i.test(path.normalize(missingBinDir))
  ) {
    return undefined;
  }

  const dataDir = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  // An initialized cluster must be GoatCitadel-managed Windows PostgreSQL 16.
  // An unrecognized or partially created cluster is never initialized over.
  const stat = fsSync.lstatSync(dataDir, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    if (bundledClusterIsInitialized(dataDir)) {
      if (
        !nativeBackendMarkerExists(dataDir) ||
        fsSync.readFileSync(path.join(dataDir, "PG_VERSION"), "utf8").trim() !== "16"
      ) {
        return undefined;
      }
    } else if (fsSync.readdirSync(dataDir).length > 0) {
      return undefined;
    }
  }
  return nativePostgresCommandsInBinDir(path.join(appDir, "runtime", "pgsql", "bin"), "win32");
}

function bundledClusterIsInitialized(dataDir: string): boolean {
  return fsSync.existsSync(path.join(dataDir, "PG_VERSION"));
}

function nativeBackendMarkerPath(dataDir: string): string {
  return path.join(dataDir, NATIVE_BACKEND_MARKER_FILENAME);
}

function nativeBackendMarkerExists(dataDir: string): boolean {
  return fsSync.existsSync(nativeBackendMarkerPath(dataDir));
}

function isNativeBundledPostgresOwnedCluster(config: GatewayRuntimeConfig): boolean {
  const dataDir = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  return nativeBackendMarkerExists(dataDir);
}

async function markNativeBundledPostgresBackend(dataDir: string): Promise<void> {
  await fs.writeFile(
    nativeBackendMarkerPath(dataDir),
    "backend=native\nowner=goatcitadel-bundled-postgres\npurpose=prevents-auto-native-clusters-from-being-restarted-with-docker\n",
    "utf8",
  );
}

function buildNativeCommandsUnavailableMessage(config: GatewayRuntimeConfig): string {
  const binDir = config.assistant.database.bundledPostgres.binDir?.trim();
  const dataDir = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  const detail =
    binDir && binDir !== AUTO_NATIVE_BIN_DIR
      ? `Configured bundledPostgres.binDir did not contain both initdb and pg_ctl: ${binDir}.`
      : `Bundled Postgres dataDir was initialized by the native backend but no local PostgreSQL server tools were found: ${dataDir}.`;
  return [
    "Bundled Postgres native backend is required but unavailable.",
    detail,
    "Install PostgreSQL server tools, set assistant.database.bundledPostgres.binDir to their bin directory, or move this dataDir aside before choosing Docker fallback.",
  ].join("\n");
}

async function canReachExpectedBundledPostgres(
  config: GatewayRuntimeConfig,
  options: ReturnType<typeof resolveGatewayPostgresConnectionOptions>,
  probeOptions?: BundledPostgresProbeOptions,
): Promise<boolean> {
  return (await probeBundledPostgresRuntime(config, options, probeOptions)).matchesExpectedRoot;
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
  probeOptions: BundledPostgresProbeOptions = {},
): Promise<BundledPostgresProbeResult> {
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
    const failure = formatBundledPostgresProbeFailure(error);
    if (probeOptions.logFailure !== false) {
      process.stderr.write(`[bundled-pg] probe failed: ${failure}\n`);
    }
    return { reachable: false, matchesExpectedRoot: false, failure };
  } finally {
    await client.close();
  }
}

function formatBundledPostgresProbeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const message = error.message.split("\n")[0] || error.name || "unknown error";
  const code = (error as NodeJS.ErrnoException).code ?? "unknown";
  return `${message} (code=${code})`;
}

function isExpectedBundledDataDirectory(config: GatewayRuntimeConfig, actualDataDirectory: string): boolean {
  const expectedNative = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  if (sameFilesystemPath(actualDataDirectory, expectedNative)) {
    return true;
  }
  if (!isDockerPostgresDataDirectory(actualDataDirectory)) {
    return false;
  }
  return hasRunningBundledDockerContainerForDataDir(config);
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

function assertDockerBundledPostgresContainerIsHardened(containerName: string, expectedHostPort: number): void {
  const inspection = inspectDockerPostgresSecurity(containerName, expectedHostPort);
  if (inspection.loopbackOnly && !inspection.trustAuth) {
    return;
  }
  const reason = inspection.details.length > 0 ? inspection.details.join("; ") : "unknown Docker inspect shape";
  throw new NonRetryableStartupError(
    [
      `Refusing to reuse bundled Postgres Docker container ${containerName}: ${reason}.`,
      "Legacy containers may expose unauthenticated Postgres beyond loopback.",
      `Run: docker rm ${containerName}`,
      "Then restart GoatCitadel so it can recreate the container with 127.0.0.1 publishing and password configuration.",
      "If the preserved data directory was initialized with trust authentication, harden or migrate its PostgreSQL authentication files before reusing it.",
      "GoatCitadel will not remove or recreate an existing container automatically. The repair command does not delete bind-mounted database files.",
    ].join("\n"),
  );
}

function assertReachableBundledDockerPostgresIsHardened(
  config: GatewayRuntimeConfig,
  dataDirectory: string | undefined,
): void {
  if (!dataDirectory || !isDockerPostgresDataDirectory(dataDirectory)) {
    return;
  }
  const names = findRunningBundledDockerContainerNamesForDataDir(config);
  if (names.length === 0) {
    throw new Error(
      [
        "Bundled Postgres probe resolved to a Docker data directory, but no running GoatCitadel Docker container is mounted to this runtime data dir.",
        "Stop the unexpected Postgres runtime or configure a different bundledPostgres.port.",
      ].join("\n"),
    );
  }
  for (const name of names) {
    assertDockerBundledPostgresContainerIsHardened(name, config.assistant.database.bundledPostgres.port);
  }
}

function inspectDockerPostgresSecurity(
  containerName: string,
  expectedHostPort: number,
): DockerPostgresSecurityInspection {
  let parsed: unknown;
  try {
    const output = execFileSync("docker", ["inspect", containerName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    parsed = JSON.parse(output);
  } catch {
    return {
      loopbackOnly: false,
      trustAuth: true,
      details: ["could not inspect Docker container security settings"],
    };
  }
  return parseDockerPostgresSecurityInspection(parsed, expectedHostPort);
}

function parseDockerPostgresSecurityInspection(
  value: unknown,
  expectedHostPort?: number,
): DockerPostgresSecurityInspection {
  const container = Array.isArray(value) ? value[0] : value;
  const details: string[] = [];
  const env = readDockerInspectEnv(container);
  const trustAuth = env.some((entry) => entry.trim().toUpperCase() === "POSTGRES_HOST_AUTH_METHOD=TRUST");
  if (trustAuth) {
    details.push("POSTGRES_HOST_AUTH_METHOD=trust");
  }
  const running = readDockerInspectRunningState(container);
  const declaredBindings = readDockerInspectDeclaredPortBindings(container);
  const effectiveBindings = readDockerInspectEffectivePortBindings(container);
  if (declaredBindings.length === 0) {
    details.push("missing declared 5432/tcp port binding");
  }
  const effectiveBindingRequired = running !== false;
  if (effectiveBindingRequired && effectiveBindings.length === 0) {
    details.push("missing effective 5432/tcp port binding");
  }
  appendUnsafeDockerBindings(details, "declared", declaredBindings);
  appendUnsafeDockerBindings(details, "effective", effectiveBindings);
  const expectedHostPortText = expectedHostPort === undefined ? undefined : String(expectedHostPort);
  const hasUnexpectedHostPort = [...declaredBindings, ...effectiveBindings].some(
    (binding) => expectedHostPortText !== undefined && binding.hostPort !== expectedHostPortText,
  );
  if (hasUnexpectedHostPort) {
    details.push(`5432/tcp publish does not use configured host port ${expectedHostPortText}`);
  }
  const hasConflictingBindings =
    effectiveBindingRequired &&
    declaredBindings.length > 0 &&
    effectiveBindings.length > 0 &&
    !dockerBindingSetsMatch(declaredBindings, effectiveBindings);
  if (hasConflictingBindings) {
    details.push("declared and effective 5432/tcp bindings conflict");
  }
  const hasUnsafeBinding = [...declaredBindings, ...effectiveBindings].some(
    (binding) => !isLoopbackDockerHostIp(binding.hostIp),
  );
  return {
    loopbackOnly:
      declaredBindings.length > 0 &&
      (!effectiveBindingRequired || effectiveBindings.length > 0) &&
      !hasUnsafeBinding &&
      !hasUnexpectedHostPort &&
      !hasConflictingBindings,
    trustAuth,
    details,
  };
}

function dockerBindingSetsMatch(left: DockerPortBinding[], right: DockerPortBinding[]): boolean {
  const normalize = (bindings: DockerPortBinding[]) =>
    [...new Set(bindings.map((binding) => `${binding.hostIp.trim().toLowerCase()}:${binding.hostPort.trim()}`))].sort();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((binding, index) => binding === normalizedRight[index])
  );
}

function readDockerInspectEnv(container: unknown): string[] {
  if (!container || typeof container !== "object") {
    return [];
  }
  const config = (container as { Config?: unknown }).Config;
  if (!config || typeof config !== "object") {
    return [];
  }
  const env = (config as { Env?: unknown }).Env;
  return Array.isArray(env) ? env.filter((entry): entry is string => typeof entry === "string") : [];
}

function readDockerInspectRunningState(container: unknown): boolean | undefined {
  if (!container || typeof container !== "object") {
    return undefined;
  }
  const state = (container as { State?: unknown }).State;
  if (!state || typeof state !== "object") {
    return undefined;
  }
  const running = (state as { Running?: unknown }).Running;
  return typeof running === "boolean" ? running : undefined;
}

function readDockerInspectDeclaredPortBindings(container: unknown): DockerPortBinding[] {
  if (!container || typeof container !== "object") {
    return [];
  }
  const hostConfig = (container as { HostConfig?: unknown }).HostConfig;
  if (!hostConfig || typeof hostConfig !== "object") {
    return [];
  }
  return readDockerPortBindings((hostConfig as { PortBindings?: unknown }).PortBindings);
}

function readDockerInspectEffectivePortBindings(container: unknown): DockerPortBinding[] {
  if (!container || typeof container !== "object") {
    return [];
  }
  const networkSettings = (container as { NetworkSettings?: unknown }).NetworkSettings;
  if (!networkSettings || typeof networkSettings !== "object") {
    return [];
  }
  return readDockerPortBindings((networkSettings as { Ports?: unknown }).Ports);
}

function readDockerPortBindings(ports: unknown): DockerPortBinding[] {
  if (!ports || typeof ports !== "object") {
    return [];
  }
  const rawBindings = (ports as Record<string, unknown>)["5432/tcp"];
  if (!Array.isArray(rawBindings)) {
    return [];
  }
  return rawBindings
    .map((binding) => {
      if (!binding || typeof binding !== "object") {
        return undefined;
      }
      return {
        hostIp:
          typeof (binding as { HostIp?: unknown }).HostIp === "string" ? (binding as { HostIp: string }).HostIp : "",
        hostPort:
          typeof (binding as { HostPort?: unknown }).HostPort === "string"
            ? (binding as { HostPort: string }).HostPort
            : "",
      };
    })
    .filter((binding): binding is DockerPortBinding => Boolean(binding));
}

function appendUnsafeDockerBindings(
  details: string[],
  source: "declared" | "effective",
  bindings: DockerPortBinding[],
): void {
  const unsafeBindings = bindings.filter((binding) => !isLoopbackDockerHostIp(binding.hostIp));
  if (unsafeBindings.length === 0) {
    return;
  }
  details.push(
    `non-loopback ${source} publish ${unsafeBindings
      .map((binding) => `${binding.hostIp || "0.0.0.0"}:${binding.hostPort || "*"}`)
      .join(", ")}`,
  );
}

function isLoopbackDockerHostIp(hostIp: string): boolean {
  const normalized = hostIp.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function hasRunningBundledDockerContainerForDataDir(config: GatewayRuntimeConfig): boolean {
  return findRunningBundledDockerContainerNamesForDataDir(config).length > 0;
}

function findRunningBundledDockerContainerNamesForDataDir(config: GatewayRuntimeConfig): string[] {
  const expectedDataDir = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  const prefix = buildBundledDockerContainerNamePrefix();
  try {
    const names = execFileSync("docker", ["ps", "--filter", `name=^/${prefix}`, "--format", "{{.Names}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return names.filter((name) => dockerContainerMountsDataDir(name, expectedDataDir));
  } catch {
    return [];
  }
}

function dockerContainerMountsDataDir(containerName: string, expectedDataDir: string): boolean {
  try {
    const output = execFileSync("docker", ["inspect", "--format", "{{json .Mounts}}", containerName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const mounts = JSON.parse(output) as Array<{ Destination?: string; Source?: string }>;
    return mounts.some((mount) => {
      const destination = mount.Destination?.trim().replaceAll("\\", "/").replace(/\/+$/, "");
      return (
        destination === "/var/lib/postgresql/data" &&
        typeof mount.Source === "string" &&
        sameFilesystemPath(mount.Source, expectedDataDir)
      );
    });
  } catch {
    return false;
  }
}

function assertBundledPostgresPortIsUsable(config: GatewayRuntimeConfig): void {
  const port = config.assistant.database.bundledPostgres.port;
  const exclusion = findWindowsTcpPortExclusion(port);
  if (!exclusion) {
    return;
  }
  const range =
    exclusion.startPort === exclusion.endPort
      ? `${exclusion.startPort}`
      : `${exclusion.startPort}-${exclusion.endPort}`;
  throw attachOperatorSummary(
    new Error(
      [
        `Bundled Postgres cannot start on 127.0.0.1:${port} because Windows has reserved TCP port range ${range}.`,
        "A reserved port can fail with Permission denied even when no process is listening on it.",
        "Set GOATCITADEL_BUNDLED_POSTGRES_PORT to a free port, or update " +
          "assistant.database.bundledPostgres.port in your local config, then restart.",
        "To inspect Windows reservations, run: netsh interface ipv4 show excludedportrange protocol=tcp",
      ].join("\n"),
    ),
    bundledPostgresOperatorSummary("reserved_port", port),
  );
}

/**
 * Fails fast, with a plain reason, when something else already answers on the
 * configured port. It only detects and reports: it never frees the port, never
 * stops the program holding it and never picks another port.
 */
async function assertBundledPostgresPortIsNotHeld(config: GatewayRuntimeConfig): Promise<void> {
  const port = config.assistant.database.bundledPostgres.port;
  const acceptsConnections = await tcpPortAcceptsConnections(port);
  if (!acceptsConnections) {
    return;
  }
  const dataDir = path.resolve(config.rootDir, config.assistant.database.bundledPostgres.dataDir);
  // Doubtful cases count as this install's own so the start keeps its old behaviour (wait and
  // retry) instead of a new refusal: a live postmaster, a postmaster.pid left behind (its pid may
  // belong to a container or a database that is still shutting down), or a container with this
  // root's name in any state (the start path reuses it by that name), or one mounting the data dir.
  const ownPostmasterAlive = readLivePostmasterPid(dataDir) !== undefined || postmasterPidFileExists(dataDir);
  const ownContainerRunning =
    !ownPostmasterAlive && canUseDocker()
      ? inspectDockerContainerState(buildBundledDockerContainerName(config.rootDir)) !== "missing" ||
        hasRunningBundledDockerContainerForDataDir(config)
      : false;
  if (!portHeldByAnotherProgram({ acceptsConnections, ownPostmasterAlive, ownContainerRunning })) {
    return;
  }
  throw attachOperatorSummary(
    new NonRetryableStartupError(
      [
        `Bundled Postgres cannot start on 127.0.0.1:${port}: the port already accepts connections, but the probe could not use it and no postmaster or container of this install owns it.`,
        "Another program may be using the port, or an older GoatCitadel database with a different password is still running.",
        "Stop that program and restart. GoatCitadel does not stop it or free the port for you.",
        "To use a different port, set GOATCITADEL_BUNDLED_POSTGRES_PORT to a free port, or update " +
          "assistant.database.bundledPostgres.port in your local config, then restart.",
      ].join("\n"),
    ),
    bundledPostgresOperatorSummary("port_held", port),
  );
}

function portHeldByAnotherProgram(input: {
  acceptsConnections: boolean;
  ownPostmasterAlive: boolean;
  ownContainerRunning: boolean;
}): boolean {
  return input.acceptsConnections && !input.ownPostmasterAlive && !input.ownContainerRunning;
}

type BundledPostgresSummaryKind = "port_held" | "other_database" | "reserved_port" | "timeout" | "no_backend";

export function bundledPostgresOperatorSummary(
  kind: BundledPostgresSummaryKind,
  port: number,
  timeoutMs?: number,
): string {
  switch (kind) {
    case "port_held":
      return `The local database could not start because another program is using its port (${port}), or an older GoatCitadel database with a different password is still running. Stop that program and press Retry. Open Logs shows how to choose a different port.`;
    case "other_database":
      return `The local database port (${port}) belongs to a different database. Stop it and press Retry, or open Logs to see how to choose a different port.`;
    case "reserved_port":
      return `The local database could not start because Windows has reserved its port (${port}). Open Logs shows how to choose a different port.`;
    case "timeout":
      return `The local database did not start within ${Math.round((timeoutMs ?? 0) / 1000)} seconds. Open Logs shows its last messages.`;
    case "no_backend":
      return "The local database could not start because no PostgreSQL install was found and Docker is not running. Open Logs shows the ways to fix this.";
  }
}

function findWindowsTcpPortExclusion(port: number): WindowsTcpPortExclusion | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  for (const protocol of ["ipv4", "ipv6"] as const) {
    let output: string;
    try {
      output = execFileSync("netsh", ["interface", protocol, "show", "excludedportrange", "protocol=tcp"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    const exclusion = parseWindowsTcpPortExclusions(output).find(
      (range) => port >= range.startPort && port <= range.endPort,
    );
    if (exclusion) {
      return exclusion;
    }
  }
  return undefined;
}

function parseWindowsTcpPortExclusions(output: string): WindowsTcpPortExclusion[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line): WindowsTcpPortExclusion | undefined => {
      const match = /^(\d+)\s+(\d+)(?:\s+(\*))?$/u.exec(line);
      if (!match) {
        return undefined;
      }
      const startPort = Number.parseInt(match[1] ?? "", 10);
      const endPort = Number.parseInt(match[2] ?? "", 10);
      if (
        !Number.isInteger(startPort) ||
        !Number.isInteger(endPort) ||
        startPort < 1 ||
        endPort > 65_535 ||
        startPort > endPort
      ) {
        return undefined;
      }
      return {
        startPort,
        endPort,
        administered: match[3] === "*",
      };
    })
    .filter((range): range is WindowsTcpPortExclusion => Boolean(range));
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
  const hash = createHash("sha256").update(rootDir).digest("hex").slice(0, 10);
  return `${buildBundledDockerContainerNamePrefix()}-${hash}`;
}

function buildBundledDockerContainerNamePrefix(): string {
  const hostname = os
    .hostname()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `goatcitadel-postgres-${hostname || "local"}`;
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
  discoverNativePostgresCommands,
  highestVersionedNativePostgresCommands,
  nativePostgresInstallRoots,
  nativePostgresCommandsFromPathEnv,
  parseNativePostgresMajor,
  isDockerPostgresDataDirectory,
  parseDockerPostgresSecurityInspection,
  parseWindowsTcpPortExclusions,
  quoteIdentifier,
  readLogTail,
  resolveNativePostgresCommands,
  sameFilesystemPath,
  dockerContainerMountsDataDir,
  formatBundledPostgresProbeFailure,
  portHeldByAnotherProgram,
  bundledPostgresOperatorSummary,
};
