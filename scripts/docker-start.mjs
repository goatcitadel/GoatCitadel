#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { resolveUiTarget } from "./lib/ui-target.mjs";

const rootDir = process.cwd();
const uiTarget = resolveUiTarget(rootDir, process.env);
const gatewayPort = process.env.GATEWAY_PORT ?? "8787";
const gatewayHost = process.env.GATEWAY_HOST ?? "0.0.0.0";
const missionControlPort = process.env.MISSION_CONTROL_PORT ?? "4173";
const missionControlHost = process.env.MISSION_CONTROL_HOST ?? "0.0.0.0";
const PLACEHOLDER_AUTH_TOKEN = "change-this-goatcitadel-token";
const PLACEHOLDER_POSTGRES_PASSWORD = "change-this-postgres-password";

assertRequiredSecret("GOATCITADEL_AUTH_TOKEN", PLACEHOLDER_AUTH_TOKEN);
assertRequiredSecret("GOATCITADEL_POSTGRES_PASSWORD", PLACEHOLDER_POSTGRES_PASSWORD);

const children = new Set();
let shuttingDown = false;

const gateway = launch("gateway", process.execPath, [path.join(rootDir, "apps", "gateway", "dist", "main.js")], {
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "production",
    GATEWAY_HOST: gatewayHost,
    GATEWAY_PORT: gatewayPort,
    GOATCITADEL_TERMINAL_TASK: "Docker Gateway",
  },
});

const missionControl = launch(
  uiTarget.packageDirName,
  path.join(uiTarget.appDir, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite"),
  ["preview", "--host", missionControlHost, "--port", missionControlPort, "--strictPort"],
  {
    cwd: uiTarget.appDir,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "production",
    },
  },
);

children.add(gateway);
children.add(missionControl);

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[docker-start] ${child.spawnargs[0]} exited with ${detail}`);
    void shutdown(code ?? 1);
  });
}

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }
  process.exit(exitCode);
}

function launch(label, command, args, options = {}) {
  console.log(`[docker-start] starting ${label}`);
  return spawn(command, args, {
    stdio: "inherit",
    ...options,
  });
}

function assertRequiredSecret(name, placeholder) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[docker-start] ${name} is required. Set it to a long random value before running docker compose.`);
    process.exit(1);
  }
  if (value === placeholder) {
    console.error(`[docker-start] ${name} still uses the documented placeholder. Replace it before startup.`);
    process.exit(1);
  }
}
