import { describe, expect, it } from "vitest";
import { deriveRealtimeEventTone, deriveRealtimeNotification, deriveRealtimeRefresh } from "./realtime-derived";

describe("realtime-derived", () => {
  it("prefers explicit links for refresh derivation", () => {
    const result = deriveRealtimeRefresh({
      eventId: "evt-1",
      sequence: 1,
      eventType: "chat_thread_updated",
      source: "chat",
      timestamp: "2026-04-22T00:00:00.000Z",
      links: { sessionId: "session-1" },
      payload: { kind: "event" },
    });

    expect(result.topics).toContain("chat");
    expect(result.topics).not.toContain("surface");
    expect(result.truthMode).toBe("authoritative");
    expect(result.usedCompatibilityInference).toBe(false);
  });

  it("marks replay gaps as degraded truth and broad refresh", () => {
    const result = deriveRealtimeRefresh({
      eventId: "evt-gap",
      sequence: 2,
      eventType: "events_replayed",
      source: "events",
      timestamp: "2026-04-22T00:00:00.000Z",
      payload: { kind: "replay_gap" },
    });

    expect(result.truthMode).toBe("replay-gap");
    expect(result.topics).toContain("surface");
    expect(result.topics).toContain("chat");
    expect(result.signalEventType).toBe("replay_gap");
  });

  it("flags compatibility inference when only the event name implies the topic", () => {
    const result = deriveRealtimeRefresh({
      eventId: "evt-approval",
      sequence: 3,
      eventType: "approval_resolved",
      source: "approvals",
      timestamp: "2026-04-22T00:00:00.000Z",
      payload: {},
    });
    const notification = deriveRealtimeNotification({
      eventId: "evt-approval",
      sequence: 3,
      eventType: "approval_resolved",
      source: "approvals",
      timestamp: "2026-04-22T00:00:00.000Z",
      payload: {},
    });

    expect(result.truthMode).toBe("compatibility");
    expect(result.usedCompatibilityInference).toBe(true);
    expect(notification).toMatchObject({
      groupKey: "ops-approvals",
      truthMode: "compatibility",
    });
    expect(
      deriveRealtimeEventTone({
        eventId: "evt-approval",
        sequence: 3,
        eventType: "approval_resolved",
        source: "approvals",
        timestamp: "2026-04-22T00:00:00.000Z",
        payload: {},
      }),
    ).toBe("warning");
  });
});
