import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
}));

const streamState = vi.hoisted(() => ({
  onEvent: null as null | ((event: unknown) => void),
}));

const apiMocks = vi.hoisted(() => ({
  fetchTimelineSummary: vi.fn(),
  connectEventStream: vi.fn(),
}));

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    fetchTimelineSummary: apiMocks.fetchTimelineSummary,
    connectEventStream: apiMocks.connectEventStream,
  };
});

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: (signal: unknown) => Promise<void> | void) => {
    refreshState.callback = callback;
  },
}));

import { TimelinePage } from "./TimelinePage";

describe("TimelinePage", () => {
  it("renders unified timeline sections from the aggregate summary", async () => {
    apiMocks.connectEventStream.mockImplementation((onEvent: (event: unknown) => void) => {
      streamState.onEvent = onEvent;
      return () => {
        streamState.onEvent = null;
      };
    });
    apiMocks.fetchTimelineSummary.mockResolvedValue({
      generatedAt: "2026-04-10T10:00:00.000Z",
      events: {
        items: [{
          eventId: "evt-1",
          sequence: 1,
          eventType: "runtime.ready",
          source: "gateway",
          timestamp: "2026-04-10T10:00:00.000Z",
          payload: {},
        }],
      },
      sessions: {
        items: [{
          sessionId: "session-1",
          title: "Operator Session",
          lifecycleStatus: "active",
          updatedAt: "2026-04-10T10:00:00.000Z",
        }],
      },
      scheduler: {
        jobs: [{ jobId: "job-1", name: "Nightly", enabled: true, schedule: "0 2 * * *" }],
        reviewQueue: [{ itemId: "review-1", reason: "Needs operator review", status: "pending" }],
      },
      improvement: {
        reports: [{ reportId: "report-1", title: "Weekly report", runId: "run-1" }],
        replayRuns: [{ runId: "run-1", status: "completed" }],
      },
    });

    let renderer = create(<div />);
    await act(async () => {
      renderer = create(<TimelinePage activeTab="sessions" workspaceId="default" onTabChange={() => undefined} />);
    });

    await act(async () => {
      streamState.onEvent?.({
        eventId: "evt-2",
        sequence: 2,
        eventType: "runtime.warning",
        source: "gateway",
        timestamp: "2026-04-10T10:05:00.000Z",
        payload: {},
      });
    });

    apiMocks.fetchTimelineSummary.mockResolvedValueOnce({
      generatedAt: "2026-04-10T10:06:00.000Z",
      events: {
        items: [{
          eventId: "evt-3",
          sequence: 3,
          eventType: "runtime.recovered",
          source: "gateway",
          timestamp: "2026-04-10T10:06:00.000Z",
          payload: {},
        }],
      },
      sessions: {
        items: [{
          sessionId: "session-1",
          title: "Operator Session",
          lifecycleStatus: "recovered",
          updatedAt: "2026-04-10T10:06:00.000Z",
        }],
      },
      scheduler: {
        jobs: [{ jobId: "job-1", name: "Nightly", enabled: true, schedule: "0 2 * * *" }],
        reviewQueue: [{ itemId: "review-1", reason: "Needs operator review", status: "pending" }],
      },
      improvement: {
        reports: [{ reportId: "report-1", title: "Weekly report", runId: "run-1" }],
        replayRuns: [{ runId: "run-1", status: "completed" }],
      },
    });
    await act(async () => {
      await refreshState.callback?.({
        topic: "dashboard",
        timestamp: Date.now(),
        reason: "test-refresh",
      });
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Timeline");
    expect(text).toContain("Buffered events");
    expect(text).toContain("Operator Session");
    expect(text).toContain("Needs operator review");
    expect(text).toContain("Weekly report");
    expect(text).toContain("runtime.recovered");
  });
});
