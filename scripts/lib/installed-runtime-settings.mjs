import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import { atomicCompareAndPublishJson, withManagedLifecycleLock } from "./managed-runtime-lifecycle.mjs";

const DEFAULT_PORTS = { gatewayPort: 8787, uiPort: 5173 };

/** Allow exactly the managed UI origin when no operator allowlist was supplied. */
export function installedRuntimeAllowedOrigins(installRoot, configuredOrigins, env = process.env) {
  return (
    configuredOrigins?.trim() ||
    env.GOATCITADEL_ALLOWED_ORIGINS?.trim() ||
    readInstalledProfileEnv(installRoot, env).GOATCITADEL_ALLOWED_ORIGINS?.trim() ||
    `http://127.0.0.1:${readInstalledRuntimeSettings(installRoot).uiPort}`
  );
}

function readInstalledProfileEnv(installRoot, env = process.env) {
  // The packaged Gateway resolves an explicit selector against its working directory.
  // A missing selected file does not fall back to a different profile's allowlist.
  const selectedFile = env.GOATCITADEL_LOCAL_ENV_FILE?.trim();
  const envPath = selectedFile
    ? path.resolve(installRoot, "app", "gateway", selectedFile)
    : path.join(installRoot, "runtime-root", ".env");
  return fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, "utf8")) : {};
}

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
      let database;
      try {
        ui = await reserveManagedPort(DEFAULT_PORTS.uiPort);
        database = await initializeFreshDatabasePort(installRoot);
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
          [gateway, ui, database].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))),
        );
      }
    },
  );
}

// Only unconfigured profiles participate. Existing databases, credentials and operator
// choices are never migrated. The canonical config is published first: if interrupted,
// Gateway's normal config sync repairs the split projection from that durable owner.
async function initializeFreshDatabasePort(installRoot) {
  const configDir = path.join(installRoot, "runtime-root", "config");
  const canonicalPath = path.join(configDir, "goatcitadel.json");
  const assistantPath = path.join(configDir, "assistant.config.json");
  if ([canonicalPath, assistantPath].some((file) => fs.existsSync(file))) return;
  const templatePath = path.join(installRoot, "app", "templates", "config", "goatcitadel.example.json");
  if (!fs.existsSync(templatePath)) return;
  const canonical = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  const database = canonical.assistant?.database;
  if (database?.driver !== "postgres" || database.postgres?.mode !== "bundled" || !database.bundledPostgres?.enabled)
    return;
  const preferredPort = database.bundledPostgres.port;
  if (!isPort(preferredPort)) throw new Error("Bundled PostgreSQL template port is invalid.");
  // An explicit environment choice must win, including its normal validation/errors.
  if (
    process.env.GOATCITADEL_BUNDLED_POSTGRES_PORT?.trim() ||
    readInstalledProfileEnv(installRoot).GOATCITADEL_BUNDLED_POSTGRES_PORT?.trim()
  )
    return;
  const reservation = await reserveManagedPort(preferredPort);
  try {
    database.bundledPostgres.port = reservation.address().port;
    const result = atomicCompareAndPublishJson({
      filePath: canonicalPath,
      expectedFingerprint: null,
      value: canonical,
      maxBytes: 1024 * 1024,
    });
    if (!result.published) throw new Error("Database config changed during first-run port selection.");
    const split = atomicCompareAndPublishJson({
      filePath: assistantPath,
      expectedFingerprint: null,
      value: canonical.assistant,
      maxBytes: 1024 * 1024,
    });
    if (!split.published) throw new Error("Assistant config changed during first-run port selection.");
    return reservation;
  } catch (error) {
    await new Promise((resolve) => reservation.close(resolve));
    throw error;
  }
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
