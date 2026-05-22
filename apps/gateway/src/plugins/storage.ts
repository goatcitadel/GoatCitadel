import fp from "fastify-plugin";
import path from "node:path";
import { setBootCheckpoint } from "../boot-tracker.js";
import { ensureBundledPostgresRuntime } from "../bundled-postgres-runtime.js";
import { repoHasConfigMarker } from "../config-files.js";
import { loadGatewayConfig } from "../config.js";
import {
  createGatewayRuntime,
  type GatewayAuthValidationPort,
  type GatewayRuntimePort,
} from "../services/gateway-runtime-factory.js";
import type { GatewayRuntimeConfig } from "../config.js";
import { shouldStartDeferredInitInBackground, shouldStopBundledPostgresOnClose } from "./storage-runtime.js";

declare module "fastify" {
  interface FastifyInstance {
    gatewayRuntime: GatewayRuntimePort;
    gatewayAuth: GatewayAuthValidationPort;
    gatewayConfig: GatewayRuntimeConfig;
  }
}

export const gatewayPlugin = fp(async (fastify) => {
  setBootCheckpoint("storage-plugin:detectRootDir");
  const rootDir = detectRootDir();
  setBootCheckpoint("storage-plugin:loadGatewayConfig");
  const config = await loadGatewayConfig(rootDir);
  setBootCheckpoint("storage-plugin:ensureBundledPostgresRuntime");
  const bundledPostgres = await ensureBundledPostgresRuntime(config);
  setBootCheckpoint("storage-plugin:postgres-ready");
  const shouldStopBundledPostgres = shouldStopBundledPostgresOnClose();
  const gateway = createGatewayRuntime(config);
  gateway.attachDevDiagnosticsLogger(fastify.log);
  fastify.decorate("gatewayRuntime", gateway);
  fastify.decorate("gatewayAuth", gateway);
  fastify.decorate("gatewayConfig", config);
  setBootCheckpoint("storage-plugin:initCritical-starting");
  await gateway.initCritical();
  setBootCheckpoint("storage-plugin:initCritical-returned");

  // codeql[js/missing-rate-limiting] Startup initialization is not an HTTP route handler.
  fastify.addHook("onReady", async () => {
    if (shouldStartDeferredInitInBackground()) {
      setImmediate(() => {
        void gateway.startDeferredInit().catch((error: unknown) => {
          fastify.log.error(error, "gateway deferred startup failed");
        });
      });
      fastify.log.debug("gateway deferred startup scheduled in background");
      return;
    }
    await gateway.startDeferredInit();
  });

  fastify.addHook("onClose", async () => {
    await gateway.close();
    if (shouldStopBundledPostgres) {
      await bundledPostgres?.stop();
    }
  });
});

function detectRootDir(): string {
  const envRoot = process.env.GOATCITADEL_ROOT_DIR?.trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }

  const candidates = [process.cwd(), path.resolve(process.cwd(), ".."), path.resolve(process.cwd(), "../..")];

  for (const candidate of candidates) {
    if (repoHasConfigMarker(candidate)) {
      return candidate;
    }
  }

  return path.resolve(process.cwd(), "../..");
}
