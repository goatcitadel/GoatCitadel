/* eslint-disable no-console */
import { buildApp } from "./app.js";
import { performShutdown } from "./shutdown.js";
import {
  INSECURE_LOCAL_ONLY_OVERRIDE_ENV,
  resolveAllowUnauthNetwork,
  resolveWarnUnauthNonLoopback,
  shouldWarnUnauthNonLoopbackBind,
} from "./startup-guard.js";
import { setGoatcitadelTerminalTitle } from "./runtime-ux.js";
import { env } from "./env.js";

const port = env.GATEWAY_PORT;
const host = env.GATEWAY_HOST;
const warnUnauthNonLoopback = resolveWarnUnauthNonLoopback();
const allowUnauthNetwork = resolveAllowUnauthNetwork();

setGoatcitadelTerminalTitle(env.GOATCITADEL_TERMINAL_TASK?.trim() || "Gateway");

const app = await buildApp();
let shuttingDown = false;

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
  await app.listen({ port, host });
  app.log.info(`gateway listening on http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  process.exit(1);
}
