import fp from "fastify-plugin";
import path from "node:path";
import { setBootCheckpoint } from "../boot-tracker.js";
import { ensureBundledPostgresRuntime } from "../bundled-postgres-runtime.js";
import { repoHasConfigMarker } from "../config-files.js";
import { loadGatewayConfig } from "../config.js";
import { getStartupPhaseRecorder } from "../diagnostics/startup-phases.js";
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
  const startupPhases = getStartupPhaseRecorder();
  setBootCheckpoint("storage-plugin:detectRootDir");
  const rootDir = detectRootDir();
  setBootCheckpoint("storage-plugin:loadGatewayConfig");
  const loadConfigPhase = startupPhases.open("load_config", { owner: "gateway.storage" });
  let config: GatewayRuntimeConfig;
  try {
    config = await loadGatewayConfig(rootDir);
    loadConfigPhase.close();
  } catch (error) {
    loadConfigPhase.fail(formatStartupPhaseError(error));
    throw error;
  }
  setBootCheckpoint("storage-plugin:ensureBundledPostgresRuntime");
  const bundledPostgresPhase = startupPhases.open("bundled_postgres", { owner: "gateway.storage" });
  let bundledPostgres: Awaited<ReturnType<typeof ensureBundledPostgresRuntime>>;
  try {
    bundledPostgres = await ensureBundledPostgresRuntime(config);
    bundledPostgresPhase.close(bundledPostgres ? "ready" : "not configured");
  } catch (error) {
    bundledPostgresPhase.fail(formatStartupPhaseError(error));
    throw error;
  }
  setBootCheckpoint("storage-plugin:postgres-ready");
  const shouldStopBundledPostgres = shouldStopBundledPostgresOnClose();
  const gateway = createGatewayRuntime(config, { sharedHostLifecycle: fastify.sharedHostLifecycle });
  gateway.attachDevDiagnosticsLogger(fastify.log);
  fastify.decorate("gatewayRuntime", gateway);
  fastify.decorate("gatewayAuth", gateway);
  fastify.decorate("gatewayConfig", config);
  setBootCheckpoint("storage-plugin:initCritical-starting");
  const criticalPhase = startupPhases.open("init_critical", { owner: "gateway.storage" });
  try {
    await gateway.initCritical();
    criticalPhase.close();
  } catch (error) {
    criticalPhase.fail(formatStartupPhaseError(error));
    throw error;
  }
  setBootCheckpoint("storage-plugin:initCritical-returned");

  // codeql[js/missing-rate-limiting] Startup initialization is not an HTTP route handler.
  fastify.addHook("onReady", async () => {
    const admission = fastify.sharedHostLifecycle.tryReserve("worker", "gateway:deferred-init");
    if (!admission.admitted) {
      fastify.log.warn(
        { lifecycleState: admission.state },
        "gateway deferred startup skipped because shared-host admission closed",
      );
      return;
    }
    const runDeferredInit = async () => {
      try {
        if (admission.reservation.signal.aborted) return;
        await gateway.startDeferredInit(admission.reservation.signal);
      } finally {
        admission.reservation.release();
      }
    };
    if (shouldStartDeferredInitInBackground()) {
      setImmediate(() => {
        const deferredPhase = startupPhases.open("deferred_init", { owner: "gateway.storage" });
        void runDeferredInit()
          .then(() => deferredPhase.close("background"))
          .catch((error: unknown) => {
            deferredPhase.fail(formatStartupPhaseError(error));
            fastify.log.error(error, "gateway deferred startup failed");
          });
      });
      fastify.log.debug("gateway deferred startup scheduled in background");
      return;
    }
    const deferredPhase = startupPhases.open("deferred_init", { owner: "gateway.storage" });
    try {
      await runDeferredInit();
      deferredPhase.close("blocking");
    } catch (error) {
      deferredPhase.fail(formatStartupPhaseError(error));
      throw error;
    }
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

function formatStartupPhaseError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
