import type {
  CapabilityTrendSeries,
  PromptPackAutoScoreRecord,
  PromptPackDimensionScoreV2,
  PromptPackDimensionScoreV3,
  PromptPackRunRecord,
  PromptPackScoreRecord,
} from "@goatcitadel/contracts";

export function formatPromptPackMetadataValues(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "none";
}

export function pickReplayBaselineScore(
  scoresDescending: PromptPackScoreRecord[],
  currentScore: PromptPackScoreRecord,
  baselineRef?: string,
): PromptPackScoreRecord | undefined {
  if (!baselineRef) {
    return scoresDescending.find((score) => score.runId !== currentScore.runId);
  }
  const baselineAt = Date.parse(baselineRef);
  return scoresDescending.find(
    (score) => score.runId !== currentScore.runId && Date.parse(score.createdAt) <= baselineAt,
  );
}

export function computePromptPackRunLatencyDelta(
  currentRun?: PromptPackRunRecord,
  baselineRun?: PromptPackRunRecord,
): number {
  const currentLatency = computePromptPackRunLatency(currentRun);
  const baselineLatency = computePromptPackRunLatency(baselineRun);
  if (currentLatency === undefined || baselineLatency === undefined) {
    return 0;
  }
  return currentLatency - baselineLatency;
}

export function buildPromptPackCapabilitySeries(
  scores: PromptPackScoreRecord[],
  capability: "routing" | "honesty" | "handoff" | "robustness" | "usability",
): CapabilityTrendSeries["points"] {
  const points: CapabilityTrendSeries["points"] = [];
  let total = 0;
  let count = 0;
  for (const score of scores) {
    const value =
      capability === "routing"
        ? score.routingScore
        : capability === "honesty"
          ? score.honestyScore
          : capability === "handoff"
            ? score.handoffScore
            : capability === "robustness"
              ? score.robustnessScore
              : score.usabilityScore;
    total += value;
    count += 1;
    points.push({
      timestamp: score.createdAt,
      value: Number((total / count).toFixed(4)),
    });
  }
  return points;
}

export function buildPromptPackCapabilitySeriesV2(
  scores: PromptPackAutoScoreRecord[],
  capability: Exclude<CapabilityTrendSeries["capability"], "run_failure_rate" | "review_rate">,
): CapabilityTrendSeries["points"] {
  const points: CapabilityTrendSeries["points"] = [];
  let total = 0;
  let count = 0;
  for (const score of scores) {
    const value = readPromptPackTrendScore(score, capability);
    if (value === undefined) {
      continue;
    }
    total += (value / 4) * 100;
    count += 1;
    points.push({
      timestamp: score.createdAt,
      value: Number((total / count).toFixed(4)),
    });
  }
  return points;
}

export function buildPromptPackRunFailureRateSeries(runs: PromptPackRunRecord[]): CapabilityTrendSeries["points"] {
  const points: CapabilityTrendSeries["points"] = [];
  let total = 0;
  let failed = 0;
  for (const run of runs) {
    total += 1;
    if (run.status === "failed") {
      failed += 1;
    }
    points.push({
      timestamp: run.finishedAt ?? run.startedAt,
      value: Number((failed / total).toFixed(4)),
    });
  }
  return points;
}

export function buildPromptPackReviewRateSeries(scores: PromptPackAutoScoreRecord[]): CapabilityTrendSeries["points"] {
  const points: CapabilityTrendSeries["points"] = [];
  let total = 0;
  let reviewCount = 0;
  for (const score of scores) {
    total += 1;
    if (score.autoVerdict === "review") {
      reviewCount += 1;
    }
    points.push({
      timestamp: score.createdAt,
      value: Number((reviewCount / total).toFixed(4)),
    });
  }
  return points;
}

export function evaluatePromptPackTrendThreshold(
  capability: CapabilityTrendSeries["capability"],
  threshold: number,
  points: CapabilityTrendSeries["points"],
): boolean | undefined {
  const latest = points.at(-1);
  if (!latest) {
    return undefined;
  }
  return capability === "run_failure_rate" ? latest.value > threshold : latest.value < threshold;
}

function computePromptPackRunLatency(run?: PromptPackRunRecord): number | undefined {
  if (!run?.finishedAt) {
    return undefined;
  }
  const startedAt = Date.parse(run.startedAt);
  const finishedAt = Date.parse(run.finishedAt);
  if (Number.isNaN(startedAt) || Number.isNaN(finishedAt)) {
    return undefined;
  }
  return Math.max(0, finishedAt - startedAt);
}

function readPromptPackTrendScore(
  score: PromptPackAutoScoreRecord,
  capability: Exclude<CapabilityTrendSeries["capability"], "run_failure_rate" | "review_rate">,
): PromptPackDimensionScoreV2 | PromptPackDimensionScoreV3 | undefined {
  if (score.scoringSchemaVersion === "v2") {
    return score.finalScores[capability];
  }
  switch (capability) {
    case "taskSuccess":
      return score.finalScores.taskSuccess;
    case "honesty":
      return score.finalScores.truthfulness;
    case "executionQuality":
      return score.finalScores.toolUseQuality ?? score.finalScores.orchestrationQuality;
    case "robustness":
      return score.finalScores.recoveryQuality;
    case "usability":
      return score.finalScores.operatorUsefulness;
  }
}
