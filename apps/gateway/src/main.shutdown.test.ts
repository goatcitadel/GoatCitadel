import { describe, expect, it, vi } from "vitest";
import { performShutdown } from "./shutdown.js";

describe("performShutdown", () => {
  it("returns graceful when app.close resolves within budget", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await performShutdown(
      {
        log,
        close: async () => undefined,
      } as never,
      "SIGTERM",
    );
    expect(result.reached).toBe("graceful");
  });

  it("warns when pre-close budget is exceeded but app.close still resolves", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onPreCloseTimeout = vi.fn();
    const result = await performShutdown(
      {
        log,
        close: () => new Promise((resolve) => setTimeout(resolve, 60)),
      } as never,
      "SIGTERM",
      { preCloseHookBudgetMs: 20, forceExitBudgetMs: 500 },
      { onPreCloseTimeout },
    );
    expect(onPreCloseTimeout).toHaveBeenCalled();
    expect(result.reached).toBe("pre-close-timeout");
  });

  it("arms force-exit when app.close exceeds force-exit budget", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onForceExitArmed = vi.fn();
    const result = await performShutdown(
      {
        log,
        close: () => new Promise((resolve) => setTimeout(resolve, 100)),
      } as never,
      "SIGTERM",
      { preCloseHookBudgetMs: 10, forceExitBudgetMs: 30 },
      { onForceExitArmed },
    );
    expect(onForceExitArmed).toHaveBeenCalled();
    expect(result.reached).toBe("force-exit-armed");
  });
});
