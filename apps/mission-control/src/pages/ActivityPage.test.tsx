import React from "react";
import { act, create, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "../api/client";
import { ActivityPage } from "./ActivityPage";
import { renderActivityPayloadSummary } from "./activity-page-helpers";

const apiMocks = vi.hoisted(() => ({
  fetchRealtimeEvents: vi.fn(),
  connectEventStream: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchRealtimeEvents: apiMocks.fetchRealtimeEvents,
  connectEventStream: apiMocks.connectEventStream,
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: (props: {
    data?: RealtimeEvent[];
    itemContent?: (index: number, event: RealtimeEvent) => React.ReactNode;
  }) => (
    <div>
      {(props.data ?? []).map((event, index) => (
        <div key={event.eventId}>{props.itemContent?.(index, event)}</div>
      ))}
    </div>
  ),
}));

function event(overrides: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return {
    eventId: "event-1",
    sequence: 1,
    eventType: "task.updated",
    source: "test",
    timestamp: "2026-05-14T12:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("renderActivityPayloadSummary", () => {
  it.each([
    [null, null],
    ["text", null],
    [{}, null],
    [
      {
        originSurface: "cowork",
        nextWakeAt: "2026-05-14T12:30:00.000Z",
        stopReason: "budget",
        externalReferenceRoots: [{ rootPath: "F:/code", label: "repo" }],
      },
      /surface cowork .* stop budget .* 1 reference root/,
    ],
    [{ externalReferenceRoots: [{}, {}] }, "2 reference roots"],
  ])("summarizes %j", (payload, expected) => {
    const summary = renderActivityPayloadSummary(payload);
    if (expected instanceof RegExp) {
      expect(summary).toMatch(expected);
    } else {
      expect(summary).toBe(expected);
    }
  });
});

describe("ActivityPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders retained events, stream payload summaries, and closes the stream on unmount", async () => {
    let emitEvent: ((event: RealtimeEvent) => void) | undefined;
    const close = vi.fn();
    apiMocks.fetchRealtimeEvents.mockResolvedValue({
      items: [
        event({
          eventId: "event-1",
          payload: { originSurface: "chat", stopReason: "done" },
        }),
      ],
    });
    apiMocks.connectEventStream.mockImplementation((callback: (event: RealtimeEvent) => void) => {
      emitEvent = callback;
      return close;
    });

    const renderer = create(<ActivityPage />);
    await flush();

    await act(async () => {
      emitEvent?.(
        event({
          eventId: "event-2",
          sequence: 2,
          eventType: "proactive.tick",
          payload: {
            originSurface: "cowork",
            externalReferenceRoots: [{ label: "repo", rootPath: "F:/code" }],
          },
        }),
      );
    });

    const text = collectText(renderer.toJSON()).replace(/\s+/g, " ");
    expect(text).toContain("2 buffered");
    expect(text).toContain("surface chat");
    expect(text).toContain("stop done");
    expect(text).toContain("surface cowork");
    expect(text).toContain("1 reference root");

    renderer.unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("surfaces fetch errors while keeping the stream status visible", async () => {
    apiMocks.fetchRealtimeEvents.mockRejectedValue(new Error("events unavailable"));
    apiMocks.connectEventStream.mockReturnValue(vi.fn());

    const renderer = create(<ActivityPage />);
    await flush();

    const text = collectText(renderer.toJSON());
    expect(text).toContain("events unavailable");
    expect(text).toContain("Stream issues");
  });
});
