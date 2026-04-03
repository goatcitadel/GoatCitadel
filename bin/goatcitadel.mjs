#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const defaultRepoUrl = process.env.GOATCITADEL_REPO_URL || "https://github.com/goatcitadel/GoatCitadel.git";
const preferredBaseDir = path.join(os.homedir(), ".GoatCitadel");
const legacyBaseDir = path.join(os.homedir(), ".goatcitadel");
const pnpmVersion = "10.31.0";
const workspaceBootstrapBuildPackages = [
  "@goatcitadel/contracts",
  "@goatcitadel/extensions-sdk",
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

const args = process.argv.slice(2);
const command = args[0] || "help";
const rawRest = args.slice(1);
const runtimeArgs = extractVerboseFlag(rawRest);
const installArgs = command === "install" || command === "update"
  ? parseInstallArgs(rawRest)
  : { passthrough: runtimeArgs.passthrough, verbose: runtimeArgs.verbose };
const repoUrl = installArgs.repoUrl || defaultRepoUrl;
const baseDir = resolveBaseDir(installArgs.installDir);
const appDir = path.join(baseDir, "app");
const rest = installArgs.passthrough;
const taskTitle = resolveTaskTitle(command);
const verboseEnv = installArgs.verbose ? { GOATCITADEL_VERBOSE: "1" } : {};
const runtimeProcessEnv = {
  ...process.env,
  ...verboseEnv,
  GOATCITADEL_TERMINAL_TASK: taskTitle,
};

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

  if (!fs.existsSync(path.join(appDir, "package.json"))) {
    console.log("GoatCitadel is not installed yet. Bootstrapping now...");
    installOrUpdate();
  }

  if (command === "up") {
    ensureWorkspaceBootstrapBuilds();
    runPnpm(["--dir", appDir, "dev", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "gateway") {
    runPnpm(["--dir", appDir, "dev:gateway", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "ui") {
    ensureWorkspaceBootstrapBuilds();
    runPnpm(["--dir", appDir, "dev:ui", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "onboard") {
    runPnpm(["--dir", appDir, "onboarding:tui", ...rest], {
      env: {
        ...runtimeProcessEnv,
        GOATCITADEL_APP_DIR: appDir,
      },
    });
    return;
  }
  if (command === "tui") {
    runPnpm(["--dir", appDir, "tui", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "tools") {
    runPnpm(["--dir", appDir, "tools", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "voice") {
    runPnpm(["--dir", appDir, "--filter", "@goatcitadel/gateway", "run", "voice:runtime", ...rest], {
      env: runtimeProcessEnv,
    });
    return;
  }
  if (command === "verify") {
    const lane = rest[0] || "fast";
    const laneArgs = rest.slice(1);
    const supportedLanes = new Set(["fast", "install", "all", "review", "soak", "deep:core", "deep:ecosystem"]);
    if (!supportedLanes.has(lane)) {
      throw new Error(`Unsupported verify lane: ${lane}`);
    }
    const scriptName = lane === "deep:core"
      ? "verify:deep:core"
      : lane === "deep:ecosystem"
        ? "verify:deep:ecosystem"
        : `verify:${lane}`;
    runPnpm(["--dir", appDir, scriptName, ...laneArgs], { env: runtimeProcessEnv });
    return;
  }
  if (command === "admin") {
    runPnpm(["--dir", appDir, "admin", ...rest], { env: runtimeProcessEnv });
    return;
  }
  if (command === "smoke") {
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

  run(corepackCmd, ["enable"]);
  run(corepackCmd, ["prepare", `pnpm@${pnpmVersion}`, "--activate"]);
  runPnpm(["--dir", appDir, "install", "--frozen-lockfile"], {
    env: runtimeProcessEnv,
  });
  buildWorkspaceBootstrapPackages();
  console.log("Materializing local config from tracked examples...");
  runPnpm(["--dir", appDir, "config:sync"], {
    env: runtimeProcessEnv,
  });
  materializeInstallerConfigExamples(appDir);
  console.log("Installing Playwright Chromium runtime...");
  runPnpm(["--dir", appDir, "--filter", "@goatcitadel/policy-engine", "exec", "playwright", "install", "chromium"], {
    env: runtimeProcessEnv,
  });
  if (!installArgs.skipVoice) {
    console.log(`Installing managed local voice runtime (${installArgs.voiceModel})...`);
    try {
      runPnpm([
        "--dir",
        appDir,
        "--filter",
        "@goatcitadel/gateway",
        "run",
        "voice:runtime",
        "install",
        "--model",
        installArgs.voiceModel,
      ], {
        env: runtimeProcessEnv,
      });
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
    throw new Error(`Update blocked because the installed checkout has non-config tracked changes: ${unexpected.join(", ")}`);
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

function doctor(extraArgs = []) {
  console.log("Running GoatCitadel doctor...");
  runPnpm(["--dir", appDir, "--filter", "@goatcitadel/gateway", "run", "doctor", ...extraArgs], {
    env: runtimeProcessEnv,
  });
}

function ensureWorkspaceBootstrapBuilds() {
  let builtAny = false;
  for (const workspacePackage of workspaceBootstrapBuildPackages) {
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

function buildWorkspaceBootstrapPackages() {
  for (const workspacePackage of workspaceBootstrapBuildPackages) {
    console.log(`Building bootstrap package ${workspacePackage}...`);
    runPnpm(["--dir", appDir, "--filter", workspacePackage, "build"]);
  }
}

function workspacePackageNeedsBuild(workspacePackage) {
  if (workspacePackage === "@goatcitadel/contracts") {
    return !fs.existsSync(path.join(appDir, "packages", "contracts", "dist", "index.js"));
  }
  if (workspacePackage === "@goatcitadel/extensions-sdk") {
    return !fs.existsSync(path.join(appDir, "packages", "extensions-sdk", "dist", "index.js"));
  }
  return false;
}

function maybeShowVersion(cmd, cmdArgs) {
  const result = spawnCommandSync(cmd, cmdArgs, { encoding: "utf8" });
  if (result.error) {
    console.log(`  ${cmd}: not found`);
    return;
  }
  const out = (result.stdout || result.stderr || "").trim();
  console.log(`  ${cmd}: ${out || "ok"}`);
}

function requireCommand(cmd) {
  const resolved = resolveCommandExecutable(cmd);
  if (!resolved) {
    throw new Error(`Missing required command: ${cmd}`);
  }
  return resolved;
}

function commandAvailable(cmd) {
  return resolveCommandExecutable(cmd) !== null;
}

function resolveCommandExecutable(cmd) {
  const candidates = process.platform === "win32"
    ? [cmd, `${cmd}.cmd`, `${cmd}.exe`]
    : [cmd];
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

  const candidates = process.platform === "win32"
    ? ["pnpm.cmd", "pnpm", "pnpm.exe"]
    : ["pnpm"];

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

function run(cmd, cmdArgs, options = {}) {
  const result = spawnCommandSync(cmd, cmdArgs, { stdio: "inherit", ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with code ${result.status}`);
  }
}

function spawnCommandSync(cmd, cmdArgs, options = {}) {
  if (isWindowsBatchCommand(cmd)) {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", buildWindowsCommand([cmd, ...cmdArgs])], options);
  }
  return spawnSync(cmd, cmdArgs, options);
}

function isWindowsBatchCommand(cmd) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
}

function buildWindowsCommand(parts) {
  return parts.map((value) => quoteWindowsCommandArg(String(value))).join(" ");
}

function quoteWindowsCommandArg(value) {
  if (value.length === 0) {
    return "\"\"";
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
  up         Start gateway + mission control [--verbose]
  gateway    Start gateway only [--verbose]
  ui         Start mission control UI only
  onboard    Run TUI onboarding wizard
  tui        Run terminal Mission Control
  tools      Tool access CLI (catalog/grants/invoke)
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
    case "verify":
      return "Verify";
    default:
      return "CLI";
  }
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
