import { buildApp } from "./app.js";
import {
  resolveAllowUnauthNetwork,
  resolveWarnUnauthNonLoopback,
  shouldWarnUnauthNonLoopbackBind,
} from "./startup-guard.js";
import { setGoatcitadelTerminalTitle } from "./runtime-ux.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
const warnUnauthNonLoopback = resolveWarnUnauthNonLoopback();
const allowUnauthNetwork = resolveAllowUnauthNetwork();

setGoatcitadelTerminalTitle(process.env.GOATCITADEL_TERMINAL_TASK?.trim() || "Gateway");

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
  app.log.info({ signal }, "shutting down gateway");
  const forceExitTimer = setTimeout(() => {
    console.error("[gateway] graceful shutdown timed out after 10 s — forcing exit");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref(); // don't keep event loop alive just for this

  try {
    await app.close();
    clearTimeout(forceExitTimer);
    process.exitCode = 0;
  } catch (error) {
    clearTimeout(forceExitTimer);
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
          overrideEnv: "GOATCITADEL_ALLOW_UNAUTH_NETWORK=1",
        },
        "Refusing to bind gateway to non-loopback host without configured auth.",
      );
      throw new Error(
        "Unsafe gateway bind blocked: non-loopback host requires auth. Set GOATCITADEL_AUTH_MODE and credentials or GOATCITADEL_ALLOW_UNAUTH_NETWORK=1 to override.",
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
