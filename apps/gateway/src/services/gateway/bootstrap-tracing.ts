import type { LogContext } from "@goatcitadel/gateway-core";
import { logger } from "@goatcitadel/gateway-core";
import { isVerboseLoggingEnabled } from "../../runtime-ux.js";

const log = logger.child("gateway-service");
const INIT_STEP_SLOW_WARNING_MS = 10_000;

/**
 * Wrap a step inside the gateway's critical-init path so a hung step is
 * visible in real time instead of presenting as 120s of silence followed by
 * a supervisor health-timeout restart.
 */
export async function traceInitStep<T>(stepName: string, fn: () => Promise<T> | T): Promise<T> {
  const startedAt = Date.now();
  let warned = false;
  const warningTimer = setTimeout(() => {
    warned = true;
    log.warn(`initCritical step "${stepName}" still running after ${Math.round(INIT_STEP_SLOW_WARNING_MS / 1000)}s`);
  }, INIT_STEP_SLOW_WARNING_MS);
  warningTimer.unref();
  try {
    return await fn();
  } finally {
    clearTimeout(warningTimer);
    const elapsedMs = Date.now() - startedAt;
    if (warned) {
      log.warn(`initCritical step "${stepName}" completed in ${elapsedMs}ms`);
    } else if (isVerboseLoggingEnabled()) {
      log.info(`initCritical step "${stepName}" completed in ${elapsedMs}ms`);
    }
  }
}

export function toLogContext(data: unknown): LogContext {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as LogContext;
  }
  return { value: data };
}
