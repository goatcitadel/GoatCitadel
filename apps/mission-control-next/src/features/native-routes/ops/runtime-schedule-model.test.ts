import { describe, expect, it } from "vitest";
import { formatScheduleNextRun } from "./runtime-schedule-model";
import { formatDateTime } from "./runtime-formatters";

describe("formatScheduleNextRun", () => {
  const nextRunAt = "2026-04-23T00:00:00.000Z";

  it("keeps the gap words when no time is known", () => {
    expect(formatScheduleNextRun({}, "No next run")).toBe("No next run");
  });

  it("shows a recorded time as it is and marks one worked out from the schedule", () => {
    expect(formatScheduleNextRun({ nextRunAt }, "No next run")).toBe(formatDateTime(nextRunAt));
    expect(formatScheduleNextRun({ nextRunAt, nextRunProjected: true }, "No next run")).toBe(
      `${formatDateTime(nextRunAt)} (from its schedule)`,
    );
  });
});
