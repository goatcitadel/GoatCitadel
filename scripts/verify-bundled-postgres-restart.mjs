import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewaySupervisor = path.join(repoRoot, "apps", "gateway", "dist", "dev-supervisor.js");
const gatewayHealthTimeoutMs = 180_000;
const processStopTimeoutMs = 20_000;
const windowsCmd = "C:\\Windows\\System32\\cmd.exe";

let runtimeRoot;
let containerName;
let containerImage;
let supervisor;

try {
  assertDockerAvailable();
  runWorkspaceTypecheck();

  runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-bundled-postgres-restart-"));
  await fs.cp(path.join(repoRoot, "config"), path.join(runtimeRoot, "config"), { recursive: true });
  containerName = buildBundledDockerContainerName(runtimeRoot);
  assertContainerDoesNotExist(containerName);

  const gatewayPort = await resolveAvailablePort();
  let postgresPort = await resolveAvailablePort();
  while (postgresPort === gatewayPort) {
    postgresPort = await resolveAvailablePort();
  }
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const env = buildSupervisorEnv(runtimeRoot, gatewayPort, postgresPort);
  process.stdout.write(
    `[bundled-postgres-restart] runtime=${runtimeRoot} gatewayPort=${gatewayPort} postgresPort=${postgresPort} container=${containerName}\n`,
  );

  supervisor = startSupervisor(env);
  await waitForHealth(gatewayUrl, supervisor);

  const originalContainerId = inspectContainerId(containerName);
  assertContainerUsesExpectedDataDir(containerName, runtimeRoot);
  process.stdout.write(
    `[bundled-postgres-restart] first startup ready; container=${containerName} id=${originalContainerId.slice(0, 12)}\n`,
  );

  await stopSupervisor(supervisor);
  supervisor = undefined;
  stopContainer(containerName);
  assertContainerState(containerName, "exited");

  supervisor = startSupervisor(env);
  await waitForHealth(gatewayUrl, supervisor);

  const restartedContainerId = inspectContainerId(containerName);
  if (restartedContainerId !== originalContainerId) {
    throw new Error(
      `Bundled Postgres container identity changed across restart: expected ${originalContainerId}, received ${restartedContainerId}.`,
    );
  }
  assertContainerState(containerName, "running");
  assertContainerUsesExpectedDataDir(containerName, runtimeRoot);

  process.stdout.write(
    `[bundled-postgres-restart] PASS: stopped container ${containerName} (${originalContainerId.slice(0, 12)}) was reused and ${gatewayUrl}/health recovered.\n`,
  );
} finally {
  if (supervisor) {
    await stopSupervisor(supervisor).catch((error) => {
      process.stderr.write(`[bundled-postgres-restart] failed to stop test supervisor: ${formatError(error)}\n`);
    });
  }
  if (containerName && runtimeRoot) {
    containerImage = tryInspectContainerImage(containerName);
    await removeReviewContainer(containerName, runtimeRoot).catch((error) => {
      process.stderr.write(
        `[bundled-postgres-restart] cleanup refused or failed for ${containerName}: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
  }
  if (runtimeRoot) {
    await reclaimRuntimeRootOwnership(runtimeRoot, containerImage).catch((error) => {
      process.stderr.write(
        `[bundled-postgres-restart] failed to reclaim ownership of the temporary runtime root: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
    await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch((error) => {
      process.stderr.write(
        `[bundled-postgres-restart] failed to remove temporary runtime root: ${formatError(error)}\n`,
      );
      process.exitCode = 1;
    });
  }
}

function assertDockerAvailable() {
  const result = run("docker", ["info", "--format", "{{.ServerVersion}}"], { allowFailure: true });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(
      `Docker is required for verify:bundled-postgres:restart. ${result.stderr.trim() || "Docker did not report a server version."}`,
    );
  }
}

function runWorkspaceTypecheck() {
  process.stdout.write("[bundled-postgres-restart] building workspace references\n");
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = run(command, ["typecheck"], { cwd: repoRoot, inherit: true, allowFailure: true });
  if (result.status !== 0) {
    throw new Error(
      `Workspace typecheck failed before the live Docker regression (exit ${result.status ?? "unknown"}).`,
    );
  }
}

function buildBundledDockerContainerName(rootDir) {
  const hostname = os
    .hostname()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const hash = createHash("sha256").update(path.resolve(rootDir)).digest("hex").slice(0, 10);
  return `goatcitadel-postgres-${hostname || "local"}-${hash}`;
}

function assertContainerDoesNotExist(name) {
  const result = run("docker", ["container", "inspect", name], { allowFailure: true });
  if (result.status === 0) {
    throw new Error(`Refusing to use pre-existing Docker container ${name}.`);
  }
}

function buildSupervisorEnv(rootDir, gatewayPort, postgresPort) {
  return {
    ...process.env,
    GOATCITADEL_ROOT_DIR: rootDir,
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(gatewayPort),
    GOATCITADEL_AUTH_MODE: "none",
    GOATCITADEL_DATABASE_DRIVER: "postgres",
    GOATCITADEL_POSTGRES_MODE: "bundled",
    GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "true",
    GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART: "true",
    GOATCITADEL_BUNDLED_POSTGRES_DATA_DIR: "./data/postgres",
    GOATCITADEL_BUNDLED_POSTGRES_PORT: String(postgresPort),
    GOATCITADEL_BUNDLED_POSTGRES_START_TIMEOUT_MS: "120000",
    GOATCITADEL_DISABLE_SECRET_STORE: "true",
    GOATCITADEL_GATEWAY_REFERENCE_BUILD: "skip",
    GOATCITADEL_GATEWAY_HEALTH_TIMEOUT_MS: "150000",
    GOATCITADEL_GATEWAY_RESTART_MAX_FAILURES: "2",
  };
}

function startSupervisor(env) {
  const child = spawn(process.execPath, [gatewaySupervisor], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = createBoundedOutput(64 * 1024);
  child.stdout.on("data", (chunk) => {
    output.append(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.append(chunk);
    process.stderr.write(chunk);
  });
  child.once("error", (error) => {
    output.spawnError = error;
  });
  return { child, output };
}

async function stopSupervisor(handle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync(windowsCmd, ["/d", "/s", "/c", "taskkill", "/PID", String(handle.child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    handle.child.kill("SIGTERM");
  }

  const exited = await waitForExit(handle.child, processStopTimeoutMs);
  if (!exited) {
    handle.child.kill("SIGKILL");
    if (!(await waitForExit(handle.child, 5_000))) {
      throw new Error(`Supervisor PID ${handle.child.pid} did not exit.`);
    }
  }
}

async function waitForHealth(gatewayUrl, handle) {
  const deadline = Date.now() + gatewayHealthTimeoutMs;
  while (Date.now() < deadline) {
    if (handle.output.spawnError) {
      throw handle.output.spawnError;
    }
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      throw new Error(
        `Gateway supervisor exited before health became ready (exit=${handle.child.exitCode}, signal=${handle.child.signalCode}).\n${handle.output.toString()}`,
      );
    }
    try {
      const response = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Startup is still in progress.
    }
    await delay(500);
  }
  throw new Error(
    `Gateway did not become healthy within ${gatewayHealthTimeoutMs}ms at ${gatewayUrl}/health.\n${handle.output.toString()}`,
  );
}

function inspectContainerId(name) {
  const result = run("docker", ["container", "inspect", "--format", "{{.Id}}", name]);
  const id = result.stdout.trim();
  if (!/^[a-f0-9]{64}$/i.test(id)) {
    throw new Error(`Docker returned an invalid container ID for ${name}: ${JSON.stringify(id)}.`);
  }
  return id;
}

function tryInspectContainerImage(name) {
  const result = run("docker", ["container", "inspect", "--format", "{{.Config.Image}}", name], {
    allowFailure: true,
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim() || undefined;
}

function assertContainerState(name, expected) {
  const result = run("docker", ["container", "inspect", "--format", "{{.State.Status}}", name]);
  const actual = result.stdout.trim().toLowerCase();
  if (actual !== expected) {
    throw new Error(`Expected ${name} state ${expected}, received ${actual || "unknown"}.`);
  }
}

function stopContainer(name) {
  const result = run("docker", ["stop", "--time", "10", name], { allowFailure: true });
  if (result.status !== 0) {
    const currentState = run("docker", ["container", "inspect", "--format", "{{.State.Status}}", name], {
      allowFailure: true,
    })
      .stdout.trim()
      .toLowerCase();
    if (currentState !== "exited") {
      throw new Error(`Failed to stop ${name}: ${result.stderr.trim() || "unknown Docker error"}`);
    }
  }
}

function assertContainerUsesExpectedDataDir(name, rootDir) {
  const result = run("docker", ["container", "inspect", "--format", "{{json .Mounts}}", name]);
  const mounts = JSON.parse(result.stdout);
  const expectedSource = normalizePathForComparison(path.join(rootDir, "data", "postgres"));
  const found = Array.isArray(mounts)
    ? mounts.some(
        (mount) =>
          mount?.Destination === "/var/lib/postgresql/data" &&
          normalizePathForComparison(String(mount?.Source ?? "")) === expectedSource,
      )
    : false;
  if (!found) {
    throw new Error(`Container ${name} does not mount the review-created data directory ${expectedSource}.`);
  }
}

async function removeReviewContainer(name, rootDir) {
  const inspection = run("docker", ["container", "inspect", name], { allowFailure: true });
  if (inspection.status !== 0) {
    return;
  }
  if (name !== buildBundledDockerContainerName(rootDir)) {
    throw new Error(`Container name ${name} does not match the temporary runtime root; refusing removal.`);
  }
  assertContainerUsesExpectedDataDir(name, rootDir);
  const removal = run("docker", ["rm", "--force", name], { allowFailure: true });
  if (removal.status !== 0) {
    throw new Error(removal.stderr.trim() || `docker rm --force ${name} failed.`);
  }
}

// initdb inside the bundled container creates PGDATA as the image's `postgres` user with mode
// 0700, and a Linux bind mount propagates that ownership to the host directory. The invoking
// user can then no longer read the tree it created, so removing it needs the container runtime
// to hand ownership back first. Docker Desktop on Windows masks this behind its own mount
// translation, which is why the host-side removal alone is enough there.
async function reclaimRuntimeRootOwnership(rootDir, image) {
  if (process.platform === "win32" || !image) {
    return;
  }
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    return;
  }
  assertTemporaryRuntimeRoot(rootDir);
  const dataDir = path.join(rootDir, "data");
  if (!(await pathExists(dataDir))) {
    return;
  }
  const result = run(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "0:0",
      "--entrypoint",
      "chown",
      "--volume",
      `${dataDir}:/goatcitadel-reclaim`,
      image,
      "-R",
      `${uid}:${gid}`,
      "/goatcitadel-reclaim",
    ],
    { allowFailure: true },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `docker chown of ${dataDir} failed (exit ${result.status ?? "unknown"}).`);
  }
}

function assertTemporaryRuntimeRoot(rootDir) {
  const resolved = path.resolve(rootDir);
  const expectedPrefix = path.resolve(os.tmpdir(), "goatcitadel-bundled-postgres-restart-");
  if (resolved === expectedPrefix || !resolved.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to rewrite ownership under ${resolved}: not a temporary runtime root.`);
  }
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not resolve an available loopback port.")));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function run(command, args, options = {}) {
  const useWindowsCommandWrapper = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const spawnCommand = useWindowsCommandWrapper ? windowsCmd : command;
  const spawnArgs = useWindowsCommandWrapper ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error && !options.allowFailure) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${result.status ?? "unknown"}): ${result.stderr?.trim() || "no diagnostic"}`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function normalizePathForComparison(value) {
  const normalized = path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function createBoundedOutput(maxBytes) {
  let value = Buffer.alloc(0);
  return {
    spawnError: undefined,
    append(chunk) {
      value = Buffer.concat([value, Buffer.from(chunk)]);
      if (value.byteLength > maxBytes) {
        value = value.subarray(value.byteLength - maxBytes);
      }
    },
    toString() {
      return value.toString("utf8").trim();
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
