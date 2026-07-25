#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const PROJECT_GROUPS = {
  gateway: [
    "packages/contracts/tsconfig.json",
    "packages/extensions-sdk/tsconfig.json",
    "packages/storage/tsconfig.json",
    "packages/gateway-core/tsconfig.json",
    "packages/mesh-core/tsconfig.json",
    "packages/memory-core/tsconfig.json",
    "packages/orchestration/tsconfig.json",
    "packages/policy-engine/tsconfig.json",
    "packages/skills/tsconfig.json",
    // The gateway's session-control CLI imports @goatcitadel/mission-control-shared
    // subpaths, whose types resolve through that package's dist. It is not one of
    // apps/gateway's project references, so nothing in this group would build it and
    // the CLI's imports fail to resolve. Build it ahead of the gateway, exactly as
    // the mission-control-next group already does.
    "packages/mission-control-shared/tsconfig.json",
    "apps/gateway/tsconfig.json",
  ],
  "mission-control-next": [
    "packages/contracts/tsconfig.json",
    "packages/mission-control-shared/tsconfig.json",
    "packages/threaded-surface-core/tsconfig.json",
    "apps/mission-control-next/tsconfig.json",
    "apps/mission-control-next/tsconfig.node.json",
  ],
};

const VALID_MODES = new Set(["typecheck", "build"]);
const VALID_COMPILERS = new Set(["tsc", "tsc6"]);
const ALL_GROUP_NAMES = Object.keys(PROJECT_GROUPS);

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const mode = options.mode ?? "typecheck";
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unsupported mode "${mode}". Expected one of: ${[...VALID_MODES].join(", ")}.`);
  }

  const compiler = options.compiler ?? "tsc";
  if (!VALID_COMPILERS.has(compiler)) {
    throw new Error(`Unsupported compiler "${compiler}". Expected one of: ${[...VALID_COMPILERS].join(", ")}.`);
  }

  const groups = resolveGroups(options.groups);
  const projects = dedupeProjects(groups.flatMap((groupName) => PROJECT_GROUPS[groupName]));

  if (projects.length === 0) {
    throw new Error("No TypeScript project groups were selected.");
  }

  const compilerLabel = compiler === "tsc" ? "TypeScript 7" : "TypeScript 6 compatibility";
  console.log(`Running ${compilerLabel} ${mode} for groups: ${groups.join(", ")}`);

  // Composite project references reject `--noEmit`; use build mode for both
  // validation commands. Outputs land in ignored dist/tsbuildinfo locations.
  await runTypeScriptCommand(["exec", compiler, "-b", ...projects, "--pretty", "false", "--force"]);
}

function parseCliArgs(args) {
  const groups = [];
  let compiler;
  let mode;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--mode") {
      mode = readOptionValue(args, index, token);
      index += 1;
      continue;
    }
    if (token === "--compiler") {
      compiler = readOptionValue(args, index, token);
      index += 1;
      continue;
    }
    if (token === "--group") {
      const rawGroup = readOptionValue(args, index, token);
      groups.push(...rawGroup.split(",").map((value) => value.trim()).filter(Boolean));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return { compiler, groups, mode };
}

function readOptionValue(args, index, optionName) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${optionName}.`);
  }
  return value;
}

function resolveGroups(requestedGroups) {
  if (!requestedGroups || requestedGroups.length === 0) {
    return ALL_GROUP_NAMES;
  }

  const selected = [];
  for (const groupName of requestedGroups) {
    if (groupName === "all") {
      selected.push(...ALL_GROUP_NAMES);
      continue;
    }
    if (!Object.hasOwn(PROJECT_GROUPS, groupName)) {
      throw new Error(`Unknown TypeScript project group "${groupName}". Expected one of: ${["all", ...ALL_GROUP_NAMES].join(", ")}.`);
    }
    selected.push(groupName);
  }
  return dedupeProjects(selected);
}

function dedupeProjects(values) {
  const seen = new Set();
  const deduped = [];
  for (const value of values) {
    const normalized = value.replaceAll("\\", "/");
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

async function runTypeScriptCommand(args) {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawnCommand(pnpmExecutable, args, {
      cwd: repoRoot,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`TypeScript command failed with exit code ${exitCode}.`);
  }
}

function spawnCommand(command, args, options) {
  if (process.platform !== "win32" || !requiresWindowsCommandShell(command)) {
    return spawn(command, args, options);
  }
  const windowsCommand = buildWindowsCommand(command, args);
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", windowsCommand], options);
}

function requiresWindowsCommandShell(command) {
  return /\.(cmd|bat)$/i.test(command);
}

function buildWindowsCommand(command, args) {
  return [quoteWindowsArg(command), ...args.map((value) => quoteWindowsArg(value))].join(" ");
}

function quoteWindowsArg(value) {
  assertSafeWindowsArg(value);
  if (value.length === 0) {
    return '""';
  }
  if (!/[ \t&()^<>|]/.test(value)) {
    return value;
  }
  return `"${value}"`;
}

function assertSafeWindowsArg(value) {
  if (/["%\r\n\0]/.test(value)) {
    throw new Error(
      "Windows shell command arguments must not contain embedded quotes, percent expansions, or control characters.",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
