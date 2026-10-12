import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COST_REPORT_HOURLY_CADENCE,
  MEMORY_CONSOLIDATION_WEEKLY_CADENCE,
  MEMORY_FLUSH_DAILY_CADENCE,
  PRIVATE_BETA_BACKUP_CADENCE,
  UPDATE_REVIEW_DAILY_CADENCE,
  resolveSystemCronTimeZone,
  systemCronScheduleLabel,
  systemCronTimeZoneForSchedule,
} from "./cron-job-schedule-labels.js";
import { parseSimpleCronSchedule } from "./gateway/cron-automation-service.js";

/** Simulates the zone the gateway host reports (what Node derives from `TZ`). */
function reportHostTimeZone(timeZone: string | undefined): void {
  const actual = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...actual.call(this), timeZone } as Intl.ResolvedDateTimeFormatOptions;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("system cron timezone", () => {
  it("seeds every built-in cadence in the host timezone instead of a fixed Pacific zone", () => {
    reportHostTimeZone("UTC");

    const labels = [
      PRIVATE_BETA_BACKUP_CADENCE,
      MEMORY_FLUSH_DAILY_CADENCE,
      MEMORY_CONSOLIDATION_WEEKLY_CADENCE,
      COST_REPORT_HOURLY_CADENCE,
      UPDATE_REVIEW_DAILY_CADENCE,
    ].map((cadence) => systemCronScheduleLabel(cadence));

    expect(labels).toEqual(["30 2 * * * UTC", "0 3 * * * UTC", "30 2 * * 0 UTC", "0 * * * * UTC", "15 4 * * * UTC"]);
    for (const label of labels) {
      expect(parseSimpleCronSchedule(label)).toMatchObject({ timeZone: "UTC" });
    }
  });

  it("follows whatever IANA zone the host reports", () => {
    reportHostTimeZone("Europe/Berlin");

    expect(resolveSystemCronTimeZone()).toBe("Europe/Berlin");
    expect(systemCronScheduleLabel(MEMORY_FLUSH_DAILY_CADENCE)).toBe("0 3 * * * Europe/Berlin");
  });

  it.each([undefined, "", "Etc/Unknown", "Not/AZone"])("falls back to UTC when the host reports %j", (zone) => {
    reportHostTimeZone(zone);

    expect(resolveSystemCronTimeZone()).toBe("UTC");
  });

  it("falls back to UTC when the host timezone lookup throws", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(() => {
      throw new RangeError("ICU timezone data unavailable");
    });

    expect(resolveSystemCronTimeZone()).toBe("UTC");
  });

  it("gates a job in the zone its persisted schedule names, not the current host zone", () => {
    reportHostTimeZone("UTC");

    expect(systemCronTimeZoneForSchedule("30 2 * * * America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(systemCronTimeZoneForSchedule("  0 2 * * 0   Asia/Tokyo  ")).toBe("Asia/Tokyo");
    expect(systemCronTimeZoneForSchedule("30 2 * * *")).toBe("UTC");
    expect(systemCronTimeZoneForSchedule("30 2 * * * Not/AZone")).toBe("UTC");
    expect(systemCronTimeZoneForSchedule(undefined)).toBe("UTC");
  });
});
