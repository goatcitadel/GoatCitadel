import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitRefresh, type RefreshSignal } from "../state/refresh-bus";
import { useRefreshSubscription } from "./useRefreshSubscription";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function Probe({
  callback,
  enabled = true,
  onFallbackStateChange,
  pollIntervalMs,
  runWhenHidden,
  staleMs,
}: {
  callback: (signal: RefreshSignal) => Promise<void> | void;
  enabled?: boolean;
  onFallbackStateChange?: (active: boolean) => void;
  pollIntervalMs?: number;
  runWhenHidden?: boolean;
  staleMs?: number;
}) {
  useRefreshSubscription("tasks", callback, {
    coalesceMs: 50,
    enabled,
    onFallbackStateChange,
    pollIntervalMs,
    runWhenHidden,
    staleMs,
  });
  return null;
}

function installBrowserTimers(hidden = false): void {
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  });
  vi.stubGlobal("document", {
    hidden,
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useRefreshSubscription", () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
    installBrowserTimers();
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("coalesces refresh events and runs a queued follow-up after an in-flight callback", async () => {
    const first = createDeferred<void>();
    const calls: RefreshSignal[] = [];
    const callback = vi.fn((signal: RefreshSignal) => {
      calls.push(signal);
      return calls.length === 1 ? first.promise : Promise.resolve();
    });

    await act(async () => {
      renderer = create(<Probe callback={callback} />);
    });

    act(() => {
      emitRefresh("tasks", {
        reason: "created",
        source: "gateway",
        eventType: "task.created",
        timestamp: Date.now(),
      });
      emitRefresh("tasks", {
        reason: "updated",
        source: "gateway",
        eventType: "task.updated",
        timestamp: Date.now() + 1,
      });
    });
    expect(callback).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ reason: "updated", eventType: "task.updated" });

    act(() => {
      emitRefresh("tasks", {
        reason: "queued",
        source: "gateway",
        eventType: "task.queued",
        timestamp: Date.now() + 2,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(calls[1]).toMatchObject({ reason: "queued", eventType: "task.queued" });
  });

  it("activates fallback polling when a topic goes stale and clears it on the next event", async () => {
    const fallbackStates: boolean[] = [];
    const calls: RefreshSignal[] = [];
    const callback = vi.fn((signal: RefreshSignal) => {
      calls.push(signal);
    });

    await act(async () => {
      renderer = create(
        <Probe
          callback={callback}
          onFallbackStateChange={(active) => fallbackStates.push(active)}
          pollIntervalMs={1000}
          staleMs={1000}
        />,
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await flush();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({
      reason: "fallback_poll",
      source: "refresh-hook",
      eventType: "fallback_poll",
    });
    expect(fallbackStates).toEqual([true]);

    act(() => {
      emitRefresh("tasks", {
        reason: "runtime_event",
        source: "gateway",
        eventType: "task.changed",
        timestamp: Date.now(),
      });
    });

    expect(fallbackStates).toEqual([true, false]);
  });

  it("skips fallback polling while hidden unless explicitly allowed", async () => {
    const callback = vi.fn();
    installBrowserTimers(true);

    await act(async () => {
      renderer = create(<Probe callback={callback} pollIntervalMs={1000} staleMs={1000} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(callback).not.toHaveBeenCalled();

    await act(async () => {
      renderer?.update(<Probe callback={callback} pollIntervalMs={1000} runWhenHidden staleMs={1000} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes timers and ignores events while disabled", async () => {
    const fallbackStates: boolean[] = [];
    const callback = vi.fn();

    await act(async () => {
      renderer = create(
        <Probe callback={callback} enabled={false} onFallbackStateChange={(active) => fallbackStates.push(active)} />,
      );
    });

    act(() => {
      emitRefresh("tasks", { reason: "ignored", timestamp: Date.now() });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(callback).not.toHaveBeenCalled();
    expect(fallbackStates).toEqual([]);
  });

  it("records callback failures and remains subscribed for later refreshes", async () => {
    const callback = vi.fn().mockRejectedValueOnce(new Error("refresh failed")).mockResolvedValueOnce(undefined);

    await act(async () => {
      renderer = create(<Probe callback={callback} />);
    });

    act(() => {
      emitRefresh("tasks", { reason: "first", timestamp: Date.now() });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await flush();
    expect(callback).toHaveBeenCalledTimes(1);

    act(() => {
      emitRefresh("tasks", { reason: "second", timestamp: Date.now() + 1 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    await flush();

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[1]?.[0]).toMatchObject({ reason: "second" });
  });
});
