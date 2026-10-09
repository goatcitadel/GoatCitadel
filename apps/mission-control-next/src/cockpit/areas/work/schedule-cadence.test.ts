import { expect, it } from "vitest";
import { buildScheduleExpression, scheduleCadence, scheduleTiming, scheduleTimezoneSummary } from "./schedule-cadence";
it("labels every schedule with the zone the Gateway actually uses", () => {
  expect(scheduleCadence("0 0 * * * UTC")).toBe("Every day at 00:00 UTC");
  expect(scheduleCadence("0 9 * * * America/Los_Angeles")).toBe("Every day at 09:00 America/Los_Angeles");
  // No suffix: the Gateway evaluates the expression in UTC (cron-automation-service: timeZone ?? "UTC").
  expect(scheduleCadence("0 9 * * *")).toBe("Every day at 09:00 UTC");
  expect(scheduleCadence("0 * * * *")).toBe("Every hour UTC");
  expect(scheduleTimezoneSummary("0 0 * * * UTC")).toContain("Runs in UTC");
  expect(scheduleTimezoneSummary("0 9 * * * America/Los_Angeles")).toContain("Runs in America/Los_Angeles");
  expect(scheduleTimezoneSummary("0 0 * * *")).toBe(
    "Runs in UTC (the Gateway default when the expression names no timezone).",
  );
  expect(scheduleTimezoneSummary("0 0 * * * Unrecognized/Zone")).toContain("not recognized");
  expect(scheduleCadence("0 0 * * * Unrecognized/Zone")).toBe("Custom schedule: 0 0 * * * Unrecognized/Zone");
});

it("projects guided timing from a saved expression and keeps an explicit timezone", () => {
  expect(scheduleTiming("30 7 * * 1-5")).toEqual({ cadence: "weekdays", time: "07:30", zone: null });
  expect(scheduleTiming("0 9 * * * Europe/Paris")).toEqual({ cadence: "daily", time: "09:00", zone: "Europe/Paris" });
  expect(scheduleTiming("0 * * * *")).toEqual({ cadence: "hourly", time: null, zone: null });
  expect(scheduleTiming("*/5 * * * *")).toEqual({ cadence: "custom", time: null, zone: null });
  expect(scheduleTiming("0 25 * * *")).toEqual({ cadence: "custom", time: null, zone: null });
});

it("builds an expression from guided timing without dropping the timezone", () => {
  expect(buildScheduleExpression("weekdays", "07:30", null)).toBe("30 7 * * 1-5");
  expect(buildScheduleExpression("daily", "09:00", "Europe/Paris")).toBe("0 9 * * * Europe/Paris");
  expect(buildScheduleExpression("hourly", null, "UTC")).toBe("0 * * * * UTC");
  expect(buildScheduleExpression("daily", null, null)).toBe("0 9 * * *");
});
