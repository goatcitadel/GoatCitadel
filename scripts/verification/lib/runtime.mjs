import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { resolveUiTarget } from "../../lib/ui-target.mjs";
import {
  inheritedWorktreeOutputLockEnvironment,
  WORKTREE_OUTPUT_LOCK_LEASE_ENV,
  WORKTREE_OUTPUT_LOCK_PATH_ENV,
  WORKTREE_OUTPUT_LOCK_ROOT_ENV,
} from "../../lib/worktree-output-lock.mjs";
import { repoRoot, sanitizeFilePart, spawnVerificationProcess, writeText } from "./shared.mjs";

let gatewayWorkspaceBuildEnsured = false;
const uiBuildKeys = new Map();
const WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe";

export async function prepareVerificationRuntime(runId) {
  const tempParent = process.env.GOATCITADEL_VERIFY_TEMP_ROOT?.trim() || os.tmpdir();
  await fs.mkdir(tempParent, { recursive: true });
  const tempRoot = await fs.mkdtemp(path.join(tempParent, `goatcitadel-verify-${sanitizeFilePart(runId)}-`));
  await fs.mkdir(path.join(tempRoot, "data"), { recursive: true });
  await fs.cp(path.join(repoRoot, "config"), path.join(tempRoot, "config"), { recursive: true });
  // The Gateway reads the plugins that ship from <rootDir>/plugins outside a packaged install.
  for (const folder of ["skills", "plugins", "workspaces"]) {
    if (existsSync(path.join(repoRoot, folder))) {
      await fs.cp(path.join(repoRoot, folder), path.join(tempRoot, folder), { recursive: true });
    }
  }
  return tempRoot;
}

export async function startVerificationStack(context, options = {}) {
  await ensureGatewayWorkspaceBuild(context, {
    omitEnv: options.gatewayEnvOmit,
    processLogPrefix: options.processLogPrefix,
  });
  const uiTarget = resolveUiTarget(repoRoot, process.env);
  const runtimeRoot = options.runtimeRoot ?? (await prepareVerificationRuntime(context.runId));
  let gateway;
  let ui;
  try {
    const gatewayPort = await resolveAvailablePort(Number(options.gatewayPort ?? 0));
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    // Chosen before the Gateway starts so its origin policy can name the UI (see withVerificationUiOrigin).
    const uiPort = options.includeUi !== false ? await resolveUiPort(options.uiPort, gatewayPort) : undefined;
    const uiUrl = uiPort ? `http://127.0.0.1:${uiPort}` : undefined;
    const gatewayEnv = buildVerificationGatewayEnv({
      runtimeRoot,
      gatewayPort,
      uiUrl,
      gatewayEnv: options.gatewayEnv,
      gatewayEnvOmit: options.gatewayEnvOmit,
    });

    gateway =
      options.gatewayMode === "built"
        ? await startProcess(
            context,
            buildVerificationProcessLogName("gateway", options.processLogPrefix),
            [
              process.execPath,
              options.builtGatewayEntryFile ?? path.join(repoRoot, "apps", "gateway", "dist", "main.js"),
            ],
            gatewayEnv,
            { omitEnv: options.gatewayEnvOmit },
          )
        : await startProcess(
            context,
            buildVerificationProcessLogName("gateway", options.processLogPrefix),
            buildVerificationGatewayCommand(),
            gatewayEnv,
            {
              omitEnv: options.gatewayEnvOmit,
              cwd: path.join(repoRoot, "apps", "gateway"),
            },
          );
    await waitForHttp(`${gatewayUrl}/health`, "Gateway health", 180000, gateway);
    if (uiUrl) {
      const uiEnv = {
        VITE_GATEWAY_URL: gatewayUrl,
        VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "true",
        VITE_GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "false",
        ...options.uiEnv,
      };
      if (options.uiMode === "preview") {
        await ensureVerificationUiBuild(context, uiTarget.packageName, uiEnv, {
          omitEnv: options.uiEnvOmit,
          processLogPrefix: options.processLogPrefix,
        });
      }
      ui = await startProcess(
        context,
        buildVerificationProcessLogName("ui", options.processLogPrefix),
        buildVerificationUiCommand(uiTarget.packageName, uiPort, options.uiMode),
        uiEnv,
        { omitEnv: options.uiEnvOmit, cwd: uiTarget.appDir },
      );
      await waitForHttp(uiUrl, `${uiTarget.displayName} UI`, 180000, ui);
    }
    return {
      runtimeRoot,
      gateway,
      ui,
      gatewayUrl,
      uiUrl,
    };
  } catch (error) {
    // Cleanup problems are reported by stopVerificationStack itself and must
    // never replace the original startup error thrown below.
    await stopVerificationStack({ runtimeRoot, gateway, ui });
    throw error;
  }
}

/**
 * Tears the stack down best-effort and NEVER throws. Nearly every caller sits
 * in a `finally` block: a cleanup throw there replaces the scenario's real
 * failure (masking the diagnosis) or converts a passing lane into a red one
 * because a Windows process lingered past the kill deadline. Cleanup problems
 * are reported to stderr and returned for callers/tests that want to inspect
 * them.
 *
 * @returns the cleanup errors that occurred (empty when teardown was clean).
 */
export async function stopVerificationStack(stack) {
  const errors = [];
  if (stack?.ui) {
    try {
      await stopProcess(stack.ui);
    } catch (error) {
      errors.push(error);
    }
  }
  if (stack?.gateway) {
    try {
      await stopProcess(stack.gateway);
    } catch (error) {
      errors.push(error);
    }
  }
  if (stack?.runtimeRoot) {
    try {
      await removeRuntimeRootWithRetry(stack.runtimeRoot);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const error of errors) {
    console.warn(`[verification] stack cleanup failure (non-fatal): ${error?.message ?? error}`);
  }
  return errors;
}

export async function waitForHttp(url, label, timeoutMs = 180000, handle = null) {
  const deadline = Date.now() + timeoutMs;
  const child = handle?.child;
  const processAbort = new AbortController();
  const abortProbe = () => processAbort.abort();
  child?.once?.("exit", abortProbe);
  child?.once?.("error", abortProbe);
  let lastStatus;
  try {
    while (true) {
      if (handle?.spawnError) {
        await handle.logsFlushed?.catch(() => undefined);
        throw handle.spawnError;
      }
      if (handle?.child && hasExited(handle.child)) {
        await handle.logsFlushed?.catch(() => undefined);
        const stdoutPath = handle.stdoutPath ? ` stdout: ${handle.stdoutPath}` : "";
        const stderrPath = handle.stderrPath ? ` stderr: ${handle.stderrPath}` : "";
        throw new Error(`${label} process exited before becoming ready.${stdoutPath}${stderrPath}`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(remaining), processAbort.signal]);
        const response = await fetch(url, { signal });
        await response.body?.cancel().catch(() => undefined);
        if (processAbort.signal.aborted) continue;
        if (response.ok) {
          return;
        }
        lastStatus = response.status;
      } catch (error) {
        if (processAbort.signal.aborted) continue;
        const code = error?.cause?.code ?? error?.code;
        if (code === "EACCES" || code === "EPERM") {
          throw new Error(
            `${label} probe was denied (${code}); the verification environment must permit loopback connections: ${url}`,
            { cause: error },
          );
        }
        // Connection refusal during startup is retryable; a denied probe is not.
      }
      const retryDelay = Math.min(1500, deadline - Date.now());
      if (retryDelay > 0) {
        await sleep(retryDelay, undefined, { signal: processAbort.signal }).catch((error) => {
          if (!processAbort.signal.aborted) throw error;
        });
      }
    }
  } finally {
    child?.off?.("exit", abortProbe);
    child?.off?.("error", abortProbe);
  }
  throw new Error(
    `${label} did not become ready in time: ${url}${lastStatus ? ` (last HTTP status: ${lastStatus})` : ""}`,
  );
}

export async function startProcess(context, name, commandArgs, extraEnv, options = {}) {
  const [command, ...args] = commandArgs;
  const diagnosticsDir = path.join(context.artifactRoot, "diagnostics");
  const stdoutPath = path.join(diagnosticsDir, `${name}.stdout.log`);
  const stderrPath = path.join(diagnosticsDir, `${name}.stderr.log`);
  // Attempt both log files independently even if the directory could not be created.
  await fs.mkdir(diagnosticsDir, { recursive: true }).catch(() => undefined);
  const child = spawnVerificationProcess(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: buildVerificationProcessEnv(process.env, extraEnv, options.omitEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handle = {
    child,
    stdoutPath,
    stderrPath,
    spawnError: null,
    logsFlushed: null,
  };
  // Without an 'error' listener, an async spawn failure (e.g. ENOENT because the binary is
  // not on PATH, or EACCES) is re-thrown as an uncaught exception on a later tick — outside
  // the caller's try/catch — crashing the whole verification run and leaking the temp root.
  // Record it instead so waiters can surface it as a normal rejected promise.
  child.once("error", (error) => {
    handle.spawnError = error;
  });
  let drainTimer;
  child.once("exit", () => {
    // Descendants can inherit the pipes and otherwise hold them open after exit.
    drainTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, 2000);
    drainTimer.unref();
  });
  child.once("close", () => clearTimeout(drainTimer));
  handle.logsFlushed = Promise.all([
    writeProcessDiagnostics(child, child.stdout, stdoutPath),
    writeProcessDiagnostics(child, child.stderr, stderrPath),
  ]).then(() => undefined);
  return handle;
}

function writeProcessDiagnostics(child, source, outputPath) {
  const log = createWriteStream(outputPath);
  const completion = finished(log, { cleanup: true }).catch((error) => {
    // Keep draining the child and writing the other log if this destination fails.
    source?.unpipe(log);
    source?.resume();
    console.warn(`[verification] could not write ${outputPath}: ${error?.message ?? error}`);
  });
  source?.once("error", (error) => log.destroy(error));
  source?.pipe(log);
  child.once("close", () => {
    // Cover failed spawns and deliberately destroyed inherited pipes as well as EOF.
    if (!log.destroyed && !log.writableEnded) log.end();
  });
  return completion;
}

/** The verification stack's own Gateway variables; startProcess merges them over the inherited env. */
export function buildVerificationGatewayEnv(
  { runtimeRoot, gatewayPort, uiUrl, gatewayEnv, gatewayEnvOmit },
  baseEnv = process.env,
) {
  return withVerificationUiOrigin(
    {
      GOATCITADEL_ROOT_DIR: runtimeRoot,
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(gatewayPort),
      GOATCITADEL_AUTH_MODE: "none",
      GOATCITADEL_DATABASE_DRIVER: "sqlite",
      GOATCITADEL_DISABLE_SECRET_STORE: "true",
      GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "true",
      GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "false",
      // The Gateway otherwise reads, and copies to verify, the operator's real ~/.GoatCitadel/backups.
      GOATCITADEL_BACKUP_DIR: path.join(runtimeRoot, "backups"),
      ...gatewayEnv,
    },
    uiUrl,
    // Only what the Gateway would inherit: a lane that omits the shell's origin list must not get it back here.
    buildVerificationProcessEnv(baseEnv, {}, gatewayEnvOmit),
  );
}

export function buildVerificationProcessEnv(baseEnv, extraEnv = {}, omitEnv = []) {
  const env = { ...baseEnv };
  for (const key of omitEnv ?? []) {
    if (typeof key === "string" && key) {
      delete env[key];
    }
  }
  return { ...env, ...extraEnv };
}

/** Output-emitting builds reuse only validated same-worktree parent control metadata.
 * Gateway, UI launch and offline restore continue using the fully scrubbed runtime builder.
 */
export async function buildVerificationBuildEnv(baseEnv, extraEnv = {}, omitEnv = [], outputRoot = repoRoot) {
  const leaseEnv = await inheritedWorktreeOutputLockEnvironment(outputRoot, baseEnv);
  const env = buildVerificationProcessEnv(baseEnv, extraEnv, omitEnv);
  for (const key of [WORKTREE_OUTPUT_LOCK_LEASE_ENV, WORKTREE_OUTPUT_LOCK_PATH_ENV, WORKTREE_OUTPUT_LOCK_ROOT_ENV])
    delete env[key];
  const buildEnv = { ...env, ...leaseEnv };
  // Nested pnpm scripts can push a Windows PATH past cmd.exe's 8191-character
  // boundary. Keep every distinct search entry in its original order/spelling.
  if (process.platform === "win32") {
    for (const key of Object.keys(buildEnv)) {
      if (key.toLowerCase() !== "path" || typeof buildEnv[key] !== "string") continue;
      const seen = new Set();
      buildEnv[key] = buildEnv[key].split(";").filter(entry => {
        const identity = entry.toLowerCase();
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      }).join(";");
    }
  }
  return buildEnv;
}

export function buildVerificationProcessLogName(name, processLogPrefix) {
  const prefix = typeof processLogPrefix === "string" ? sanitizeFilePart(processLogPrefix.trim()) : "";
  return prefix ? `${prefix}-${name}` : name;
}

export function buildVerificationGatewayCommand() {
  return [
    process.execPath,
    path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(repoRoot, "apps", "gateway", "src", "main.ts"),
  ];
}

export function buildVerificationUiCommand(packageName, port, uiMode) {
  const packageDirName = packageName.split("/").at(-1) || "mission-control-next";
  const viteCliPath = path.join(repoRoot, "apps", packageDirName, "node_modules", "vite", "bin", "vite.js");
  return [
    process.execPath,
    viteCliPath,
    ...(uiMode === "preview" ? ["preview"] : ["--force"]),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ];
}

export async function stopProcess(handle) {
  if (!handle?.child) {
    return;
  }
  if (hasExited(handle.child) || handle.spawnError) {
    return finishProcessCleanup(handle, true);
  }
  if (process.platform === "win32") {
    const treeKill = spawnSync(
      WINDOWS_CMD_PATH,
      ["/d", "/s", "/c", "taskkill", "/PID", String(handle.child.pid), "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    if (treeKill.error || treeKill.status !== 0) {
      try {
        handle.child.kill("SIGTERM");
      } catch {
        // The bounded wait below reports a process that could not be stopped.
      }
    }
    let exited = await waitForExit(handle.child, 12000).then(
      () => true,
      () => false,
    );
    if (!exited && !hasExited(handle.child)) {
      try {
        handle.child.kill("SIGKILL");
      } catch {
        // The final bounded wait reports the cleanup failure.
      }
      exited = await waitForExit(handle.child, 4000).then(
        () => true,
        () => false,
      );
    }
    return finishProcessCleanup(handle, exited);
  }
  handle.child.kill("SIGTERM");
  let exited = await waitForExit(handle.child, 8000).then(
    () => true,
    () => false,
  );
  if (!exited && !hasExited(handle.child)) {
    handle.child.kill("SIGKILL");
    exited = await waitForExit(handle.child, 4000).then(
      () => true,
      () => false,
    );
  }
  await finishProcessCleanup(handle, exited);
}

async function finishProcessCleanup(handle, exited) {
  try {
    if (!exited && !hasExited(handle.child)) {
      throw new Error(`Verification process ${handle.child.pid} did not stop within the cleanup deadline`);
    }
    await handle.logsFlushed?.catch(() => undefined);
  } finally {
    handle.child.stdout?.destroy();
    handle.child.stderr?.destroy();
  }
}

export async function requestJson(gatewayUrl, route, init = {}) {
  const method = init.method ?? "GET";
  const response = await fetch(`${gatewayUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

export function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildVerificationWorkspaceRefreshCommands() {
  return {
    gateway: ["--dir", repoRoot, "--filter", "@goatcitadel/gateway...", "build"],
    threadedSurfaceCore: [
      "--dir",
      repoRoot,
      "--filter",
      "@goatcitadel/threaded-surface-core",
      "exec",
      "tsc",
      "-b",
      "tsconfig.json",
      "--force",
    ],
  };
}

export async function ensureGatewayWorkspaceBuild(context, options = {}) {
  if (gatewayWorkspaceBuildEnsured) {
    return;
  }

  const gatewayPackageJson = JSON.parse(
    await fs.readFile(path.join(repoRoot, "apps", "gateway", "package.json"), "utf8"),
  );
  const workspacePackages = Object.keys(gatewayPackageJson.dependencies ?? {})
    .filter((dependency) => dependency.startsWith("@goatcitadel/"))
    .map((dependency) => {
      const packageName = dependency.replace("@goatcitadel/", "");
      return {
        dependency,
        packageName,
        outputPath: path.join(repoRoot, "packages", packageName, "dist", "index.js"),
      };
    });
  workspacePackages.push(
    {
      dependency: "@goatcitadel/mission-control-shared",
      packageName: "mission-control-shared",
      outputPath: path.join(repoRoot, "packages", "mission-control-shared", "dist", "index.js"),
    },
    {
      dependency: "@goatcitadel/threaded-surface-core",
      packageName: "threaded-surface-core",
      outputPath: path.join(repoRoot, "packages", "threaded-surface-core", "dist", "index.js"),
    },
  );
  const missingWorkspacePackages = workspacePackages.filter(({ outputPath }) => !existsSync(outputPath));

  const refreshCommands = buildVerificationWorkspaceRefreshCommands();
  const logLines = [
    "verification startup refreshes gateway workspace builds to avoid stale package outputs.",
    missingWorkspacePackages.length > 0 ? "" : "all expected workspace outputs already existed before refresh.",
    ...(missingWorkspacePackages.length > 0
      ? ["", "missing outputs detected:", ...missingWorkspacePackages.map(({ outputPath }) => outputPath)]
      : []),
    "",
    "$ pnpm --dir <repoRoot> --filter @goatcitadel/gateway... build",
    "",
  ];
  const result = await runPnpmSync(refreshCommands.gateway, options.omitEnv);
  logLines.push(
    result.stdout ?? "",
    result.stderr ?? "",
    result.error ? `${result.error.name}: ${result.error.message}` : "",
    "",
    "$ pnpm --dir <repoRoot> --filter @goatcitadel/threaded-surface-core exec tsc -b tsconfig.json --force",
    "",
  );
  const threadedSurfaceCoreResult = await runPnpmSync(refreshCommands.threadedSurfaceCore, options.omitEnv);
  logLines.push(
    threadedSurfaceCoreResult.stdout ?? "",
    threadedSurfaceCoreResult.stderr ?? "",
    threadedSurfaceCoreResult.error
      ? `${threadedSurfaceCoreResult.error.name}: ${threadedSurfaceCoreResult.error.message}`
      : "",
  );

  let remainingMissingPackages = missingWorkspacePackages.filter(({ outputPath }) => !existsSync(outputPath));
  for (const missingPackage of remainingMissingPackages) {
    logLines.push(
      "",
      `$ pnpm --dir <repoRoot> --filter ${missingPackage.dependency} exec tsc -b tsconfig.json --force`,
      "",
    );
    const forcedResult = await runPnpmSync(
      ["--dir", repoRoot, "--filter", missingPackage.dependency, "exec", "tsc", "-b", "tsconfig.json", "--force"],
      options.omitEnv,
    );
    logLines.push(
      forcedResult.stdout ?? "",
      forcedResult.stderr ?? "",
      forcedResult.error ? `${forcedResult.error.name}: ${forcedResult.error.message}` : "",
    );
    if (forcedResult.error || forcedResult.status !== 0) {
      const buildLogPath = path.join(
        context.artifactRoot,
        "diagnostics",
        `${buildVerificationProcessLogName("workspace-build", options.processLogPrefix)}.log`,
      );
      await writeText(buildLogPath, logLines.join("\n"));
      throw new Error(`Failed to build gateway workspace dependencies. See ${buildLogPath}`);
    }
  }

  remainingMissingPackages = missingWorkspacePackages.filter(({ outputPath }) => !existsSync(outputPath));
  const buildLogPath = path.join(
    context.artifactRoot,
    "diagnostics",
    `${buildVerificationProcessLogName("workspace-build", options.processLogPrefix)}.log`,
  );
  await writeText(buildLogPath, logLines.join("\n"));
  if (
    result.error ||
    result.status !== 0 ||
    threadedSurfaceCoreResult.error ||
    threadedSurfaceCoreResult.status !== 0 ||
    remainingMissingPackages.length > 0
  ) {
    throw new Error(`Failed to build gateway workspace dependencies. See ${buildLogPath}`);
  }

  gatewayWorkspaceBuildEnsured = true;
}

async function ensureVerificationUiBuild(context, packageName, uiEnv, options = {}) {
  const buildKey = JSON.stringify({
    overrides: Object.entries(uiEnv).sort(([a], [b]) => a.localeCompare(b)),
    omitEnv: [...(options.omitEnv ?? [])].sort(),
  });
  if (uiBuildKeys.get(packageName) === buildKey) {
    return;
  }
  // A failed build may have already overwritten the older build's assets.
  uiBuildKeys.delete(packageName);

  const logLines = [
    "verification startup builds the UI before preview mode so visual proof does not run against Vite HMR/watch state.",
    "",
    `$ pnpm --dir <repoRoot> --filter ${packageName} build`,
    "",
  ];
  // Vite's production mode still emits React development code when NODE_ENV is
  // inherited as development. Pin the build only; keep fixture runtime modes.
  const result = await runPnpmSyncWithEnv(
    ["--dir", repoRoot, "--filter", packageName, "build"],
    { ...uiEnv, NODE_ENV: "production" },
    options.omitEnv,
  );
  logLines.push(
    result.stdout ?? "",
    result.stderr ?? "",
    result.error ? `${result.error.name}: ${result.error.message}` : "",
  );

  const buildLogPath = path.join(
    context.artifactRoot,
    "diagnostics",
    `${buildVerificationProcessLogName(`ui-build-${sanitizeFilePart(packageName)}`, options.processLogPrefix)}.log`,
  );
  await writeText(buildLogPath, logLines.join("\n"));
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to build verification UI ${packageName}. See ${buildLogPath}`);
  }

  uiBuildKeys.set(packageName, buildKey);
}

function runPnpmSync(args, omitEnv = []) {
  return runPnpmSyncWithEnv(args, {}, omitEnv);
}

async function runPnpmSyncWithEnv(args, extraEnv, omitEnv = []) {
  const env = await buildVerificationBuildEnv(process.env, extraEnv, omitEnv);
  if (process.platform === "win32") {
    return spawnSync(WINDOWS_CMD_PATH, ["/d", "/s", "/c", pnpmCommand(), ...args], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
  }
  return spawnSync(pnpmCommand(), args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

// The Gateway's built-in explicit origins (apps/gateway/src/cors-origin-guard.ts). Setting
// GOATCITADEL_ALLOWED_ORIGINS replaces them, so they are kept next to the UI origin.
const GATEWAY_DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:8787",
];

/**
 * Names the stack's UI origin in the Gateway's explicit allowed origins. The Gateway trusts a loopback
 * origin on an arbitrary port only when auth is on, so with the stack's default auth mode "none" the UI's
 * own port must be listed, as an operator serving the UI on a custom port would list it.
 */
export function withVerificationUiOrigin(gatewayEnv, uiOrigin, baseEnv = process.env) {
  if (!uiOrigin) return gatewayEnv;
  const configured = gatewayEnv.GOATCITADEL_ALLOWED_ORIGINS ?? baseEnv.GOATCITADEL_ALLOWED_ORIGINS ?? "";
  const listed = configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origins = new Set([...(listed.length > 0 ? listed : GATEWAY_DEFAULT_ALLOWED_ORIGINS), uiOrigin]);
  return { ...gatewayEnv, GOATCITADEL_ALLOWED_ORIGINS: [...origins].join(",") };
}

async function resolveUiPort(preferredPort, gatewayPort) {
  let port = await resolveAvailablePort(Number(preferredPort ?? 0));
  // Neither port is bound yet, so an ephemeral pick can repeat the Gateway's.
  while (port === gatewayPort) port = await resolveAvailablePort(0);
  return port;
}

export async function resolveAvailablePort(preferredPort) {
  if (!Number.isFinite(preferredPort) || preferredPort <= 0) {
    return await resolveEphemeralPort();
  }
  const preferredIsFree = await isPortFree(preferredPort);
  if (preferredIsFree) {
    return preferredPort;
  }
  return await resolveEphemeralPort();
}

async function resolveEphemeralPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("failed to resolve an available port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function removeRuntimeRootWithRetry(runtimeRoot, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rm(runtimeRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      const isTransientCleanupLock = error?.code === "EBUSY" || error?.code === "EPERM" || error?.code === "EACCES";
      if (!isTransientCleanupLock || attempt === attempts - 1) {
        throw error;
      }
      await delay(1000 * (attempt + 1));
    }
  }
}

function hasExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (hasExited(child)) {
      resolve();
      return;
    }
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("process exit timeout"));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}
