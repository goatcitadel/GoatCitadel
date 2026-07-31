import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startBackgroundInterval, trackBackgroundTask } from "./background-scheduler.js";

interface HarnessOptions {
  readonly intervalMs?: number;
  readonly bootDelayMs?: number;
  readonly task?: () => Promise<void>;
  readonly isClosing?: () => boolean;
}

function createHarness(overrides: HarnessOptions = {}) {
  const inflight = new Set<Promise<void>>();
  const task = overrides.task ?? vi.fn(async () => undefined);
  const isClosing = overrides.isClosing ?? ((): boolean => false);
  const onError = vi.fn();
  const registerInflight = vi.fn((promise: Promise<void>) => {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
  });
  const handle = startBackgroundInterval({
    label: "test scheduler",
    intervalMs: overrides.intervalMs ?? 1000,
    bootDelayMs: overrides.bootDelayMs,
    task,
    isClosing,
    registerInflight,
    onError,
  });
  return { handle, task, onError, registerInflight, inflight };
}

async function drain(inflight: Set<Promise<void>>): Promise<void> {
  await Promise.allSettled([...inflight]);
}

describe("startBackgroundInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs the boot pass after the boot delay and not before", async () => {
    const task = vi.fn(async () => undefined);
    const { inflight } = createHarness({ task, bootDelayMs: 500, intervalMs: 10_000 });

    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await drain(inflight);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("fires the task repeatedly on the interval", async () => {
    const task = vi.fn(async () => undefined);
    const { inflight } = createHarness({ task, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    await drain(inflight);
    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    await drain(inflight);
    expect(task).toHaveBeenCalledTimes(4);
  });

  it("does not schedule a boot pass when bootDelayMs is omitted", async () => {
    const task = vi.fn(async () => undefined);
    const { inflight } = createHarness({ task, intervalMs: 1000 });

    // No boot timer: nothing fires before the first interval elapses.
    await vi.advanceTimersByTimeAsync(999);
    await drain(inflight);
    expect(task).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await drain(inflight);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("catches and reports a rejected task instead of throwing or rejecting unhandled", async () => {
    const failure = new Error("tick boom");
    const task = vi.fn(async () => {
      throw failure;
    });
    const { inflight, onError } = createHarness({ task, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    const settled = await Promise.allSettled([...inflight]);

    // The registered in-flight promise resolves (never rejects), so no unhandled rejection.
    expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure, "test scheduler");
  });

  it("registers each in-flight tick so callers can await drain", async () => {
    const task = vi.fn(async () => undefined);
    const { registerInflight, inflight } = createHarness({ task, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(2000);
    await drain(inflight);

    expect(registerInflight).toHaveBeenCalledTimes(2);
    expect(registerInflight.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  });

  it("skips scheduling work while closing and registers nothing", async () => {
    let closing = true;
    const task = vi.fn(async () => undefined);
    const { registerInflight, inflight } = createHarness({
      task,
      intervalMs: 1000,
      bootDelayMs: 500,
      isClosing: () => closing,
    });

    await vi.advanceTimersByTimeAsync(5000);
    await drain(inflight);
    expect(task).not.toHaveBeenCalled();
    expect(registerInflight).not.toHaveBeenCalled();

    // Once no longer closing, the recurring interval resumes firing.
    closing = false;
    await vi.advanceTimersByTimeAsync(1000);
    await drain(inflight);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the boot timer and interval and is idempotent", async () => {
    const task = vi.fn(async () => undefined);
    const { handle, inflight } = createHarness({ task, intervalMs: 1000, bootDelayMs: 500 });

    handle.stop();
    handle.stop(); // second call must not throw

    await vi.advanceTimersByTimeAsync(10_000);
    await drain(inflight);
    expect(task).not.toHaveBeenCalled();
  });

  it("skips a tick while a previous tick's work is still in flight (Finding 9)", async () => {
    let resolveTask: (() => void) | undefined;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTask = resolve;
        }),
    );
    const { inflight } = createHarness({ task, intervalMs: 1000 });

    // First interval fires the tick, which stays pending.
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);

    // A second interval elapses while the first tick is still in flight → skipped.
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1);

    // Complete the first tick; the next interval then runs a fresh tick.
    resolveTask?.();
    await drain(inflight);
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
  });
});

describe("trackBackgroundTask", () => {
  it("observes a rejected task without creating an unhandled finally branch", async () => {
    const failure = new Error("postgres connection terminated");
    const backgroundTasks = new Set<Promise<void>>();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const task = Promise.reject(failure);
      trackBackgroundTask(backgroundTasks, task);

      expect(backgroundTasks.has(task)).toBe(true);
      await expect(task).rejects.toBe(failure);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(backgroundTasks.size).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
