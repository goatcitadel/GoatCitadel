import { describe, expect, it } from "vitest";
import type { CostSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";
import { projectUsageCostSummary } from "./OpsSavedBoardsWidgets";

function summary(overrides: Partial<CostSummaryResponse> = {}): CostSummaryResponse {
  return {
    scope: "day",
    from: "2026-08-08T00:00:00.000Z",
    to: "2026-08-09T00:00:00.000Z",
    items: [],
    ...overrides,
  };
}

describe("projectUsageCostSummary", () => {
  it("does not present an incomplete zero as exact free usage", () => {
    const projection = projectUsageCostSummary(
      summary({
        usageAvailability: {
          trackedEvents: 0,
          unknownEvents: 1,
          totalAgentEvents: 1,
          metricAvailability: {
            inputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
            outputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
            cachedInputTokens: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
            costUsd: { knownAttemptCount: 0, unknownAttemptCount: 1, complete: false },
          },
        },
        items: [{ key: "openai", tokenInput: 0, tokenOutput: 0, tokenCachedInput: 0, tokenTotal: 0, costUsd: 0 }],
      }),
    );

    expect(projection.costLabel).toBe("Unknown");
    expect(projection.coverageDescription).toContain("1 provider attempt has unknown cost");
  });

  it("labels known incomplete spend as a lower bound", () => {
    const projection = projectUsageCostSummary(
      summary({
        items: [
          {
            key: "openai",
            tokenInput: 800,
            tokenOutput: 200,
            tokenCachedInput: 0,
            tokenTotal: 1000,
            costUsd: 0.25,
            metricAvailability: {
              inputTokensComplete: true,
              outputTokensComplete: true,
              cachedInputTokensComplete: true,
              costUsdComplete: false,
            },
          },
        ],
      }),
    );

    expect(projection.costLabel).toBe("$0.25+");
    expect(projection.coverageDescription).toContain("lower bound");
  });

  it("formats exact zero only when coverage is explicitly complete", () => {
    const projection = projectUsageCostSummary(
      summary({
        items: [
          {
            key: "local",
            tokenInput: 1,
            tokenOutput: 1,
            tokenCachedInput: 0,
            tokenTotal: 2,
            costUsd: 0,
            metricAvailability: {
              inputTokensComplete: true,
              outputTokensComplete: true,
              cachedInputTokensComplete: true,
              costUsdComplete: true,
            },
          },
        ],
      }),
    );

    expect(projection.costLabel).toBe("$0.00");
    expect(projection.coverageDescription).toContain("complete cost coverage");
  });
});
