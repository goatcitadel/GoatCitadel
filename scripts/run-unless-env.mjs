#!/usr/bin/env node
import { spawn } from "node:child_process";

const [, , envName, command, ...args] = process.argv;

if (!envName || !command) {
  console.error("Usage: node scripts/run-unless-env.mjs ENV_NAME command [args...]");
  process.exit(2);
}

if (isTruthyEnv(process.env[envName])) {
  console.log(`[run-unless-env] ${envName} is set; skipping ${[command, ...args].join(" ")}`);
  process.exit(0);
}

const spawnSpec = resolveSpawnSpec(command, args);
const child = spawn(spawnSpec.command, spawnSpec.args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  shell: false,
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("close", (code) => {
  process.exit(code ?? 0);
});

function isTruthyEnv(value) {
  if (!value) {
    return false;
  }
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

function resolveSpawnSpec(commandName, commandArgs) {
  const resolvedCommand = process.platform === "win32" && commandName === "pnpm" ? "pnpm.cmd" : commandName;
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolvedCommand)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", buildWindowsCommand([resolvedCommand, ...commandArgs])],
    };
  }
  return { command: resolvedCommand, args: commandArgs };
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
