#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveUiTarget } from "./lib/ui-target.mjs";

const DEFAULT_DEV_UI_PACKAGE = "@goatcitadel/mission-control-next";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const bootstrapPackages = [
  "@goatcitadel/contracts",
  "@goatcitadel/extensions-sdk",
  "@goatcitadel/gateway-core",
  "@goatcitadel/memory-core",
  "@goatcitadel/mission-control-shared",
  "@goatcitadel/mesh-core",
  "@goatcitadel/orchestration",
  "@goatcitadel/policy-engine",
  "@goatcitadel/skills",
  "@goatcitadel/storage",
  "@goatcitadel/threaded-surface-core",
];

const rawArgs = process.argv.slice(2);
const { verbose, bootstrapMode, passthrough } = extractLauncherOptions(rawArgs);
const bootstrapPlan = resolveBootstrapPlan(repoRoot, bootstrapPackages, bootstrapMode);

if (bootstrapPlan.shouldBuild) {
  console.log(`[dev] syncing runtime workspace packages: ${bootstrapPackages.join(", ")}`);
  if (bootstrapPlan.reason) {
    console.log(`[dev] bootstrap reason: ${bootstrapPlan.reason}`);
  }
  const bootstrapArgs = bootstrapPackages.flatMap((pkg) => ["--filter", pkg]);
  const bootstrapResult =
    process.platform === "win32"
      ? spawnSync(
          process.env.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", buildWindowsCommand(["pnpm", ...bootstrapArgs, "build"])],
          { stdio: "inherit", cwd: repoRoot },
        )
      : spawnSync("pnpm", [...bootstrapArgs, "build"], { stdio: "inherit", cwd: repoRoot });

  if (bootstrapResult.error) {
    throw bootstrapResult.error;
  }
  if (bootstrapResult.status !== 0) {
    console.error("[dev] workspace bootstrap build failed");
    process.exit(1);
  }
} else {
  console.log(`[dev] runtime workspace packages already fresh; skipped bootstrap (${bootstrapPlan.reason})`);
}

const devEnv = process.env.GOATCITADEL_UI_PACKAGE?.trim()
  ? process.env
  : { ...process.env, GOATCITADEL_UI_PACKAGE: DEFAULT_DEV_UI_PACKAGE };
const uiTarget = resolveUiTarget(process.cwd(), devEnv);

setTerminalTitle("Dev");
console.log(`[dev] starting gateway + ${uiTarget.displayName} (${uiTarget.packageName})`);

const commandArgs = [
  "--parallel",
  "--filter",
  "@goatcitadel/gateway",
  "--filter",
  uiTarget.packageName,
  "dev",
  ...passthrough,
];

const result = process.platform === "win32"
  ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", buildWindowsCommand(["pnpm", ...commandArgs])], {
      stdio: "inherit",
      cwd: repoRoot,
      env: {
        ...devEnv,
        GOATCITADEL_TERMINAL_TASK: "Dev",
        ...(verbose ? { GOATCITADEL_VERBOSE: "1" } : {}),
      },
    })
  : spawnSync("pnpm", commandArgs, {
      stdio: "inherit",
      cwd: repoRoot,
      env: {
        ...devEnv,
        GOATCITADEL_TERMINAL_TASK: "Dev",
        ...(verbose ? { GOATCITADEL_VERBOSE: "1" } : {}),
      },
    });

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 0;

function extractLauncherOptions(argv) {
  const passthrough = [];
  let bootstrapMode = normalizeBootstrapMode(process.env.GOATCITADEL_DEV_BOOTSTRAP) ?? "auto";
  let verbose = false;
  for (const value of argv) {
    if (value === "--verbose" || value === "-verbose") {
      verbose = true;
      continue;
    }
    if (value === "--skip-bootstrap") {
      bootstrapMode = "skip";
      continue;
    }
    if (value === "--force-bootstrap") {
      bootstrapMode = "always";
      continue;
    }
    if (value.startsWith("--bootstrap=")) {
      bootstrapMode = normalizeBootstrapMode(value.slice("--bootstrap=".length)) ?? bootstrapMode;
      continue;
    }
    passthrough.push(value);
  }
  return { verbose, bootstrapMode, passthrough };
}

function normalizeBootstrapMode(value) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "always" || normalized === "force" || normalized === "1" || normalized === "true") {
    return "always";
  }
  if (normalized === "skip" || normalized === "never" || normalized === "0" || normalized === "false") {
    return "skip";
  }
  if (normalized === "auto") {
    return "auto";
  }
  console.warn(`[dev] ignoring unknown bootstrap mode "${value}"; expected auto, always, or skip`);
  return undefined;
}

function resolveBootstrapPlan(rootDir, packageNames, mode) {
  if (mode === "always") {
    return { shouldBuild: true, reason: "forced by bootstrap mode" };
  }
  if (mode === "skip") {
    return { shouldBuild: false, reason: "forced by bootstrap mode" };
  }

  const stale = [];
  for (const packageName of packageNames) {
    const freshness = readWorkspacePackageFreshness(rootDir, packageName);
    if (!freshness.fresh) {
      stale.push(`${packageName}${freshness.reason ? ` (${freshness.reason})` : ""}`);
    }
  }

  if (stale.length === 0) {
    return { shouldBuild: false, reason: "all runtime package dist outputs are newer than inputs" };
  }

  return {
    shouldBuild: true,
    reason: `stale or missing outputs: ${stale.join(", ")}`,
  };
}

function readWorkspacePackageFreshness(rootDir, packageName) {
  const packageDir = findWorkspacePackageDir(rootDir, packageName);
  if (!packageDir) {
    return { fresh: false, reason: "package not found" };
  }
  const distDir = path.join(packageDir, "dist");
  if (!fs.existsSync(distDir)) {
    return { fresh: false, reason: "missing dist" };
  }

  const inputMtime = newestMtime([
    path.join(packageDir, "src"),
    path.join(packageDir, "scripts"),
    path.join(packageDir, "package.json"),
    ...findTsconfigFiles(packageDir),
  ]);
  const outputMtime = newestMtime([distDir], (filePath) => /\.(?:js|d\.ts|json|map)$/u.test(filePath));

  if (inputMtime === undefined) {
    return { fresh: false, reason: "missing inputs" };
  }
  if (outputMtime === undefined) {
    return { fresh: false, reason: "missing dist outputs" };
  }
  if (inputMtime > outputMtime + 1) {
    return { fresh: false, reason: "inputs newer than dist" };
  }
  return { fresh: true };
}

function findWorkspacePackageDir(rootDir, packageName) {
  for (const workspaceRoot of ["packages", "apps"]) {
    const parent = path.join(rootDir, workspaceRoot);
    if (!fs.existsSync(parent)) {
      continue;
    }
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageJsonPath = path.join(parent, entry.name, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        if (packageJson.name === packageName) {
          return path.dirname(packageJsonPath);
        }
      } catch {
        // Treat unreadable package metadata as not found so the bootstrap rebuilds.
      }
    }
  }
  return undefined;
}

function findTsconfigFiles(packageDir) {
  return fs
    .readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^tsconfig(?:\..+)?\.json$/u.test(entry.name))
    .map((entry) => path.join(packageDir, entry.name));
}

function newestMtime(pathsToCheck, fileFilter) {
  let newest;
  for (const candidate of pathsToCheck) {
    for (const mtime of collectMtimes(candidate, fileFilter)) {
      newest = newest === undefined ? mtime : Math.max(newest, mtime);
    }
  }
  return newest;
}

function collectMtimes(targetPath, fileFilter = () => true) {
  if (!fs.existsSync(targetPath)) {
    return [];
  }
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return fileFilter(targetPath) ? [stat.mtimeMs] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const mtimes = [];
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    mtimes.push(...collectMtimes(path.join(targetPath, entry.name), fileFilter));
  }
  return mtimes;
}

function buildWindowsCommand(parts) {
  return parts.map((value) => quoteWindowsCommandArg(String(value))).join(" ");
}

function quoteWindowsCommandArg(value) {
  if (value.length === 0) {
    return "\"\"";
  }
  if (!/[\s\"&()^<>|]/.test(value)) {
    return value;
  }
  return `"${value.replace(/([\"\\])/g, "\\$1")}"`;
}

function setTerminalTitle(task) {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.write(`\u001b]0;GoatCitadel - ${task}\u0007`);
}
