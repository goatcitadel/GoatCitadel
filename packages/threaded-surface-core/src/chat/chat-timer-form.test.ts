import { describe, expect, it } from "vitest";
import { toDateTimeLocalValue, zonedDateTimeToIso } from "./chat-timer-form";

describe("Chat timer form helpers", () => {
  it("resolves an explicit timezone deterministically", () => {
    expect(zonedDateTimeToIso("2026-07-27T17:30", "America/Los_Angeles")).toBe("2026-07-28T00:30:00.000Z");
  });

  it("rejects a nonexistent DST wall-clock time", () => {
    expect(() => zonedDateTimeToIso("2026-03-08T02:30", "America/Los_Angeles")).toThrow(/does not exist/i);
  });

  it("formats local form values without applying a UTC conversion", () => {
    const date = new Date(2026, 6, 27, 17, 5);
    expect(toDateTimeLocalValue(date)).toBe("2026-07-27T17:05");
  });
});
