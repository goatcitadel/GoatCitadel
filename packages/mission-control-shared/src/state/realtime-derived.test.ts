import { describe, expect, it } from "vitest";
import type { RealtimeEvent } from "../api/types";
import { deriveRealtimeEventTone, deriveRealtimeNotification, deriveRealtimeRefresh } from "./realtime-derived";

function event(overrides: Partial<RealtimeEvent> = {}): RealtimeEvent {
  return {
    eventId: "evt",
    sequence: 1,
    eventType: "generic_event",
    source: "gateway",
    timestamp: "2026-04-22T00:00:00.000Z",
    payload: {},
    ...overrides,
  } as RealtimeEvent;
}

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

    expect(result.truthMode).toBe("compatibility");
    expect(result.usedCompatibilityInference).toBe(true);
    expect(
      deriveRealtimeNotification({
        eventId: "evt-approval",
        sequence: 3,
        eventType: "approval_resolved",
        source: "approvals",
        timestamp: "2026-04-22T00:00:00.000Z",
        payload: {},
      }),
    ).toBeUndefined();
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

  it("keeps durable history events authoritative but silent", () => {
    const refresh = deriveRealtimeRefresh(
      event({
        eventAuthority: "durable_history",
        eventType: "task_history_replayed",
        links: { taskId: "task-1" },
      }),
    );

    expect(refresh).toEqual({
      topics: [],
      truthMode: "authoritative",
      usedCompatibilityInference: false,
      signalReason: "task_history_replayed",
      signalEventType: "task_history_replayed",
    });
    expect(deriveRealtimeNotification(event({ eventAuthority: "durable_history" }))).toBeUndefined();
  });

  it("merges default topics, explicit links, system source, and compatibility keywords", () => {
    const refresh = deriveRealtimeRefresh(
      event({
        eventType:
          "dashboard prompt_pack chat approval tool file memory agent skill mcp task improvement integration provider llama system",
        source: "system",
        eventClass: "domain_fact",
        payload: { kind: "runtime" },
        links: { sessionId: "session-1", approvalId: "approval-1", taskId: "task-1" },
      }),
      { defaultTopics: ["surface", "chat"] },
    );

    expect(refresh.truthMode).toBe("compatibility");
    expect(refresh.usedCompatibilityInference).toBe(true);
    expect(refresh.topics).toEqual([
      "surface",
      "chat",
      "approvals",
      "tasks",
      "system",
      "quality",
      "tools",
      "files",
      "memory",
      "agents",
      "skills",
      "mcp",
      "improvement",
      "integrations",
      "npu",
      "llamaCpp",
    ]);
  });

  it("derives notifications from explicit links, replay gaps, compatibility keywords, and quiet events", () => {
    expect(deriveRealtimeNotification(event({ links: { approvalId: "approval-1" } }))).toBeUndefined();
    expect(
      deriveRealtimeNotification(event({ eventType: "approval_created", links: { approvalId: "approval-1" } })),
    ).toMatchObject({
      attentionKind: "approval_waiting",
      soundCue: "waiting",
      tone: "warning",
    });
    expect(
      deriveRealtimeNotification(event({ links: { approvalId: "approval-1", sessionId: "session-1" } })),
    ).toBeUndefined();
    expect(
      deriveRealtimeNotification(event({ links: { approvalId: "approval-1", taskId: "task-1" } })),
    ).toBeUndefined();
    expect(deriveRealtimeNotification(event({ eventType: "approval_task_changed" }))).toBeUndefined();
    expect(deriveRealtimeNotification(event({ links: { taskId: "task-1" } }))).toMatchObject({
      tone: "info",
      groupKey: "cowork-tasks",
      truthMode: "authoritative",
    });
    expect(deriveRealtimeNotification(event({ links: { sessionId: "session-1" } }))).toMatchObject({
      tone: "info",
      groupKey: "chat-thread",
      truthMode: "authoritative",
    });
    expect(deriveRealtimeNotification(event({ payload: { kind: "replay_gap" } }))).toMatchObject({
      tone: "warning",
      groupKey: "stream-replay-gap",
      truthMode: "replay-gap",
      soundCue: "problem",
    });
    expect(
      deriveRealtimeNotification(
        event({
          eventType: "orchestration_event",
          links: { runId: "run-1" },
          payload: { event: "run_started" },
        }),
      ),
    ).toMatchObject({
      tone: "info",
      attentionKind: "activity_update",
      soundCue: "started",
    });
    expect(
      deriveRealtimeNotification(
        event({
          eventType: "orchestration_event",
          links: { runId: "run-1" },
          payload: { event: "run_resumed" },
        }),
      ),
    ).toMatchObject({
      tone: "success",
      attentionKind: "activity_update",
      soundCue: "resumed",
    });
    expect(
      deriveRealtimeNotification(
        event({
          eventType: "orchestration_event",
          links: { runId: "run-1" },
          payload: { event: "run_completed" },
        }),
      ),
    ).toMatchObject({
      tone: "success",
      attentionKind: "run_completed",
      soundCue: "done",
    });
    expect(
      deriveRealtimeNotification(
        event({
          eventType: "task_updated",
          links: { taskId: "task-1" },
          payload: { status: "completed" },
        }),
      ),
    ).toMatchObject({
      message: "Task activity updated in Cowork.",
      attentionKind: "activity_update",
    });
    expect(
      deriveRealtimeNotification(
        event({
          eventType: "orchestration_event",
          links: { runId: "run-1" },
          payload: { event: "run_failed" },
        }),
      ),
    ).toMatchObject({
      tone: "error",
      attentionKind: "run_failed",
      soundCue: "problem",
    });
    expect(
      deriveRealtimeNotification(
        event({
          eventType: "orchestration_event",
          links: { approvalId: "approval-1", runId: "run-1" },
          payload: { event: "run_paused_for_approval" },
        }),
      ),
    ).toMatchObject({
      tone: "warning",
      attentionKind: "operator_blocked",
      soundCue: "waiting",
    });
    expect(deriveRealtimeNotification(event({ eventType: "task_changed" }))).toMatchObject({
      groupKey: "cowork-tasks",
      truthMode: "compatibility",
      soundCue: "soft_update",
    });
    expect(deriveRealtimeNotification(event({ eventType: "deliverable_added" }))).toMatchObject({
      groupKey: "handoff-ready",
      soundCue: "handoff_ready",
    });
    expect(deriveRealtimeNotification(event({ eventType: "gateway_disconnected" }))).toMatchObject({
      groupKey: "connection-interrupted",
      soundCue: "disconnected",
    });
    expect(deriveRealtimeNotification(event({ eventType: "gateway_connected" }))).toMatchObject({
      groupKey: "connection-restored",
      soundCue: "connected",
    });
    expect(deriveRealtimeNotification(event({ eventType: "chat_message_saved" }))).toMatchObject({
      groupKey: "chat-thread",
      truthMode: "compatibility",
      soundCue: "message",
    });
    expect(deriveRealtimeNotification(event({ eventType: "heartbeat" }))).toBeUndefined();
  });

  it("does not throw when an event is missing its payload (MCSHARED-001 defense-in-depth)", () => {
    // RealtimeEvent.payload is typed Record<string, unknown> but events that
    // bypass the SSE boundary normalizer (e.g. DashboardStateResponse.recentEvents)
    // could arrive without a payload; the pure derivers must not dereference it unsafely.
    const malformed = {
      eventId: "evt",
      sequence: 1,
      eventType: "task_updated",
      source: "gateway",
      timestamp: "",
    } as unknown as RealtimeEvent;
    expect(() => deriveRealtimeRefresh(malformed)).not.toThrow();
    expect(() => deriveRealtimeNotification(malformed)).not.toThrow();
    expect(() => deriveRealtimeEventTone(malformed)).not.toThrow();
    expect(deriveRealtimeEventTone(malformed)).toBe("success");
  });

  it("maps event tone from replay gaps, failures, task activity, live domains, and muted noise", () => {
    expect(deriveRealtimeEventTone(event({ payload: { kind: "replay_gap" } }))).toBe("warning");
    expect(deriveRealtimeEventTone(event({ eventType: "auth_device_requested" }))).toBe("warning");
    expect(deriveRealtimeEventTone(event({ eventType: "provider_failed" }))).toBe("critical");
    expect(deriveRealtimeEventTone(event({ links: { taskId: "task-1" } }))).toBe("success");
    expect(deriveRealtimeEventTone(event({ eventType: "deliverable_created" }))).toBe("success");
    expect(deriveRealtimeEventTone(event({ eventClass: "domain_fact" }))).toBe("live");
    expect(deriveRealtimeEventTone(event({ eventType: "tool_completed" }))).toBe("live");
    expect(deriveRealtimeEventTone(event({ eventType: "heartbeat" }))).toBe("muted");
  });
});
