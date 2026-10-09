import { describe, expect, it } from "vitest";
import { parseSimpleCronSchedule } from "./system-cron-schedulers.js";

// The system schedulers keep a private copy of the cron parser; it must read weekdays exactly as the cron service does.
describe("system scheduler weekday parsing", () => {
  it("reads weekday ranges and lists as the days they name", () => {
    expect(parseSimpleCronSchedule("0 9 * * 1-5")?.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(parseSimpleCronSchedule("0 9 * * 1-3,5")?.weekdays).toEqual([1, 2, 3, 5]);
    expect(parseSimpleCronSchedule("0 9 * * 0,6 UTC")).toMatchObject({ weekdays: [0, 6], timeZone: "UTC" });
  });

  it("rejects weekday tokens that are not exact days or ascending ranges", () => {
    for (const weekday of ["1x", "5-1", "1-7", "1-", "-5", "1,,2", "1--5", "01x"]) {
      expect(parseSimpleCronSchedule(`0 9 * * ${weekday}`)).toBeNull();
    }
  });
});
