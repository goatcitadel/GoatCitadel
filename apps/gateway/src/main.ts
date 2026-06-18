/* eslint-disable no-console */
// IMPORTANT: boot-tracker must be the first import so its heartbeat is
// registered before the rest of the import graph executes. See
// boot-tracker.ts for context on the Windows boot-hang investigation.
import { endBootTracking, setBootCheckpoint } from "./boot-tracker.js";
setBootCheckpoint("main.ts:imports-resolving");
import { buildApp } from "./app.js";
import { performShutdown } from "./shutdown.js";
import { getStartupPhaseRecorder } from "./diagnostics/startup-phases.js";
import {
  INSECURE_LOCAL_ONLY_OVERRIDE_ENV,
  resolveAllowUnauthNetwork,
  resolveWarnUnauthNonLoopback,
  shouldWarnUnauthNonLoopbackBind,
} from "./startup-guard.js";
import { setGoatcitadelTerminalTitle } from "./runtime-ux.js";
import { env } from "./env.js";
import { startA2AGrpcServer, type A2AGrpcServerHandle } from "./services/a2a-grpc-server.js";

setBootCheckpoint("main.ts:body-start");
const startupPhases = getStartupPhaseRecorder();
const port = env.GATEWAY_PORT;
const host = env.GATEWAY_HOST;
const warnUnauthNonLoopback = resolveWarnUnauthNonLoopback();
const allowUnauthNetwork = resolveAllowUnauthNetwork();

setGoatcitadelTerminalTitle(env.GOATCITADEL_TERMINAL_TASK?.trim() || "Gateway");

setBootCheckpoint("main.ts:buildApp-starting");
const buildAppPhase = startupPhases.open("build_app", { owner: "gateway.main" });
const app = await buildApp().then(
  (builtApp) => {
    buildAppPhase.close();
    return builtApp;
  },
  (error: unknown) => {
    buildAppPhase.fail(formatStartupPhaseError(error));
    throw error;
  },
);
setBootCheckpoint("main.ts:buildApp-returned");
let shuttingDown = false;
let a2aGrpcServer: A2AGrpcServerHandle | undefined;

process.on("warning", (warning) => {
  app.log.warn(
    {
      warningName: warning.name,
      code: "code" in warning ? (warning as Error & { code?: string }).code : undefined,
      detail: warning.message,
      stack: warning.stack,
    },
    `node warning: ${warning.name}`,
  );
});

const shutdown = async (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    if (a2aGrpcServer?.enabled) {
      await a2aGrpcServer.close();
      app.log.info("A2A gRPC listener stopped");
    }
    const result = await performShutdown(app, signal, undefined, {
      onForceExitArmed: () => {
        console.error("[gateway] graceful shutdown timed out after 10 s — forcing exit");
        process.exit(1);
      },
    });
    if (result.reached !== "force-exit-armed") {
      process.exitCode = 0;
    }
  } catch (error) {
    app.log.error(error, "gateway shutdown failed");
    process.exitCode = 1;
  }
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  const unsafeBind = shouldWarnUnauthNonLoopbackBind(host, app.gatewayConfig.assistant.auth);
  if (unsafeBind) {
    if (!allowUnauthNetwork) {
      app.log.error(
        {
          host,
          authMode: app.gatewayConfig.assistant.auth.mode,
          overrideEnv: `${INSECURE_LOCAL_ONLY_OVERRIDE_ENV}=true`,
        },
        "Refusing to bind gateway to non-loopback host without configured auth.",
      );
      throw new Error(
        `Unsafe gateway bind blocked: non-loopback host requires auth. Set GOATCITADEL_AUTH_MODE and credentials or ${INSECURE_LOCAL_ONLY_OVERRIDE_ENV}=true to override intentionally.`,
      );
    }
    if (warnUnauthNonLoopback) {
      app.log.warn(
        {
          host,
          authMode: app.gatewayConfig.assistant.auth.mode,
        },
        "Binding gateway to non-loopback host without configured auth. Set GOATCITADEL_AUTH_TOKEN or GOATCITADEL_AUTH_MODE=basic for safer remote access.",
      );
    }
  }
  setBootCheckpoint("main.ts:listen-starting");
  const listenPhase = startupPhases.open("listen", { owner: "gateway.main" });
  try {
    await app.listen({ port, host });
    listenPhase.close(`http://${host}:${port}`);
  } catch (error) {
    listenPhase.fail(formatStartupPhaseError(error));
    throw error;
  }
  app.log.info(`gateway listening on http://${host}:${port}`);
  const a2aGrpcPhase = startupPhases.open("a2a_grpc", { owner: "gateway.main" });
  try {
    a2aGrpcServer = await startA2AGrpcServer({
      config: app.gatewayConfig,
      a2a: app.services.a2a,
      logger: app.log,
    });
    a2aGrpcPhase.close(a2aGrpcServer.enabled ? "enabled" : "disabled");
  } catch (error) {
    a2aGrpcPhase.fail(formatStartupPhaseError(error));
    throw error;
  }
  startupPhases.markReady();
  endBootTracking();
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  process.exit(1);
}

function formatStartupPhaseError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
