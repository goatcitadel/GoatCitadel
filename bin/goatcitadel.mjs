#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { resolveUiTarget } from "../scripts/lib/ui-target.mjs";

const defaultRepoUrl = process.env.GOATCITADEL_REPO_URL || "https://github.com/goatcitadel/GoatCitadel.git";
const preferredBaseDir = path.join(os.homedir(), ".GoatCitadel");
const legacyBaseDir = path.join(os.homedir(), ".goatcitadel");
const pnpmVersion = "10.31.0";
const workspaceRuntimeBuildPackages = [
  "@goatcitadel/contracts",
  "@goatcitadel/extensions-sdk",
  "@goatcitadel/memory-core",
  "@goatcitadel/storage",
  "@goatcitadel/gateway-core",
  "@goatcitadel/mesh-core",
  "@goatcitadel/orchestration",
  "@goatcitadel/skills",
  "@goatcitadel/policy-engine",
];
const managedWorkspaceTooling = [
  {
    bin: "tsc",
    label: "TypeScript compiler",
    purpose: "package builds and typechecks",
  },
  {
    bin: "tsx",
    label: "TSX runner",
    purpose: "doctor, gateway, and script execution",
  },
  {
    bin: "vitest",
    label: "Vitest runner",
    purpose: "targeted package verification",
  },
];
const managedLocalConfigPaths = [
  "config/assistant.config.json",
  "config/tool-policy.json",
  "config/budgets.json",
  "config/llm-providers.json",
  "config/cron-jobs.json",
  "config/goatcitadel.json",
  "config/private-beta.profile.json",
];
const WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe";

const args = process.argv.slice(2);
const command = args[0] || "help";
const rawRest = args.slice(1);
const runtimeArgs = extractVerboseFlag(rawRest);
const installArgs =
  command === "install" || command === "update" || command === "uninstall"
    ? parseInstallArgs(rawRest)
    : { passthrough: runtimeArgs.passthrough, verbose: runtimeArgs.verbose };
const repoUrl = installArgs.repoUrl || defaultRepoUrl;
const baseDir = resolveBaseDir(installArgs.installDir);
const appDir = resolveAppDir(baseDir);
const binDir = path.join(baseDir, "bin");
const packagedReleaseManifestPath = path.join(appDir, "release-manifest.json");
const packagedGatewayDir = path.join(appDir, "gateway");
const packagedGatewayEntry = path.join(packagedGatewayDir, "dist", "main.js");
const packagedUiDistDir = path.join(appDir, "mission-control", "dist");
const packagedUiServerEntry = path.join(appDir, "runtime", "ui-static-server.mjs");
const packagedNodeExecutable = path.join(appDir, "runtime", "node", process.platform === "win32" ? "node.exe" : "node");
const packagedTemplateConfigDir = path.join(appDir, "templates", "config");
const packagedTemplateSkillsDir = path.join(appDir, "templates", "skills");
const packagedTemplateWorkspacesDir = path.join(appDir, "templates", "workspaces");
const packagedTemplateEnvPath = path.join(appDir, "templates", ".env.example");
const packagedRuntimeRoot = path.join(baseDir, "runtime-root");
const runtimeStateDir = path.join(baseDir, "runtime");
const runtimeLogDir = path.join(runtimeStateDir, "logs");
const gatewayPidPath = path.join(runtimeStateDir, "gateway.pid");
const uiPidPath = path.join(runtimeStateDir, "ui.pid");
const defaultGatewayUrl = "http://127.0.0.1:8787";
const defaultUiUrl = "http://127.0.0.1:5173";
const rest = installArgs.passthrough;
const taskTitle = resolveTaskTitle(command);
const verboseEnv = installArgs.verbose ? { GOATCITADEL_VERBOSE: "1" } : {};
const runtimeProcessEnv = {
  ...process.env,
  ...verboseEnv,
  GOATCITADEL_TERMINAL_TASK: taskTitle,
};
let jsonStdoutMode = false;

async function main() {
  setTerminalTitle(taskTitle);

  if (command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "install" || command === "update") {
    installOrUpdate();
    return;
  }

  if (command === "uninstall") {
    await uninstallInstall();
    return;
  }

  if (command === "secrets") {
    secrets(rest);
    return;
  }

  if (command === "status") {
    await printRuntimeCommandResult(() => readRuntimeStatus(), rest);
    return;
  }

  if (command === "stop") {
    await printRuntimeCommandResult(() => stopGoatCitadelRuntime(), rest);
    return;
  }

  if (!isPackagedInstall() && !fs.existsSync(path.join(appDir, "package.json"))) {
    console.log("GoatCitadel is not installed yet. Bootstrapping now...");
    installOrUpdate();
  }

  if (command === "launch") {
    await launchGoatCitadel(rest);
    return;
  }
  if (command === "up") {
    if (isPackagedInstall()) {
      await launchGoatCitadel(rest);
      return;
    }
    ensureWorkspaceRuntimeBuilds();
    runPnpm(["--dir", appDir, "dev", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "gateway") {
    ensureWorkspaceRuntimeBuilds();
    runPnpm(["--dir", appDir, "dev:gateway", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "ui") {
    ensureWorkspaceRuntimeBuilds();
    runPnpm(["--dir", appDir, "dev:ui", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "onboard") {
    ensureWorkspaceRuntimeBuilds();
    runPnpm(["--dir", appDir, "onboarding:tui", ...rest], {
      env: {
        ...runtimeProcessEnv,
        GOATCITADEL_APP_DIR: appDir,
      },
    });
    return;
  }
  if (command === "tui") {
    ensureWorkspaceRuntimeBuilds();
    runPnpm(["--dir", appDir, "tui", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "tools") {
    ensureWorkspaceRuntimeBuilds();
    runPnpm(["--dir", appDir, "tools", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "voice") {
    ensureWorkspaceRuntimeBuilds();
    runPnpm(["--dir", appDir, "--filter", "@goatcitadel/gateway", "run", "voice:runtime", ...rest], {
      env: runtimeProcessEnv,
    });
    return;
  }
  if (command === "verify") {
    ensureWorkspaceRuntimeBuilds();
    const lane = rest[0] || "fast";
    const laneArgs = rest.slice(1);
    const supportedLanes = new Set(["fast", "install", "all", "review", "soak", "deep:core", "deep:ecosystem"]);
    if (!supportedLanes.has(lane)) {
      throw new Error(`Unsupported verify lane: ${lane}`);
    }
    const scriptName =
      lane === "deep:core"
        ? "verify:deep:core"
        : lane === "deep:ecosystem"
          ? "verify:deep:ecosystem"
          : `verify:${lane}`;
    runPnpm(["--dir", appDir, scriptName, ...laneArgs], { env: runtimeProcessEnv });
    return;
  }
  if (command === "admin") {
    ensureWorkspaceRuntimeBuilds();
    runPnpm(["--dir", appDir, "admin", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "smoke") {
    ensureWorkspaceRuntimeBuilds();
    runPnpm(["--dir", appDir, "smoke", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "npu" || command === "npu-sidecar") {
    run("python", [path.join(appDir, "apps", "npu-sidecar", "server.py"), ...rest]);
    return;
  }
  if (command === "doctor") {
    doctor(rest);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function installOrUpdate() {
  const gitCmd = requireCommand("git");
  requireCommand("node");
  const corepackCmd = requireCommand("corepack");
  let preservedManagedConfig = null;

  fs.mkdirSync(baseDir, { recursive: true });

  if (fs.existsSync(path.join(appDir, ".git"))) {
    console.log(`Updating GoatCitadel in ${appDir}...`);
    run(gitCmd, ["-C", appDir, "fetch", "--all", "--prune"]);
    preservedManagedConfig = preserveManagedConfigForUpdate(gitCmd, appDir);
    run(gitCmd, ["-C", appDir, "pull", "--ff-only"]);
    restorePreservedManagedConfig(appDir, preservedManagedConfig);
  } else {
    if (fs.existsSync(appDir)) {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
    console.log(`Cloning GoatCitadel from ${repoUrl}...`);
    run(gitCmd, ["clone", repoUrl, appDir]);
  }

  printManagedInstallNotice({
    title: `Preparing pnpm (${pnpmVersion})...`,
    what: `the managed pnpm launcher for GoatCitadel's workspace`,
    why: "GoatCitadel uses pnpm to materialize local package binaries and run workspace build, doctor, and verification commands.",
  });
  run(corepackCmd, ["enable"]);
  run(corepackCmd, ["prepare", `pnpm@${pnpmVersion}`, "--activate"]);
  installWorkspaceDependencies(
    "GoatCitadel needs its local workspace dependencies and command shims before it can build runtime packages and run diagnostics.",
  );
  buildWorkspaceRuntimePackages();
  console.log("Materializing local config from tracked examples...");
  runPnpm(["--dir", appDir, "config:sync"], {
    env: runtimeProcessEnv,
  });
  materializeInstallerConfigExamples(appDir);
  materializeInstallerEnvDefaults(appDir);
  printManagedInstallNotice({
    title: "Installing Playwright Chromium runtime...",
    what: "the managed Chromium browser used by GoatCitadel browser automation",
    why: "Browser tools, screenshot capture, and Playwright-backed verification flows need a local browser runtime to run safely and predictably.",
  });
  runPnpm(["--dir", appDir, "--filter", "@goatcitadel/policy-engine", "exec", "playwright", "install", "chromium"], {
    env: runtimeProcessEnv,
  });
  if (!installArgs.skipVoice) {
    printManagedInstallNotice({
      title: `Installing managed local voice runtime (${installArgs.voiceModel})...`,
      what: "the managed local whisper.cpp voice runtime",
      why: "Voice transcription and local speech features need a downloaded runtime before GoatCitadel can use them.",
    });
    try {
      runPnpm(
        [
          "--dir",
          appDir,
          "--filter",
          "@goatcitadel/gateway",
          "run",
          "voice:runtime",
          "install",
          "--model",
          installArgs.voiceModel,
        ],
        {
          env: {
            ...runtimeProcessEnv,
            GOATCITADEL_DATABASE_DRIVER: "sqlite",
          },
        },
      );
    } catch (error) {
      console.warn(
        `Managed voice runtime install failed: ${error instanceof Error ? error.message : String(error)}. ` +
          "Core GoatCitadel install is complete. Repair later with `goatcitadel voice install`.",
      );
    }
  }

  console.log("");
  console.log("GoatCitadel install complete.");
  console.log(`Install directory: ${appDir}`);
  console.log("Run:");
  console.log("  goatcitadel verify install");
  console.log("  goatcitadel up");
  console.log("  goatcitadel onboard");
  console.log("  goatcitadel doctor --deep");
  console.log("  goatcitadel voice status");
  console.log("  goat verify install");
  console.log("  goat up");
  console.log("  goat onboard");
  console.log("  goat doctor --deep");
  console.log("  goat voice status");
  console.log("  Managed GoatCitadel config is preserved across installer updates.");
}

function parseInstallArgs(argv) {
  let installDir;
  let repoUrlOverride;
  let skipVoice = false;
  let voiceModel = "base.en";
  let force = false;
  let verbose = false;
  const passthrough = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--install-dir") {
      installDir = argv[index + 1];
      if (!installDir) {
        throw new Error("Missing value for --install-dir");
      }
      index += 1;
      continue;
    }
    if (value === "--repo") {
      repoUrlOverride = argv[index + 1];
      if (!repoUrlOverride) {
        throw new Error("Missing value for --repo");
      }
      index += 1;
      continue;
    }
    if (value === "--skip-voice") {
      skipVoice = true;
      continue;
    }
    if (value === "--voice-model") {
      voiceModel = argv[index + 1];
      if (!voiceModel) {
        throw new Error("Missing value for --voice-model");
      }
      index += 1;
      continue;
    }
    if (value === "--force" || value === "--yes" || value === "-y") {
      force = true;
      continue;
    }
    if (value === "--verbose" || value === "-verbose") {
      verbose = true;
      continue;
    }
    passthrough.push(value);
  }
  return {
    installDir,
    repoUrl: repoUrlOverride,
    skipVoice,
    voiceModel,
    force,
    verbose,
    passthrough,
  };
}

function extractVerboseFlag(argv) {
  const passthrough = [];
  let verbose = false;
  for (const value of argv) {
    if (value === "--verbose" || value === "-verbose") {
      verbose = true;
      continue;
    }
    passthrough.push(value);
  }
  return { verbose, passthrough };
}

function resolveBaseDir(installDirOverride) {
  if (installDirOverride?.trim()) {
    return path.resolve(installDirOverride.trim());
  }
  if (process.env.GOATCITADEL_HOME?.trim()) {
    return path.resolve(process.env.GOATCITADEL_HOME.trim());
  }
  return fs.existsSync(path.join(preferredBaseDir, "app"))
    ? preferredBaseDir
    : fs.existsSync(path.join(legacyBaseDir, "app"))
      ? legacyBaseDir
      : preferredBaseDir;
}

function resolveAppDir(currentBaseDir) {
  if (process.env.GOATCITADEL_APP_DIR?.trim()) {
    return path.resolve(process.env.GOATCITADEL_APP_DIR.trim());
  }
  if (
    fs.existsSync(path.join(currentBaseDir, "pnpm-workspace.yaml")) &&
    fs.existsSync(path.join(currentBaseDir, "bin", "goatcitadel.mjs"))
  ) {
    return currentBaseDir;
  }
  return path.join(currentBaseDir, "app");
}

function preserveManagedConfigForUpdate(gitCmd, repositoryPath) {
  const status = spawnCommandSync(gitCmd, ["-C", repositoryPath, "status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  });
  if (status.error) {
    throw status.error;
  }
  if (status.status !== 0) {
    throw new Error("Failed to inspect GoatCitadel working tree state.");
  }
  const dirtyPaths = String(status.stdout || "")
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  const unexpected = dirtyPaths.filter((item) => !managedLocalConfigPaths.includes(item));
  if (unexpected.length > 0) {
    throw new Error(
      `Update blocked because the installed checkout has non-config tracked changes: ${unexpected.join(", ")}`,
    );
  }
  const existingConfigPaths = managedLocalConfigPaths.filter((relativePath) =>
    fs.existsSync(path.join(repositoryPath, relativePath)),
  );
  if (existingConfigPaths.length === 0) {
    return null;
  }
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-update-"));
  for (const relativePath of existingConfigPaths) {
    const sourcePath = path.join(repositoryPath, relativePath);
    const backupPath = path.join(backupRoot, relativePath);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(sourcePath, backupPath);
  }
  for (const relativePath of dirtyPaths) {
    run(gitCmd, ["-C", repositoryPath, "restore", "--source=HEAD", "--", relativePath]);
  }
  return {
    backupRoot,
    paths: existingConfigPaths,
  };
}

function restorePreservedManagedConfig(repositoryPath, preservedState) {
  if (!preservedState) {
    return;
  }
  for (const relativePath of preservedState.paths) {
    const backupPath = path.join(preservedState.backupRoot, relativePath);
    if (!fs.existsSync(backupPath)) {
      continue;
    }
    const destinationPath = path.join(repositoryPath, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(backupPath, destinationPath);
  }
}

function materializeInstallerConfigExamples(repositoryPath) {
  const configDir = path.join(repositoryPath, "config");
  const optionalTemplates = ["private-beta.profile"];
  for (const stem of optionalTemplates) {
    const actualPath = path.join(configDir, `${stem}.json`);
    const examplePath = path.join(configDir, `${stem}.example.json`);
    if (fs.existsSync(actualPath) || !fs.existsSync(examplePath)) {
      continue;
    }
    fs.copyFileSync(examplePath, actualPath);
  }
}

function materializeInstallerEnvDefaults(repositoryPath) {
  const envPath = path.join(repositoryPath, ".env");
  const examplePath = path.join(repositoryPath, ".env.example");
  if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
  }
  if (setEnvFileDefault(envPath, "GOATCITADEL_DATABASE_DRIVER", "sqlite")) {
    console.log("Configured local .env database driver for install-safe startup: sqlite");
  }
}

function setEnvFileDefault(envPath, key, value) {
  let raw = "";
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    raw = "";
  }

  if (hasActiveEnvValue(raw, key)) {
    return false;
  }

  const nextLine = `${key}=${value}`;
  const next = raw.trim() ? `${raw.replace(/\s*$/u, "")}\n${nextLine}\n` : `${nextLine}\n`;
  fs.writeFileSync(envPath, next, "utf8");
  return true;
}

function hasActiveEnvValue(raw, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=`, "mu").test(raw);
}

function doctor(extraArgs = []) {
  console.log("Running GoatCitadel doctor...");
  ensureWorkspaceToolingReady(
    "Doctor depends on GoatCitadel's local workspace tooling so it can run repair flows, type-aware scripts, and targeted package checks.",
  );
  ensureWorkspaceRuntimeBuilds();
  runPnpm(["--dir", appDir, "--filter", "@goatcitadel/gateway", "run", "doctor", ...extraArgs], {
    env: runtimeProcessEnv,
  });
}

async function launchGoatCitadel(extraArgs = []) {
  const launchOptions = parseLaunchOptions(extraArgs);
  const gatewayUrl = process.env.GOATCITADEL_GATEWAY_URL || defaultGatewayUrl;
  const uiUrl = process.env.GOATCITADEL_MISSION_CONTROL_URL || defaultUiUrl;

  const result = await withJsonCleanStdout(launchOptions.json, async () => {
    ensureLaunchRuntimeDirectories();

    if (isPackagedInstall()) {
      seedPackagedRuntimeRoot();
      const nodeExecutable = resolvePackagedNodeExecutable();
      await ensureGatewayReady({
        packaged: true,
        gatewayUrl,
        nodeExecutable,
      });
      await ensureUiReady({
        packaged: true,
        gatewayUrl,
        uiUrl,
        nodeExecutable,
      });
    } else {
      ensureWorkspaceRuntimeBuilds();
      await ensureGatewayReady({
        packaged: false,
        gatewayUrl,
      });
      await ensureUiReady({
        packaged: false,
        gatewayUrl,
        uiUrl,
      });
    }

    return readRuntimeStatus({
      gatewayUrl,
      uiUrl,
      assumeReady: true,
    });
  });

  if (!launchOptions.noOpen) {
    openBrowser(result.targetUrl);
  }

  if (launchOptions.json) {
    writeJsonResult(result);
    return;
  }

  if (launchOptions.wait) {
    console.log(`GoatCitadel is ready at ${result.targetUrl}`);
  } else {
    console.log(`Launching GoatCitadel at ${result.targetUrl}`);
  }
}

function isPackagedInstall() {
  return (
    fs.existsSync(packagedReleaseManifestPath) &&
    fs.existsSync(packagedGatewayEntry) &&
    fs.existsSync(packagedUiDistDir) &&
    fs.existsSync(packagedUiServerEntry)
  );
}

function ensureLaunchRuntimeDirectories() {
  fs.mkdirSync(runtimeStateDir, { recursive: true });
  fs.mkdirSync(runtimeLogDir, { recursive: true });
}

async function readRuntimeStatus(options = {}) {
  const gatewayUrl = options.gatewayUrl || process.env.GOATCITADEL_GATEWAY_URL || defaultGatewayUrl;
  const uiUrl = options.uiUrl || process.env.GOATCITADEL_MISSION_CONTROL_URL || defaultUiUrl;
  ensureLaunchRuntimeDirectories();

  const gatewayPid = readManagedPid(gatewayPidPath);
  const uiPid = readManagedPid(uiPidPath);
  const gatewayReady = options.assumeReady === true || (await waitForHttp(`${gatewayUrl}/health`, 750, 1));
  const uiReady = options.assumeReady === true || (await waitForHttp(`${uiUrl}/health`, 750, 1));
  const startupState = gatewayReady
    ? await fetchJson(`${gatewayUrl}/api/v1/onboarding/startup`).catch(() => undefined)
    : undefined;
  const desktopEventStream = gatewayReady ? await issueDesktopEventStreamToken(gatewayUrl) : undefined;
  const onboardingCompleted = startupState?.completed === true;
  const targetUrl = onboardingCompleted ? `${uiUrl}/?tab=dashboard` : `${uiUrl}/?tab=onboarding`;
  const pidStates = [gatewayPid.state, uiPid.state];
  const anyAlive = pidStates.includes("running");
  const anyStale = pidStates.includes("stale");
  const anyReady = gatewayReady || uiReady;
  const status =
    gatewayReady && uiReady
      ? "ready"
      : anyAlive || anyReady
        ? "degraded"
        : anyStale
          ? "stale"
          : "stopped";

  return buildRuntimeCommandResult({
    status,
    gatewayUrl,
    uiUrl,
    targetUrl,
    onboardingCompleted,
    packaged: isPackagedInstall(),
    gatewayReady,
    uiReady,
    gatewayPid,
    uiPid,
    desktopEventStream,
  });
}

async function stopGoatCitadelRuntime() {
  ensureLaunchRuntimeDirectories();
  const before = await readRuntimeStatus();
  const stopped = [];
  const stale = [];

  for (const item of [
    { label: "ui", path: uiPidPath },
    { label: "gateway", path: gatewayPidPath },
  ]) {
    const pidInfo = readManagedPid(item.path);
    if (pidInfo.state === "running" && pidInfo.pid) {
      stopManagedProcess(pidInfo.pid);
      stopped.push({ label: item.label, pid: pidInfo.pid });
    } else if (pidInfo.state === "stale") {
      stale.push({ label: item.label, pid: pidInfo.pid });
    }
    fs.rmSync(item.path, { force: true });
  }

  const after = await readRuntimeStatus();
  return {
    ...after,
    action: "stop",
    previousStatus: before.status,
    stopped,
    stale,
  };
}

function buildRuntimeCommandResult({
  status,
  gatewayUrl,
  uiUrl,
  targetUrl,
  onboardingCompleted,
  packaged,
  gatewayReady,
  uiReady,
  gatewayPid,
  uiPid,
  desktopEventStream,
}) {
  return {
    status,
    gatewayUrl,
    uiUrl,
    targetUrl,
    packaged,
    runtimeRoot: packaged ? packagedRuntimeRoot : appDir,
    runtimeStateDir,
    pidFiles: {
      gateway: gatewayPidPath,
      ui: uiPidPath,
    },
    pids: {
      gateway: gatewayPid,
      ui: uiPid,
    },
    logFiles: {
      gatewayStdout: path.join(runtimeLogDir, "gateway.stdout.log"),
      gatewayStderr: path.join(runtimeLogDir, "gateway.stderr.log"),
      missionControlStdout: path.join(runtimeLogDir, "mission-control.stdout.log"),
      missionControlStderr: path.join(runtimeLogDir, "mission-control.stderr.log"),
    },
    readiness: {
      gateway: gatewayReady,
      ui: uiReady,
    },
    onboardingCompleted,
    ...(desktopEventStream ? { desktopEventStream } : {}),
    checkedAt: new Date().toISOString(),
  };
}

async function issueDesktopEventStreamToken(gatewayUrl) {
  try {
    const response = await fetch(`${gatewayUrl}/api/v1/auth/sse-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `desktop-sse-token:${randomUUID()}`,
        ...readLauncherOperatorAuthHeaders(),
      },
      body: JSON.stringify({ scope: "events:stream" }),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload?.token) {
      return {
        scope: payload.scope || "events:stream",
        token: payload.token,
        expiresAt: payload.expiresAt,
      };
    }
    if (response.status === 400 && /not needed/i.test(String(payload?.error ?? ""))) {
      return {
        scope: "events:stream",
        authMode: "none",
      };
    }
    return {
      scope: "events:stream",
      error: payload?.error || `SSE token request failed with HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      scope: "events:stream",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readLauncherOperatorAuthHeaders() {
  const token = process.env.GOATCITADEL_AUTH_TOKEN?.trim();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  const username = process.env.GOATCITADEL_AUTH_BASIC_USERNAME?.trim();
  const password = process.env.GOATCITADEL_AUTH_BASIC_PASSWORD;
  if (username && password) {
    return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
  }
  return {};
}

function readManagedPid(filePath) {
  if (!fs.existsSync(filePath)) {
    return { state: "missing" };
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { state: "invalid", raw };
  }
  return {
    pid,
    state: isProcessAlive(pid) ? "running" : "stale",
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopManagedProcess(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T"], { stdio: "ignore" });
    if (isProcessAlive(pid)) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const start = Date.now();
  while (Date.now() - start < 2500 && isProcessAlive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best effort stop.
    }
  }
}

async function printRuntimeCommandResult(fn, args) {
  const options = parseRuntimeOutputOptions(args);
  const result = await withJsonCleanStdout(options.json, fn);
  if (options.json) {
    writeJsonResult(result);
    return;
  }
  console.log(`${result.status}: ${result.targetUrl}`);
}

function parseLaunchOptions(args) {
  const options = {
    json: false,
    noOpen: false,
    wait: false,
  };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-open") {
      options.noOpen = true;
    } else if (arg === "--wait") {
      options.wait = true;
    } else {
      throw new Error(`Unsupported launch flag: ${arg}`);
    }
  }
  return options;
}

function parseRuntimeOutputOptions(args) {
  const options = { json: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unsupported runtime flag: ${arg}`);
  }
  return options;
}

async function withJsonCleanStdout(json, fn) {
  if (!json) {
    return fn();
  }
  const originalLog = console.log;
  const originalJsonStdoutMode = jsonStdoutMode;
  jsonStdoutMode = true;
  console.log = (...args) => console.error(...args);
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    jsonStdoutMode = originalJsonStdoutMode;
  }
}

function writeJsonResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function seedPackagedRuntimeRoot() {
  fs.mkdirSync(packagedRuntimeRoot, { recursive: true });
  seedDirectoryIfMissing(packagedTemplateConfigDir, path.join(packagedRuntimeRoot, "config"));
  seedDirectoryIfMissing(packagedTemplateSkillsDir, path.join(packagedRuntimeRoot, "skills"));
  seedDirectoryIfMissing(packagedTemplateWorkspacesDir, path.join(packagedRuntimeRoot, "workspaces"));
  if (!fs.existsSync(path.join(packagedRuntimeRoot, ".env")) && fs.existsSync(packagedTemplateEnvPath)) {
    fs.copyFileSync(packagedTemplateEnvPath, path.join(packagedRuntimeRoot, ".env"));
  }
  fs.mkdirSync(path.join(packagedRuntimeRoot, "data"), { recursive: true });
  fs.mkdirSync(path.join(packagedRuntimeRoot, "artifacts"), { recursive: true });
}

function seedDirectoryIfMissing(sourceDir, destinationDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }
  if (!fs.existsSync(destinationDir)) {
    fs.cpSync(sourceDir, destinationDir, { recursive: true });
    return;
  }
  copyMissingEntries(sourceDir, destinationDir);
}

function copyMissingEntries(sourceDir, destinationDir) {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destinationPath)) {
        fs.cpSync(sourcePath, destinationPath, { recursive: true });
      } else {
        copyMissingEntries(sourcePath, destinationPath);
      }
      continue;
    }
    if (!fs.existsSync(destinationPath)) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function resolvePackagedNodeExecutable() {
  return fs.existsSync(packagedNodeExecutable) ? packagedNodeExecutable : process.execPath;
}

async function ensureGatewayReady({ packaged, gatewayUrl, nodeExecutable }) {
  if (await waitForHttp(`${gatewayUrl}/health`, 1500, 2)) {
    return;
  }
  if (packaged) {
    startPackagedGateway(nodeExecutable, gatewayUrl);
  } else {
    startSourceGateway(gatewayUrl);
  }
  if (!(await waitForHttp(`${gatewayUrl}/health`, 180000))) {
    throw new Error(`Gateway did not become healthy at ${gatewayUrl}`);
  }
}

async function ensureUiReady({ packaged, gatewayUrl, uiUrl, nodeExecutable }) {
  if (await waitForHttp(`${uiUrl}/health`, 1500, 2)) {
    return;
  }
  if (packaged) {
    startPackagedUi(nodeExecutable, uiUrl);
  } else {
    startSourceUi(gatewayUrl, uiUrl);
  }
  if (!(await waitForHttp(`${uiUrl}/health`, 180000))) {
    throw new Error(`Mission Control did not become healthy at ${uiUrl}`);
  }
}

function startPackagedGateway(nodeExecutable, gatewayUrl) {
  const port = String(new URL(gatewayUrl).port || "8787");
  writePidFile(
    gatewayPidPath,
    spawnDetachedProcess({
      cmd: nodeExecutable,
      args: [packagedGatewayEntry],
      cwd: packagedGatewayDir,
      env: {
        ...runtimeProcessEnv,
        GOATCITADEL_ROOT_DIR: packagedRuntimeRoot,
        GOATCITADEL_DATABASE_DRIVER: "sqlite",
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: port,
      },
      stdoutPath: path.join(runtimeLogDir, "gateway.stdout.log"),
      stderrPath: path.join(runtimeLogDir, "gateway.stderr.log"),
    }),
  );
}

function startPackagedUi(nodeExecutable, uiUrl) {
  const port = String(new URL(uiUrl).port || "5173");
  writePidFile(
    uiPidPath,
    spawnDetachedProcess({
      cmd: nodeExecutable,
      args: [packagedUiServerEntry],
      cwd: appDir,
      env: {
        ...runtimeProcessEnv,
        GOATCITADEL_UI_DIST_DIR: packagedUiDistDir,
        GOATCITADEL_UI_HOST: "127.0.0.1",
        GOATCITADEL_UI_PORT: port,
      },
      stdoutPath: path.join(runtimeLogDir, "mission-control.stdout.log"),
      stderrPath: path.join(runtimeLogDir, "mission-control.stderr.log"),
    }),
  );
}

function startSourceGateway(gatewayUrl) {
  const runner = resolvePnpmRunner();
  const port = String(new URL(gatewayUrl).port || "8787");
  writePidFile(
    gatewayPidPath,
    spawnDetachedProcess({
      cmd: runner.cmd,
      args: [...runner.prefix, "--dir", appDir, "dev:gateway"],
      cwd: appDir,
      env: {
        ...runtimeProcessEnv,
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: port,
      },
      stdoutPath: path.join(runtimeLogDir, "gateway.stdout.log"),
      stderrPath: path.join(runtimeLogDir, "gateway.stderr.log"),
    }),
  );
}

function startSourceUi(gatewayUrl, uiUrl) {
  const runner = resolvePnpmRunner();
  const port = String(new URL(uiUrl).port || "5173");
  const uiTarget = resolveUiTarget(appDir, runtimeProcessEnv);
  writePidFile(
    uiPidPath,
    spawnDetachedProcess({
      cmd: runner.cmd,
      args: [
        ...runner.prefix,
        "--dir",
        appDir,
        "--filter",
        uiTarget.packageName,
        "exec",
        "vite",
        "--host",
        "127.0.0.1",
        "--port",
        port,
      ],
      cwd: appDir,
      env: {
        ...runtimeProcessEnv,
        VITE_GATEWAY_URL: gatewayUrl,
      },
      stdoutPath: path.join(runtimeLogDir, "mission-control.stdout.log"),
      stderrPath: path.join(runtimeLogDir, "mission-control.stderr.log"),
    }),
  );
}

function spawnDetachedProcess({ cmd, args, cwd, env, stdoutPath, stderrPath }) {
  const stdoutFd = fs.openSync(stdoutPath, "a");
  const stderrFd = fs.openSync(stderrPath, "a");
  const child = isWindowsBatchCommand(cmd)
    ? spawn(WINDOWS_CMD_PATH, ["/d", "/s", "/c", buildWindowsCommand([cmd, ...args])], {
        cwd,
        env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      })
    : spawn(cmd, args, {
        cwd,
        env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
  child.unref();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  return child.pid ?? 0;
}

function writePidFile(filePath, pid) {
  if (!pid) {
    return;
  }
  fs.writeFileSync(filePath, String(pid), "utf8");
}

async function waitForHttp(url, timeoutMs, attempts = 120) {
  const startedAt = Date.now();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // keep waiting
    }
    if (Date.now() - startedAt >= timeoutMs) {
      break;
    }
    await sleep(Math.min(1500, Math.max(250, Math.floor(timeoutMs / Math.max(1, attempts)))));
  }
  return false;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn(WINDOWS_CMD_PATH, ["/d", "/s", "/c", "start", '""', url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      return;
    }
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch (error) {
    console.warn(`Unable to open browser automatically: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`Open ${url}`);
  }
}

async function uninstallInstall() {
  const force = Boolean(installArgs.force);
  const installed = fs.existsSync(baseDir);
  if (!installed) {
    console.log(`No GoatCitadel install found at ${baseDir}.`);
    await removeLauncherPathRegistration();
    return;
  }

  if (!force) {
    const confirmed = await confirmUninstall(baseDir);
    if (!confirmed) {
      console.log("Uninstall cancelled.");
      return;
    }
  }

  await removeLauncherPathRegistration();
  scheduleInstallRemoval(baseDir);
  console.log(`Scheduled GoatCitadel uninstall for ${baseDir}`);
  console.log("Open a new shell after uninstall so PATH changes take effect.");
}

async function confirmUninstall(targetDir) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Uninstall requires a TTY confirmation prompt or --force.");
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`Remove GoatCitadel completely from ${targetDir}? Type 'yes' to continue: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function removeLauncherPathRegistration() {
  const normalizedBinDir = normalizePathForCompare(binDir);
  if (process.platform === "win32") {
    const currentShellPath = process.env.Path ?? process.env.PATH ?? "";
    const nextShellPath = removePathEntry(currentShellPath, normalizedBinDir, ";");
    process.env.Path = nextShellPath;
    process.env.PATH = nextShellPath;
    run(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$current = [Environment]::GetEnvironmentVariable('Path','User'); ` +
          `$parts = @(); ` +
          `if (-not [string]::IsNullOrWhiteSpace($current)) { ` +
          `$parts = $current -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' } } ` +
          `$target = ${toPowershellSingleQuoted(binDir)}; ` +
          `$next = @($parts | Where-Object { $_ -ne $target }) -join ';'; ` +
          `[Environment]::SetEnvironmentVariable('Path', $next, 'User')`,
      ],
      {
        stdio: "ignore",
      },
    );
    return;
  }

  const profileFiles = [
    path.join(os.homedir(), ".zshrc"),
    path.join(os.homedir(), ".bashrc"),
    path.join(os.homedir(), ".profile"),
  ];
  const pathLine = `export PATH="${binDir}:$PATH"`;
  for (const profileFile of profileFiles) {
    if (!fs.existsSync(profileFile)) {
      continue;
    }
    const original = fs.readFileSync(profileFile, "utf8");
    const block = `# GoatCitadel\n${pathLine}`;
    let updated = original
      .replace(block, "")
      .replace(block.replace(/\n/g, "\r\n"), "")
      .replace(/\n{3,}/g, "\n\n");
    if (updated !== original) {
      updated = updated.trimEnd();
      fs.writeFileSync(profileFile, updated ? `${updated}\n` : "", "utf8");
    }
  }
}

function scheduleInstallRemoval(targetDir) {
  const cleanupScriptPath = path.join(os.tmpdir(), `goatcitadel-uninstall-${process.pid}-${Date.now()}.mjs`);
  const cleanupScript = `import fs from "node:fs/promises";
import path from "node:path";

const target = ${JSON.stringify(targetDir)};
const scriptPath = ${JSON.stringify(cleanupScriptPath)};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      break;
    } catch {
      await delay(1000 * (attempt + 1));
    }
  }
  try {
    await fs.rm(scriptPath, { force: true });
  } catch {}
}

  await delay(1500);
await main();
`;
  fs.writeFileSync(cleanupScriptPath, cleanupScript, "utf8");
  const child = spawn(process.execPath, [cleanupScriptPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function removePathEntry(currentPath, targetEntry, separator) {
  return currentPath
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => normalizePathForCompare(part) !== targetEntry)
    .join(separator);
}

function normalizePathForCompare(value) {
  return path
    .resolve(value)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function toPowershellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function ensureWorkspaceRuntimeBuilds() {
  ensureWorkspaceToolingReady(
    "GoatCitadel needs local workspace tooling before it can build runtime packages for this command.",
  );
  let builtAny = false;
  for (const workspacePackage of workspaceRuntimeBuildPackages) {
    if (workspacePackageNeedsBuild(workspacePackage)) {
      if (!builtAny) {
        console.log("Preparing GoatCitadel workspace packages...");
        builtAny = true;
      }
      console.log(`  Building ${workspacePackage}...`);
      runPnpm(["--dir", appDir, "--filter", workspacePackage, "build"]);
    }
  }
}

function buildWorkspaceRuntimePackages() {
  for (const workspacePackage of workspaceRuntimeBuildPackages) {
    console.log(`Building runtime package ${workspacePackage}...`);
    runPnpm(["--dir", appDir, "--filter", workspacePackage, "build"]);
  }
}

function ensureWorkspaceToolingReady(reason) {
  const state = inspectWorkspaceTooling(appDir);
  if (!state.needsInstall) {
    return;
  }
  const detail = state.missing.map((item) => `${item.label} (${item.purpose})`).join(", ");
  printManagedInstallNotice({
    title: "Restoring GoatCitadel workspace tooling...",
    what: detail || "local workspace dependencies and command shims",
    why: reason,
  });
  installWorkspaceDependencies(reason);
  const after = inspectWorkspaceTooling(appDir);
  if (after.needsInstall) {
    throw new Error(
      `Workspace tooling is still incomplete after install: ${after.missing.map((item) => item.label).join(", ")}`,
    );
  }
}

function installWorkspaceDependencies(reason) {
  printManagedInstallNotice({
    title: "Installing workspace dependencies...",
    what: "GoatCitadel's local package graph and command shims under node_modules/.bin",
    why: reason,
  });
  const frozenResult = spawnPnpmCommand(["--dir", appDir, "install", "--frozen-lockfile"], {
    env: runtimeProcessEnv,
  });
  if (!frozenResult.error && frozenResult.status === 0) {
    return;
  }
  const combinedOutput = `${frozenResult.stdout || ""}\n${frozenResult.stderr || ""}`;
  if (isOutdatedLockfileInstallFailure(combinedOutput)) {
    printManagedInstallNotice({
      title: "Refreshing workspace lock metadata...",
      what: "a reconciled pnpm lockfile install",
      why: "The package manifests moved ahead of pnpm-lock.yaml, so GoatCitadel needs to refresh lock metadata before it can restore the local toolchain cleanly.",
    });
    const relaxedResult = spawnPnpmCommand(["--dir", appDir, "install", "--no-frozen-lockfile"], {
      env: runtimeProcessEnv,
    });
    if (!relaxedResult.error && relaxedResult.status === 0) {
      return;
    }
    throw formatSpawnFailure("pnpm", ["--dir", appDir, "install", "--no-frozen-lockfile"], relaxedResult);
  }
  throw formatSpawnFailure("pnpm", ["--dir", appDir, "install", "--frozen-lockfile"], frozenResult);
}

function workspacePackageNeedsBuild(workspacePackage) {
  const packageDirName = workspacePackage.replace("@goatcitadel/", "");
  return !fs.existsSync(path.join(appDir, "packages", packageDirName, "dist", "index.js"));
}

function requireCommand(cmd) {
  const resolved = resolveCommandExecutable(cmd);
  if (!resolved) {
    throw new Error(`Missing required command: ${cmd}`);
  }
  return resolved;
}

function resolveCommandExecutable(cmd) {
  const candidates = process.platform === "win32" ? [cmd, `${cmd}.cmd`, `${cmd}.exe`] : [cmd];
  for (const candidate of candidates) {
    const result = spawnCommandSync(candidate, ["--version"], { encoding: "utf8" });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

function resolvePnpmRunner() {
  const localPnpm = path.join(baseDir, "bin", process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  if (fs.existsSync(localPnpm)) {
    return {
      cmd: localPnpm,
      prefix: [],
    };
  }

  const candidates = process.platform === "win32" ? ["pnpm.cmd", "pnpm", "pnpm.exe"] : ["pnpm"];

  for (const candidate of candidates) {
    const result = spawnCommandSync(candidate, ["--version"], { encoding: "utf8" });
    if (!result.error && result.status === 0) {
      return {
        cmd: candidate,
        prefix: [],
      };
    }
  }

  const corepackCmd = resolveCommandExecutable("corepack");
  if (corepackCmd) {
    return {
      cmd: corepackCmd,
      prefix: ["pnpm"],
    };
  }

  throw new Error("pnpm is not available. Run `corepack enable` or reinstall GoatCitadel prerequisites.");
}

function runPnpm(args, options = {}) {
  const runner = resolvePnpmRunner();
  run(runner.cmd, [...runner.prefix, ...args], options);
}

function spawnPnpmCommand(args, options = {}) {
  const runner = resolvePnpmRunner();
  return spawnCommandSync(runner.cmd, [...runner.prefix, ...args], {
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  });
}

function run(cmd, cmdArgs, options = {}) {
  const result = spawnCommandSync(cmd, cmdArgs, jsonStdoutMode ? jsonSafeSpawnOptions(options) : { stdio: "inherit", ...options });
  if (jsonStdoutMode && result.stdout) {
    process.stderr.write(result.stdout);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with code ${result.status}`);
  }
}

function spawnCommandSync(cmd, cmdArgs, options = {}) {
  if (isWindowsBatchCommand(cmd)) {
    return spawnSync(WINDOWS_CMD_PATH, ["/d", "/s", "/c", buildWindowsCommand([cmd, ...cmdArgs])], options);
  }
  return spawnSync(cmd, cmdArgs, options);
}

function jsonSafeSpawnOptions(options) {
  if (Object.hasOwn(options, "stdio")) {
    return options;
  }
  return {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
    ...options,
  };
}

function inspectWorkspaceTooling(rootDir) {
  const missing = [];
  const nodeModulesRoot = path.join(rootDir, "node_modules");
  if (!fs.existsSync(nodeModulesRoot)) {
    return {
      needsInstall: true,
      missing: [
        {
          label: "workspace dependencies",
          purpose: "GoatCitadel package commands and local tool binaries",
        },
      ],
    };
  }
  for (const tool of managedWorkspaceTooling) {
    if (!fs.existsSync(localWorkspaceBinPath(rootDir, tool.bin))) {
      missing.push(tool);
    }
  }
  return {
    needsInstall: missing.length > 0,
    missing,
  };
}

function localWorkspaceBinPath(rootDir, binName) {
  const fileName = process.platform === "win32" ? `${binName}.cmd` : binName;
  return path.join(rootDir, "node_modules", ".bin", fileName);
}

function isOutdatedLockfileInstallFailure(output) {
  return /ERR_PNPM_OUTDATED_LOCKFILE|Cannot install with "frozen-lockfile"/i.test(output);
}

function formatSpawnFailure(cmd, cmdArgs, result) {
  if (result.error) {
    return result.error;
  }
  const renderedArgs = cmdArgs.length > 0 ? ` ${cmdArgs.join(" ")}` : "";
  const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  return new Error(
    detail
      ? `${cmd}${renderedArgs} exited with code ${result.status}: ${detail}`
      : `${cmd}${renderedArgs} exited with code ${result.status}`,
  );
}

function printManagedInstallNotice({ title, what, why }) {
  console.log(title);
  console.log(`  What: ${what}`);
  console.log(`  Why: ${why}`);
}

function isWindowsBatchCommand(cmd) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
}

function buildWindowsCommand(parts) {
  return parts.map((value) => quoteWindowsCommandArg(String(value))).join(" ");
}

function quoteWindowsCommandArg(value) {
  if (value.length === 0) {
    return '""';
  }
  if (!/[\s"&()^<>|]/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function printHelp() {
  console.log(`GoatCitadel CLI

Usage:
  goatcitadel <command>
  goat <command> (short shell shortcut; works in PowerShell)

Commands:
  install    Install GoatCitadel from GitHub [--install-dir <path>] [--repo <url>] [--skip-voice] [--voice-model <id>] [--verbose]
  update     Update existing install from GitHub [--install-dir <path>] [--repo <url>] [--skip-voice] [--voice-model <id>] [--verbose]
  uninstall  Remove a local GoatCitadel install [--install-dir <path>] [--force]
  launch     Start the local stack if needed, wait for health, and open Mission Control [--no-open] [--json] [--wait]
  status     Report local runtime status [--json]
  stop       Stop GoatCitadel-managed local runtime processes [--json]
  up         Start gateway + mission control [--verbose]
  gateway    Start gateway only [--verbose]
  ui         Start mission control UI only
  onboard    Run TUI onboarding wizard
  tui        Run terminal Mission Control
  tools      Tool access CLI (catalog/grants/invoke)
  secrets    Generate deployment secrets (generate --docker-env)
  voice      Managed local voice runtime (install/status/models/select/remove)
  verify     Unattended verification lanes (fast/install/all/review/soak/deep:core/deep:ecosystem)
  admin      Backup/retention admin CLI
  smoke      Run smoke tests
  npu        Run local NPU sidecar (Python)
  doctor     Run diagnostics + safe repair (flags: --audit-only --no-repair --deep --yes --json --profile)
  help       Show this help

Install defaults:
  repo       ${defaultRepoUrl}
  base dir   ${baseDir}
  voice      base.en (managed whisper.cpp + local audio helper)
`);
}

function resolveTaskTitle(currentCommand) {
  switch (currentCommand) {
    case "install":
      return "Install";
    case "update":
      return "Update";
    case "uninstall":
      return "Uninstall";
    case "launch":
      return "Launch";
    case "up":
      return "Dev";
    case "gateway":
      return "Gateway";
    case "ui":
      return "Mission Control";
    case "onboard":
      return "Onboarding";
    case "tui":
      return "TUI";
    case "doctor":
      return "Doctor";
    case "secrets":
      return "Secrets";
    case "verify":
      return "Verify";
    default:
      return "CLI";
  }
}

function secrets(argv) {
  const subcommand = argv[0];
  const format = argv[1];
  if (subcommand !== "generate" || (format && format !== "--docker-env")) {
    console.log("Usage: goatcitadel secrets generate --docker-env");
    process.exitCode = subcommand === "generate" ? 0 : 1;
    return;
  }
  const authToken = randomDockerSecret();
  let postgresPassword = randomDockerSecret();
  while (postgresPassword === authToken) {
    postgresPassword = randomDockerSecret();
  }
  console.log(`GOATCITADEL_AUTH_TOKEN=${authToken}`);
  console.log(`GOATCITADEL_POSTGRES_PASSWORD=${postgresPassword}`);
}

function randomDockerSecret() {
  return randomBytes(32).toString("base64url");
}

function setTerminalTitle(task) {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.write(`\u001b]0;GoatCitadel - ${task}\u0007`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
