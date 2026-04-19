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
});
