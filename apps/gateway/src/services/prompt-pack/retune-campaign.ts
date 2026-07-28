import type {
  PromptRetuneMetrics,
  PromptRetuneNoiseFloor,
  PromptRetunePassRecord,
  PromptRetuneSuccessBar,
} from "@goatcitadel/contracts";

export function defaultPromptRetuneSuccessBar(): PromptRetuneSuccessBar {
  return {
    minWeightedScoreDelta: 0,
    requirePassRateNonRegression: true,
    maxFailureRateDelta: 0,
    minAverageWeightedScore: 80,
    minPassRate: 1,
    maxFailureRate: 0,
  };
}

export function calculatePromptRetuneNoiseFloor(metrics: PromptRetuneMetrics[]): PromptRetuneNoiseFloor {
  return {
    weightedScore: maxPairwiseDelta(metrics.map((item) => item.averageWeightedScore)),
    passRate: maxPairwiseDelta(metrics.map((item) => item.passRate)),
    failureRate: maxPairwiseDelta(metrics.map((item) => item.failureRate)),
    latencyMs: maxPairwiseDelta(metrics.map((item) => item.averageLatencyMs)),
  };
}

export function averagePromptRetuneMetrics(metrics: PromptRetuneMetrics[]): PromptRetuneMetrics {
  const count = Math.max(1, metrics.length);
  return {
    averageWeightedScore: metrics.reduce((sum, item) => sum + item.averageWeightedScore, 0) / count,
    passRate: metrics.reduce((sum, item) => sum + item.passRate, 0) / count,
    failureRate: metrics.reduce((sum, item) => sum + item.failureRate, 0) / count,
    averageLatencyMs: metrics.reduce((sum, item) => sum + item.averageLatencyMs, 0) / count,
  };
}

export function evaluatePromptRetuneCandidate(input: {
  baseline: PromptRetuneMetrics;
  candidate: PromptRetuneMetrics;
  noiseFloor: PromptRetuneNoiseFloor;
  successBar: PromptRetuneSuccessBar;
}): NonNullable<PromptRetunePassRecord["eligibility"]> {
  const weightedDelta = input.candidate.averageWeightedScore - input.baseline.averageWeightedScore;
  const requiredWeightedDelta = Math.max(input.noiseFloor.weightedScore, input.successBar.minWeightedScoreDelta);
  const passRateDelta = input.candidate.passRate - input.baseline.passRate;
  const failureRateDelta = input.candidate.failureRate - input.baseline.failureRate;
  const latencyDelta = input.candidate.averageLatencyMs - input.baseline.averageLatencyMs;

  if (
    (input.successBar.minAverageWeightedScore !== undefined &&
      input.candidate.averageWeightedScore < input.successBar.minAverageWeightedScore) ||
    (input.successBar.minPassRate !== undefined && input.candidate.passRate < input.successBar.minPassRate) ||
    (input.successBar.maxFailureRate !== undefined && input.candidate.failureRate > input.successBar.maxFailureRate) ||
    (input.successBar.maxAverageLatencyMs !== undefined &&
      input.candidate.averageLatencyMs > input.successBar.maxAverageLatencyMs) ||
    (input.successBar.requirePassRateNonRegression && passRateDelta < -input.noiseFloor.passRate) ||
    failureRateDelta > input.successBar.maxFailureRateDelta + input.noiseFloor.failureRate ||
    (input.successBar.maxLatencyDeltaMs !== undefined &&
      latencyDelta > input.successBar.maxLatencyDeltaMs + input.noiseFloor.latencyMs)
  ) {
    return "regressed";
  }
  return weightedDelta > requiredWeightedDelta ? "eligible" : "inconclusive";
}

function maxPairwiseDelta(values: number[]): number {
  let max = 0;
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      max = Math.max(max, Math.abs((values[left] ?? 0) - (values[right] ?? 0)));
    }
  }
  return max;
}
