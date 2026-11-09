import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { atomicCompareAndPublishJson, withManagedLifecycleLock } from "./managed-runtime-lifecycle.mjs";

const DEFAULT_PORTS = { gatewayPort: 8787, uiPort: 5173 };

/** Managed ports are distinct from the external-runtime attachment URL overrides. */
export function readInstalledRuntimeSettings(installRoot) {
  const settingsPath = path.join(installRoot, "runtime", "launcher-settings.json");
  if (!fs.existsSync(settingsPath)) return { ...DEFAULT_PORTS };
  const stat = fs.lstatSync(settingsPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
    throw new Error("Installed runtime settings must be a regular JSON file below 4096 bytes.");
  }
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (
    settings.schemaVersion !== 1 ||
    !isPort(settings.gatewayPort) ||
    !isPort(settings.uiPort) ||
    settings.gatewayPort === settings.uiPort
  ) {
    throw new Error(
      "Invalid launcher-settings.json: choose distinct gatewayPort and uiPort values from 1024 to 65535.",
    );
  }
  return { gatewayPort: settings.gatewayPort, uiPort: settings.uiPort };
}

/** Give a fresh packaged install stable local ports before either service starts. */
export async function initializeInstalledRuntimeSettings(installRoot) {
  const runtimeDir = path.join(installRoot, "runtime");
  const settingsPath = path.join(runtimeDir, "launcher-settings.json");
  const alreadyStarted = () =>
    [
      settingsPath,
      path.join(runtimeDir, "gateway.pid"),
      path.join(runtimeDir, "ui.pid"),
      path.join(installRoot, "runtime-root", "data"),
    ].some((candidate) => fs.existsSync(candidate));
  if (alreadyStarted()) return;

  await withManagedLifecycleLock(
    { lockPath: path.join(runtimeDir, "locks", "launcher-settings.lifecycle.lock"), service: "launcher-settings" },
    async () => {
      if (alreadyStarted()) return;
      const gateway = await reserveManagedPort(DEFAULT_PORTS.gatewayPort);
      let ui;
      try {
        ui = await reserveManagedPort(DEFAULT_PORTS.uiPort);
        const result = atomicCompareAndPublishJson({
          filePath: settingsPath,
          expectedFingerprint: null,
          value: { schemaVersion: 1, gatewayPort: gateway.address().port, uiPort: ui.address().port },
        });
        if (!result.published && !fs.existsSync(settingsPath)) {
          throw new Error("Could not save managed launcher ports.");
        }
      } finally {
        await Promise.all(
          [gateway, ui].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))),
        );
      }
    },
  );
}

async function reserveManagedPort(preferredPort) {
  try {
    return await listenOnLoopback(preferredPort);
  } catch (error) {
    if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
    return await listenOnLoopback(0);
  }
}

function listenOnLoopback(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function isPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}
