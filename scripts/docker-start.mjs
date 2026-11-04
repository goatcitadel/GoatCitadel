#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import {
  PLACEHOLDER_AUTH_TOKEN,
  PLACEHOLDER_POSTGRES_PASSWORD,
  validateDistinctDockerSecrets,
  validateRequiredDockerSecret,
} from "./lib/docker-secrets.mjs";
import { resolveUiTarget } from "./lib/ui-target.mjs";

const rootDir = process.cwd();
const uiTarget = resolveUiTarget(rootDir, process.env);
const gatewayPort = process.env.GATEWAY_PORT ?? "8787";
const gatewayHost = process.env.GATEWAY_HOST ?? "0.0.0.0";
const missionControlPort = process.env.MISSION_CONTROL_PORT ?? "4173";
const missionControlHost = process.env.MISSION_CONTROL_HOST ?? "0.0.0.0";
assertRequiredSecret("GOATCITADEL_AUTH_TOKEN", PLACEHOLDER_AUTH_TOKEN);
assertRequiredSecret("GOATCITADEL_POSTGRES_PASSWORD", PLACEHOLDER_POSTGRES_PASSWORD);
assertDistinctSecrets("GOATCITADEL_AUTH_TOKEN", "GOATCITADEL_POSTGRES_PASSWORD");

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
  const isLive = (child) => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  let signalFailed = false;
  const onError = (error) => { signalFailed = true; console.error("[docker-start] child signal failed", error); };
  // Observe actual exits before signalling. An error or `killed` is not termination.
  const exited = Promise.all([...children].map((child) => !isLive(child) ? Promise.resolve() : new Promise((resolve) => {
    child.once("exit", resolve);
    child.on("error", onError);
  })));
  const signalLive = (signal) => {
    for (const child of children) {
      if (!isLive(child)) continue;
      try { if (!child.kill(signal)) signalFailed = true; }
      catch (error) { onError(error); }
    }
  };
  const waitForExit = async (budgetMs) => {
    let deadline;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => { deadline = setTimeout(() => resolve(false), budgetMs); }),
      ]);
    } finally { clearTimeout(deadline); }
  };
  signalLive("SIGTERM");
  // Gateway owns a 10 s drain/close window. Keep PID 1 alive through exit delivery.
  const forced = !await waitForExit(10_500);
  if (forced) {
    signalLive("SIGKILL");
    // Even denied signals must settle the supervisor as an explicit failure.
    if (!await waitForExit(1000)) console.error("[docker-start] shutdown incomplete: owned children have not exited");
  }
  for (const child of children) child.removeListener("error", onError);
  process.exit(forced || signalFailed ? 1 : exitCode);
}

function launch(label, command, args, options = {}) {
  console.log(`[docker-start] starting ${label}`);
  return spawn(command, args, {
    stdio: "inherit",
    ...options,
  });
}

function assertRequiredSecret(name, placeholder) {
  const error = validateRequiredDockerSecret(name, process.env[name], placeholder);
  if (error) {
    console.error(`[docker-start] ${error}`);
    process.exit(1);
  }
}

function assertDistinctSecrets(leftName, rightName) {
  const error = validateDistinctDockerSecrets(leftName, process.env[leftName], rightName, process.env[rightName]);
  if (error) {
    console.error(`[docker-start] ${error}`);
    process.exit(1);
  }
}
