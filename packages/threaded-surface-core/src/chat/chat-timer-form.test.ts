import { describe, expect, it } from "vitest";
import { parseChatTimerDraft, toDateTimeLocalValue, zonedDateTimeToIso } from "./chat-timer-form";

describe("plain-language Chat timers", () => {
  it.each([
    "Please set a five-minute timer to remind me to stretch.",
    "Set a timer for 5 minutes to remind me to stretch. Deliver the reminder only in this Chat.",
    "Please set a five-minute timer to remind me to stretch. Deliver the reminder only in this Chat. This is a synthetic smoke test.",
    "Remind me in five minutes to stretch.",
  ])("stages a five-minute timer for %s", (request) => {
    expect(parseChatTimerDraft(request)).toEqual({ delayMs: 300_000, message: "stretch." });
  });

  it("stages a reminder about someone else without requesting delivery to them", () => {
    expect(parseChatTimerDraft("please set a 5 minute timer for my friend to message her mother")).toEqual({
      delayMs: 300_000,
      message: "my friend to message her mother",
    });
  });

  it.each([
    "How do I set a five-minute timer to remind me to stretch?",
    "Set a five-minute timer.",
    "Set a five-minute timer to remind me to stretch. Text it to my friend.",
    "Set a five-minute timer for my friend to message her mother. Send the reminder to my friend.",
    "Set a five-minute timer to remind me to stretch. Deliver the reminder only in this Chat. This is a synthetic smoke test. Send me an email too.",
    "Set a five-minute timer for my friend to message her mother and text it to her.",
    "Remind me in one second to stretch.",
  ])("leaves ambiguous or out-of-bounds requests on the normal Chat path: %s", (request) => {
    expect(parseChatTimerDraft(request)).toBeUndefined();
  });
});

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
