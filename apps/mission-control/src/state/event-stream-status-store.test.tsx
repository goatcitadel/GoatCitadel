import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadStore() {
  vi.resetModules();
  return import("./event-stream-status-store");
}

function installTimerWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
}

function renderText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe("event-stream-status-store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installTimerWindow();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("publishes state changes immediately and throttles same-state event ticks", async () => {
    const { publishEventStreamStatus, resetEventStreamStatus, useEventStreamStatus } = await loadStore();

    function Probe() {
      const status = useEventStreamStatus();
      return (
        <span>{`${status.state}:${status.reconnectAttempts}:${status.lastEventAt ?? "none"}:${status.leaseId ?? "none"}`}</span>
      );
    }

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe />);
    });
    expect(renderText(renderer)).toContain("closed:0:none:none");

    act(() => {
      publishEventStreamStatus({
        state: "open",
        reconnectAttempts: 0,
        lastEventAt: "2026-05-14T12:00:00.000Z",
        leaseId: "lease-1",
      });
    });
    expect(renderText(renderer)).toContain("open:0:2026-05-14T12:00:00.000Z:lease-1");

    act(() => {
      publishEventStreamStatus({
        state: "open",
        reconnectAttempts: 0,
        lastEventAt: "2026-05-14T12:00:01.000Z",
        leaseId: "lease-1",
      });
    });
    expect(renderText(renderer)).toContain("open:0:2026-05-14T12:00:00.000Z:lease-1");

    act(() => {
      publishEventStreamStatus({
        state: "retrying",
        reconnectAttempts: 1,
        lastEventAt: "2026-05-14T12:00:02.000Z",
        lastErrorAt: "2026-05-14T12:00:02.000Z",
        leaseId: "lease-1",
      });
    });
    expect(renderText(renderer)).toContain("retrying:1:2026-05-14T12:00:02.000Z:lease-1");

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(renderText(renderer)).toContain("retrying:1:2026-05-14T12:00:02.000Z:lease-1");

    act(() => {
      publishEventStreamStatus({
        state: "retrying",
        reconnectAttempts: 1,
        lastEventAt: "2026-05-14T12:00:08.000Z",
        lastErrorAt: "2026-05-14T12:00:02.000Z",
        leaseId: "lease-1",
      });
    });
    expect(renderText(renderer)).toContain("retrying:1:2026-05-14T12:00:08.000Z:lease-1");

    act(() => {
      resetEventStreamStatus();
    });
    expect(renderText(renderer)).toContain("closed:0:none:none");
  });

  it("drops throttled updates when no browser timer is available", async () => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "window");
    const { publishEventStreamStatus, resetEventStreamStatus, useEventStreamStatus } = await loadStore();

    function Probe() {
      const status = useEventStreamStatus();
      return <span>{status.lastEventAt ?? "none"}</span>;
    }

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe />);
    });

    act(() => {
      publishEventStreamStatus({
        state: "open",
        reconnectAttempts: 0,
        lastEventAt: "2026-05-14T12:00:00.000Z",
      });
      publishEventStreamStatus({
        state: "open",
        reconnectAttempts: 0,
        lastEventAt: "2026-05-14T12:00:01.000Z",
      });
    });

    expect(renderText(renderer)).toContain("2026-05-14T12:00:00.000Z");

    act(() => {
      resetEventStreamStatus();
    });
    expect(renderText(renderer)).toContain("none");
  });
});
