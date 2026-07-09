import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ChatSessionPrefsRecord } from "@goatcitadel/contracts";
import { executeOrchestrationPlan } from "./engine.js";
import { buildOrchestrationPerformanceReport } from "./performance-gates.js";
import type { OrchestrationPlan, OrchestrationTaskInput } from "./types.js";

describe("orchestration performance gates", () => {
  it("fails closed when no runtime samples are present", () => {
    const report = buildOrchestrationPerformanceReport({
      samples: [],
      qualityGates: [],
      generatedAt: "2026-07-09T00:00:00.000Z",
    });

    expect(report.passed).toBe(false);
    expect(report.thresholdFailures).toContain("at least one performance sample is required");
  });

  it("fails closed on invalid sample timing and counters", () => {
    const report = buildOrchestrationPerformanceReport({
      samples: [
        {
          sampleId: "invalid-sample",
          startedAt: "not-a-date",
          finishedAt: "2026-07-09T00:00:00.000Z",
          costUsd: Number.NaN,
          retryCount: -1,
          waitCount: Number.POSITIVE_INFINITY,
          duplicateDispatchCount: -1,
        },
        {
          sampleId: "backwards-sample",
          startedAt: "2026-07-09T00:00:01.000Z",
          finishedAt: "2026-07-09T00:00:00.000Z",
        },
      ],
      qualityGates: [],
      generatedAt: "2026-07-09T00:00:00.000Z",
    });

    expect(report.passed).toBe(false);
    expect(report.thresholdFailures).toEqual(
      expect.arrayContaining([
        "sample invalid-sample has invalid timestamps",
        "sample invalid-sample has invalid costUsd",
        "sample invalid-sample has invalid retryCount",
        "sample invalid-sample has invalid waitCount",
        "sample invalid-sample has invalid duplicateDispatchCount",
        "sample backwards-sample finished before it started",
      ]),
    );
    expect(Object.values(report.latencyMs).every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(report.totalCostUsd)).toBe(true);
  });

  it("reports latency percentiles, cost, retries, waits, and duplicate dispatch failures", () => {
    const report = buildOrchestrationPerformanceReport({
      generatedAt: "2026-06-17T00:00:00.000Z",
      thresholds: {
        maxP95LatencyMs: 250,
        maxP99LatencyMs: 250,
        maxDuplicateDispatches: 0,
        maxRetries: 0,
        maxWaits: 0,
        maxCostUsd: 0.01,
      },
      samples: [
        {
          sampleId: "phase-1",
          startedAt: "2026-06-17T00:00:00.000Z",
          finishedAt: "2026-06-17T00:00:00.100Z",
          costUsd: 0.002,
        },
        {
          sampleId: "phase-2",
          startedAt: "2026-06-17T00:00:01.000Z",
          finishedAt: "2026-06-17T00:00:01.300Z",
          retryCount: 1,
          waitCount: 1,
          duplicateDispatchCount: 1,
          costUsd: 0.009,
        },
      ],
      qualityGates: [
        {
          gateId: "synthesis-quality",
          category: "synthesis",
          passed: false,
          score: 0.4,
          details: "final synthesis fell back to partial output",
        },
      ],
    });

    expect(report.latencyMs).toEqual({ total: 400, p50: 100, p95: 300, p99: 300, max: 300 });
    expect(report.totalCostUsd).toBe(0.011);
    expect(report.thresholdFailures).toEqual([
      "p95 latency 300ms exceeded 250ms",
      "p99 latency 300ms exceeded 250ms",
      "duplicate dispatches 1 exceeded 0",
      "retries 1 exceeded 0",
      "waits 1 exceeded 0",
      "cost 0.011 exceeded 0.01",
      "synthesis-quality failed: final synthesis fell back to partial output",
    ]);
    expect(report.passed).toBe(false);
  });

  it("passes a fake-provider orchestration smoke gate with clean synthesis output", async () => {
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(createCompletion("Plan the work in two clear steps."))
      .mockResolvedValueOnce(createCompletion("Execute the work with concrete details."))
      .mockResolvedValueOnce(createCompletion("Review found no blocking issues."))
      .mockResolvedValueOnce(createCompletion("Final recommendation with plan, execution, and review."));

    const result = await executeOrchestrationPlan({
      task: createTask(),
      plan: createPlan(),
      callbacks: { createChatCompletion },
      concurrency: 2,
    });
    const samples = result.stepResults.map((step) => ({
      sampleId: step.stepId,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt ?? step.startedAt,
      costUsd: 0.001,
      retryCount: 0,
      waitCount: step.waitStatus ? 1 : 0,
      duplicateDispatchCount: 0,
    }));
    const report = buildOrchestrationPerformanceReport({
      samples,
      qualityGates: [
        {
          gateId: "routing-quality",
          category: "routing",
          passed: result.routeDecision.selectedProviders.length === result.stepResults.length,
          score: 1,
          details: "route selected one provider record for each step",
        },
        {
          gateId: "synthesis-quality",
          category: "synthesis",
          passed: result.finalOutput.includes("Final recommendation") && !result.integritySignals?.length,
          score: 1,
          details: "final synthesis completed without fallback integrity signals",
        },
        {
          gateId: "recovery-quality",
          category: "recovery",
          passed: samples.every((sample) => sample.duplicateDispatchCount === 0),
          score: 1,
          details: "fake-provider run recorded no duplicate dispatches",
        },
      ],
      generatedAt: "2026-06-17T00:00:03.000Z",
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(4);
    expect(result.finalOutput).toContain("Final recommendation");
    expect(report.thresholdFailures).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

function createCompletion(text: string): ChatCompletionResponse {
  return {
    model: "fake-fast-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
      },
    ],
  } as ChatCompletionResponse;
}

function createPrefs(): ChatSessionPrefsRecord {
  return {
    sessionId: "session-1",
    mode: "cowork",
    planningMode: "off",
    providerId: undefined,
    model: undefined,
    webMode: "auto",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    visionFallbackModel: undefined,
    orchestrationEnabled: true,
    orchestrationIntensity: "balanced",
    orchestrationVisibility: "explicit",
    orchestrationProviderPreference: "speed",
    orchestrationReviewDepth: "standard",
    orchestrationParallelism: "sequential",
    codeAutoApply: "off",
    proactiveMode: "off",
    autonomyBudget: undefined,
    retrievalMode: "standard",
    reflectionMode: "off",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
  };
}

function createTask(): OrchestrationTaskInput {
  return {
    sessionId: "session-1",
    workspaceId: "default",
    mode: "cowork",
    objective: "Plan, execute, review, and synthesize a launch recommendation.",
    prefs: createPrefs(),
    conversation: [],
    historyMessages: [],
  };
}

function createPlan(): OrchestrationPlan {
  return {
    workflowTemplate: "cowork.plan.work.synthesize",
    summary: "Plan, execute, review, synthesize.",
    source: "workflow_template",
    routeDecision: {
      modePolicy: "cowork",
      workflowTemplate: "cowork.plan.work.synthesize",
      hidden: false,
      visibility: "explicit",
      intensity: "balanced",
      providerPreference: "speed",
      reviewDepth: "standard",
      parallelism: "sequential",
      selectedRoles: ["Planner", "Worker", "Reviewer", "Synthesis"],
      selectedProviders: [
        { role: "Planner", providerId: "fake", model: "fake-fast-model" },
        { role: "Worker", providerId: "fake", model: "fake-fast-model" },
        { role: "Reviewer", providerId: "fake", model: "fake-fast-model" },
        { role: "Synthesis", providerId: "fake", model: "fake-fast-model" },
      ],
      triggerReason: "cowork_explicit_orchestration",
    },
    steps: [
      createStep("step-1", 0, "planner", "Planner", 1),
      createStep("step-2", 1, "worker", "Worker", 2),
      createStep("step-3", 2, "reviewer", "Reviewer", 3),
      createStep("step-4", 3, "synthesizer", "Synthesis", 4),
    ],
  };
}

function createStep(
  stepId: string,
  index: number,
  role: OrchestrationPlan["steps"][number]["role"],
  label: string,
  stage: number,
): OrchestrationPlan["steps"][number] {
  return {
    stepId,
    index,
    role,
    label,
    stage,
    objective: `${label} objective.`,
    parallelizable: false,
    providerId: "fake",
    model: "fake-fast-model",
    dependsOnStepIds: index === 0 ? [] : [`step-${index}`],
  };
}
