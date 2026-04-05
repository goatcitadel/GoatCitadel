#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const bootstrapPackages = [
  "@goatcitadel/contracts",
  "@goatcitadel/extensions-sdk",
  "@goatcitadel/gateway-core",
  "@goatcitadel/memory-core",
  "@goatcitadel/mesh-core",
  "@goatcitadel/orchestration",
  "@goatcitadel/policy-engine",
  "@goatcitadel/skills",
  "@goatcitadel/storage",
];

console.log(`[dev] syncing runtime workspace packages: ${bootstrapPackages.join(", ")}`);
const bootstrapArgs = bootstrapPackages.flatMap((pkg) => ["--filter", pkg]);
const bootstrapResult = process.platform === "win32"
  ? spawnSync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", buildWindowsCommand(["pnpm", ...bootstrapArgs, "build"])],
      { stdio: "inherit" },
    )
  : spawnSync("pnpm", [...bootstrapArgs, "build"], { stdio: "inherit" });

if (bootstrapResult.error) {
  throw bootstrapResult.error;
}
if (bootstrapResult.status !== 0) {
  console.error("[dev] workspace bootstrap build failed");
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
const { verbose, passthrough } = extractVerboseFlag(rawArgs);

setTerminalTitle("Dev");

const commandArgs = [
  "--parallel",
  "--filter",
  "@goatcitadel/gateway",
  "--filter",
  "@goatcitadel/mission-control",
  "dev",
  ...passthrough,
];

const result = process.platform === "win32"
  ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", buildWindowsCommand(["pnpm", ...commandArgs])], {
      stdio: "inherit",
      env: {
        ...process.env,
        GOATCITADEL_TERMINAL_TASK: "Dev",
        ...(verbose ? { GOATCITADEL_VERBOSE: "1" } : {}),
      },
    })
  : spawnSync("pnpm", commandArgs, {
      stdio: "inherit",
      env: {
        ...process.env,
        GOATCITADEL_TERMINAL_TASK: "Dev",
        ...(verbose ? { GOATCITADEL_VERBOSE: "1" } : {}),
      },
    });

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 0;

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
