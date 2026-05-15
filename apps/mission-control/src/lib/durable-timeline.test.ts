import { describe, expect, it } from "vitest";
import { describeDurableTimelineEvent } from "./durable-timeline";

describe("describeDurableTimelineEvent", () => {
  it("polishes orchestration hold and approval wording", () => {
    expect(
      describeDurableTimelineEvent({
        eventType: "run_paused",
        payload: {
          actorId: "orchestration",
          previousStatus: "queued",
        },
      } as any),
    ).toEqual({
      label: "Held until explicit start",
    });

    expect(
      describeDurableTimelineEvent({
        eventType: "run_paused",
        payload: {
          actorId: "orchestration",
          previousStatus: "running",
        },
      } as any),
    ).toEqual({
      label: "Worker parked for approval",
      detail: undefined,
    });

    expect(
      describeDurableTimelineEvent({
        eventType: "run_resumed",
        payload: {
          actorId: "orchestration",
          previousStatus: "paused",
        },
      } as any),
    ).toEqual({
      label: "Released to worker",
    });
  });

  it("uses execution-specific wording when phase context exists", () => {
    expect(
      describeDurableTimelineEvent({
        eventType: "run_started",
        payload: {
          waveId: "wave-1",
          phaseId: "phase-2",
        },
      } as any),
    ).toEqual({
      label: "Execution started",
      detail: "wave-1 · phase-2",
    });

    expect(
      describeDurableTimelineEvent({
        eventType: "run_resumed",
        payload: {
          waveId: "wave-1",
          phaseId: "phase-3",
        },
      } as any),
    ).toEqual({
      label: "Execution resumed",
      detail: "wave-1 · phase-3",
    });
  });

  it("describes durable timeline fallback states and wake/retry outcomes", () => {
    expect(describeDurableTimelineEvent({ eventType: "run_created", payload: {} } as any)).toEqual({
      label: "Run created",
    });
    expect(describeDurableTimelineEvent({ eventType: "run_started", payload: {} } as any)).toEqual({
      label: "Worker picked up run",
    });
    expect(
      describeDurableTimelineEvent({
        eventType: "run_paused",
        payload: { actorId: "operator", previousStatus: "running" },
      } as any),
    ).toEqual({
      label: "Run paused",
      detail: "operator · running",
    });
    expect(
      describeDurableTimelineEvent({
        eventType: "run_paused",
        payload: { actorId: "operator", previousStatus: "running", reason: "manual stop" },
      } as any),
    ).toEqual({
      label: "Run paused",
      detail: "manual stop",
    });
    expect(
      describeDurableTimelineEvent({
        eventType: "run_resumed",
        payload: { actorId: "operator", previousStatus: "paused" },
      } as any),
    ).toEqual({
      label: "Run resumed",
      detail: "operator · paused",
    });
    expect(
      describeDurableTimelineEvent({ eventType: "run_waiting", payload: { eventKey: "approval" } } as any),
    ).toEqual({
      label: "Waiting for event",
      detail: "approval",
    });
    expect(describeDurableTimelineEvent({ eventType: "run_woken", payload: { eventKey: "approval" } } as any)).toEqual({
      label: "Wake event received",
      detail: "approval",
    });
    expect(
      describeDurableTimelineEvent({ eventType: "run_retry_scheduled", payload: { reason: "backoff" } } as any),
    ).toEqual({
      label: "Retry scheduled",
      detail: "backoff",
    });
    expect(
      describeDurableTimelineEvent({ eventType: "run_cancelled", payload: { actorId: "operator" } } as any),
    ).toEqual({
      label: "Run cancelled",
      detail: "operator",
    });
    expect(describeDurableTimelineEvent({ eventType: "run_completed", payload: {} } as any)).toEqual({
      label: "Run completed",
    });
    expect(describeDurableTimelineEvent({ eventType: "run_failed", payload: { reason: "boom" } } as any)).toEqual({
      label: "Run failed",
      detail: "boom",
    });
    expect(
      describeDurableTimelineEvent({ eventType: "run_dead_lettered", payload: { reason: "limit" } } as any),
    ).toEqual({
      label: "Moved to dead letter",
      detail: "limit",
    });
    expect(
      describeDurableTimelineEvent({ eventType: "dead_letter_recovered", payload: { actorId: "operator" } } as any),
    ).toEqual({
      label: "Recovered from dead letter",
      detail: "operator",
    });
    expect(describeDurableTimelineEvent({ eventType: "custom_event", payload: {} } as any)).toEqual({
      label: "custom event",
    });
  });
});
