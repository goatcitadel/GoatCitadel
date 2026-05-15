import { describe, expect, it } from "vitest";
import type { RealtimeEvent } from "../api/client";
import { mergeLiveEvents } from "./useTimelineSummary";

function event(eventId: string, sequence: number | undefined, timestamp: string): RealtimeEvent {
  return {
    eventId,
    eventType: "runtime.lifecycle",
    sequence: sequence as number,
    timestamp,
    source: "gateway",
    payload: {},
  } as unknown as RealtimeEvent;
}

describe("mergeLiveEvents", () => {
  it("deduplicates by event id, sorts by sequence then timestamp, and caps the live buffer", () => {
    const existing = [
      event("old-sequence", 1, "2026-05-14T10:00:00.000Z"),
      event("same", 2, "2026-05-14T10:01:00.000Z"),
      event("newer-timestamp", undefined, "2026-05-14T10:04:00.000Z"),
      event("older-timestamp", undefined, "2026-05-14T10:03:00.000Z"),
    ];

    expect(mergeLiveEvents(existing, event("same", 3, "2026-05-14T10:02:00.000Z")).map((item) => item.eventId)).toEqual(
      ["same", "old-sequence", "newer-timestamp", "older-timestamp"],
    );

    const large = Array.from({ length: 305 }, (_, index) =>
      event(`event-${index}`, index, `2026-05-14T10:${String(index % 60).padStart(2, "0")}:00.000Z`),
    );
    const merged = mergeLiveEvents(large, event("latest", 999, "2026-05-14T12:00:00.000Z"));
    expect(merged).toHaveLength(300);
    expect(merged[0]?.eventId).toBe("latest");
    expect(merged[merged.length - 1]?.eventId).toBe("event-6");
  });
});
