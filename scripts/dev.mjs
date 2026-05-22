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

if (bootstrapPlan.shouldBuild) {
  console.log(`[dev] syncing runtime workspace packages: ${bootstrapPlan.packages.join(", ")}`);
  if (bootstrapPlan.reason) {
    console.log(`[dev] bootstrap reason: ${bootstrapPlan.reason}`);
  }
  const bootstrapArgs = bootstrapPlan.packages.flatMap((pkg) => ["--filter", pkg]);
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
