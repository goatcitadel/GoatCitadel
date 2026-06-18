import {
  buildOrchestrationPerformanceReport,
  type OrchestrationPerformanceSample,
  type OrchestrationQualityGateResult,
} from "./performance-gates.js";

const samples: OrchestrationPerformanceSample[] = [
  {
    sampleId: "fake-provider-routing",
    startedAt: "2026-06-17T00:00:00.000Z",
    finishedAt: "2026-06-17T00:00:00.180Z",
    costUsd: 0.001,
  },
  {
    sampleId: "fake-provider-recovery",
    startedAt: "2026-06-17T00:00:01.000Z",
    finishedAt: "2026-06-17T00:00:01.260Z",
    retryCount: 0,
    waitCount: 0,
    duplicateDispatchCount: 0,
    costUsd: 0.002,
  },
  {
    sampleId: "fake-provider-synthesis",
    startedAt: "2026-06-17T00:00:02.000Z",
    finishedAt: "2026-06-17T00:00:02.430Z",
    costUsd: 0.003,
  },
];

const qualityGates: OrchestrationQualityGateResult[] = [
  {
    gateId: "routing-quality",
    category: "routing",
    passed: true,
    score: 1,
    details: "Fake-provider scenario keeps required orchestration route evidence present.",
  },
  {
    gateId: "recovery-quality",
    category: "recovery",
    passed: true,
    score: 1,
    details: "Scenario records zero duplicate dispatches, waits, and retries.",
  },
  {
    gateId: "synthesis-quality",
    category: "synthesis",
    passed: true,
    score: 1,
    details: "Scenario produces a final synthesis quality signal without fallback failures.",
  },
];

const report = buildOrchestrationPerformanceReport({
  samples,
  qualityGates,
  generatedAt: "2026-06-17T00:00:03.000Z",
});

console.log(JSON.stringify(report, null, 2));

if (!report.passed) {
  process.exitCode = 1;
}
