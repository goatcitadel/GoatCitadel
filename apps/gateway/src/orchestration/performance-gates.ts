export interface OrchestrationPerformanceSample {
  sampleId: string;
  startedAt: string;
  finishedAt: string;
  costUsd?: number;
  retryCount?: number;
  waitCount?: number;
  duplicateDispatchCount?: number;
}

export interface OrchestrationQualityGateResult {
  gateId: string;
  category: "routing" | "recovery" | "latency" | "synthesis";
  passed: boolean;
  score: number;
  details: string;
}

export interface OrchestrationPerformanceThresholds {
  maxP95LatencyMs: number;
  maxP99LatencyMs: number;
  maxDuplicateDispatches: number;
  maxRetries: number;
  maxWaits: number;
  maxCostUsd: number;
}

export interface OrchestrationPerformanceReport {
  generatedAt: string;
  sampleCount: number;
  latencyMs: {
    total: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  totalCostUsd: number;
  totalRetries: number;
  totalWaits: number;
  duplicateDispatches: number;
  qualityGates: OrchestrationQualityGateResult[];
  thresholdFailures: string[];
  passed: boolean;
}

export const DEFAULT_ORCHESTRATION_PERFORMANCE_THRESHOLDS: OrchestrationPerformanceThresholds = {
  maxP95LatencyMs: 30_000,
  maxP99LatencyMs: 45_000,
  maxDuplicateDispatches: 0,
  maxRetries: 2,
  maxWaits: 2,
  maxCostUsd: 1,
};

export function buildOrchestrationPerformanceReport(input: {
  samples: OrchestrationPerformanceSample[];
  qualityGates: OrchestrationQualityGateResult[];
  thresholds?: Partial<OrchestrationPerformanceThresholds>;
  generatedAt?: string;
}): OrchestrationPerformanceReport {
  const thresholds = { ...DEFAULT_ORCHESTRATION_PERFORMANCE_THRESHOLDS, ...input.thresholds };
  const validationFailures: string[] = [];
  const latencies: number[] = [];
  const costs: number[] = [];
  const retries: number[] = [];
  const waits: number[] = [];
  const duplicates: number[] = [];

  if (input.samples.length === 0) {
    validationFailures.push("at least one performance sample is required");
  }
  for (const sample of input.samples) {
    const startedAt = Date.parse(sample.startedAt);
    const finishedAt = Date.parse(sample.finishedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
      validationFailures.push(`sample ${sample.sampleId} has invalid timestamps`);
    } else if (finishedAt < startedAt) {
      validationFailures.push(`sample ${sample.sampleId} finished before it started`);
    } else {
      latencies.push(finishedAt - startedAt);
    }
    costs.push(validateNonNegativeNumber(sample, "costUsd", validationFailures));
    retries.push(validateNonNegativeInteger(sample, "retryCount", validationFailures));
    waits.push(validateNonNegativeInteger(sample, "waitCount", validationFailures));
    duplicates.push(validateNonNegativeInteger(sample, "duplicateDispatchCount", validationFailures));
  }
  latencies.sort((left, right) => left - right);
  const totalCostUsd = sum(costs);
  const totalRetries = sum(retries);
  const totalWaits = sum(waits);
  const duplicateDispatches = sum(duplicates);
  const latencyMs = {
    total: sum(latencies),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    max: latencies.at(-1) ?? 0,
  };
  const thresholdFailures = [
    ...validationFailures,
    latencyMs.p95 > thresholds.maxP95LatencyMs
      ? `p95 latency ${latencyMs.p95}ms exceeded ${thresholds.maxP95LatencyMs}ms`
      : undefined,
    latencyMs.p99 > thresholds.maxP99LatencyMs
      ? `p99 latency ${latencyMs.p99}ms exceeded ${thresholds.maxP99LatencyMs}ms`
      : undefined,
    duplicateDispatches > thresholds.maxDuplicateDispatches
      ? `duplicate dispatches ${duplicateDispatches} exceeded ${thresholds.maxDuplicateDispatches}`
      : undefined,
    totalRetries > thresholds.maxRetries ? `retries ${totalRetries} exceeded ${thresholds.maxRetries}` : undefined,
    totalWaits > thresholds.maxWaits ? `waits ${totalWaits} exceeded ${thresholds.maxWaits}` : undefined,
    totalCostUsd > thresholds.maxCostUsd ? `cost ${totalCostUsd} exceeded ${thresholds.maxCostUsd}` : undefined,
    ...input.qualityGates.filter((gate) => !gate.passed).map((gate) => `${gate.gateId} failed: ${gate.details}`),
  ].filter((failure): failure is string => Boolean(failure));

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sampleCount: input.samples.length,
    latencyMs,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    totalRetries,
    totalWaits,
    duplicateDispatches,
    qualityGates: input.qualityGates,
    thresholdFailures,
    passed: thresholdFailures.length === 0,
  };
}

// Ceiling "nearest-rank" percentile over an ascending-sorted input: index = ceil(n*p) - 1
// (clamped to [0, n-1]). Not interpolated, so for even-count inputs p50 is the lower-middle
// element (e.g. p50 of [100, 300] is 100, not 200). Chosen for determinism over smoothness.
function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.ceil(values.length * percentileValue) - 1);
  return values[index] ?? 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function validateNonNegativeNumber(
  sample: OrchestrationPerformanceSample,
  field: "costUsd",
  failures: string[],
): number {
  const value = sample[field];
  if (value === undefined) {
    return 0;
  }
  if (!Number.isFinite(value) || value < 0) {
    failures.push(`sample ${sample.sampleId} has invalid ${field}`);
    return 0;
  }
  return value;
}

function validateNonNegativeInteger(
  sample: OrchestrationPerformanceSample,
  field: "retryCount" | "waitCount" | "duplicateDispatchCount",
  failures: string[],
): number {
  const value = sample[field];
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    failures.push(`sample ${sample.sampleId} has invalid ${field}`);
    return 0;
  }
  return value;
}
