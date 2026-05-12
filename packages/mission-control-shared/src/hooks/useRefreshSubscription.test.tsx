import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitRefresh } from "../state/refresh-bus";
import { useRefreshSubscription } from "./useRefreshSubscription";

function installWindow(hidden = false) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: { hidden },
  });
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useRefreshSubscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    installWindow(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("coalesces event signals and unsubscribes on unmount", async () => {
    const callback = vi.fn();
    const renderer = create(
      <Harness
        callback={callback}
        options={{
          coalesceMs: 50,
        }}
      />,
    );

    emitRefresh("chat", { reason: "first", source: "test", timestamp: Date.now() });
    emitRefresh("chat", { reason: "second", source: "test", eventType: "message.created", timestamp: Date.now() + 1 });
    expect(callback).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toMatchObject({
      topic: "chat",
      reason: "second",
      eventType: "message.created",
    });

    renderer.unmount();
    emitRefresh("chat", { reason: "after unmount", source: "test" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("queues one more event refresh when a callback is already in flight", async () => {
    let releaseFirst!: () => void;
    const callback = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    create(<Harness callback={callback} options={{ coalesceMs: 25 }} />);

    emitRefresh("chat", { reason: "first", source: "test" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    emitRefresh("chat", { reason: "queued", source: "test" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
    });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[1]?.[0]).toMatchObject({ reason: "queued" });
  });

  it("runs fallback polling only when stale and visible unless explicitly allowed", async () => {
    const fallbackStates: boolean[] = [];
    const callback = vi.fn();
    create(
      <Harness
        callback={callback}
        options={{
          staleMs: 100,
          pollIntervalMs: 100,
          onFallbackStateChange: (active) => fallbackStates.push(active),
        }}
      />,
    );

    document.hidden = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(callback).not.toHaveBeenCalled();

    document.hidden = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "fallback_poll",
        eventType: "fallback_poll",
        source: "refresh-hook",
      }),
    );
    expect(fallbackStates).toEqual([true]);

    callback.mockClear();
    document.hidden = true;
    create(
      <Harness
        callback={callback}
        topic="system"
        options={{
          staleMs: 100,
          pollIntervalMs: 100,
          runWhenHidden: true,
        }}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(callback).toHaveBeenCalled();
  });

  it("handles disabled subscriptions and callback failures without leaking timers", async () => {
    const callback = vi.fn().mockRejectedValue(new Error("refresh failed"));
    const fallbackStates: boolean[] = [];
    const renderer = create(
      <Harness
        callback={callback}
        options={{
          enabled: false,
          coalesceMs: 10,
          staleMs: 100,
          onFallbackStateChange: (active) => fallbackStates.push(active),
        }}
      />,
    );

    emitRefresh("chat", { reason: "disabled", source: "test" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(callback).not.toHaveBeenCalled();

    renderer.update(
      <Harness
        callback={callback}
        options={{
          enabled: true,
          coalesceMs: 10,
        }}
      />,
    );
    emitRefresh("chat", { reason: "failure", source: "test" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await flushAsync();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(fallbackStates).toEqual([]);
  });
});

function Harness({
  callback,
  options,
  topic = "chat",
}: {
  callback: Parameters<typeof useRefreshSubscription>[1];
  options?: Parameters<typeof useRefreshSubscription>[2];
  topic?: Parameters<typeof useRefreshSubscription>[0];
}) {
  useRefreshSubscription(topic, callback, options);
  return null;
}
