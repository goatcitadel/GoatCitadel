import type { FastifyInstance } from "fastify";

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
  app: Pick<FastifyInstance, "log" | "close">,
  signal: string,
  budget: ShutdownBudget = DEFAULT_SHUTDOWN_BUDGET,
  hooks?: { onForceExitArmed?: () => void; onPreCloseTimeout?: () => void },
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
    await app.close();
  } finally {
    clearTimeout(preCloseTimer);
    clearTimeout(forceExitTimer);
  }

  return {
    reached: forceExitArmed ? "force-exit-armed" : preCloseTimedOut ? "pre-close-timeout" : "graceful",
    durationMs: Date.now() - start,
  };
}
