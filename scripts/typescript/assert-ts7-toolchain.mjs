#!/usr/bin/env node

import process from "node:process";
import { spawn } from "node:child_process";

const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const EXPECTED_TS7_VERSION = "Version 7.0.2";
const EXPECTED_TS6_VERSION_PATTERN = /^Version 6\.0\.\d+$/;

async function main() {
  const tscVersion = await run(["exec", "tsc", "--version"]);
  if (tscVersion.trim() !== EXPECTED_TS7_VERSION) {
    throw new Error(`Expected tsc to resolve to ${EXPECTED_TS7_VERSION}, got ${JSON.stringify(tscVersion.trim())}.`);
  }

  const tsc6Version = await run(["exec", "tsc6", "--version"]);
  if (!EXPECTED_TS6_VERSION_PATTERN.test(tsc6Version.trim())) {
    throw new Error(`Expected tsc6 to resolve to TypeScript 6.0.x, got ${JSON.stringify(tsc6Version.trim())}.`);
  }

  const tsModule = await import("typescript");
  const ts = tsModule.default ?? tsModule;
  if (!/^6\.0\.\d+$/.test(String(ts.version))) {
    throw new Error(`Expected import "typescript" to resolve to the TS6 API package, got ${JSON.stringify(ts.version)}.`);
  }
  for (const apiName of ["createSourceFile", "transpileModule", "flattenDiagnosticMessageText"]) {
    if (typeof ts[apiName] !== "function") {
      throw new Error(`Expected TS6 API import to expose ${apiName}.`);
    }
  }

  console.log(`TypeScript toolchain OK: tsc=${tscVersion.trim()}, tsc6=${tsc6Version.trim()}, API=${ts.version}`);
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(pnpmExecutable, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`pnpm ${args.join(" ")} failed with exit code ${code}.\n${stderrText}`));
        return;
      }
      resolve(stdoutText);
    });
  });
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
