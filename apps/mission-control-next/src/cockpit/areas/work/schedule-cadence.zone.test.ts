import { expect, it } from "vitest";
import { defaultScheduleExpression, formatInZone, nextGuidedRun, scheduleZoneOptions } from "./schedule-cadence";

it("WK-02: defaults a new schedule to the browser timezone, with no suffix for UTC", () => {
  expect(defaultScheduleExpression("Europe/Paris")).toBe("0 9 * * * Europe/Paris");
  expect(defaultScheduleExpression("UTC")).toBe("0 9 * * *");
  expect(defaultScheduleExpression("Etc/UTC")).toBe("0 9 * * *");
});

it("WK-02: computes the next guided run on the wall clock of the chosen zone", () => {
  // 2026-10-16 is a Friday. 06:00 UTC is 08:00 in Paris (CEST, UTC+2).
  const now = new Date("2026-10-16T06:00:00.000Z");
  expect(nextGuidedRun("daily", "09:00", "Europe/Paris", now)?.toISOString()).toBe("2026-10-16T07:00:00.000Z");
  expect(nextGuidedRun("daily", "09:00", "UTC", now)?.toISOString()).toBe("2026-10-16T09:00:00.000Z");
  expect(nextGuidedRun("daily", "07:30", "UTC", now)?.toISOString()).toBe("2026-10-16T07:30:00.000Z");
  expect(nextGuidedRun("daily", "05:00", "UTC", now)?.toISOString()).toBe("2026-10-17T05:00:00.000Z");
  // Weekdays skip Saturday and Sunday.
  const friday = new Date("2026-10-16T12:00:00.000Z");
  expect(nextGuidedRun("weekdays", "09:00", "UTC", friday)?.toISOString()).toBe("2026-10-19T09:00:00.000Z");
  // After Paris leaves summer time on 25 Oct, 09:00 is 08:00 UTC.
  const sunday = new Date("2026-10-25T12:00:00.000Z");
  expect(nextGuidedRun("daily", "09:00", "Europe/Paris", sunday)?.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  expect(nextGuidedRun("hourly", null, "UTC", now)).toBeNull();
  expect(formatInZone(new Date("2026-10-16T07:00:00.000Z"), "Europe/Paris")).toContain("09:00");
});

it("skips a daily wall time that does not exist during the spring transition", () => {
  const now = new Date("2026-03-08T05:00:00.000Z");
  const next = nextGuidedRun("daily", "02:30", "America/New_York", now);
  expect(next?.toISOString()).toBe("2026-03-09T06:30:00.000Z");
});

it("still previews the first occurrence of a repeated fall-back wall time", () => {
  const now = new Date("2026-11-01T04:00:00.000Z");
  expect(nextGuidedRun("daily", "01:30", "America/New_York", now)?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
});

it("previews the remaining fall-back occurrence for a new daily schedule", () => {
  const now = new Date("2026-11-01T06:00:00.000Z");
  expect(nextGuidedRun("daily", "01:30", "America/New_York", now)?.toISOString()).toBe("2026-11-01T06:30:00.000Z");
});

it("selects the next occurrence through a half-hour fall-back transition", () => {
  const zone = "Australia/Lord_Howe";
  const beforeBoth = new Date("2026-04-04T14:30:00.000Z");
  const between = new Date("2026-04-04T15:00:00.000Z");
  expect(nextGuidedRun("daily", "01:45", zone, beforeBoth)?.toISOString()).toBe("2026-04-04T14:45:00.000Z");
  expect(nextGuidedRun("daily", "01:45", zone, between)?.toISOString()).toBe("2026-04-04T15:15:00.000Z");
});

it("offers the chosen zone, the browser zone and UTC first, without duplicates", () => {
  const options = scheduleZoneOptions("Europe/Paris", "America/New_York");
  expect(options.slice(0, 3)).toEqual(["Europe/Paris", "America/New_York", "UTC"]);
  expect(new Set(options).size).toBe(options.length);
});
