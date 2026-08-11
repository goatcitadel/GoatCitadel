#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireWorktreeOutputLock } from "./lib/worktree-output-lock.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");

async function main() {
  const { command, args, owner } = parseArgs(process.argv.slice(2));
  const lease = await acquireWorktreeOutputLock({ repoRoot, owner });
  try {
    const result = await runCommand(command, args);
    if (result.signal) {
      console.error(`Locked command terminated by ${result.signal}.`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = result.code ?? 1;
  } finally {
    await lease.release();
  }
}

function parseArgs(argv) {
  let owner = "raw-build-or-typecheck";
  let separator = -1;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--") {
      separator = index;
      break;
    }
    if (item.startsWith("--label=")) {
      owner = item.slice("--label=".length).trim() || owner;
      continue;
    }
    throw new Error(`Unknown lock-wrapper option: ${item}`);
  }
  if (separator < 0 || !argv[separator + 1]) {
    throw new Error("Usage: node scripts/run-with-worktree-output-lock.mjs [--label=owner] -- command [args...]");
  }
  return {
    owner,
    command: argv[separator + 1],
    args: argv.slice(separator + 2),
  };
}

function runCommand(command, args) {
  const invocation = resolveInvocation(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: false,
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function resolveInvocation(command, args) {
  const resolvedCommand = process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(resolvedCommand)) {
    return { command: resolvedCommand, args };
  }
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", buildWindowsCommand([resolvedCommand, ...args])],
  };
}

function buildWindowsCommand(parts) {
  return parts.map((value) => quoteWindowsCommandArg(String(value))).join(" ");
}

function quoteWindowsCommandArg(value) {
  if (/["%\r\n\0]/u.test(value)) {
    throw new Error("Unsafe quote, percent expansion, or control character in Windows command argument.");
  }
  if (value.length === 0) return '""';
  return /[\s&()^<>|]/u.test(value) ? `"${value}"` : value;
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
