#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const contractsDist = path.resolve("packages/contracts/dist/index.js");
const extensionsSdkDist = path.resolve("packages/extensions-sdk/dist/index.js");
if (!fs.existsSync(contractsDist) || !fs.existsSync(extensionsSdkDist)) {
  console.log("[dev] bootstrap packages not built — running bootstrap build...");
  const bootstrapResult = process.platform === "win32"
    ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "pnpm --filter @goatcitadel/contracts --filter @goatcitadel/extensions-sdk build"], {
        stdio: "inherit",
      })
    : spawnSync("pnpm", ["--filter", "@goatcitadel/contracts", "--filter", "@goatcitadel/extensions-sdk", "build"], {
        stdio: "inherit",
      });
  if (bootstrapResult.error) {
    throw bootstrapResult.error;
  }
  if (bootstrapResult.status !== 0) {
    console.error("[dev] contracts build failed");
    process.exit(1);
  }
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
  if (!/[\s"&()^<>|]/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function setTerminalTitle(task) {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.write(`\u001b]0;GoatCitadel - ${task}\u0007`);
}
