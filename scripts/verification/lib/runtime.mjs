import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { repoRoot, sanitizeFilePart, spawnVerificationProcess, writeText } from "./shared.mjs";

let gatewayWorkspaceBuildEnsured = false;

export async function prepareVerificationRuntime(runId) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `goatcitadel-verify-${sanitizeFilePart(runId)}-`));
  await fs.mkdir(path.join(tempRoot, "data"), { recursive: true });
  await fs.cp(path.join(repoRoot, "config"), path.join(tempRoot, "config"), { recursive: true });
  if (existsSync(path.join(repoRoot, "skills"))) {
    await fs.cp(path.join(repoRoot, "skills"), path.join(tempRoot, "skills"), { recursive: true });
  }
  if (existsSync(path.join(repoRoot, "workspaces"))) {
    await fs.cp(path.join(repoRoot, "workspaces"), path.join(tempRoot, "workspaces"), { recursive: true });
  }
  return tempRoot;
}

export async function startVerificationStack(context, options = {}) {
  await ensureGatewayWorkspaceBuild(context);
  const runtimeRoot = options.runtimeRoot ?? await prepareVerificationRuntime(context.runId);
  const gatewayPort = await resolveAvailablePort(Number(options.gatewayPort ?? 8787));
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const gatewayEnv = {
    GOATCITADEL_ROOT_DIR: runtimeRoot,
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(gatewayPort),
    GOATCITADEL_AUTH_MODE: "none",
    GOATCITADEL_DATABASE_DRIVER: "sqlite",
    GOATCITADEL_DISABLE_SECRET_STORE: "true",
    GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "true",
    GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "false",
    ...options.gatewayEnv,
  };

  const gateway = await startProcess(context, "gateway", [pnpmCommand(), "--dir", repoRoot, "dev:gateway"], gatewayEnv);
  let ui;
  let uiPort;
  let uiUrl;
  try {
    await waitForHttp(`${gatewayUrl}/health`, "Gateway health", 180000, gateway);
    if (options.includeUi !== false) {
      uiPort = await resolveAvailablePort(Number(options.uiPort ?? 5173));
      uiUrl = `http://127.0.0.1:${uiPort}`;
      const uiEnv = {
        VITE_GATEWAY_URL: gatewayUrl,
        VITE_GOATCITADEL_DEV_DIAGNOSTICS_ENABLED: "true",
        VITE_GOATCITADEL_DEV_DIAGNOSTICS_VERBOSE: "false",
        ...options.uiEnv,
      };
      ui = await startProcess(
        context,
        "ui",
        [
          pnpmCommand(),
          "--dir",
          repoRoot,
          "--filter",
          "@goatcitadel/mission-control",
          "exec",
          "vite",
          "--host",
          "127.0.0.1",
          "--port",
          String(uiPort),
        ],
        uiEnv,
      );
      await waitForHttp(uiUrl, "Mission Control UI", 180000, ui);
    }
    return {
      runtimeRoot,
      gateway,
      ui,
      gatewayUrl,
      uiUrl,
    };
  } catch (error) {
    await stopVerificationStack({ runtimeRoot, gateway, ui });
    throw error;
  }
}

export async function stopVerificationStack(stack) {
  if (stack?.ui) {
    await stopProcess(stack.ui);
  }
  if (stack?.gateway) {
    await stopProcess(stack.gateway);
  }
  if (stack?.runtimeRoot) {
    await removeRuntimeRootWithRetry(stack.runtimeRoot);
  }
}

export async function waitForHttp(url, label, timeoutMs = 180000, handle = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle?.child?.exitCode !== null) {
      const stdoutPath = handle.stdoutPath ? ` stdout: ${handle.stdoutPath}` : "";
      const stderrPath = handle.stderrPath ? ` stderr: ${handle.stderrPath}` : "";
      throw new Error(`${label} process exited before becoming ready.${stdoutPath}${stderrPath}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // keep waiting
    }
    await delay(1500);
  }
  throw new Error(`${label} did not become ready in time: ${url}`);
}

export async function startProcess(context, name, commandArgs, extraEnv) {
  const [command, ...args] = commandArgs;
  const stdoutPath = path.join(context.artifactRoot, "diagnostics", `${name}.stdout.log`);
  const stderrPath = path.join(context.artifactRoot, "diagnostics", `${name}.stderr.log`);
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawnVerificationProcess(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
  child.on("exit", async () => {
    await writeText(stdoutPath, Buffer.concat(stdoutChunks).toString("utf8"));
    await writeText(stderrPath, Buffer.concat(stderrChunks).toString("utf8"));
  });
  return {
    child,
    stdoutPath,
    stderrPath,
  };
}

export async function stopProcess(handle) {
  if (!handle?.child || handle.child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "taskkill", "/PID", String(handle.child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    await waitForExit(handle.child, 12000).catch(() => undefined);
    handle.child.stdout?.destroy();
    handle.child.stderr?.destroy();
    return;
  }
  handle.child.kill("SIGTERM");
  await waitForExit(handle.child, 8000).catch(async () => {
    handle.child.kill("SIGKILL");
    await waitForExit(handle.child, 4000).catch(() => undefined);
  });
  handle.child.stdout?.destroy();
  handle.child.stderr?.destroy();
}

export async function requestJson(gatewayUrl, route, init = {}) {
  const method = init.method ?? "GET";
  const response = await fetch(`${gatewayUrl}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

export function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureGatewayWorkspaceBuild(context) {
  if (gatewayWorkspaceBuildEnsured) {
    return;
  }

  const gatewayPackageJson = JSON.parse(
    await fs.readFile(path.join(repoRoot, "apps", "gateway", "package.json"), "utf8"),
  );
  const workspacePackages = Object.keys(gatewayPackageJson.dependencies ?? {})
    .filter((dependency) => dependency.startsWith("@goatcitadel/"))
    .map((dependency) => {
      const packageName = dependency.replace("@goatcitadel/", "");
      return {
        dependency,
        packageName,
        outputPath: path.join(repoRoot, "packages", packageName, "dist", "index.js"),
      };
    });
  const missingWorkspacePackages = workspacePackages.filter(({ outputPath }) => !existsSync(outputPath));

  if (missingWorkspacePackages.length === 0) {
    gatewayWorkspaceBuildEnsured = true;
    return;
  }

  const logLines = [
    "missing outputs detected:",
    ...missingWorkspacePackages.map(({ outputPath }) => outputPath),
    "",
    "$ pnpm --dir <repoRoot> --filter @goatcitadel/gateway... build",
    "",
  ];
  const result = runPnpmSync(["--dir", repoRoot, "--filter", "@goatcitadel/gateway...", "build"]);
  logLines.push(result.stdout ?? "", result.stderr ?? "", result.error ? `${result.error.name}: ${result.error.message}` : "");

  let remainingMissingPackages = missingWorkspacePackages.filter(({ outputPath }) => !existsSync(outputPath));
  for (const missingPackage of remainingMissingPackages) {
    logLines.push(
      "",
      `$ pnpm --dir <repoRoot> --filter ${missingPackage.dependency} exec tsc -b tsconfig.json --force`,
      "",
    );
    const forcedResult = runPnpmSync([
      "--dir",
      repoRoot,
      "--filter",
      missingPackage.dependency,
      "exec",
      "tsc",
      "-b",
      "tsconfig.json",
      "--force",
    ]);
    logLines.push(
      forcedResult.stdout ?? "",
      forcedResult.stderr ?? "",
      forcedResult.error ? `${forcedResult.error.name}: ${forcedResult.error.message}` : "",
    );
    if (forcedResult.error || forcedResult.status !== 0) {
      const buildLogPath = path.join(context.artifactRoot, "diagnostics", "workspace-build.log");
      await writeText(buildLogPath, logLines.join("\n"));
      throw new Error(`Failed to build gateway workspace dependencies. See ${buildLogPath}`);
    }
  }

  remainingMissingPackages = missingWorkspacePackages.filter(({ outputPath }) => !existsSync(outputPath));
  const buildLogPath = path.join(context.artifactRoot, "diagnostics", "workspace-build.log");
  await writeText(buildLogPath, logLines.join("\n"));
  if (result.error || result.status !== 0 || remainingMissingPackages.length > 0) {
    throw new Error(`Failed to build gateway workspace dependencies. See ${buildLogPath}`);
  }

  gatewayWorkspaceBuildEnsured = true;
}

function runPnpmSync(args) {
  if (process.platform === "win32") {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", pnpmCommand(), ...args], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    });
  }
  return spawnSync(pnpmCommand(), args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
}

async function resolveAvailablePort(preferredPort) {
  if (!Number.isFinite(preferredPort) || preferredPort <= 0) {
    return await resolveEphemeralPort();
  }
  const preferredIsFree = await isPortFree(preferredPort);
  if (preferredIsFree) {
    return preferredPort;
  }
  return await resolveEphemeralPort();
}

async function resolveEphemeralPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("failed to resolve an available port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function removeRuntimeRootWithRetry(runtimeRoot, attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rm(runtimeRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const isTransientCleanupLock = error?.code === "EBUSY" || error?.code === "EPERM" || error?.code === "EACCES";
      if (!isTransientCleanupLock || attempt === attempts - 1) {
        if (isTransientCleanupLock) {
          console.warn(
            `[verify] unable to remove verification runtime root after ${attempts} attempts; leaving ${runtimeRoot} in place (${error.code}).`,
          );
          return;
        }
        throw error;
      }
      await delay(1000 * (attempt + 1));
    }
  }
  if (lastError) {
    throw lastError;
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process exit timeout")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
