import { describe, expect, it } from "vitest";
import { calculatePromptRetuneNoiseFloor, evaluatePromptRetuneCandidate } from "./retune-campaign.js";

describe("prompt retune campaign metrics", () => {
  const baseline = { averageWeightedScore: 80, passRate: 0.8, failureRate: 0.1, averageLatencyMs: 100 };

  it("uses the largest pairwise A/A variation as each noise floor", () => {
    const noise = calculatePromptRetuneNoiseFloor([
      baseline,
      { averageWeightedScore: 82, passRate: 0.75, failureRate: 0.15, averageLatencyMs: 130 },
      { averageWeightedScore: 79, passRate: 0.85, failureRate: 0.05, averageLatencyMs: 90 },
    ]);
    expect(noise.weightedScore).toBe(3);
    expect(noise.passRate).toBeCloseTo(0.1);
    expect(noise.failureRate).toBeCloseTo(0.1);
    expect(noise.latencyMs).toBe(40);
  });

  it("requires score improvement to strictly exceed noise and rejects guardrail regressions", () => {
    const noiseFloor = { weightedScore: 2, passRate: 0.02, failureRate: 0.01, latencyMs: 10 };
    const successBar = {
      minWeightedScoreDelta: 1,
      requirePassRateNonRegression: true,
      maxFailureRateDelta: 0,
      maxLatencyDeltaMs: 25,
    };
    expect(
      evaluatePromptRetuneCandidate({
        baseline,
        candidate: { ...baseline, averageWeightedScore: 82 },
        noiseFloor,
        successBar,
      }),
    ).toBe("inconclusive");
    expect(
      evaluatePromptRetuneCandidate({
        baseline,
        candidate: { ...baseline, averageWeightedScore: 82.01 },
        noiseFloor,
        successBar,
      }),
    ).toBe("eligible");
    expect(
      evaluatePromptRetuneCandidate({
        baseline,
        candidate: { ...baseline, averageWeightedScore: 85, passRate: 0.7 },
        noiseFloor,
        successBar,
      }),
    ).toBe("regressed");
  });
});
