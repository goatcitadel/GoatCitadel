import { describe, expect, it } from "vitest";
import {
  TIME_UNAVAILABLE,
  formatAbsoluteTime,
  formatBytes,
  formatDuration,
  formatMoney,
  formatMoneyLowerBound,
  formatRelativeTime,
  formatSeconds,
  plural,
  presentTime,
} from "./format";

const NOW = Date.parse("2026-10-15T12:00:00Z");

describe("format", () => {
  it("formats relative times and falls back to the date after a week", () => {
    expect(formatRelativeTime(NOW - 20_000, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe("5 minutes ago");
    expect(formatRelativeTime(NOW + 2 * 3_600_000, NOW)).toBe("in 2 hours");
    expect(formatRelativeTime(NOW - 86_400_000, NOW)).toBe("yesterday");
    expect(formatRelativeTime("2026-09-01T00:00:00Z", NOW)).not.toMatch(/T\d\d:/);
    expect(formatRelativeTime("not a date", NOW)).toBe(TIME_UNAVAILABLE);
  });

  it("presents a time with its absolute title and machine value", () => {
    const time = presentTime("2026-10-15T11:55:00Z", NOW)!;
    expect(time.text).toBe("5 minutes ago");
    expect(time.title).toBe(formatAbsoluteTime("2026-10-15T11:55:00Z"));
    expect(time.dateTime).toBe("2026-10-15T11:55:00.000Z");
    expect(presentTime(undefined, NOW)).toBeNull();
  });

  it("formats money at two decimals without hiding unknown or tiny amounts", () => {
    expect(formatMoney(12.345)).toBe("$12.35");
    expect(formatMoney(0.000123)).toBe("<$0.01");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(undefined)).toBe("Unknown");
    expect(formatMoney(3, { atLeast: true })).toBe("at least $3.00");
    // A lower bound under a cent reads "<$0.01" like any other tiny amount (SY-N03), never "$0.0012".
    expect(formatMoney(0.0012, { atLeast: true })).toBe("under $0.01 known (some costs unknown)");
    expect(formatMoneyLowerBound(0.0026)).toBe("Under $0.01 known (some costs unknown)");
    expect(formatMoneyLowerBound(12.344)).toBe("At least $12.34");
    expect(formatMoneyLowerBound(3)).toBe("At least $3.00");
    // A lower bound rounds down, so it never claims more than was recorded.
    expect(formatMoneyLowerBound(12.346)).toBe("At least $12.34");
    expect(formatMoneyLowerBound(0.0051)).toBe("Under $0.01 known (some costs unknown)");
    expect(formatMoney(12.349, { atLeast: true })).toBe("at least $12.34");
  });

  it("formats sizes, durations and counts", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(1_234_567_890)).toBe("1.1 GB");
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(185_000)).toBe("3 min 5 s");
    expect(formatSeconds(3600)).toBe("1 h");
    expect(formatSeconds(7 * 86_400)).toBe("7 days");
    expect(plural(1, "update")).toBe("1 update");
    expect(plural(1204, "request")).toBe("1,204 requests");
    expect(plural(2, "entry", "entries")).toBe("2 entries");
  });
});
