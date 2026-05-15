import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "../api/client";
import { buildRealtimeEventSummary, EventCard } from "./EventCard";

function event(overrides: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return {
    eventId: "evt-1",
    sequence: 42,
    eventType: "approval_created",
    source: "approval",
    timestamp: "2026-03-10T18:00:00.000Z",
    payload: { summary: "Review shell access" },
    links: {},
    ...overrides,
  } as RealtimeEvent;
}

describe("EventCard", () => {
  it("builds summaries from payload details, sessions, tasks, and source labels", () => {
    expect(buildRealtimeEventSummary(event())).toBe("Approval reported approval created: Review shell access.");
    expect(
      buildRealtimeEventSummary(
        event({
          source: "system",
          payload: {},
          links: { sessionId: "session-abcdef" },
        }),
      ),
    ).toBe("System reported approval created: session abcdef.");
    expect(
      buildRealtimeEventSummary(
        event({
          source: "chat",
          payload: {},
          links: { taskId: "task-123456" },
        }),
      ),
    ).toBe("Chat reported approval created: task 123456.");
    expect(buildRealtimeEventSummary(event({ source: "mcp", payload: {}, links: {} }))).toBe(
      "Mcp reported approval created.",
    );
  });

  it("renders event metadata, linked records, trace preview actions, and raw payload", async () => {
    const onLoadTracePreview = vi.fn();
    const renderer = create(
      <EventCard
        event={event({
          traceId: "trace-1",
          correlationId: "corr-1",
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: {
            approvalId: "approval-1",
            proactiveRunId: "proactive-1",
            taskId: "task-1",
            runId: "run-1",
          },
        })}
        summary="Approval needs review."
        tracePreview={["tool queued", "approval requested"]}
        onLoadTracePreview={onLoadTracePreview}
      />,
    );

    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("Approval Created");
    expect(text).toContain("Approval needs review.");
    expect(text).toContain("trace");
    expect(text).toContain("trace-1");
    expect(text).toContain("approval");
    expect(text).toContain("approval-1");
    expect(text).toContain("Refresh trace detail");
    expect(text).toContain("tool queued");
    expect(text).toContain("Show raw payload");

    const action = renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === "Refresh trace detail");
    await act(async () => {
      action?.props.onClick?.();
    });

    expect(onLoadTracePreview).toHaveBeenCalledTimes(1);
  });

  it("offers trace loading before preview data exists", () => {
    const renderer = create(
      <EventCard
        event={event({ correlationId: "corr-2" })}
        summary="Trace can be loaded."
        onLoadTracePreview={vi.fn()}
      />,
    );

    expect(JSON.stringify(renderer.toJSON())).toContain("Load trace detail");
  });
});
