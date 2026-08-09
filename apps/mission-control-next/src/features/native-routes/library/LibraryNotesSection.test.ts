import { describe, expect, it } from "vitest";
import { toReminderDueAtIso } from "./LibraryNotesSection";

describe("toReminderDueAtIso", () => {
  it("converts a datetime-local value to the canonical UTC timestamp", () => {
    const input = "2026-06-06T17:00";
    const result = toReminderDueAtIso(input);

    expect(result).not.toBeNull();
    expect(result).toMatch(/Z$/u);
    expect(Date.parse(result!)).toBe(new Date(input).getTime());
  });

  it("rejects empty and invalid due dates", () => {
    expect(toReminderDueAtIso(" ")).toBeNull();
    expect(toReminderDueAtIso("not-a-date")).toBeNull();
  });
});
