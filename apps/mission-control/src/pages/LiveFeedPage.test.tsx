import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const connectEventStreamMock = vi.hoisted(() => vi.fn());
const fetchDevDiagnosticsMock = vi.hoisted(() => vi.fn());
const fetchRealtimeEventsMock = vi.hoisted(() => vi.fn());

vi.mock("../api/client", () => ({
  connectEventStream: connectEventStreamMock,
  fetchDevDiagnostics: fetchDevDiagnosticsMock,
  fetchRealtimeEvents: fetchRealtimeEventsMock,
}));

import { LiveFeedPage } from "./LiveFeedPage";

describe("LiveFeedPage", () => {
  let streamHandler: ((event: any) => void) | null = null;
  const closeStream = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    closeStream.mockClear();
    streamHandler = null;
    connectEventStreamMock.mockImplementation((handler: (event: any) => void) => {
      streamHandler = handler;
      return closeStream;
    });
    fetchDevDiagnosticsMock.mockResolvedValue({ items: [] });
    fetchRealtimeEventsMock.mockResolvedValue({
      items: [
        {
          eventId: "evt-1",
          sequence: 12,
          eventType: "task_updated",
          source: "gateway",
          timestamp: "2026-04-09T12:00:00.000Z",
          correlationId: "corr-1",
          payload: { status: "queued" },
        },
      ],
    });
  });

  it("renders human-readable event summaries with raw payload tucked behind details", async () => {
    let renderer = create(<div />);

    await act(async () => {
      renderer = create(<LiveFeedPage />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Gateway reported task updated: queued.");
    expect(text).toContain("Show raw payload");
    expect(text).toContain("Load trace detail");
  });

  it("loads trace previews for correlated events and preserves the stream cleanup", async () => {
    fetchDevDiagnosticsMock.mockResolvedValueOnce({
      items: [
        {
          id: "diag-1",
          timestamp: "2026-04-09T12:01:00.000Z",
          event: "chat.turn",
          message: "Turn started",
        },
      ],
    });
    let renderer = create(<div />);

    await act(async () => {
      renderer = create(<LiveFeedPage />);
      await Promise.resolve();
    });

    const loadTrace = renderer.root
      .findAllByType("button")
      .find((button) => JSON.stringify(button.props.children).includes("Load trace detail"));
    expect(loadTrace).toBeTruthy();

    await act(async () => {
      loadTrace?.props.onClick();
      await Promise.resolve();
    });

    expect(fetchDevDiagnosticsMock).toHaveBeenCalledWith({ correlationId: "corr-1", limit: 12 });
    expect(JSON.stringify(renderer.toJSON())).toContain("chat.turn: Turn started");

    renderer.unmount();
    expect(closeStream).toHaveBeenCalledTimes(1);
  });

  it("reloads retained events on replay gaps and shows fetch or trace errors", async () => {
    fetchRealtimeEventsMock.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({
      items: [
        {
          eventId: "evt-reloaded",
          sequence: 20,
          eventType: "task_created",
          source: "gateway",
          timestamp: "2026-04-09T12:02:00.000Z",
          payload: { title: "Reloaded task" },
        },
      ],
    });
    let renderer = create(<div />);

    await act(async () => {
      renderer = create(<LiveFeedPage />);
      await Promise.resolve();
    });

    await act(async () => {
      streamHandler?.({
        eventId: "gap-1",
        sequence: 21,
        eventType: "events_stream_control",
        source: "gateway",
        timestamp: "2026-04-09T12:03:00.000Z",
        payload: { kind: "replay_gap" },
      });
      await Promise.resolve();
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Reloaded task");
    expect(fetchRealtimeEventsMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces initial feed and trace preview failures", async () => {
    fetchRealtimeEventsMock.mockRejectedValueOnce(new Error("feed unavailable"));
    let renderer = create(<div />);

    await act(async () => {
      renderer = create(<LiveFeedPage />);
      await Promise.resolve();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain("feed unavailable");

    renderer.unmount();

    fetchRealtimeEventsMock.mockResolvedValueOnce({
      items: [
        {
          eventId: "evt-error",
          sequence: 22,
          eventType: "task_updated",
          source: "gateway",
          timestamp: "2026-04-09T12:04:00.000Z",
          correlationId: "corr-error",
          payload: { status: "running" },
        },
      ],
    });
    fetchDevDiagnosticsMock.mockRejectedValueOnce(new Error("diagnostics unavailable"));

    await act(async () => {
      renderer = create(<LiveFeedPage />);
      await Promise.resolve();
    });

    const loadTrace = renderer.root
      .findAllByType("button")
      .find((button) => JSON.stringify(button.props.children).includes("Load trace detail"));
    await act(async () => {
      loadTrace?.props.onClick();
      await Promise.resolve();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain("diagnostics unavailable");
  });
});
