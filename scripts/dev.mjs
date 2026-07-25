#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeBootstrapMode, resolveBootstrapPlan } from "./lib/dev-bootstrap.mjs";
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

const useWorkspaceTypeScriptGraph =
  isTruthyEnv(process.env.GOATCITADEL_DEV_WORKSPACE_TSC_GRAPH) || isTruthyEnv(process.env.GOATCITADEL_DEV_TS7);

if (bootstrapPlan.shouldBuild) {
  console.log(`[dev] syncing runtime workspace packages: ${bootstrapPlan.packages.join(", ")}`);
  if (bootstrapPlan.reason) {
    console.log(`[dev] bootstrap reason: ${bootstrapPlan.reason}`);
  }
  const bootstrapResult = useWorkspaceTypeScriptGraph
    ? spawnSync(
        process.execPath,
        [path.join(repoRoot, "scripts", "typescript", "run-ts7-workspace.mjs"), "--mode", "build", "--group", "gateway"],
        { stdio: "inherit", cwd: repoRoot },
      )
    : runPnpmBootstrap(bootstrapPlan.packages);

  if (bootstrapResult.error) {
    throw bootstrapResult.error;
  }
  if (bootstrapResult.status !== 0) {
    console.error("[dev] workspace bootstrap build failed");
    process.exit(1);
  }
  if (useWorkspaceTypeScriptGraph) {
    console.log("[dev] bootstrap completed via TypeScript workspace graph");
  }
} else {
  console.log(`[dev] runtime workspace packages already fresh; skipped bootstrap (${bootstrapPlan.reason})`);
}

const devEnvBase = {
  ...process.env,
  GOATCITADEL_DEV: "1",
  GOATCITADEL_UI_PACKAGE: process.env.GOATCITADEL_UI_PACKAGE?.trim() || DEFAULT_DEV_UI_PACKAGE,
};
// When the bootstrap step confirms all runtime packages are already fresh, the
// supervisor's tsc -b reference build is guaranteed to be a no-op too. Forward
// a "skip" hint so the supervisor doesn't repeat the same freshness check via
// a much slower tsc invocation. Users can still force it by passing
// GOATCITADEL_GATEWAY_REFERENCE_BUILD=always.
const shouldForwardReferenceSkip =
  !bootstrapPlan.shouldBuild && !process.env.GOATCITADEL_GATEWAY_REFERENCE_BUILD?.trim();
const devEnv = shouldForwardReferenceSkip
  ? { ...devEnvBase, GOATCITADEL_GATEWAY_REFERENCE_BUILD: "skip" }
  : devEnvBase;
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

function isTruthyEnv(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function runPnpmBootstrap(packages) {
  const bootstrapArgs = packages.flatMap((pkg) => ["--filter", pkg]);
  return process.platform === "win32"
    ? spawnSync(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", buildWindowsCommand(["pnpm", ...bootstrapArgs, "build"])],
        { stdio: "inherit", cwd: repoRoot },
      )
    : spawnSync("pnpm", [...bootstrapArgs, "build"], { stdio: "inherit", cwd: repoRoot });
}

function buildWindowsCommand(parts) {
  return parts.map((value) => quoteWindowsCommandArg(String(value))).join(" ");
}

function quoteWindowsCommandArg(value) {
  assertSafeWindowsCommandArg(value);
  if (value.length === 0) {
    return "\"\"";
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

function setTerminalTitle(task) {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.write(`\u001b]0;GoatCitadel - ${task}\u0007`);
}
