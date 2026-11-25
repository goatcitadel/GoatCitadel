import { describe, expect, it } from "vitest";
import { fixedRetryDelayMs } from "./approval-resolution-effects-service.js";

describe("fixed approval-effect retry delays", () => {
  it("keeps the fixed delay while the wait is young", () => {
    expect(fixedRetryDelayMs(2_000, 1)).toBe(2_000);
    expect(fixedRetryDelayMs(2_000, 30)).toBe(2_000);
    expect(fixedRetryDelayMs(250, 30)).toBe(250);
  });

  it("doubles after the free attempts and never exceeds the cap", () => {
    expect(fixedRetryDelayMs(2_000, 31)).toBe(4_000);
    expect(fixedRetryDelayMs(2_000, 32)).toBe(8_000);
    expect(fixedRetryDelayMs(2_000, 33)).toBe(15_000);
    expect(fixedRetryDelayMs(2_000, 10_000)).toBe(15_000);
    expect(fixedRetryDelayMs(250, 31)).toBe(500);
  });

  it("never shortens a delay that is already above the cap", () => {
    expect(fixedRetryDelayMs(60_000, 100)).toBe(60_000);
  });
});
