#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import {
  atomicCompareAndPublishJson,
  atomicCompareAndRemove,
  inspectLifecycleLockHolder,
  inspectProcessBindingWithRetry,
  queryProcessCreationIdentity,
  readManagedStateFile,
  withManagedLifecycleLock,
} from "../scripts/lib/managed-runtime-lifecycle.mjs";
import {
  assessLauncherEndpointOwnership,
  assessManagedStopSafety,
  buildEndpointOwnershipDiagnostic,
  formatManagedEndpointCollision,
  parseManagedProcessMetadata,
  resolveLauncherEndpoint,
  safeEndpointOrigin,
} from "../scripts/lib/managed-runtime-ownership.mjs";
import { resolveUiTarget } from "../scripts/lib/ui-target.mjs";

const defaultRepoUrl = process.env.GOATCITADEL_REPO_URL || "https://github.com/goatcitadel/GoatCitadel.git";
const preferredBaseDir = resolvePreferredBaseDir();
const legacyBaseDirs =
  process.platform === "darwin"
    ? [path.join(os.homedir(), ".GoatCitadel"), path.join(os.homedir(), ".goatcitadel")]
    : [path.join(os.homedir(), ".goatcitadel")];
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
const MANAGED_METADATA_MAX_BYTES = 4096;
const MANAGED_HEALTH_MAX_BYTES = 8192;
const MANAGED_OWNERSHIP_PROBE_TIMEOUT_MS = 2_000;
const MANAGED_LIFECYCLE_LOCK_TIMEOUT_MS = 190_000;
const POST_LAUNCH_RETENTION_RECHECK_DELAY_MS = 750;
const POST_LAUNCH_RETENTION_RECHECK_WINDOW_MS = 10_000;

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
    if (command === "update" && isPackagedInstall()) {
      console.error("This GoatCitadel installation is managed by the packaged installer.");
      console.error("Download or rebuild the newer Windows installer and run it to update in place.");
      console.error("The installer replaces the app payload while preserving runtime-root data and configuration.");
      process.exitCode = 1;
      return;
    }
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

  if (command === "mcp-server") {
    await runMcpServerModeStdio(rest);
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
  if (fs.existsSync(path.join(preferredBaseDir, "app"))) {
    return preferredBaseDir;
  }
  for (const legacyBaseDir of legacyBaseDirs) {
    if (fs.existsSync(path.join(legacyBaseDir, "app"))) {
      return legacyBaseDir;
    }
  }
  return preferredBaseDir;
}

function resolvePreferredBaseDir() {
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "GoatCitadel")
    : path.join(os.homedir(), ".GoatCitadel");
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
  const endpoints = resolveLauncherRuntimeEndpoints();

  const result = await withJsonCleanStdout(launchOptions.json, async () => {
    ensureLaunchRuntimeDirectories();

    if (isPackagedInstall()) {
      seedPackagedRuntimeRoot();
      const nodeExecutable = resolvePackagedNodeExecutable();
      await ensureGatewayReady({
        packaged: true,
        endpoint: endpoints.gateway,
        nodeExecutable,
      });
      await ensureUiReady({
        packaged: true,
        gatewayEndpoint: endpoints.gateway,
        endpoint: endpoints.ui,
        nodeExecutable,
      });
    } else {
      ensureWorkspaceRuntimeBuilds();
      await ensureGatewayReady({
        packaged: false,
        endpoint: endpoints.gateway,
      });
      await ensureUiReady({
        packaged: false,
        gatewayEndpoint: endpoints.gateway,
        endpoint: endpoints.ui,
      });
    }

    let status = await readRuntimeStatus({ endpoints });
    const retentionDeadline = Date.now() + POST_LAUNCH_RETENTION_RECHECK_WINDOW_MS;
    while ((!status.readiness.gateway || !status.readiness.ui) && Date.now() < retentionDeadline) {
      // The post-launch snapshot races a sibling launcher's probes, whose
      // synchronous identity reads can saturate the host for several seconds.
      // Re-reading inside a bounded window cannot accept a genuine ownership
      // loss: readiness must still prove exact running metadata, health, and
      // identity on the final read.
      await sleep(POST_LAUNCH_RETENTION_RECHECK_DELAY_MS);
      status = await readRuntimeStatus({ endpoints });
    }
    if (!status.readiness.gateway || !status.readiness.ui) {
      const summarize = (diagnostic) =>
        `${diagnostic.reason} (pidState=${diagnostic.pidState}, responded=${diagnostic.endpointResponded}, ` +
        `healthy=${diagnostic.endpointHealthy}, identityVerified=${diagnostic.identityVerified})`;
      throw new Error(
        "Gateway and Mission Control did not retain accepted endpoint ownership after launch. " +
          `Gateway: ${summarize(status.endpointOwnership.gateway)}; ` +
          `Mission Control: ${summarize(status.endpointOwnership.ui)}.`,
      );
    }
    return status;
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

function resolveLauncherRuntimeEndpoints() {
  return {
    gateway: {
      service: "gateway",
      serviceLabel: "Gateway",
      overrideEnvKey: "GOATCITADEL_GATEWAY_URL",
      defaultUrl: defaultGatewayUrl,
      healthPath: "/health",
      pidPath: gatewayPidPath,
      lockPath: path.join(runtimeStateDir, "locks", "gateway.lifecycle.lock"),
      ...resolveLauncherEndpoint({
        defaultUrl: defaultGatewayUrl,
        overrideValue: process.env.GOATCITADEL_GATEWAY_URL,
      }),
    },
    ui: {
      service: "mission-control",
      serviceLabel: "Mission Control",
      overrideEnvKey: "GOATCITADEL_MISSION_CONTROL_URL",
      defaultUrl: defaultUiUrl,
      healthPath: "/health",
      pidPath: uiPidPath,
      lockPath: path.join(runtimeStateDir, "locks", "mission-control.lifecycle.lock"),
      ...resolveLauncherEndpoint({
        defaultUrl: defaultUiUrl,
        overrideValue: process.env.GOATCITADEL_MISSION_CONTROL_URL,
      }),
    },
  };
}

async function inspectLauncherRuntimeOwnershipWithLocks(endpoints, timeoutMs) {
  const inspect = async (endpoint) => {
    if (endpoint.attachmentMode === "external_override") {
      return inspectLauncherEndpointOwnership(endpoint, timeoutMs);
    }
    try {
      return await withManagedLifecycleLock(
        {
          lockPath: endpoint.lockPath,
          service: endpoint.service,
          timeoutMs: 1_500,
        },
        () => inspectLauncherEndpointOwnership(endpoint, timeoutMs, { bindServingIdentity: true }),
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("lifecycle lock")) {
        return inspectLauncherEndpointOwnership(endpoint, timeoutMs, { considerLifecycleLockHolder: true });
      }
      throw error;
    }
  };
  // Endpoint inspections run sequentially: each health probe must complete
  // before any synchronous process-identity read can block the event loop,
  // or an in-flight probe aborts on an overdue timer and misreads a healthy
  // endpoint as unresponsive.
  const gateway = await inspect(endpoints.gateway);
  const ui = await inspect(endpoints.ui);
  return { gateway, ui };
}

async function inspectLauncherEndpointOwnership(endpoint, timeoutMs, options = {}) {
  const metadataRecord = readManagedProcessMetadata(endpoint.pidPath, endpoint.service);
  let pidInfo = metadataRecord.info;
  const health = await probeEndpointHealth(`${endpoint.url}${endpoint.healthPath}`, timeoutMs);
  let identityMatched = false;
  let processBinding;

  if (endpoint.attachmentMode === "managed" && pidInfo.state === "running") {
    const markerMatched =
      health.managedInstanceId === pidInfo.instanceId &&
      health.service === pidInfo.service &&
      Number.isSafeInteger(health.managedProcessId) &&
      health.managedProcessId > 0;
    if (markerMatched) {
      processBinding = await inspectProcessBindingWithRetry({ rootPid: pidInfo.pid, servingPid: health.managedProcessId });
      if (processBinding.status === "unavailable") {
        pidInfo = { ...pidInfo, state: "unverified", reason: "process_identity_unavailable" };
      } else if (processBinding.status !== "verified") {
        pidInfo = classifyManagedRootProcess(pidInfo);
      } else if (processBinding.rootIdentity !== pidInfo.processIdentity) {
        pidInfo = { ...pidInfo, state: "reused", reason: "process_identity_mismatch" };
      } else {
        const servingIdentityMatched =
          pidInfo.servingPid === health.managedProcessId &&
          pidInfo.servingProcessIdentity === processBinding.servingIdentity;
        if (!servingIdentityMatched && options.bindServingIdentity === true) {
          const publish = atomicCompareAndPublishJson({
            filePath: endpoint.pidPath,
            expectedFingerprint: metadataRecord.fingerprint,
            value: managedMetadataValue(pidInfo, {
              servingPid: health.managedProcessId,
              servingProcessIdentity: processBinding.servingIdentity,
            }),
          });
          if (publish.published) {
            return inspectLauncherEndpointOwnership(endpoint, timeoutMs, { bindServingIdentity: false });
          }
          return inspectLauncherEndpointOwnership(endpoint, timeoutMs, { bindServingIdentity: false });
        }
        identityMatched = servingIdentityMatched;
      }
    } else if (!health.responded && pidInfo.servingPid && pidInfo.servingProcessIdentity) {
      // A temporary health failure must not make an otherwise exact managed
      // process impossible to stop. The persisted serving identity plus the
      // current OS ancestry still proves ownership without trusting the port.
      processBinding = await inspectProcessBindingWithRetry({ rootPid: pidInfo.pid, servingPid: pidInfo.servingPid });
      if (processBinding.status === "unavailable") {
        pidInfo = { ...pidInfo, state: "unverified", reason: "process_identity_unavailable" };
      } else if (processBinding.status !== "verified") {
        pidInfo = classifyManagedRootProcess(pidInfo);
      } else if (processBinding.rootIdentity !== pidInfo.processIdentity) {
        pidInfo = { ...pidInfo, state: "reused", reason: "process_identity_mismatch" };
      } else {
        identityMatched = processBinding.servingIdentity === pidInfo.servingProcessIdentity;
      }
    } else {
      pidInfo = classifyManagedRootProcess(pidInfo);
    }
  }
  let launchInProgress = false;
  if (
    options.considerLifecycleLockHolder === true &&
    endpoint.attachmentMode === "managed" &&
    health.responded &&
    pidInfo.state !== "running"
  ) {
    // Reached only without the lifecycle lock. A live holder for this exact
    // service means a managed launch is publishing metadata right now, so the
    // assessment waits instead of reporting an unrelated-listener collision.
    const lockHolder = await inspectLifecycleLockHolder({
      lockPath: endpoint.lockPath,
      service: endpoint.service,
    });
    launchInProgress = lockHolder.held;
  }
  return {
    endpoint,
    pidInfo,
    metadataRecord: { ...metadataRecord, info: pidInfo },
    health,
    processBinding,
    assessment: assessLauncherEndpointOwnership({
      attachmentMode: endpoint.attachmentMode,
      pidState: pidInfo.state,
      endpointResponded: health.responded,
      endpointHealthy: health.healthy,
      identityMatched,
      launchInProgress,
    }),
  };
}

function classifyManagedRootProcess(pidInfo) {
  const current = queryProcessCreationIdentity(pidInfo.pid);
  if (current.status === "unavailable") {
    return { ...pidInfo, state: "unverified", reason: "process_identity_unavailable" };
  }
  if (current.status !== "running") {
    return { ...pidInfo, state: "stale", reason: "process_exited" };
  }
  if (current.identity !== pidInfo.processIdentity) {
    return { ...pidInfo, state: "reused", reason: "process_identity_mismatch" };
  }
  return pidInfo;
}

function managedMetadataValue(pidInfo, overrides = {}) {
  return {
    pid: pidInfo.pid,
    processIdentity: pidInfo.processIdentity,
    instanceId: pidInfo.instanceId,
    service: pidInfo.service,
    startedAt: pidInfo.startedAt,
    ...(pidInfo.servingPid && pidInfo.servingProcessIdentity
      ? { servingPid: pidInfo.servingPid, servingProcessIdentity: pidInfo.servingProcessIdentity }
      : {}),
    ...overrides,
  };
}

function throwForManagedEndpointCollision(snapshot) {
  if (snapshot.assessment.collision) {
    throw new Error(managedEndpointCollisionMessage(snapshot));
  }
}

function managedEndpointCollisionMessage(snapshot) {
  return formatManagedEndpointCollision({
    serviceLabel: snapshot.endpoint.serviceLabel,
    defaultUrl: snapshot.endpoint.defaultUrl,
    overrideEnvKey: snapshot.endpoint.overrideEnvKey,
    assessment: snapshot.assessment,
  });
}

function endpointOwnershipDiagnostic(snapshot) {
  return {
    ...buildEndpointOwnershipDiagnostic(snapshot.assessment),
    ...(snapshot.pidInfo.reason ? { metadataReason: snapshot.pidInfo.reason } : {}),
  };
}

async function readRuntimeStatus(options = {}) {
  const endpoints = options.endpoints || resolveLauncherRuntimeEndpoints();
  const gatewayUrl = endpoints.gateway.url;
  const uiUrl = endpoints.ui.url;
  ensureLaunchRuntimeDirectories();

  const ownership = await inspectLauncherRuntimeOwnershipWithLocks(endpoints, MANAGED_OWNERSHIP_PROBE_TIMEOUT_MS);
  const gatewayPid = ownership.gateway.pidInfo;
  const uiPid = ownership.ui.pidInfo;
  const gatewayReady = ownership.gateway.assessment.readinessAccepted;
  const uiReady = ownership.ui.assessment.readinessAccepted;
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
  const status = gatewayReady && uiReady ? "ready" : anyAlive || anyReady ? "degraded" : anyStale ? "stale" : "stopped";

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
    endpointOwnership: {
      gateway: endpointOwnershipDiagnostic(ownership.gateway),
      ui: endpointOwnershipDiagnostic(ownership.ui),
    },
    desktopEventStream,
  });
}

async function stopGoatCitadelRuntime() {
  ensureLaunchRuntimeDirectories();
  const endpoints = resolveLauncherRuntimeEndpoints();
  const before = await readRuntimeStatus({ endpoints });
  const stopped = [];
  const stale = [];
  const notStopped = [];

  for (const item of [
    { label: "ui", endpoint: endpoints.ui },
    { label: "gateway", endpoint: endpoints.gateway },
  ]) {
    const outcome =
      item.endpoint.attachmentMode === "external_override"
        ? await stopManagedLauncherEndpoint(item)
        : await withManagedLifecycleLock(
            {
              lockPath: item.endpoint.lockPath,
              service: item.endpoint.service,
              timeoutMs: MANAGED_LIFECYCLE_LOCK_TIMEOUT_MS,
            },
            () => stopManagedLauncherEndpoint(item),
          );
    if (outcome.stopped) {
      stopped.push(outcome.stopped);
    }
    if (outcome.stale) {
      stale.push(outcome.stale);
    }
    if (outcome.notStopped) {
      notStopped.push(outcome.notStopped);
    }
  }

  const after = await readRuntimeStatus({ endpoints });
  return {
    ...after,
    action: "stop",
    previousStatus: before.status,
    stopped,
    stale,
    notStopped,
  };
}

async function stopManagedLauncherEndpoint(item) {
  const snapshot = await inspectLauncherEndpointOwnership(item.endpoint, MANAGED_OWNERSHIP_PROBE_TIMEOUT_MS, {
    bindServingIdentity: true,
  });
  const stopSafety = managedStopSafety(item.endpoint, snapshot);
  if (!stopSafety.allowed || !snapshot.pidInfo.pid) {
    if (
      item.endpoint.attachmentMode === "managed" &&
      snapshot.pidInfo.state === "missing" &&
      !snapshot.health.responded
    ) {
      return {};
    }
    return {
      ...(snapshot.pidInfo.state === "stale" ? { stale: { label: item.label, pid: snapshot.pidInfo.pid } } : {}),
      notStopped: buildManagedStopDiagnostic(item, snapshot, stopSafety.reason),
    };
  }

  // Re-read health, the OS process tree, and the compare token immediately
  // before termination. A PID or serving-child transition after the first
  // decision therefore fails closed instead of targeting the new owner.
  const verified = await inspectLauncherEndpointOwnership(item.endpoint, MANAGED_OWNERSHIP_PROBE_TIMEOUT_MS, {
    bindServingIdentity: true,
  });
  const verifiedSafety = managedStopSafety(item.endpoint, verified);
  const canonicalMetadata = readManagedProcessMetadata(item.endpoint.pidPath, item.endpoint.service);
  if (
    !verifiedSafety.allowed ||
    verified.pidInfo.instanceId !== snapshot.pidInfo.instanceId ||
    canonicalMetadata.fingerprint !== verified.metadataRecord.fingerprint
  ) {
    return {
      notStopped: buildManagedStopDiagnostic(item, verified, "identity_changed_before_stop"),
    };
  }

  stopManagedProcess(verified.pidInfo.pid);
  let rootCurrent = queryProcessCreationIdentity(verified.pidInfo.pid);
  let servingCurrent = queryProcessCreationIdentity(verified.pidInfo.servingPid);
  if (
    servingCurrent.status === "running" &&
    servingCurrent.identity === verified.pidInfo.servingProcessIdentity &&
    (rootCurrent.status !== "running" || rootCurrent.identity !== verified.pidInfo.processIdentity)
  ) {
    stopManagedProcess(verified.pidInfo.servingPid);
    servingCurrent = queryProcessCreationIdentity(verified.pidInfo.servingPid);
  }
  rootCurrent = queryProcessCreationIdentity(verified.pidInfo.pid);
  const rootStopped = rootCurrent.status !== "running" || rootCurrent.identity !== verified.pidInfo.processIdentity;
  const servingStopped =
    servingCurrent.status !== "running" || servingCurrent.identity !== verified.pidInfo.servingProcessIdentity;
  if (!rootStopped || !servingStopped) {
    return {
      notStopped: buildManagedStopDiagnostic(item, verified, "stop_incomplete"),
    };
  }

  const remove = atomicCompareAndRemove({
    filePath: item.endpoint.pidPath,
    expectedFingerprint: verified.metadataRecord.fingerprint,
  });
  return {
    stopped: { label: item.label, pid: verified.pidInfo.pid },
    ...(!remove.removed ? { notStopped: buildManagedStopDiagnostic(item, verified, `metadata_${remove.reason}`) } : {}),
  };
}

function managedStopSafety(endpoint, snapshot) {
  return assessManagedStopSafety({
    attachmentMode: endpoint.attachmentMode,
    pidState: snapshot.pidInfo.state,
    identityMatched: snapshot.assessment.identityMatched,
  });
}

function buildManagedStopDiagnostic(item, snapshot, reason) {
  return {
    label: item.label,
    ...(snapshot.pidInfo.pid ? { pid: snapshot.pidInfo.pid } : {}),
    reason:
      item.endpoint.attachmentMode === "managed" && snapshot.pidInfo.state === "invalid"
        ? (snapshot.pidInfo.reason ?? reason)
        : reason,
    attachmentMode: item.endpoint.attachmentMode,
    pidState: snapshot.pidInfo.state,
    endpointResponded: snapshot.health.responded,
    identityVerified: snapshot.assessment.identityMatched,
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
  endpointOwnership,
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
    endpointOwnership,
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
    const response = await fetchWithTimeout(
      `${gatewayUrl}/api/v1/auth/sse-token`,
      LAUNCHER_GATEWAY_REQUEST_TIMEOUT_MS,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `desktop-sse-token:${randomUUID()}`,
          ...readLauncherOperatorAuthHeaders(),
        },
        body: JSON.stringify({ scope: "events:stream" }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload?.token) {
      return {
        scope: payload.scope || "events:stream",
        token: payload.token,
        expiresAt: payload.expiresAt,
      };
    }
    if (response.ok && payload?.authMode === "none") {
      return {
        scope: payload.scope || "events:stream",
        authMode: "none",
      };
    }
    // Compatibility with older Gateways that represented the tokenless mode
    // as a 400 response. New Gateways return the success shape above so normal
    // desktop status polling does not generate warning logs.
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

async function runMcpServerModeStdio(argv) {
  const options = parseMcpServerArgs(argv);
  const state = {
    gatewayUrl: normalizeLauncherGatewayUrl(
      options.gatewayUrl || process.env.GOATCITADEL_GATEWAY_URL || defaultGatewayUrl,
    ),
    agentId: options.agentId || process.env.GOATCITADEL_MCP_AGENT_ID || "mcp-stdio-client",
    sessionId:
      options.sessionId ||
      process.env.GOATCITADEL_MCP_SESSION_ID ||
      `mcp-stdio-${process.pid}-${Date.now().toString(36)}`,
    workspaceId: options.workspaceId || process.env.GOATCITADEL_MCP_WORKSPACE_ID,
    permissionProfileId: options.permissionProfileId || process.env.GOATCITADEL_MCP_PERMISSION_PROFILE_ID,
    localOperatorOverrideId: options.localOperatorOverrideId || process.env.GOATCITADEL_MCP_LOCAL_OPERATOR_OVERRIDE_ID,
  };
  process.stderr.write(
    `[goatcitadel:mcp-server] Gateway-backed stdio proxy started for ${state.gatewayUrl}. Tools remain Gateway-governed.\n`,
  );

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      writeJsonRpcResponse({
        jsonrpc: "2.0",
        id: null,
        error: buildJsonRpcError(-32700, `Parse error: ${error.message}`),
      });
      continue;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      writeJsonRpcResponse({
        jsonrpc: "2.0",
        id: null,
        error: buildJsonRpcError(-32600, "Invalid JSON-RPC request."),
      });
      continue;
    }
    if (message.id === undefined) {
      await handleMcpServerNotification(message);
      continue;
    }
    try {
      writeJsonRpcResponse(await handleMcpServerRequest(message, state));
    } catch (error) {
      writeJsonRpcResponse({
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: buildJsonRpcError(-32603, sanitizeLauncherError(error)),
      });
    }
  }
}

function parseMcpServerArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--gateway-url") {
      options.gatewayUrl = readRequiredCliValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--agent-id") {
      options.agentId = readRequiredCliValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--session-id") {
      options.sessionId = readRequiredCliValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--workspace-id") {
      options.workspaceId = readRequiredCliValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--permission-profile-id") {
      options.permissionProfileId = readRequiredCliValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--local-operator-override-id") {
      options.localOperatorOverrideId = readRequiredCliValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printMcpServerHelp();
      process.exit(0);
    }
    throw new Error(`Unsupported mcp-server option: ${arg}`);
  }
  return options;
}

function readRequiredCliValue(argv, index, flag) {
  const value = argv[index]?.trim();
  if (!value) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function printMcpServerHelp() {
  console.log(`GoatCitadel MCP server-mode stdio proxy

Usage:
  goatcitadel mcp-server [--gateway-url <url>] [--agent-id <id>] [--session-id <id>] [--workspace-id <id>]

Environment:
  GOATCITADEL_GATEWAY_URL                     Gateway base URL (default ${defaultGatewayUrl})
  GOATCITADEL_AUTH_TOKEN                      Bearer token for Gateway auth
  GOATCITADEL_AUTH_BASIC_USERNAME/PASSWORD    Basic auth credentials
  GOATCITADEL_MCP_AGENT_ID                    Agent id recorded in Gateway policy/audit
  GOATCITADEL_MCP_SESSION_ID                  Session id recorded in Gateway policy/audit
  GOATCITADEL_MCP_WORKSPACE_ID                Optional workspace id

This command speaks JSON-RPC over stdio and proxies only read-only, closed-world
server-mode descriptors through Gateway-owned policy, approvals, and audit.
`);
}

async function handleMcpServerNotification(message) {
  if (message.method === "notifications/initialized" || message.method === "$/cancelRequest") {
    return;
  }
  process.stderr.write(`[goatcitadel:mcp-server] Ignored notification ${String(message.method ?? "unknown")}.\n`);
}

async function handleMcpServerRequest(message, state) {
  const id = message.id ?? null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: buildJsonRpcError(-32600, "Invalid JSON-RPC request."),
    };
  }
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: readMcpProtocolVersion(message.params) || "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "goatcitadel",
          version: "1.0.0",
        },
      },
    };
  }
  if (message.method === "tools/list") {
    const manifest = await fetchMcpServerModeManifestForStdio(state);
    const manifestTools = Array.isArray(manifest.tools) ? manifest.tools : [];
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: manifestTools.filter(isMcpStdioToolCallable).map(toMcpStdioToolDescriptor),
      },
    };
  }
  if (message.method === "tools/call") {
    const result = await callMcpServerModeToolForStdio(state, message.params);
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: buildJsonRpcError(-32601, `Unsupported MCP method: ${message.method}`),
  };
}

function readMcpProtocolVersion(params) {
  return params && typeof params === "object" && typeof params.protocolVersion === "string"
    ? params.protocolVersion
    : undefined;
}

async function fetchMcpServerModeManifestForStdio(state) {
  return launcherGatewayRequest(state, "/api/v1/mcp/server-mode/manifest");
}

async function callMcpServerModeToolForStdio(state, params) {
  const call = normalizeMcpToolCallParams(params);
  const response = await launcherGatewayRequest(state, "/api/v1/mcp/server-mode/call", {
    method: "POST",
    // Tool calls proxy real gateway work (code mode, long tools), so they get a
    // generous deadline rather than the short health-check bound — but still a
    // deadline, so a gateway that accepts the connection yet never answers can't
    // hang the stdio client forever.
    timeoutMs: LAUNCHER_GATEWAY_TOOL_CALL_TIMEOUT_MS,
    body: JSON.stringify({
      descriptorName: call.name,
      args: call.arguments,
      agentId: state.agentId,
      sessionId: state.sessionId,
      workspaceId: state.workspaceId,
      permissionProfileId: state.permissionProfileId,
      localOperatorOverrideId: state.localOperatorOverrideId,
    }),
  });
  return toMcpToolCallResult(response);
}

async function launcherGatewayRequest(state, apiPath, init = {}) {
  const { timeoutMs, ...fetchInit } = init;
  const url = new URL(apiPath, `${state.gatewayUrl}/`).toString();
  const response = await fetchWithTimeout(url, timeoutMs ?? LAUNCHER_GATEWAY_REQUEST_TIMEOUT_MS, {
    ...fetchInit,
    method: fetchInit.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "x-goatcitadel-origin-surface": "mcp",
      "x-goatcitadel-correlation-id": `mcp-stdio:${randomUUID()}`,
      ...(fetchInit.method && fetchInit.method !== "GET" ? { "Idempotency-Key": `mcp-stdio:${randomUUID()}` } : {}),
      ...readLauncherOperatorAuthHeaders(),
      ...(fetchInit.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Gateway request ${apiPath} returned non-JSON response with HTTP ${response.status}.`);
    }
  }
  if (!response.ok) {
    const errorMessage =
      typeof body?.error === "string" ? body.error : `Gateway request ${apiPath} failed with HTTP ${response.status}.`;
    throw new Error(errorMessage);
  }
  return body;
}

function normalizeMcpToolCallParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("tools/call params must be an object.");
  }
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!name) {
    throw new Error("tools/call params.name is required.");
  }
  const args =
    params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
  return { name, arguments: args };
}

function isMcpStdioToolCallable(tool) {
  return (
    tool &&
    typeof tool === "object" &&
    tool.serverModeState === "call_preview" &&
    tool.gatewayCallable === true &&
    tool.annotations?.readOnlyHint === true &&
    tool.annotations?.destructiveHint !== true &&
    tool.annotations?.openWorldHint !== true
  );
}

function toMcpStdioToolDescriptor(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: simplifyMcpServerModeInputSchema(tool.inputSchema),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  };
}

function simplifyMcpServerModeInputSchema(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return { type: "object", additionalProperties: true };
  }
  const properties = inputSchema.properties && typeof inputSchema.properties === "object" ? inputSchema.properties : {};
  const argsSchema = properties.args && typeof properties.args === "object" ? properties.args : undefined;
  return argsSchema ?? { type: "object", additionalProperties: true };
}

function toMcpToolCallResult(response) {
  const ok = response?.outcome === "executed";
  return {
    content: [
      {
        type: "text",
        text: ok ? stringifyMcpToolResult(response.result) : response?.policyReason || "MCP tool call was blocked.",
      },
    ],
    isError: !ok,
    _meta: {
      outcome: response?.outcome,
      policyReason: response?.policyReason,
      auditEventId: response?.auditEventId,
      approvalId: response?.approvalId,
      capabilityId: response?.capabilityId,
      toolName: response?.toolName,
    },
  };
}

function stringifyMcpToolResult(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "Tool completed without a structured result.";
  }
  return JSON.stringify(value, null, 2);
}

function writeJsonRpcResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function buildJsonRpcError(code, message, data) {
  return {
    code,
    message,
    ...(data === undefined ? {} : { data }),
  };
}

function sanitizeLauncherError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(Bearer|token|api[-_]?key|authorization)\s*[:=]\s*[A-Za-z0-9._~+/=-]{12,}/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._~+/=-]{12,}@/g, "[REDACTED]@")
    .slice(0, 1000);
}

function normalizeLauncherGatewayUrl(value) {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function readManagedProcessMetadata(filePath, expectedService) {
  const record = readManagedStateFile(filePath, MANAGED_METADATA_MAX_BYTES);
  if (!record.exists) {
    return { info: { state: "missing" }, fingerprint: null };
  }
  if (record.oversized) {
    return { info: { state: "invalid", reason: "metadata_too_large" }, fingerprint: record.fingerprint };
  }
  if (record.unreadable || typeof record.raw !== "string") {
    return { info: { state: "invalid", reason: "metadata_unreadable" }, fingerprint: record.fingerprint };
  }
  return {
    info: parseManagedProcessMetadata(record.raw, {
      expectedService,
      isProcessAlive,
    }),
    fingerprint: record.fingerprint,
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
    return !isProcessAlive(pid);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isProcessAlive(pid);
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
  return !isProcessAlive(pid);
}

async function printRuntimeCommandResult(fn, args) {
  const options = parseRuntimeOutputOptions(args);
  const result = await withJsonCleanStdout(options.json, fn);
  if (options.json) {
    writeJsonResult(result);
    return;
  }
  console.log(`${result.status}: ${result.targetUrl}`);
  for (const item of result.notStopped ?? []) {
    console.log(
      `Not stopped: ${item.label} (${item.reason}; managed identity verified: ${item.identityVerified === true ? "yes" : "no"}).`,
    );
  }
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

async function ensureGatewayReady({ packaged, endpoint, nodeExecutable }) {
  const outcome = await establishLauncherEndpointReadiness({
    endpoint,
    timeoutMs: 180000,
    startManaged: (expectedFingerprint) => {
      if (packaged) {
        startPackagedGateway(nodeExecutable, endpoint.url, expectedFingerprint);
      } else {
        startSourceGateway(endpoint.url, expectedFingerprint);
      }
    },
  });
  if (outcome.ready) {
    return;
  }
  const live = (await probeEndpointHealth(`${endpoint.url}/livez`, 1500)).healthy;
  throw new Error(
    [
      describeEndpointReadinessFailure(endpoint, outcome),
      live ? "Gateway process answered /livez but /health did not pass." : "Gateway process did not answer /livez.",
      buildRuntimeLogSummary("gateway"),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function ensureUiReady({ packaged, gatewayEndpoint, endpoint, nodeExecutable }) {
  const outcome = await establishLauncherEndpointReadiness({
    endpoint,
    timeoutMs: 180000,
    startManaged: (expectedFingerprint) => {
      if (packaged) {
        startPackagedUi(nodeExecutable, endpoint.url, expectedFingerprint);
      } else {
        startSourceUi(gatewayEndpoint.url, endpoint.url, expectedFingerprint);
      }
    },
  });
  if (!outcome.ready) {
    throw new Error(
      [describeEndpointReadinessFailure(endpoint, outcome), buildRuntimeLogSummary("mission-control")]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function establishLauncherEndpointReadiness({ endpoint, timeoutMs, startManaged }) {
  if (endpoint.attachmentMode === "external_override") {
    return establishLauncherEndpointReadinessUnlocked({ endpoint, timeoutMs, startManaged });
  }
  return withManagedLifecycleLock(
    {
      lockPath: endpoint.lockPath,
      service: endpoint.service,
      timeoutMs: Math.max(MANAGED_LIFECYCLE_LOCK_TIMEOUT_MS, timeoutMs + 10_000),
    },
    () => establishLauncherEndpointReadinessUnlocked({ endpoint, timeoutMs, startManaged }),
  );
}

async function establishLauncherEndpointReadinessUnlocked({ endpoint, timeoutMs, startManaged }) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await inspectLauncherEndpointOwnership(endpoint, Math.min(1500, timeoutMs), {
    bindServingIdentity: true,
  });
  throwForManagedEndpointCollision(snapshot);
  if (snapshot.assessment.readinessAccepted) {
    return { ready: true, started: false, snapshot };
  }

  if (snapshot.assessment.launchAction === "wait_external") {
    const waited = await waitForLauncherEndpointDecision(endpoint, deadline);
    throwForManagedEndpointCollision(waited.snapshot);
    return {
      ready: waited.kind === "ready",
      started: false,
      failure: waited.kind === "timeout" ? "external_unavailable" : waited.kind,
      snapshot: waited.snapshot,
    };
  }

  if (snapshot.assessment.launchAction === "wait_managed") {
    const waited = await waitForLauncherEndpointDecision(endpoint, deadline);
    throwForManagedEndpointCollision(waited.snapshot);
    if (waited.kind === "ready") {
      return { ready: true, started: false, snapshot: waited.snapshot };
    }
    if (waited.kind === "timeout") {
      return { ready: false, started: false, failure: "managed_process_not_ready", snapshot: waited.snapshot };
    }
    snapshot = waited.snapshot;
  }

  if (snapshot.assessment.launchAction !== "spawn") {
    return { ready: false, started: false, failure: "managed_endpoint_unavailable", snapshot };
  }

  startManaged(snapshot.metadataRecord.fingerprint);
  const waited = await waitForLauncherEndpointDecision(endpoint, deadline);
  throwForManagedEndpointCollision(waited.snapshot);
  if (waited.kind === "ready") {
    return { ready: true, started: true, snapshot: waited.snapshot };
  }
  return {
    ready: false,
    started: true,
    failure: waited.kind === "spawnable" ? "managed_process_exited" : "managed_endpoint_unavailable",
    snapshot: waited.snapshot,
  };
}

async function waitForLauncherEndpointDecision(endpoint, deadline) {
  let snapshot = await inspectLauncherEndpointOwnership(
    endpoint,
    Math.min(1500, Math.max(250, deadline - Date.now())),
    { bindServingIdentity: true },
  );
  while (true) {
    if (snapshot.assessment.readinessAccepted) {
      return { kind: "ready", snapshot };
    }
    if (snapshot.assessment.collision) {
      return { kind: "collision", snapshot };
    }
    if (snapshot.assessment.launchAction === "spawn") {
      return { kind: "spawnable", snapshot };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { kind: "timeout", snapshot };
    }
    await sleep(Math.min(1000, Math.max(100, remainingMs)));
    snapshot = await inspectLauncherEndpointOwnership(endpoint, Math.min(1500, Math.max(250, deadline - Date.now())), {
      bindServingIdentity: true,
    });
  }
}

function describeEndpointReadinessFailure(endpoint, outcome) {
  const safeEndpoint = safeEndpointOrigin(endpoint.url);
  if (endpoint.attachmentMode === "external_override") {
    return (
      `Configured external ${endpoint.serviceLabel} did not become healthy at ${safeEndpoint}. ` +
      `Start that runtime or clear ${endpoint.overrideEnvKey} to use GoatCitadel's managed default.`
    );
  }
  if (outcome.failure === "managed_process_not_ready") {
    const pid = outcome.snapshot.pidInfo.pid ? ` (PID ${outcome.snapshot.pidInfo.pid})` : "";
    return `Managed ${endpoint.serviceLabel} process${pid} did not become healthy; no duplicate process was spawned.`;
  }
  if (outcome.failure === "managed_process_exited") {
    return `Managed ${endpoint.serviceLabel} process exited before ${safeEndpoint} became healthy.`;
  }
  return `Managed ${endpoint.serviceLabel} did not become healthy at ${safeEndpoint}.`;
}

function startPackagedGateway(nodeExecutable, gatewayUrl, expectedFingerprint) {
  const port = String(new URL(gatewayUrl).port || "8787");
  startManagedDetachedProcess({
    pidPath: gatewayPidPath,
    service: "gateway",
    expectedFingerprint,
    cmd: nodeExecutable,
    args: [packagedGatewayEntry],
    cwd: packagedGatewayDir,
    env: {
      ...runtimeProcessEnv,
      GOATCITADEL_APP_DIR: appDir,
      GOATCITADEL_ROOT_DIR: packagedRuntimeRoot,
      GOATCITADEL_DATABASE_DRIVER: "sqlite",
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: port,
    },
    stdoutPath: path.join(runtimeLogDir, "gateway.stdout.log"),
    stderrPath: path.join(runtimeLogDir, "gateway.stderr.log"),
  });
}

function startPackagedUi(nodeExecutable, uiUrl, expectedFingerprint) {
  const port = String(new URL(uiUrl).port || "5173");
  startManagedDetachedProcess({
    pidPath: uiPidPath,
    service: "mission-control",
    expectedFingerprint,
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
  });
}

function startSourceGateway(gatewayUrl, expectedFingerprint) {
  const runner = resolvePnpmRunner();
  const port = String(new URL(gatewayUrl).port || "8787");
  startManagedDetachedProcess({
    pidPath: gatewayPidPath,
    service: "gateway",
    expectedFingerprint,
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
  });
}

function startSourceUi(gatewayUrl, uiUrl, expectedFingerprint) {
  const runner = resolvePnpmRunner();
  const port = String(new URL(uiUrl).port || "5173");
  const uiTarget = resolveUiTarget(appDir, runtimeProcessEnv);
  startManagedDetachedProcess({
    pidPath: uiPidPath,
    service: "mission-control",
    expectedFingerprint,
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
      "--strictPort",
    ],
    cwd: appDir,
    env: {
      ...runtimeProcessEnv,
      VITE_GATEWAY_URL: gatewayUrl,
    },
    stdoutPath: path.join(runtimeLogDir, "mission-control.stdout.log"),
    stderrPath: path.join(runtimeLogDir, "mission-control.stderr.log"),
  });
}

function startManagedDetachedProcess({
  pidPath,
  service,
  expectedFingerprint,
  cmd,
  args,
  cwd,
  env,
  stdoutPath,
  stderrPath,
}) {
  const metadata = {
    instanceId: randomUUID(),
    service,
    startedAt: new Date().toISOString(),
  };
  const pid = spawnDetachedProcess({
    cmd,
    args,
    cwd,
    env: {
      ...env,
      GOATCITADEL_MANAGED_INSTANCE_ID: metadata.instanceId,
      GOATCITADEL_MANAGED_SERVICE: metadata.service,
    },
    stdoutPath,
    stderrPath,
  });
  if (!pid) {
    throw new Error(`Managed ${service} process did not expose a process ID.`);
  }
  const processIdentity = waitForProcessCreationIdentity(pid, 5_000);
  if (!processIdentity) {
    stopNewManagedProcess(pid);
    throw new Error(`Managed ${service} process creation identity could not be established.`);
  }
  try {
    const publish = atomicCompareAndPublishJson({
      filePath: pidPath,
      expectedFingerprint,
      value: { pid, processIdentity, ...metadata },
    });
    if (!publish.published) {
      throw new Error(`Managed ${service} metadata changed during launch (${publish.reason}).`);
    }
  } catch (error) {
    stopNewManagedProcess(pid, processIdentity);
    throw error;
  }
}

function waitForProcessCreationIdentity(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = queryProcessCreationIdentity(pid);
    if (current.status === "running") {
      return current.identity;
    }
    if (Date.now() >= deadline) {
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return undefined;
}

function stopNewManagedProcess(pid, expectedIdentity) {
  if (expectedIdentity) {
    const current = queryProcessCreationIdentity(pid);
    if (current.status !== "running" || current.identity !== expectedIdentity) {
      return false;
    }
  }
  return stopManagedProcess(pid);
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

async function probeEndpointHealth(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await readBoundedJsonBody(response, MANAGED_HEALTH_MAX_BYTES);
    if (!body.completed) {
      return { responded: true, healthy: false };
    }
    const payload = body.payload;
    return {
      responded: true,
      healthy: response.ok,
      ...(typeof payload?.service === "string" && payload.service.length <= 64 ? { service: payload.service } : {}),
      ...(typeof payload?.managedInstanceId === "string" && payload.managedInstanceId.length <= 128
        ? { managedInstanceId: payload.managedInstanceId }
        : {}),
      ...(Number.isSafeInteger(payload?.managedProcessId) && payload.managedProcessId > 0
        ? { managedProcessId: payload.managedProcessId }
        : {}),
    };
  } catch {
    return { responded: false, healthy: false };
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJsonBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    return { completed: true, payload: undefined };
  }
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { completed: false };
      }
      chunks.push(Buffer.from(value));
    }
    const raw = Buffer.concat(chunks, totalBytes).toString("utf8");
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { completed: true, payload: undefined };
    }
    return {
      completed: true,
      payload: payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined,
    };
  } catch {
    return { completed: false };
  } finally {
    reader.releaseLock();
  }
}

async function fetchWithTimeout(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Every launcher-side gateway request must carry a deadline: launch/status run
// under installer smokes and desktop hosts that block on our exit, and a gateway
// that accepts the connection but never answers would otherwise hang them forever.
const LAUNCHER_GATEWAY_REQUEST_TIMEOUT_MS = 15000;

// MCP stdio tool calls proxy real gateway work and can run far longer than a
// health check, so they get their own generous deadline. It still bounds the
// request so a hung gateway cannot stall the stdio client indefinitely.
const LAUNCHER_GATEWAY_TOOL_CALL_TIMEOUT_MS = 600000;

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, LAUNCHER_GATEWAY_REQUEST_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

function buildRuntimeLogSummary(processName) {
  const stdoutPath = path.join(runtimeLogDir, `${processName}.stdout.log`);
  const stderrPath = path.join(runtimeLogDir, `${processName}.stderr.log`);
  const stderrTail = readLogTail(stderrPath);
  const stdoutTail = readLogTail(stdoutPath);
  const details = [];
  if (stderrTail) {
    details.push(`Recent ${path.basename(stderrPath)}:\n${stderrTail}`);
  }
  if (stdoutTail) {
    details.push(`Recent ${path.basename(stdoutPath)}:\n${stdoutTail}`);
  }
  if (details.length === 0) {
    return `No recent ${processName} log output was captured under ${runtimeLogDir}.`;
  }
  return details.join("\n");
}

function readLogTail(filePath, maxBytes = 6000) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size <= 0) {
      return "";
    }
    const fd = fs.openSync(filePath, "r");
    try {
      const bytesToRead = Math.min(maxBytes, stats.size);
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, stats.size - bytesToRead);
      return buffer.toString("utf8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
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
    if (runtimeProcessEnv.GOATCITADEL_INSTALL_ALLOW_LOCKFILE_REFRESH !== "1") {
      throw new Error(
        "Frozen-lockfile install failed. Refusing to refresh pnpm-lock.yaml during launcher-managed install. Review the manifest/lockfile mismatch first, or set GOATCITADEL_INSTALL_ALLOW_LOCKFILE_REFRESH=1 for an intentional local recovery.",
      );
    }
    printManagedInstallNotice({
      title: "Refreshing workspace lock metadata...",
      what: "a reconciled pnpm lockfile install",
      why: "GOATCITADEL_INSTALL_ALLOW_LOCKFILE_REFRESH=1 is set and the package manifests moved ahead of pnpm-lock.yaml, so GoatCitadel is performing an explicit local recovery refresh.",
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
  const result = spawnCommandSync(
    cmd,
    cmdArgs,
    jsonStdoutMode ? jsonSafeSpawnOptions(options) : { stdio: "inherit", ...options },
  );
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
  assertSafeWindowsCommandArg(value);
  if (value.length === 0) {
    return '""';
  }
  if (!/[\s&()^<>|]/.test(value)) {
    return value;
  }
  return `"${value}"`;
}

function assertSafeWindowsCommandArg(value) {
  if (/["%\r\n\0]/.test(value)) {
    throw new Error(
      "Windows shell command arguments must not contain embedded quotes, percent expansions, or control characters.",
    );
  }
}

function printHelp() {
  console.log(`GoatCitadel CLI

Usage:
  goatcitadel <command>
  goat <command> (short shell shortcut; works in PowerShell)

Commands:
  install    Install GoatCitadel from GitHub [--install-dir <path>] [--repo <url>] [--skip-voice] [--voice-model <id>] [--verbose]
  update     Update a source-bootstrap install from GitHub; packaged Windows installs use the newer installer
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
  mcp-server Gateway-backed MCP server-mode stdio proxy (initialize/tools/list/tools/call)
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
    case "mcp-server":
      return "MCP Server";
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
