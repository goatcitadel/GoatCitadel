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

const child = spawn(resolveCommand(command), args, {
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

function resolveCommand(commandName) {
  if (process.platform === "win32" && commandName === "pnpm") {
    return "pnpm.cmd";
  }
  return commandName;
}
