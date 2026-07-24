import { describe, expect, it, vi } from "vitest";
import { performShutdown } from "./shutdown.js";
import { SharedHostLifecycleService } from "./services/shared-host-lifecycle-service.js";

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

  it("runs the shared-host admission barrier before closing the process", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    const admitted = lifecycle.tryReserve("worker", "worker-before-signal");
    if (!admitted.admitted) throw new Error("expected worker admission");
    setTimeout(() => admitted.reservation.release(), 5);
    const close = vi.fn(async () => undefined);

    const result = await performShutdown({ log, close, sharedHostLifecycle: lifecycle } as never, "SIGTERM", {
      preCloseHookBudgetMs: 50,
      forceExitBudgetMs: 500,
    });

    expect(result.reached).toBe("graceful");
    expect(close).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot()).toMatchObject({
      state: "closed",
      admission: "closed",
      drain: { mode: "force", reason: "shutdown_SIGTERM", forcedOutstandingCount: 0 },
    });
  });

  it("force-aborts admitted work at the bounded pre-close deadline and records outstanding truth", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    const admitted = lifecycle.tryReserve("worker", "stuck-worker");
    if (!admitted.admitted) throw new Error("expected worker admission");
    const aborted = vi.fn();
    admitted.reservation.signal.addEventListener("abort", aborted);

    await performShutdown({ log, close: async () => undefined, sharedHostLifecycle: lifecycle } as never, "SIGINT", {
      preCloseHookBudgetMs: 10,
      forceExitBudgetMs: 500,
    });

    expect(aborted).toHaveBeenCalledTimes(1);
    expect(lifecycle.snapshot()).toMatchObject({
      state: "closed",
      activeCount: 1,
      drain: { timedOut: true, forcedOutstandingCount: 1 },
    });
    admitted.reservation.release();
  });

  it("closes admission, stops listeners/producers, drains counted work, then closes services and storage", async () => {
    const order: string[] = [];
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const lifecycle = new SharedHostLifecycleService({ enabled: true });
    lifecycle.markAccepting();
    const admitted = lifecycle.tryReserve("agent", "active-grpc-call");
    if (!admitted.admitted) throw new Error("expected agent admission");

    await performShutdown(
      {
        log,
        sharedHostLifecycle: lifecycle,
        gatewayRuntime: {
          stopExternalAdmission: async () => {
            order.push("producers-stopped");
            expect(lifecycle.snapshot().admission).toBe("closed");
          },
        },
        close: async () => {
          expect(lifecycle.snapshot()).toMatchObject({ state: "closing", activeCount: 0 });
          order.push("services-storage-closed");
        },
      } as never,
      "SIGTERM",
      { preCloseHookBudgetMs: 100, forceExitBudgetMs: 500 },
      {
        stopListeners: async () => {
          expect(lifecycle.snapshot().state).toBe("draining");
          order.push("listeners-stopped");
          admitted.reservation.release();
        },
      },
    );

    expect(order.slice(0, 2).sort()).toEqual(["listeners-stopped", "producers-stopped"].sort());
    expect(order.at(-1)).toBe("services-storage-closed");
    expect(lifecycle.snapshot().state).toBe("closed");
  });
});
