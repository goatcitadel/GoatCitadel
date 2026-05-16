import { describe, it, expect } from "vitest";
import { clampSummaryReserveTokens } from "./chat-compaction.js";

describe("clampSummaryReserveTokens", () => {
  it("returns the requested value when within limit", () => {
    expect(clampSummaryReserveTokens(8000, 32000)).toEqual({
      value: 8000,
      clamped: false,
    });
  });

  it("clamps to the output token limit and surfaces a warning", () => {
    const result = clampSummaryReserveTokens(64000, 32000);
    expect(result.value).toBe(32000);
    expect(result.clamped).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("32000");
  });

  it("returns the requested value when outputTokenLimit is undefined", () => {
    expect(clampSummaryReserveTokens(64000, undefined)).toEqual({
      value: 64000,
      clamped: false,
    });
  });

  it("floors negative requests to 0 and clamps", () => {
    const result = clampSummaryReserveTokens(-5, 32000);
    expect(result.value).toBe(0);
    expect(result.clamped).toBe(true);
  });

  it("treats requested equal to limit as not clamped", () => {
    expect(clampSummaryReserveTokens(32000, 32000)).toEqual({
      value: 32000,
      clamped: false,
    });
  });
});
