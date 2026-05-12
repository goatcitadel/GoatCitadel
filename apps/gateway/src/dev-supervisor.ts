import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadLocalEnvFile } from "./env-file.js";
import {
  createTerminalReporter,
  formatVerboseFlagHint,
  isVerboseLoggingEnabled,
  setGoatcitadelTerminalTitle,
} from "./runtime-ux.js";
import {
  INSECURE_LOCAL_ONLY_OVERRIDE_ENV,
  isLoopbackHost,
  resolveAllowUnauthNetwork,
  resolveWarnUnauthNonLoopback,
  shouldWarnUnauthNonLoopbackBind,
} from "./startup-guard.js";

loadLocalEnvFile();

const cliArgs = process.argv.slice(2);
const verboseRequested = cliArgs.includes("--verbose") || cliArgs.includes("-verbose") || isVerboseLoggingEnabled();
if (verboseRequested) {
  process.env.GOATCITADEL_VERBOSE = "1";
}
setGoatcitadelTerminalTitle(process.env.GOATCITADEL_TERMINAL_TASK?.trim() || "Gateway Dev");

const gatewayHost = process.env.GATEWAY_HOST ?? "127.0.0.1";
const gatewayHealthHost = resolveGatewayHealthHost(gatewayHost);
const gatewayPort = Number(process.env.GATEWAY_PORT ?? 8787);
// Bundled Postgres crash recovery on Windows can legitimately take well over a
// minute after an interrupted shutdown, especially when the data directory is
// under active file indexing or antivirus scanning. Keep the dev supervisor
// patient enough to wait for recovery instead of restarting a gateway that is
// still making forward progress toward readiness.
const gatewayHealthTimeoutMs = readPositiveInt(process.env.GOATCITADEL_GATEWAY_HEALTH_TIMEOUT_MS, 120_000);
const warnUnauthNonLoopback = resolveWarnUnauthNonLoopback();
const pollMs = Number(process.env.GOATCITADEL_GATEWAY_WATCH_POLL_MS ?? 1200);
const restartWindowMs = Number(process.env.GOATCITADEL_GATEWAY_RESTART_WINDOW_MS ?? 60_000);
const restartMaxFailures = Number(process.env.GOATCITADEL_GATEWAY_RESTART_MAX_FAILURES ?? 5);
const restartBaseBackoffMs = Number(process.env.GOATCITADEL_GATEWAY_RESTART_BASE_BACKOFF_MS ?? 1000);
const restartMaxBackoffMs = Number(process.env.GOATCITADEL_GATEWAY_RESTART_MAX_BACKOFF_MS ?? 30_000);
const restartCircuitOpenMs = Number(process.env.GOATCITADEL_GATEWAY_RESTART_CIRCUIT_MS ?? 60_000);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configuredRoot = process.env.GOATCITADEL_ROOT_DIR?.trim();
const runtimeRoot = configuredRoot ? path.resolve(configuredRoot) : repoRoot;
const gatewayDir = path.join(repoRoot, "apps", "gateway");
const log = createTerminalReporter({
  scope: "gateway-dev",
  verbose: verboseRequested,
});

const watchRoots = [
  path.join(gatewayDir, "src"),
  path.join(repoRoot, "packages", "contracts", "src"),
  path.join(repoRoot, "packages", "storage", "src"),
  path.join(repoRoot, "packages", "gateway-core", "src"),
  path.join(repoRoot, "packages", "policy-engine", "src"),
  path.join(repoRoot, "packages", "skills", "src"),
  path.join(repoRoot, "packages", "orchestration", "src"),
  path.join(repoRoot, "packages", "mesh-core", "src"),
];

let child: ChildProcess | null = null;
let shuttingDown = false;
let restarting = false;
let polling = false;
let lastSignature = "";
let restartTimer: NodeJS.Timeout | null = null;
let circuitOpenUntil = 0;
const failureTimestamps: number[] = [];

async function main(): Promise<void> {
  log.info(`watching gateway on http://${gatewayHealthHost}:${gatewayPort}/health`);
  if (verboseRequested) {
    log.debug("workspace roots loaded", {
      repoRoot,
      runtimeRoot,
      watchRoots,
      pollMs,
      gatewayHealthTimeoutMs,
    });
  } else {
    log.info(formatVerboseFlagHint());
  }
  assertGatewayBindIsSafeForDev(gatewayHost);
  log.info(
    `restart budget ${restartMaxFailures} failures / ${restartWindowMs}ms`,
    verboseRequested
      ? {
          restartBaseBackoffMs,
          restartMaxBackoffMs,
          restartCircuitOpenMs,
        }
      : undefined,
  );
  if (warnUnauthNonLoopback && shouldWarnUnauthNonLoopbackBind(gatewayHost, readSupervisorAuthConfig())) {
    log.warn("non-loopback bind without explicit auth env detected", {
      host: gatewayHost,
      suggestion: "Set GOATCITADEL_AUTH_TOKEN or GOATCITADEL_AUTH_MODE=basic for safer remote access.",
    });
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  lastSignature = await computeSignature();
  await restartGateway("initial start");

  setInterval(() => {
    void pollForChanges();
  }, pollMs).unref();
}

async function pollForChanges(): Promise<void> {
  if (polling || restarting || shuttingDown) {
    return;
  }
  polling = true;
  try {
    const next = await computeSignature();
    if (next !== lastSignature) {
      lastSignature = next;
      await restartGateway("source/config change");
    }
  } finally {
    polling = false;
  }
}

async function restartGateway(reason: string): Promise<void> {
  if (restarting || shuttingDown) {
    return;
  }
  const now = Date.now();
  if (now < circuitOpenUntil) {
    const remaining = circuitOpenUntil - now;
    log.warn(`restart circuit open for ${remaining}ms`, { reason });
    scheduleRestartAfter(remaining, "circuit reopen");
    return;
  }
  restarting = true;
  try {
    clearRestartTimer();
    log.info(`restarting gateway (${reason})`);
    await stopChild("restart");
    await startChild();
  } finally {
    restarting = false;
  }
}

async function startChild(): Promise<void> {
  if (await isPortOpen()) {
    log.error("gateway port already in use before spawn", {
      host: gatewayHealthHost,
      port: gatewayPort,
      advice: "Stop the existing listener on this port before running pnpm dev.",
    });
    const delay = registerFailureAndGetDelay("port_in_use_before_spawn");
    if (delay !== null) {
      scheduleRestartAfter(delay, "port in use");
    }
    return;
  }

  if (!ensureGatewayProjectReferencesBuilt()) {
    return;
  }

  const { command, args } = buildGatewayStartCommand();

  child = spawn(command, args, {
    cwd: gatewayDir,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      GOATCITADEL_ROOT_DIR: runtimeRoot,
      GOATCITADEL_VERBOSE: verboseRequested ? "1" : process.env.GOATCITADEL_VERBOSE,
      GATEWAY_HOST: gatewayHost,
      GATEWAY_PORT: String(gatewayPort),
      GOATCITADEL_GATEWAY_SUPERVISED: "1",
    },
    stdio: "inherit",
    detached: process.platform !== "win32",
  });

  const currentPid = child.pid;
  if (!currentPid) {
    throw new Error("failed to start gateway child process");
  }

  child.on("exit", (code, signal) => {
    if (child?.pid === currentPid) {
      child = null;
    }
    if (shuttingDown || restarting) {
      return;
    }
    log.warn("gateway exited", {
      pid: currentPid,
      code: code ?? "null",
      signal: signal ?? "null",
    });
    const delay = registerFailureAndGetDelay("process_exit");
    if (delay !== null) {
      scheduleRestartAfter(delay, "process exit");
    }
  });

  const healthy = await waitForGatewayHealth(gatewayHealthTimeoutMs);
  if (healthy) {
    resetFailureBudget();
    log.success("gateway online", { pid: currentPid });
    return;
  }

  log.warn("gateway did not become healthy in time", { timeoutMs: gatewayHealthTimeoutMs });
  const delay = registerFailureAndGetDelay("health_timeout");
  if (delay !== null) {
    scheduleRestartAfter(delay, "health timeout");
  }
}

function ensureGatewayProjectReferencesBuilt(): boolean {
  log.info("building gateway project references");
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
  };
  const result =
    process.platform === "win32"
      ? spawnSync(
          process.env.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", "pnpm exec tsc -b tsconfig.json --pretty false"],
          {
            cwd: gatewayDir,
            env,
            stdio: "pipe",
            encoding: "utf8",
          },
        )
      : spawnSync("pnpm", ["exec", "tsc", "-b", "tsconfig.json", "--pretty", "false"], {
          cwd: gatewayDir,
          env,
          stdio: "pipe",
          encoding: "utf8",
        });

  if ((result.status ?? 1) === 0) {
    return true;
  }

  log.error("gateway project reference build failed", {
    status: result.status ?? "null",
    signal: result.signal ?? "null",
    stderr: sanitizeSpawnOutput(result.stderr),
    stdout: sanitizeSpawnOutput(result.stdout),
  });
  const delay = registerFailureAndGetDelay("reference_build_failed");
  if (delay !== null) {
    scheduleRestartAfter(delay, "reference build failed");
  }
  return false;
}

function buildGatewayStartCommand(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    // Node 24 on Windows can throw spawn EINVAL when launching *.cmd directly.
    // Using cmd /c is stable and keeps behavior identical for local dev usage.
    const comspec = process.env.ComSpec || "cmd.exe";
    return {
      command: comspec,
      args: ["/d", "/s", "/c", "pnpm exec tsx src/main.ts"],
    };
  }
  return {
    command: "pnpm",
    args: ["exec", "tsx", "src/main.ts"],
  };
}

async function stopChild(reason: string): Promise<void> {
  const running = child;
  if (!running?.pid) {
    return;
  }

  const pid = running.pid;
  log.info("stopping gateway", { pid, reason });

  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        running.kill("SIGTERM");
      }
      await sleep(1200);
      if (isProcessAlive(pid)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          running.kill("SIGKILL");
        }
      }
    }
  } catch {
    // ignore kill failures; we still wait for port closure below.
  }

  child = null;
  const portClosed = await waitForPortClosed(10_000);
  if (!portClosed) {
    log.warn("gateway port did not release before timeout", {
      host: gatewayHost,
      port: gatewayPort,
    });
  }
}

async function waitForGatewayHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isGatewayHealthy()) {
      return true;
    }
    await sleep(300);
  }
  return false;
}

async function waitForPortClosed(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await isPortOpen();
    if (!open) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function isGatewayHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`http://${gatewayHealthHost}:${gatewayPort}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function isPortOpen(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: gatewayHealthHost, port: gatewayPort });
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sanitizeSpawnOutput(value: string | Buffer | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 ? text.slice(-1200) : undefined;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function computeSignature(): Promise<string> {
  const entries: string[] = [];
  for (const watchRoot of watchRoots) {
    await collectPathSignature(watchRoot, entries);
  }
  entries.sort();
  return entries.join("|");
}

async function collectPathSignature(targetPath: string, out: string[]): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(targetPath);
  } catch {
    return;
  }

  if (stat.isDirectory()) {
    const items = await fs.readdir(targetPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name === "node_modules" || item.name === "dist" || item.name === ".git") {
        continue;
      }
      await collectPathSignature(path.join(targetPath, item.name), out);
    }
    return;
  }

  const ext = path.extname(targetPath).toLowerCase();
  if (![".ts", ".tsx", ".json"].includes(ext)) {
    return;
  }

  const relative = path.relative(repoRoot, targetPath).replaceAll("\\", "/");
  out.push(`${relative}:${stat.mtimeMs}`);
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearRestartTimer();
  log.info("shutdown signal", { signal });
  await stopChild(signal);
  process.exitCode = 0;
}

function registerFailureAndGetDelay(reason: string): number | null {
  const now = Date.now();
  pruneFailures(now);
  failureTimestamps.push(now);
  const failures = failureTimestamps.length;
  const computedDelay = Math.min(
    restartMaxBackoffMs,
    Math.round(restartBaseBackoffMs * 2 ** Math.max(0, failures - 1)),
  );

  if (failures > restartMaxFailures) {
    circuitOpenUntil = now + restartCircuitOpenMs;
    log.error("restart budget exceeded", {
      failures,
      restartMaxFailures,
      reason,
      restartCircuitOpenMs,
    });
    return restartCircuitOpenMs;
  }

  return computedDelay;
}

function scheduleRestartAfter(delayMs: number, reason: string): void {
  if (shuttingDown || restartTimer) {
    return;
  }
  const delay = Math.max(100, delayMs);
  log.info(`scheduling restart in ${delay}ms`, { reason });
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartGateway(reason);
  }, delay);
}

function clearRestartTimer(): void {
  if (!restartTimer) {
    return;
  }
  clearTimeout(restartTimer);
  restartTimer = null;
}

function pruneFailures(now = Date.now()): void {
  while (failureTimestamps.length > 0 && now - (failureTimestamps[0] ?? now) > restartWindowMs) {
    failureTimestamps.shift();
  }
}

function resetFailureBudget(): void {
  failureTimestamps.length = 0;
  circuitOpenUntil = 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveGatewayHealthHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") {
    return "127.0.0.1";
  }
  return host;
}

function assertGatewayBindIsSafeForDev(host: string): void {
  if (
    isLoopbackHost(host) ||
    resolveAllowUnauthNetwork() ||
    !shouldWarnUnauthNonLoopbackBind(host, readSupervisorAuthConfig())
  ) {
    return;
  }
  throw new Error(
    `Unsafe gateway bind blocked for local dev: GATEWAY_HOST=${host}. ` +
      "Set GATEWAY_HOST=127.0.0.1 for local-only access, configure GOATCITADEL_AUTH_MODE with credentials, " +
      `or explicitly set ${INSECURE_LOCAL_ONLY_OVERRIDE_ENV}=true to override.`,
  );
}

function readSupervisorAuthConfig() {
  return {
    mode: (process.env.GOATCITADEL_AUTH_MODE?.trim().toLowerCase() ?? "none") as "none" | "token" | "basic",
    allowLoopbackBypass: true,
    token: {
      value: process.env.GOATCITADEL_AUTH_TOKEN?.trim(),
      queryParam: "access_token",
    },
    basic: {
      username: process.env.GOATCITADEL_AUTH_BASIC_USERNAME?.trim(),
      password: process.env.GOATCITADEL_AUTH_BASIC_PASSWORD?.trim(),
    },
  };
}

main().catch((error) => {
  log.fatal((error as Error).message, error);
  process.exitCode = 1;
});
