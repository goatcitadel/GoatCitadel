import { describe, expect, it } from "vitest";
import {
  buildScheduleExpression,
  clampNumber,
  describeScheduleExpression,
  endDateToIso,
  parseScheduleExpression,
  slugifyJobId,
  toDateInputValue,
  toTimeInputValue,
  type CronScheduleDraft,
} from "./CronPage";

describe("CronPage schedule helpers", () => {
  it("normalizes operator-entered job names into stable IDs", () => {
    expect(slugifyJobId("  Nightly Runtime Review!!  ")).toBe("nightly-runtime-review");
    expect(slugifyJobId("A".repeat(80))).toHaveLength(64);
    expect(slugifyJobId("%%%")).toBe("");
  });

  it("parses hourly, daily, and weekly cron expressions into form drafts", () => {
    expect(parseScheduleExpression("15 * * * * UTC")).toMatchObject({
      frequency: "hourly",
      intervalHours: 1,
      minute: 15,
      timeZone: "UTC",
    });
    expect(parseScheduleExpression("5 */8 * * * America/New_York")).toMatchObject({
      frequency: "hourly",
      intervalHours: 8,
      minute: 5,
      timeZone: "America/New_York",
    });
    expect(parseScheduleExpression("30 9 * * * Europe/London", "2026-05-14T18:00:00.000Z")).toMatchObject({
      frequency: "daily",
      hour: 9,
      minute: 30,
      endDate: "2026-05-14",
    });
    expect(parseScheduleExpression("45 6 * * 5,1 UTC")).toMatchObject({
      frequency: "weekly",
      hour: 6,
      minute: 45,
      weekdays: [1, 5],
    });
  });

  it("clamps invalid schedule tokens back into safe defaults", () => {
    const draft = parseScheduleExpression("99 */99 * * 99 UTC");

    expect(draft.minute).toBe(59);
    expect(draft.intervalHours).toBe(23);
    expect(parseScheduleExpression("bad bad * * bad UTC")).toMatchObject({
      minute: 0,
      hour: 2,
      weekdays: [1],
    });
  });

  it("builds cron expressions from form drafts", () => {
    const baseDraft: CronScheduleDraft = {
      frequency: "daily",
      intervalHours: 6,
      hour: 2,
      minute: 0,
      weekdays: [1],
      timeZone: "UTC",
      endDate: "",
    };

    expect(buildScheduleExpression(baseDraft)).toBe("0 2 * * * UTC");
    expect(buildScheduleExpression({ ...baseDraft, frequency: "hourly", intervalHours: 1, minute: 20 })).toBe(
      "20 * * * * UTC",
    );
    expect(buildScheduleExpression({ ...baseDraft, frequency: "hourly", intervalHours: 4 })).toBe("0 */4 * * * UTC");
    expect(buildScheduleExpression({ ...baseDraft, frequency: "weekly", weekdays: [] })).toBe("0 2 * * 1 UTC");
    expect(buildScheduleExpression({ ...baseDraft, frequency: "weekly", weekdays: [0, 6] })).toBe("0 2 * * 0,6 UTC");
  });

  it("formats schedule summaries and date/time fields for the UI", () => {
    expect(describeScheduleExpression("20 * * * * UTC")).toBe("Every hour at 20 past the hour (UTC)");
    expect(describeScheduleExpression("20 */4 * * * UTC")).toBe("Every 4 hours at 20 past the hour (UTC)");
    expect(describeScheduleExpression("30 9 * * * UTC", "2026-05-14T18:00:00.000Z")).toBe(
      "Every day at 09:30 (UTC) until 2026-05-14",
    );
    expect(describeScheduleExpression("45 6 * * 1,5 UTC")).toBe("Monday, Friday at 06:45 (UTC)");
    expect(toTimeInputValue(3, 7)).toBe("03:07");
    expect(toDateInputValue("2026-05-14T18:00:00.000Z")).toBe("2026-05-14");
    expect(endDateToIso("2026-05-14")).toBe(new Date("2026-05-14T23:59:59").toISOString());
    expect(clampNumber("11", 0, 10, 3)).toBe(10);
    expect(clampNumber("bad", 0, 10, 3)).toBe(3);
  });
});
