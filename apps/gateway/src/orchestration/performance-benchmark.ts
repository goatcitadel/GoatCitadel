import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatSessionPrefsRecord,
  LlmRuntimeConfig,
} from "@goatcitadel/contracts";
import { executeOrchestrationPlan } from "./engine.js";
import {
  buildOrchestrationPerformanceReport,
  type OrchestrationPerformanceReport,
  type OrchestrationPerformanceSample,
  type OrchestrationQualityGateResult,
} from "./performance-gates.js";
import { buildProviderCapabilityRegistry } from "./providers/capability-registry.js";
import { buildOrchestrationPlan, resolveModePolicy, shouldUseModeOrchestration } from "./router.js";
import type { OrchestrationRouterInput, OrchestrationTaskInput } from "./types.js";
import {
  createChatCompletion as createServiceChatCompletion,
  type LlmCompletionHost,
} from "../services/llm-completion-service.js";

const WARMUP_ITERATIONS = 1;
const MEASURED_PAIR_ITERATIONS = 5;
const RETRY_MEASURED_ITERATIONS = 1;
const DEFAULT_FAKE_PROVIDER_DELAY_MS = 12;
const FAKE_PROVIDER_ATTEMPT_COST_USD = 0.0001;

type BenchmarkScenarioId = "serial-fanout-synthesis" | "parallel-fanout-synthesis" | "provider-retry-synthesis";

interface UnobservableDuration {
  observable: false;
  valueMs: null;
  reason: string;
}

interface ObservableDuration {
  observable: true;
  valueMs: number;
}

interface ActiveHandleEvidence {
  observable: boolean;
  before: number | null;
  after: number | null;
  delta: number | null;
  reason?: string;
}

interface ChildProcessEvidence {
  observable: false;
  count: null;
  reason: string;
}

interface RetryEvidence {
  source: "none" | "llm_completion_service";
  transientFailureDiagnosticCount: number;
  firstFailure?: string;
}

type CompletionDiagnostic = Parameters<LlmCompletionHost["recordDevDiagnostic"]>[0];

export interface OrchestrationBenchmarkRun {
  sampleId: string;
  scenarioId: BenchmarkScenarioId;
  iteration: number;
  startedAt: string;
  finishedAt: string;
  routingPlanningLatency: ObservableDuration;
  timeToFirstToken: UnobservableDuration;
  firstProviderCompletionLatencyMs: number;
  endToEndLatencyMs: number;
  fanOutCriticalPathMs: number;
  synthesisLatencyMs: number;
  retryCount: number;
  retryEvidence: RetryEvidence;
  waitCount: number;
  waitTimeMs: number;
  dispatchCount: number;
  providerAttemptCount: number;
  duplicateDispatchCount: number;
  simulatedCostUsd: number;
  databaseOperations: number;
  serializedContextSizeBytes: number;
  heapGrowthBytes: number;
  heapPeakGrowthBytes: number;
  activeHandles: ActiveHandleEvidence;
  childProcesses: ChildProcessEvidence;
  maxConcurrentProviderCalls: number;
  orchestrationEligible: boolean;
  planSource: "planner" | "workflow_template" | "planner_with_template_fallback";
  workflowTemplate: string;
  routeTriggerReason: string;
  plannedStepCount: number;
  completedStepCount: number;
  selectedProviderCount: number;
  finalOutput: string;
  integritySignals: string[];
}

export interface OrchestrationBenchmarkScenario {
  scenarioId: BenchmarkScenarioId;
  description: string;
  warmupRuns: number;
  measuredRuns: OrchestrationBenchmarkRun[];
  summary: {
    firstProviderCompletionLatencyMs: PercentileSummary;
    endToEndLatencyMs: PercentileSummary;
    fanOutCriticalPathMs: PercentileSummary;
    synthesisLatencyMs: PercentileSummary;
    totalRetries: number;
    totalWaits: number;
    totalWaitTimeMs: number;
    totalDispatches: number;
    totalProviderAttempts: number;
    totalDuplicateDispatches: number;
    totalSimulatedCostUsd: number;
    totalDatabaseOperations: number;
    totalSerializedContextSizeBytes: number;
    heapGrowthBytes: SignedSummary;
    maxHeapPeakGrowthBytes: number;
    activeHandles: ActiveHandleSummary;
    maxConcurrentProviderCalls: number;
  };
}

interface PercentileSummary {
  p50: number;
  p95: number;
  max: number;
}

interface SignedSummary {
  p50: number;
  min: number;
  max: number;
}

interface ActiveHandleSummary {
  observableRuns: number;
  maxDelta: number | null;
}

export interface OrchestrationPerformanceBenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  config: {
    warmupIterations: number;
    measuredPairIterations: number;
    retryMeasuredIterations: number;
    fakeProviderDelayMs: number;
    fakeProviderAttemptCostUsd: number;
  };
  scenarios: OrchestrationBenchmarkScenario[];
  comparisons: {
    serialVsParallel: {
      pairedRuns: Array<{
        iteration: number;
        serialEndToEndMs: number;
        parallelEndToEndMs: number;
        speedupRatio: number;
      }>;
      serialMedianEndToEndMs: number;
      parallelMedianEndToEndMs: number;
      medianSpeedupRatio: number;
    };
  };
  aggregate: {
    measuredRunCount: number;
    firstProviderCompletionLatencyMs: PercentileSummary;
    endToEndLatencyMs: PercentileSummary;
    fanOutCriticalPathMs: PercentileSummary;
    synthesisLatencyMs: PercentileSummary;
    totalRetries: number;
    totalWaits: number;
    totalWaitTimeMs: number;
    totalDispatches: number;
    totalProviderAttempts: number;
    totalDuplicateDispatches: number;
    totalSimulatedCostUsd: number;
    totalDatabaseOperations: number;
    totalSerializedContextSizeBytes: number;
    heapGrowthBytes: SignedSummary;
    maxHeapPeakGrowthBytes: number;
    activeHandles: ActiveHandleSummary;
    routingPlanningLatencyMs: PercentileSummary;
    timeToFirstToken: UnobservableDuration;
    childProcesses: ChildProcessEvidence;
  };
  performanceGate: OrchestrationPerformanceReport;
  passed: boolean;
}

export interface PerformanceBenchmarkCliArgs {
  outputPath?: string;
}

export function parsePerformanceBenchmarkCliArgs(args: string[]): PerformanceBenchmarkCliArgs {
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a path.");
      }
      outputPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      outputPath = argument.slice("--output=".length);
      if (!outputPath) {
        throw new Error("--output requires a path.");
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return outputPath ? { outputPath } : {};
}

export async function runOrchestrationPerformanceBenchmark(options?: {
  fakeProviderDelayMs?: number;
}): Promise<OrchestrationPerformanceBenchmarkReport> {
  const fakeProviderDelayMs = validateDelay(options?.fakeProviderDelayMs ?? DEFAULT_FAKE_PROVIDER_DELAY_MS);
  const serialWarmups: OrchestrationBenchmarkRun[] = [];
  const parallelWarmups: OrchestrationBenchmarkRun[] = [];
  for (let iteration = 1; iteration <= WARMUP_ITERATIONS; iteration += 1) {
    serialWarmups.push(await runScenario("serial-fanout-synthesis", iteration, fakeProviderDelayMs));
    parallelWarmups.push(await runScenario("parallel-fanout-synthesis", iteration, fakeProviderDelayMs));
  }

  const serialRuns: OrchestrationBenchmarkRun[] = [];
  const parallelRuns: OrchestrationBenchmarkRun[] = [];
  for (let iteration = 1; iteration <= MEASURED_PAIR_ITERATIONS; iteration += 1) {
    if (iteration % 2 === 0) {
      parallelRuns.push(await runScenario("parallel-fanout-synthesis", iteration, fakeProviderDelayMs));
      serialRuns.push(await runScenario("serial-fanout-synthesis", iteration, fakeProviderDelayMs));
    } else {
      serialRuns.push(await runScenario("serial-fanout-synthesis", iteration, fakeProviderDelayMs));
      parallelRuns.push(await runScenario("parallel-fanout-synthesis", iteration, fakeProviderDelayMs));
    }
  }

  for (let iteration = 1; iteration <= WARMUP_ITERATIONS; iteration += 1) {
    await runScenario("provider-retry-synthesis", iteration, fakeProviderDelayMs);
  }
  const retryRuns: OrchestrationBenchmarkRun[] = [];
  for (let iteration = 1; iteration <= RETRY_MEASURED_ITERATIONS; iteration += 1) {
    retryRuns.push(await runScenario("provider-retry-synthesis", iteration, fakeProviderDelayMs));
  }

  const scenarios = [
    buildScenario(
      "serial-fanout-synthesis",
      "Two independent fake-provider branches execute serially before real engine synthesis.",
      serialWarmups.length,
      serialRuns,
    ),
    buildScenario(
      "parallel-fanout-synthesis",
      "The same branches execute concurrently before the real engine fan-in and synthesis stage.",
      parallelWarmups.length,
      parallelRuns,
    ),
    buildScenario(
      "provider-retry-synthesis",
      "The production LLM completion service retries one transient fake-provider 503 while engine dispatch remains single-shot.",
      WARMUP_ITERATIONS,
      retryRuns,
    ),
  ];
  const allRuns = scenarios.flatMap((scenario) => scenario.measuredRuns);
  const serialVsParallel = buildPairedComparison(serialRuns, parallelRuns);
  const qualityGates = buildQualityGates(allRuns, serialVsParallel);
  const generatedAt = new Date().toISOString();
  const performanceGate = buildOrchestrationPerformanceReport({
    samples: allRuns.map(toPerformanceSample),
    qualityGates,
    generatedAt,
  });
  const handleDeltas = allRuns.map((run) => run.activeHandles.delta).filter((value): value is number => value !== null);

  return {
    schemaVersion: 1,
    generatedAt,
    config: {
      warmupIterations: WARMUP_ITERATIONS,
      measuredPairIterations: MEASURED_PAIR_ITERATIONS,
      retryMeasuredIterations: RETRY_MEASURED_ITERATIONS,
      fakeProviderDelayMs,
      fakeProviderAttemptCostUsd: FAKE_PROVIDER_ATTEMPT_COST_USD,
    },
    scenarios,
    comparisons: { serialVsParallel },
    aggregate: {
      measuredRunCount: allRuns.length,
      firstProviderCompletionLatencyMs: summarize(allRuns.map((run) => run.firstProviderCompletionLatencyMs)),
      endToEndLatencyMs: summarize(allRuns.map((run) => run.endToEndLatencyMs)),
      fanOutCriticalPathMs: summarize(allRuns.map((run) => run.fanOutCriticalPathMs)),
      synthesisLatencyMs: summarize(allRuns.map((run) => run.synthesisLatencyMs)),
      totalRetries: sum(allRuns.map((run) => run.retryCount)),
      totalWaits: sum(allRuns.map((run) => run.waitCount)),
      totalWaitTimeMs: sum(allRuns.map((run) => run.waitTimeMs)),
      totalDispatches: sum(allRuns.map((run) => run.dispatchCount)),
      totalProviderAttempts: sum(allRuns.map((run) => run.providerAttemptCount)),
      totalDuplicateDispatches: sum(allRuns.map((run) => run.duplicateDispatchCount)),
      totalSimulatedCostUsd: round(sum(allRuns.map((run) => run.simulatedCostUsd)), 6),
      totalDatabaseOperations: sum(allRuns.map((run) => run.databaseOperations)),
      totalSerializedContextSizeBytes: sum(allRuns.map((run) => run.serializedContextSizeBytes)),
      heapGrowthBytes: summarizeSigned(allRuns.map((run) => run.heapGrowthBytes)),
      maxHeapPeakGrowthBytes: Math.max(...allRuns.map((run) => run.heapPeakGrowthBytes), 0),
      activeHandles: {
        observableRuns: handleDeltas.length,
        maxDelta: handleDeltas.length > 0 ? Math.max(...handleDeltas) : null,
      },
      routingPlanningLatencyMs: summarize(allRuns.map((run) => run.routingPlanningLatency.valueMs)),
      timeToFirstToken: unobservableTimeToFirstToken(),
      childProcesses: unobservableChildProcesses(),
    },
    performanceGate,
    passed: performanceGate.passed,
  };
}

async function runScenario(
  scenarioId: BenchmarkScenarioId,
  iteration: number,
  fakeProviderDelayMs: number,
): Promise<OrchestrationBenchmarkRun> {
  const concurrency = scenarioId === "parallel-fanout-synthesis" ? 2 : 1;
  const injectRetry = scenarioId === "provider-retry-synthesis";
  const startEpochMs = Date.now();
  const startMark = performance.now();
  const heapBefore = process.memoryUsage().heapUsed;
  let heapPeak = heapBefore;
  const handlesBefore = readActiveHandleCount();
  let activeProviderCalls = 0;
  let maxConcurrentProviderCalls = 0;
  let dispatchCount = 0;
  let providerAttemptCount = 0;
  let firstCompletionMark: number | undefined;
  let serializedContextSizeBytes = 0;
  let researcherDispatchCount = 0;
  const calls: Array<{ logicalStep: string; startedAt: number; finishedAt: number }> = [];
  const task = createTask(scenarioId);
  const routerInput = createRouterInput(task);
  const routingStartMark = performance.now();
  const orchestrationEligible = shouldUseModeOrchestration(routerInput);
  const plan = buildOrchestrationPlan(routerInput);
  const routingPlanningLatencyMs = performance.now() - routingStartMark;
  if (!orchestrationEligible) {
    throw new Error("Deterministic benchmark objective did not select orchestration.");
  }
  const retryHarness = injectRetry ? createTransientRetryHarness(fakeProviderDelayMs) : undefined;

  const createChatCompletion = async (request: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
    const role = classifyLogicalStepRole(request);
    const logicalStep = role === "researcher" ? (researcherDispatchCount++ === 0 ? "branch-one" : "branch-two") : role;
    const callStart = performance.now();
    dispatchCount += 1;
    activeProviderCalls += 1;
    maxConcurrentProviderCalls = Math.max(maxConcurrentProviderCalls, activeProviderCalls);
    serializedContextSizeBytes += Buffer.byteLength(JSON.stringify(request.messages), "utf8");
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    let response: ChatCompletionResponse;
    if (retryHarness) {
      response = await createServiceChatCompletion(retryHarness.host, request);
    } else {
      providerAttemptCount += 1;
      await delay(fakeProviderDelayMs);
      response = createFakeCompletion(logicalStep);
    }
    const callEnd = performance.now();
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    calls.push({ logicalStep, startedAt: callStart, finishedAt: callEnd });
    firstCompletionMark ??= callEnd;
    activeProviderCalls -= 1;
    return response;
  };

  const result = await executeOrchestrationPlan({
    task,
    plan,
    callbacks: { createChatCompletion },
    concurrency,
  });
  const endMark = performance.now();
  const endToEndLatencyMs = endMark - startMark;
  const finishedAt = new Date(startEpochMs + Math.max(0, Math.round(endToEndLatencyMs))).toISOString();
  const heapAfter = process.memoryUsage().heapUsed;
  heapPeak = Math.max(heapPeak, heapAfter);
  const handlesAfter = readActiveHandleCount();
  const branchCalls = calls.filter((call) => call.logicalStep.startsWith("branch-"));
  const synthesisCall = calls.find((call) => call.logicalStep === "synthesis");
  const transientFailureDiagnostics = retryHarness?.readTransientFailureDiagnostics() ?? [];
  const observedProviderAttemptCount = retryHarness?.readProviderAttemptCount() ?? providerAttemptCount;
  const retryCount = transientFailureDiagnostics.length;
  const retryEvidence: RetryEvidence = retryHarness
    ? {
        source: "llm_completion_service",
        transientFailureDiagnosticCount: transientFailureDiagnostics.length,
        firstFailure: transientFailureDiagnostics[0]?.runtimeError?.message,
      }
    : { source: "none", transientFailureDiagnosticCount: 0 };

  return {
    sampleId: `${scenarioId}-${iteration}`,
    scenarioId,
    iteration,
    startedAt: new Date(startEpochMs).toISOString(),
    finishedAt,
    routingPlanningLatency: { observable: true, valueMs: round(routingPlanningLatencyMs, 6) },
    timeToFirstToken: unobservableTimeToFirstToken(),
    firstProviderCompletionLatencyMs: round((firstCompletionMark ?? endMark) - startMark),
    endToEndLatencyMs: round(endToEndLatencyMs),
    fanOutCriticalPathMs: round(readCriticalPath(branchCalls)),
    synthesisLatencyMs: round(synthesisCall ? synthesisCall.finishedAt - synthesisCall.startedAt : 0),
    retryCount,
    retryEvidence,
    waitCount: result.stepResults.filter((step) => Boolean(step.waitStatus)).length,
    waitTimeMs: 0,
    dispatchCount,
    providerAttemptCount: observedProviderAttemptCount,
    duplicateDispatchCount: Math.max(0, dispatchCount - plan.steps.length),
    simulatedCostUsd: round(observedProviderAttemptCount * FAKE_PROVIDER_ATTEMPT_COST_USD, 6),
    databaseOperations: 0,
    serializedContextSizeBytes,
    heapGrowthBytes: heapAfter - heapBefore,
    heapPeakGrowthBytes: Math.max(0, heapPeak - heapBefore),
    activeHandles: buildActiveHandleEvidence(handlesBefore, handlesAfter),
    childProcesses: unobservableChildProcesses(),
    maxConcurrentProviderCalls,
    orchestrationEligible,
    planSource: plan.source,
    workflowTemplate: plan.workflowTemplate,
    routeTriggerReason: plan.routeDecision.triggerReason,
    plannedStepCount: plan.steps.length,
    completedStepCount: result.stepResults.filter((step) => step.status === "completed").length,
    selectedProviderCount: result.routeDecision.selectedProviders.length,
    finalOutput: result.finalOutput,
    integritySignals: result.integritySignals ?? [],
  };
}

function buildScenario(
  scenarioId: BenchmarkScenarioId,
  description: string,
  warmupRuns: number,
  measuredRuns: OrchestrationBenchmarkRun[],
): OrchestrationBenchmarkScenario {
  return {
    scenarioId,
    description,
    warmupRuns,
    measuredRuns,
    summary: {
      firstProviderCompletionLatencyMs: summarize(measuredRuns.map((run) => run.firstProviderCompletionLatencyMs)),
      endToEndLatencyMs: summarize(measuredRuns.map((run) => run.endToEndLatencyMs)),
      fanOutCriticalPathMs: summarize(measuredRuns.map((run) => run.fanOutCriticalPathMs)),
      synthesisLatencyMs: summarize(measuredRuns.map((run) => run.synthesisLatencyMs)),
      totalRetries: sum(measuredRuns.map((run) => run.retryCount)),
      totalWaits: sum(measuredRuns.map((run) => run.waitCount)),
      totalWaitTimeMs: sum(measuredRuns.map((run) => run.waitTimeMs)),
      totalDispatches: sum(measuredRuns.map((run) => run.dispatchCount)),
      totalProviderAttempts: sum(measuredRuns.map((run) => run.providerAttemptCount)),
      totalDuplicateDispatches: sum(measuredRuns.map((run) => run.duplicateDispatchCount)),
      totalSimulatedCostUsd: round(sum(measuredRuns.map((run) => run.simulatedCostUsd)), 6),
      totalDatabaseOperations: sum(measuredRuns.map((run) => run.databaseOperations)),
      totalSerializedContextSizeBytes: sum(measuredRuns.map((run) => run.serializedContextSizeBytes)),
      heapGrowthBytes: summarizeSigned(measuredRuns.map((run) => run.heapGrowthBytes)),
      maxHeapPeakGrowthBytes: Math.max(...measuredRuns.map((run) => run.heapPeakGrowthBytes), 0),
      activeHandles: summarizeActiveHandles(measuredRuns),
      maxConcurrentProviderCalls: Math.max(...measuredRuns.map((run) => run.maxConcurrentProviderCalls), 0),
    },
  };
}

function buildPairedComparison(serialRuns: OrchestrationBenchmarkRun[], parallelRuns: OrchestrationBenchmarkRun[]) {
  const pairedRuns = serialRuns.map((serial, index) => {
    const parallel = parallelRuns[index] as OrchestrationBenchmarkRun;
    return {
      iteration: serial.iteration,
      serialEndToEndMs: serial.endToEndLatencyMs,
      parallelEndToEndMs: parallel.endToEndLatencyMs,
      speedupRatio: round(serial.endToEndLatencyMs / Math.max(parallel.endToEndLatencyMs, 0.001)),
    };
  });
  return {
    pairedRuns,
    serialMedianEndToEndMs: percentile(
      serialRuns.map((run) => run.endToEndLatencyMs),
      0.5,
    ),
    parallelMedianEndToEndMs: percentile(
      parallelRuns.map((run) => run.endToEndLatencyMs),
      0.5,
    ),
    medianSpeedupRatio: percentile(
      pairedRuns.map((pair) => pair.speedupRatio),
      0.5,
    ),
  };
}

function buildQualityGates(
  runs: OrchestrationBenchmarkRun[],
  comparison: ReturnType<typeof buildPairedComparison>,
): OrchestrationQualityGateResult[] {
  const routingPassed = runs.every(
    (run) =>
      run.orchestrationEligible &&
      run.planSource === "workflow_template" &&
      run.completedStepCount === run.plannedStepCount &&
      run.selectedProviderCount === run.plannedStepCount,
  );
  const synthesisPassed = runs.every(
    (run) => run.finalOutput.includes("Final synthesis complete") && run.integritySignals.length === 0,
  );
  const retryRuns = runs.filter((run) => run.scenarioId === "provider-retry-synthesis");
  const recoveryPassed =
    runs.every((run) => run.duplicateDispatchCount === 0 && run.waitCount === 0) &&
    retryRuns.every((run) => run.retryCount === 1 && run.providerAttemptCount === run.plannedStepCount + 1);
  const latencyPassed = comparison.parallelMedianEndToEndMs < comparison.serialMedianEndToEndMs;
  return [
    {
      gateId: "runtime-routing-quality",
      category: "routing",
      passed: routingPassed,
      score: routingPassed ? 1 : 0,
      details: "Each real engine run completed all planned steps with one selected provider per step.",
    },
    {
      gateId: "runtime-synthesis-quality",
      category: "synthesis",
      passed: synthesisPassed,
      score: synthesisPassed ? 1 : 0,
      details: "Each real engine run produced the deterministic final synthesis without integrity fallback.",
    },
    {
      gateId: "runtime-recovery-quality",
      category: "recovery",
      passed: recoveryPassed,
      score: recoveryPassed ? 1 : 0,
      details:
        "The production LLM completion service recovered one retryable fake-provider 503 without engine redispatch, waits, or duplicate dispatches.",
    },
    {
      gateId: "paired-parallel-latency",
      category: "latency",
      passed: latencyPassed,
      score: latencyPassed ? 1 : 0,
      details: `Parallel median ${comparison.parallelMedianEndToEndMs}ms; serial median ${comparison.serialMedianEndToEndMs}ms.`,
    },
  ];
}

function toPerformanceSample(run: OrchestrationBenchmarkRun): OrchestrationPerformanceSample {
  return {
    sampleId: run.sampleId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    costUsd: run.simulatedCostUsd,
    retryCount: run.retryCount,
    waitCount: run.waitCount,
    duplicateDispatchCount: run.duplicateDispatchCount,
  };
}

function createTask(scenarioId: BenchmarkScenarioId): OrchestrationTaskInput {
  return {
    sessionId: `benchmark-${scenarioId}`,
    workspaceId: "benchmark",
    mode: "chat",
    objective:
      "Compare two deterministic orchestration approaches, analyze their tradeoffs, critique the evidence, and synthesize a recommendation.",
    prefs: createPrefs(`benchmark-${scenarioId}`),
    conversation: [],
    historyMessages: [],
  };
}

function createRouterInput(task: OrchestrationTaskInput): OrchestrationRouterInput {
  const runtime = createRuntime();
  return {
    task,
    runtime,
    capabilities: buildProviderCapabilityRegistry(runtime),
    policy: resolveModePolicy(task.mode),
  };
}

function createRuntime(): LlmRuntimeConfig {
  return {
    activeProviderId: "openai",
    activeModel: "fake-benchmark-model",
    providers: [
      {
        providerId: "openai",
        label: "Fake OpenAI benchmark provider",
        baseUrl: "http://127.0.0.1/benchmark/openai",
        apiStyle: "openai-chat-completions",
        defaultModel: "fake-benchmark-model",
        hasApiKey: true,
        apiKeySource: "env",
      },
      {
        providerId: "anthropic",
        label: "Fake Anthropic benchmark provider",
        baseUrl: "http://127.0.0.1/benchmark/anthropic",
        apiStyle: "openai-chat-completions",
        defaultModel: "fake-benchmark-model",
        hasApiKey: true,
        apiKeySource: "env",
      },
    ],
  };
}

function createTransientRetryHarness(fakeProviderDelayMs: number): {
  host: LlmCompletionHost;
  readProviderAttemptCount: () => number;
  readTransientFailureDiagnostics: () => CompletionDiagnostic[];
} {
  const runtime = createRuntime();
  const diagnostics: CompletionDiagnostic[] = [];
  let providerAttemptCount = 0;
  const host = {
    config: {
      assistant: {
        memory: {
          enabled: false,
          qmd: { enabled: false, applyToChat: false },
        },
      },
    },
    memoryLifecycleService: {
      composeContext: async () => undefined,
    },
    hooksService: {
      runInlineHooks: async () => ({ runs: [] }),
      enqueueAfterHooks: () => undefined,
      hasMutateHook: () => false,
    },
    llmService: {
      chatCompletions: async (request: ChatCompletionRequest) => {
        providerAttemptCount += 1;
        const shouldFail = providerAttemptCount === 1;
        await delay(fakeProviderDelayMs);
        if (shouldFail) {
          throw new Error("request failed (503 Service Unavailable)");
        }
        return createFakeCompletion(classifyLogicalStepRole(request));
      },
      chatCompletionsStream: () => {
        throw new Error("Streaming is outside the non-streaming orchestration benchmark.");
      },
      getRuntimeConfig: () => runtime,
      resolveExecutionApiStyle: () => "openai-chat-completions",
    },
    resolveMemoryWorkspaceRelativeDir: () => "benchmark",
    resolveChatCompletionHookWorkspaceId: () => "benchmark",
    persistContextManifestForCompletionRequest: () => undefined,
    resolveFallbackTargets: () => [],
    recordDevDiagnostic: (diagnostic: CompletionDiagnostic) => {
      diagnostics.push(diagnostic);
    },
    publishRealtime: () => undefined,
  } as unknown as LlmCompletionHost;

  return {
    host,
    readProviderAttemptCount: () => providerAttemptCount,
    readTransientFailureDiagnostics: () =>
      diagnostics.filter(
        (diagnostic) =>
          diagnostic.event === "chat.completion.attempt_failed" && diagnostic.runtimeError?.retryable === true,
      ),
  };
}

function createPrefs(sessionId: string): ChatSessionPrefsRecord {
  return {
    sessionId,
    mode: "chat",
    planningMode: "off",
    providerId: undefined,
    model: undefined,
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    visionFallbackModel: undefined,
    orchestrationEnabled: true,
    orchestrationIntensity: "balanced",
    orchestrationVisibility: "explicit",
    orchestrationProviderPreference: "speed",
    orchestrationReviewDepth: "standard",
    orchestrationParallelism: "parallel",
    codeAutoApply: "manual",
    proactiveMode: "off",
    autonomyBudget: undefined,
    retrievalMode: "standard",
    reflectionMode: "off",
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

function classifyLogicalStepRole(request: ChatCompletionRequest): "researcher" | "critic" | "synthesis" {
  const systemPrompt = JSON.stringify(request.messages[0]?.content ?? "");
  if (systemPrompt.includes("final Chat synthesizer")) {
    return "synthesis";
  }
  if (systemPrompt.includes("Act as a critic")) {
    return "critic";
  }
  return "researcher";
}

function createFakeCompletion(logicalStep: string): ChatCompletionResponse {
  const content =
    logicalStep === "synthesis"
      ? "Final synthesis complete with both deterministic branch handoffs."
      : `${logicalStep} deterministic evidence complete.`;
  return {
    model: "fake-benchmark-model",
    choices: [{ index: 0, message: { role: "assistant", content } }],
  } as ChatCompletionResponse;
}

function readCriticalPath(calls: Array<{ startedAt: number; finishedAt: number }>): number {
  if (calls.length === 0) {
    return 0;
  }
  return Math.max(...calls.map((call) => call.finishedAt)) - Math.min(...calls.map((call) => call.startedAt));
}

function summarize(values: number[]): PercentileSummary {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: round(Math.max(...values, 0)),
  };
}

function summarizeSigned(values: number[]): SignedSummary {
  if (values.length === 0) {
    return { p50: 0, min: 0, max: 0 };
  }
  return {
    p50: percentile(values, 0.5),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function summarizeActiveHandles(runs: OrchestrationBenchmarkRun[]): ActiveHandleSummary {
  const deltas = runs.map((run) => run.activeHandles.delta).filter((value): value is number => value !== null);
  return {
    observableRuns: deltas.length,
    maxDelta: deltas.length > 0 ? Math.max(...deltas) : null,
  };
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return round(sorted[index] ?? 0);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, precision = 3): number {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

function validateDelay(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 1_000) {
    throw new Error("fakeProviderDelayMs must be a finite number between 1 and 1000.");
  }
  return value;
}

function readActiveHandleCount(): number | null {
  const runtimeProcess = process as NodeJS.Process & { _getActiveHandles?: () => unknown[] };
  return typeof runtimeProcess._getActiveHandles === "function" ? runtimeProcess._getActiveHandles().length : null;
}

function buildActiveHandleEvidence(before: number | null, after: number | null): ActiveHandleEvidence {
  if (before === null || after === null) {
    return {
      observable: false,
      before,
      after,
      delta: null,
      reason: "This Node runtime does not expose active-handle inspection.",
    };
  }
  return { observable: true, before, after, delta: after - before };
}

function unobservableTimeToFirstToken(): UnobservableDuration {
  return {
    observable: false,
    valueMs: null,
    reason: "executeOrchestrationPlan uses non-streaming completion callbacks; first-token timing is not observable.",
  };
}

function unobservableChildProcesses(): ChildProcessEvidence {
  return {
    observable: false,
    count: null,
    reason: "The in-process orchestration engine does not expose child-process telemetry.",
  };
}
