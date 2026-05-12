import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publishEventStreamStatus, resetEventStreamStatus, useEventStreamStatus } from "./event-stream-status-store";

function StatusProbe({ onStatus }: { onStatus: (state: string, reconnectAttempts: number) => void }) {
  const status = useEventStreamStatus();
  onStatus(status.state, status.reconnectAttempts);
  return <span>{status.state}</span>;
}

describe("event stream status store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    resetEventStreamStatus();
  });

  afterEach(() => {
    resetEventStreamStatus();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("publishes state changes immediately and throttles frequent event-only updates", () => {
    const snapshots: Array<[string, number]> = [];
    const renderer = create(<StatusProbe onStatus={(state, attempts) => snapshots.push([state, attempts])} />);

    act(() => {
      publishEventStreamStatus({
        state: "open",
        reconnectAttempts: 0,
        lastEventAt: "2026-01-01T00:00:00.000Z",
        leaseId: "lease-1",
      });
    });
    expect(renderer.root.findByType("span").children.join("")).toBe("open");
    expect(snapshots.at(-1)).toEqual(["open", 0]);

    act(() => {
      publishEventStreamStatus({
        state: "open",
        reconnectAttempts: 0,
        lastEventAt: "2026-01-01T00:00:01.000Z",
        leaseId: "lease-1",
      });
    });
    expect(snapshots.at(-1)).toEqual(["open", 0]);

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(snapshots.at(-1)).toEqual(["open", 0]);

    act(() => {
      publishEventStreamStatus({
        state: "retrying",
        reconnectAttempts: 2,
        lastErrorAt: "2026-01-01T00:00:02.000Z",
      });
    });
    expect(snapshots.at(-1)).toEqual(["retrying", 2]);

    act(() => {
      resetEventStreamStatus();
    });
    expect(snapshots.at(-1)).toEqual(["closed", 0]);
    renderer.unmount();
  });

  it("drops pending throttled updates when a later state change arrives", () => {
    const snapshots: Array<[string, number]> = [];
    const renderer = create(<StatusProbe onStatus={(state, attempts) => snapshots.push([state, attempts])} />);

    act(() => {
      publishEventStreamStatus({
        state: "open",
        reconnectAttempts: 0,
        lastEventAt: "2026-01-01T00:00:00.000Z",
      });
      publishEventStreamStatus({
        state: "open",
        reconnectAttempts: 0,
        lastEventAt: "2026-01-01T00:00:01.000Z",
      });
      publishEventStreamStatus({
        state: "error",
        reconnectAttempts: 3,
        lastErrorAt: "2026-01-01T00:00:02.000Z",
      });
      vi.advanceTimersByTime(5000);
    });

    expect(snapshots.at(-1)).toEqual(["error", 3]);
    renderer.unmount();
  });
});
