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
  beforeEach(() => {
    connectEventStreamMock.mockImplementation(() => () => undefined);
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
});
