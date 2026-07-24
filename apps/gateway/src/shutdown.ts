import type { FastifyInstance } from "fastify";
import {
  MIN_SHARED_HOST_DRAIN_TIMEOUT_MS,
  resolveSharedHostDrainTimeoutMs,
  type SharedHostLifecycleService,
} from "./services/shared-host-lifecycle-service.js";

export interface ShutdownBudget {
  preCloseHookBudgetMs: number;
  forceExitBudgetMs: number;
}

export const DEFAULT_SHUTDOWN_BUDGET: ShutdownBudget = {
  preCloseHookBudgetMs: 5_000,
  forceExitBudgetMs: 10_000,
};

export interface ShutdownResult {
  reached: "graceful" | "force-exit-armed" | "pre-close-timeout";
  durationMs: number;
}

export async function performShutdown(
  app: Pick<FastifyInstance, "log" | "close"> & {
    sharedHostLifecycle?: SharedHostLifecycleService;
    gatewayRuntime?: { stopExternalAdmission?(): Promise<void> };
  },
  signal: string,
  budget: ShutdownBudget = DEFAULT_SHUTDOWN_BUDGET,
  hooks?: {
    onForceExitArmed?: () => void;
    onPreCloseTimeout?: () => void;
    stopListeners?: () => Promise<void> | void;
  },
): Promise<ShutdownResult> {
  const start = Date.now();
  app.log.info({ signal }, "shutting down gateway");

  let forceExitArmed = false;
  const forceExitTimer = setTimeout(() => {
    forceExitArmed = true;
    hooks?.onForceExitArmed?.();
  }, budget.forceExitBudgetMs);
  forceExitTimer.unref();

  let preCloseTimedOut = false;
  const preCloseTimer = setTimeout(() => {
    preCloseTimedOut = true;
    hooks?.onPreCloseTimeout?.();
    app.log.warn(
      { budgetMs: budget.preCloseHookBudgetMs },
      "pre-close hook budget exceeded; continuing to force-exit window",
    );
  }, budget.preCloseHookBudgetMs);
  preCloseTimer.unref();

  try {
    let drainPromise: Promise<unknown> | undefined;
    if (app.sharedHostLifecycle?.enabled) {
      const configuredDrainMs = resolveSharedHostDrainTimeoutMs();
      const drainTimeoutMs = Math.max(
        MIN_SHARED_HOST_DRAIN_TIMEOUT_MS,
        Math.min(configuredDrainMs, budget.preCloseHookBudgetMs),
      );
      if (app.sharedHostLifecycle.snapshot().state === "starting") {
        app.sharedHostLifecycle.abortStartup();
      } else {
        // drain() closes admission synchronously before its first await. Start
        // it first, then stop listeners/producers while admitted work settles.
        drainPromise = app.sharedHostLifecycle.drain({
          mode: "force",
          timeoutMs: drainTimeoutMs,
          reason: `shutdown_${signal}`,
          actorId: "gateway",
        });
      }
    }
    const admissionStops = await Promise.allSettled([
      Promise.resolve().then(() => hooks?.stopListeners?.()),
      Promise.resolve().then(() => app.gatewayRuntime?.stopExternalAdmission?.()),
    ]);
    for (const result of admissionStops) {
      if (result.status === "rejected") {
        app.log.warn({ error: result.reason }, "listener/producer admission stop failed during shutdown");
      }
    }
    if (drainPromise) {
      try {
        await drainPromise;
      } catch (error) {
        app.log.warn({ error }, "shared-host pre-close drain failed; continuing process shutdown");
      }
    }
    await app.close();
    app.sharedHostLifecycle?.markClosed();
  } finally {
    clearTimeout(preCloseTimer);
    clearTimeout(forceExitTimer);
  }

  return {
    reached: forceExitArmed ? "force-exit-armed" : preCloseTimedOut ? "pre-close-timeout" : "graceful",
    durationMs: Date.now() - start,
  };
}
