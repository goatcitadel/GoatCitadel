import { describe, expect, it } from "vitest";
import { parsePerformanceBenchmarkCliArgs, runOrchestrationPerformanceBenchmark } from "./performance-benchmark.js";

describe("orchestration performance benchmark", () => {
  it("runs warmups plus five measured serial/parallel pairs through the real engine", async () => {
    const report = await runOrchestrationPerformanceBenchmark({
      fakeProviderDelayMs: 8,
    });

    expect(report.config).toMatchObject({
      warmupIterations: 1,
      measuredPairIterations: 5,
      retryMeasuredIterations: 1,
      fakeProviderDelayMs: 8,
    });
    expect(report.scenarios.map((scenario) => [scenario.scenarioId, scenario.measuredRuns.length])).toEqual([
      ["serial-fanout-synthesis", 5],
      ["parallel-fanout-synthesis", 5],
      ["provider-retry-synthesis", 1],
    ]);
    expect(report.comparisons.serialVsParallel.pairedRuns).toHaveLength(5);
    expect(report.comparisons.serialVsParallel.parallelMedianEndToEndMs).toBeLessThan(
      report.comparisons.serialVsParallel.serialMedianEndToEndMs,
    );
    expect(report.aggregate.measuredRunCount).toBe(11);
    expect(report.performanceGate.sampleCount).toBe(11);
    expect(report.performanceGate.passed).toBe(true);
    expect(report.passed).toBe(true);
  });

  it("reports honest observability boundaries and provider retry evidence", async () => {
    const report = await runOrchestrationPerformanceBenchmark({
      fakeProviderDelayMs: 8,
    });
    const serial = report.scenarios[0]?.measuredRuns[0];
    const parallel = report.scenarios[1]?.measuredRuns[0];
    const retry = report.scenarios[2]?.measuredRuns[0];

    expect(serial).toMatchObject({
      dispatchCount: 4,
      duplicateDispatchCount: 0,
      retryCount: 0,
      maxConcurrentProviderCalls: 1,
      orchestrationEligible: true,
      planSource: "workflow_template",
      workflowTemplate: "cowork.research.synthesize.critic",
      routeTriggerReason: "chat_hidden_review",
      plannedStepCount: 4,
    });
    expect(parallel).toMatchObject({
      dispatchCount: 4,
      duplicateDispatchCount: 0,
      retryCount: 0,
      maxConcurrentProviderCalls: 2,
    });
    expect(retry).toMatchObject({
      dispatchCount: 4,
      providerAttemptCount: 5,
      retryCount: 1,
      duplicateDispatchCount: 0,
      waitCount: 0,
      retryEvidence: {
        source: "llm_completion_service",
        transientFailureDiagnosticCount: 1,
        firstFailure: "request failed (503 Service Unavailable)",
      },
    });
    expect(retry?.finalOutput).toContain("Final synthesis complete");
    expect(retry?.routingPlanningLatency).toMatchObject({ observable: true, valueMs: expect.any(Number) });
    expect(retry?.timeToFirstToken).toMatchObject({ observable: false, valueMs: null });
    expect(retry?.databaseOperations).toBe(0);
    expect(retry?.childProcesses).toMatchObject({ observable: false, count: null });
    expect(retry?.serializedContextSizeBytes).toBeGreaterThan(0);
  });

  it("parses the optional output path and rejects incomplete arguments", () => {
    expect(parsePerformanceBenchmarkCliArgs([])).toEqual({});
    expect(parsePerformanceBenchmarkCliArgs(["--output", "artifacts/perf.json"])).toEqual({
      outputPath: "artifacts/perf.json",
    });
    expect(parsePerformanceBenchmarkCliArgs(["--output=artifacts/perf.json"])).toEqual({
      outputPath: "artifacts/perf.json",
    });
    expect(() => parsePerformanceBenchmarkCliArgs(["--output"])).toThrow(/requires a path/i);
    expect(() => parsePerformanceBenchmarkCliArgs(["--unknown"])).toThrow(/unknown argument/i);
  });
});
