import { describe, expect, it } from "vitest";
import {
  clearRegisteredTokenEstimators,
  estimateTokens,
  estimateTokensFromText,
  registerTokenEstimator,
  truncateByTokenEstimate,
} from "./token-estimator.js";

describe("token estimator", () => {
  it("uses a registered exact estimator when available", () => {
    clearRegisteredTokenEstimators();
    registerTokenEstimator({
      name: "test-exact",
      estimate: (input) => input.split(/\s+/).filter(Boolean).length,
    });

    const result = estimateTokens("alpha beta gamma");
    expect(result.mode).toBe("exact");
    expect(result.estimator).toBe("test-exact");
    expect(result.count).toBe(3);

    clearRegisteredTokenEstimators();
  });

  it("skips undefined and non-finite plugin estimates before accepting zero", () => {
    clearRegisteredTokenEstimators();
    registerTokenEstimator({ name: "zero", estimate: () => 0 });
    registerTokenEstimator({ name: "nan", estimate: () => Number.NaN });
    registerTokenEstimator({ name: "undefined", estimate: () => undefined });

    expect(estimateTokens("billable but cached")).toEqual({
      count: 0,
      mode: "exact",
      estimator: "zero",
    });

    clearRegisteredTokenEstimators();
  });

  it("falls back to heuristic counting for prose, code, urls, and mixed structured text", () => {
    expect(estimateTokensFromText("short plain sentence")).toBeGreaterThan(0);
    expect(
      estimateTokensFromText("const filePath = 'F:/code/personal-ai/apps/gateway/src/services/gateway-service.ts';"),
    ).toBeGreaterThan(8);
    expect(estimateTokensFromText("https://example.com/a/really/long/path?with=query&and=value")).toBeGreaterThan(8);
    expect(estimateTokensFromText('{"url":"https://example.com","count":12,"items":["a","b"]}')).toBeGreaterThan(8);
    expect(estimateTokensFromText("alpha🙂beta")).toBe(4);
  });

  it("truncates using the shared estimator budget instead of a fixed char ratio", () => {
    const input = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const truncated = truncateByTokenEstimate(input, 6);
    expect(truncated).toContain("[truncated]");
    expect(estimateTokensFromText(truncated)).toBeLessThanOrEqual(6);
  });
});
