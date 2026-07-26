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
import {
  createRemoteWorkerNativeRuntimeService,
  type RemoteWorkerNativeRuntimeService,
} from "./services/remote-worker-native-runtime-service.js";
import { SharedHostAdmissionClosedError } from "./services/shared-host-lifecycle-service.js";
import { resolveGatewayStartupExitCode } from "./startup-errors.js";

setBootCheckpoint("main.ts:body-start");
const startupPhases = getStartupPhaseRecorder();
const port = env.GATEWAY_PORT;
const host = env.GATEWAY_HOST;
const warnUnauthNonLoopback = resolveWarnUnauthNonLoopback();
const allowUnauthNetwork = resolveAllowUnauthNetwork();

setGoatcitadelTerminalTitle(env.GOATCITADEL_TERMINAL_TASK?.trim() || "Gateway");

type GatewayApp = Awaited<ReturnType<typeof buildApp>>;

let app!: GatewayApp;
let shuttingDown = false;
let a2aGrpcServer: A2AGrpcServerHandle | undefined;
let remoteWorkerNativeRuntime: RemoteWorkerNativeRuntimeService | undefined;

await runGateway();

async function runGateway(): Promise<void> {
  setBootCheckpoint("main.ts:buildApp-starting");
  const buildAppPhase = startupPhases.open("build_app", { owner: "gateway.main" });
  try {
    app = await buildApp();
    buildAppPhase.close();
  } catch (error) {
    buildAppPhase.fail(formatStartupPhaseError(error));
    console.error(error);
    process.exitCode = resolveGatewayStartupExitCode(error);
    endBootTracking();
    return;
  }
  setBootCheckpoint("main.ts:buildApp-returned");

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
      const result = await performShutdown(app, signal, undefined, {
        stopListeners: stopNetworkListeners,
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
    const remoteWorkerPhase = startupPhases.open("remote_worker_native", { owner: "gateway.main" });
    try {
      remoteWorkerNativeRuntime = createRemoteWorkerNativeRuntimeService({
        sharedHostLifecycle: app.sharedHostLifecycle,
      });
      const remoteWorkerSnapshot = await remoteWorkerNativeRuntime.start();
      remoteWorkerPhase.close(
        remoteWorkerSnapshot.state === "listening_dark"
          ? `listening_dark:${remoteWorkerSnapshot.address ?? "bound"}`
          : remoteWorkerSnapshot.state,
      );
    } catch (error) {
      remoteWorkerPhase.fail(formatStartupPhaseError(error));
      throw error;
    }
    setBootCheckpoint("main.ts:listen-starting");
    const listenPhase = startupPhases.open("listen", { owner: "gateway.main" });
    const listenerAdmission = app.sharedHostLifecycle.tryReserve("worker", "gateway:http-listener-startup");
    if (!listenerAdmission.admitted) {
      throw new SharedHostAdmissionClosedError(listenerAdmission.state, listenerAdmission.reason);
    }
    try {
      await app.listen({ port, host });
      if (listenerAdmission.reservation.signal.aborted) {
        throw new Error("HTTP listener startup was interrupted by shared-host drain.");
      }
      listenPhase.close(`http://${host}:${port}`);
    } catch (error) {
      listenPhase.fail(formatStartupPhaseError(error));
      throw error;
    } finally {
      listenerAdmission.reservation.release();
    }
    app.log.info(`gateway listening on http://${host}:${port}`);
    const a2aGrpcPhase = startupPhases.open("a2a_grpc", { owner: "gateway.main" });
    try {
      a2aGrpcServer = await startA2AGrpcServer({
        config: app.gatewayConfig,
        a2a: app.services.a2a,
        sharedHostLifecycle: app.sharedHostLifecycle,
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
    process.exitCode = resolveGatewayStartupExitCode(error);
    try {
      if (!shuttingDown) {
        shuttingDown = true;
        await performShutdown(app, "STARTUP_FAILURE", undefined, { stopListeners: stopNetworkListeners });
      }
    } catch (cleanupError) {
      app.log.error(cleanupError, "gateway startup-failure cleanup failed");
    } finally {
      endBootTracking();
    }
  }
}

async function stopNetworkListeners(): Promise<void> {
  const stops: Promise<void>[] = [];
  if (remoteWorkerNativeRuntime !== undefined) {
    stops.push(
      remoteWorkerNativeRuntime.close().then(() => {
        app.log.info("Remote worker native listener stopped");
      }),
    );
  }
  if (a2aGrpcServer?.enabled) {
    stops.push(
      a2aGrpcServer.close().then(() => {
        app.log.info("A2A gRPC listener stopped");
      }),
    );
  }
  if (app.server.listening) {
    stops.push(
      new Promise<void>((resolve, reject) => {
        app.server.close((error) => (error ? reject(error) : resolve()));
      }),
    );
  }
  await Promise.all(stops);
}

function formatStartupPhaseError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
