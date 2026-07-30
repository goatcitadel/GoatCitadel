import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const TEMPORARY_ROOT_PREFIX = "goatcitadel-desktop-verify-";
const LOOPBACK_HOST = "127.0.0.1";
const LAUNCHER_AUTH_ENV_KEYS = [
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_AUTH_BASIC_USERNAME",
  "GOATCITADEL_AUTH_BASIC_PASSWORD",
];

export async function createDesktopVerificationIsolation(options = {}) {
  const temporaryParent = path.resolve(options.temporaryParent ?? os.tmpdir());
  const runtimeHome = fs.mkdtempSync(path.join(temporaryParent, TEMPORARY_ROOT_PREFIX));
  const guards = [];

  try {
    guards.push(await startLoopbackGuard("gateway"));
    guards.push(await startLoopbackGuard("mission-control"));
  } catch (error) {
    await Promise.allSettled(guards.map((guard) => guard.close()));
    removeOwnedTemporaryRoot(runtimeHome, temporaryParent);
    throw error;
  }

  let disposed = false;
  return {
    runtimeHome,
    gatewayUrl: guards[0].url,
    uiUrl: guards[1].url,
    buildLauncherEnvironment(baseEnv, appDir) {
      const env = {
        ...baseEnv,
        GOATCITADEL_HOME: runtimeHome,
        GOATCITADEL_APP_DIR: path.resolve(appDir),
        GOATCITADEL_GATEWAY_URL: guards[0].url,
        GOATCITADEL_MISSION_CONTROL_URL: guards[1].url,
      };
      for (const key of LAUNCHER_AUTH_ENV_KEYS) {
        delete env[key];
      }
      return env;
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      await Promise.all(guards.map((guard) => guard.close()));
      removeOwnedTemporaryRoot(runtimeHome, temporaryParent);
    },
  };
}

export function runIsolatedLauncherStatus(repoRoot, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "bin", "goatcitadel.mjs"), "status", "--json"], {
      cwd: repoRoot,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let spawnError;

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(spawnError ? { error: spawnError } : {}),
      });
    });
  });
}

async function startLoopbackGuard(label) {
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.setHeader("connection", "close");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: `${label} reserved for desktop verification` }));
  });
  server.unref();

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOOPBACK_HOST);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error(`Could not reserve the ${label} desktop verification port.`);
  }

  return {
    url: `http://${LOOPBACK_HOST}:${address.port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server) {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function removeOwnedTemporaryRoot(runtimeHome, temporaryParent) {
  const resolvedRuntimeHome = path.resolve(runtimeHome);
  const expectedPrefix = `${temporaryParent}${path.sep}${TEMPORARY_ROOT_PREFIX}`;
  if (!resolvedRuntimeHome.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to remove unexpected desktop verification root: ${resolvedRuntimeHome}`);
  }
  fs.rmSync(resolvedRuntimeHome, { recursive: true, force: true });
}
