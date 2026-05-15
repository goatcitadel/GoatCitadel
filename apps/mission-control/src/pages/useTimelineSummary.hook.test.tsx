import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEvent, TimelineSummaryResponse } from "../api/client";
import { useTimelineSummary } from "./useTimelineSummary";

const apiMocks = vi.hoisted(() => ({
  close: vi.fn(),
  connectEventStream: vi.fn(),
  fetchTimelineSummary: vi.fn(),
}));

const refreshMocks = vi.hoisted(() => ({
  callback: undefined as undefined | (() => Promise<void>),
  useRefreshSubscription: vi.fn((_: string, callback: () => Promise<void>) => {
    refreshMocks.callback = callback;
  }),
}));

vi.mock("../api/client", () => ({
  connectEventStream: apiMocks.connectEventStream,
  fetchTimelineSummary: apiMocks.fetchTimelineSummary,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: refreshMocks.useRefreshSubscription,
}));

function event(eventId: string, sequence: number): RealtimeEvent {
  return {
    eventId,
    eventType: "runtime.lifecycle",
    sequence,
    timestamp: `2026-05-14T12:00:0${sequence}.000Z`,
    source: "gateway",
    payload: {},
  } as unknown as RealtimeEvent;
}

function summary(eventIds: string[]): TimelineSummaryResponse {
  return {
    generatedAt: "2026-05-14T12:00:00.000Z",
    events: {
      items: eventIds.map((eventId, index) => event(eventId, index + 1)),
    },
    sessions: {
      items: [],
    },
    scheduler: {
      jobs: [],
      reviewQueue: [],
    },
    improvement: {
      reports: [],
      replayRuns: [],
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe("useTimelineSummary", () => {
  beforeEach(() => {
    apiMocks.close.mockReset();
    apiMocks.connectEventStream.mockReset();
    apiMocks.fetchTimelineSummary.mockReset();
    refreshMocks.callback = undefined;
    refreshMocks.useRefreshSubscription.mockClear();
    apiMocks.connectEventStream.mockReturnValue(apiMocks.close);
  });

  it("loads the summary, merges live events, refreshes on subscription, and closes the stream", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    apiMocks.connectEventStream.mockImplementation((callback: (event: RealtimeEvent) => void) => {
      onEvent = callback;
      return apiMocks.close;
    });
    apiMocks.fetchTimelineSummary.mockResolvedValueOnce(summary(["initial"]));

    function Probe() {
      const timeline = useTimelineSummary();
      return (
        <span>
          {timeline.error ?? "ok"}:{timeline.isRefreshing ? "refreshing" : "idle"}:
          {timeline.data?.events.items.map((item) => item.eventId).join("|") ?? "none"}
        </span>
      );
    }

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe />);
    });
    await flush();

    expect(renderText(renderer)).toContain("ok");
    expect(renderText(renderer)).toContain("initial");
    expect(apiMocks.connectEventStream).toHaveBeenCalledTimes(1);
    expect(refreshMocks.useRefreshSubscription).toHaveBeenCalledWith(
      "dashboard",
      expect.any(Function),
      expect.objectContaining({
        coalesceMs: 1000,
        enabled: true,
        pollIntervalMs: 15000,
        staleMs: 20000,
      }),
    );

    act(() => {
      onEvent?.(event("live", 9));
    });
    expect(renderText(renderer)).toContain("live|initial");

    const refresh = createDeferred<TimelineSummaryResponse>();
    apiMocks.fetchTimelineSummary.mockReturnValueOnce(refresh.promise);
    void act(() => {
      void refreshMocks.callback?.();
    });
    await flush();
    expect(renderText(renderer)).toContain("refreshing");

    await act(async () => {
      refresh.resolve(summary(["refreshed"]));
      await refresh.promise;
    });
    expect(renderText(renderer)).toContain("idle");
    expect(renderText(renderer)).toContain("refreshed");

    act(() => {
      renderer.unmount();
    });
    expect(apiMocks.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces initial load failures without replacing live state", async () => {
    apiMocks.fetchTimelineSummary.mockRejectedValueOnce(new Error("timeline offline"));

    function Probe() {
      const timeline = useTimelineSummary();
      return <span>{timeline.error ?? timeline.data?.events.items.length ?? "no-error"}</span>;
    }

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe />);
    });
    await flush();

    expect(renderText(renderer)).toContain("timeline offline");
  });
});
