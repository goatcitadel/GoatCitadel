import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const promptPackMocks = vi.hoisted(() => ({
  autoScorePromptPackBatch: vi.fn(),
  autoScorePromptPackTest: vi.fn(),
  cancelPromptPackBenchmark: vi.fn(),
  cancelPromptRetuneCampaign: vi.fn(),
  createPromptRetuneCampaign: vi.fn(),
  dispositionPromptRetunePass: vi.fn(),
  exportPromptPackReport: vi.fn(),
  fetchPromptPackBenchmark: vi.fn(),
  fetchPromptPackExport: vi.fn(),
  fetchPromptPackReplayRegressionStatus: vi.fn(),
  fetchPromptPackReport: vi.fn(),
  fetchPromptPacks: vi.fn(),
  fetchPromptPackTests: vi.fn(),
  fetchPromptPackTrends: vi.fn(),
  fetchPromptRetuneCampaign: vi.fn(),
  fetchSettings: vi.fn(),
  importPromptPack: vi.fn(),
  loadModelsForProvider: vi.fn(),
  refreshCallback: undefined as undefined | (() => Promise<void>),
  refreshFallback: undefined as undefined | ((refreshing: boolean) => void),
  resetPromptPack: vi.fn(),
  runPromptPackBenchmark: vi.fn(),
  runPromptPackReplayRegression: vi.fn(),
  runPromptPackTest: vi.fn(),
  scorePromptPackTest: vi.fn(),
  startPromptRetuneCandidate: vi.fn(),
  startPromptRetuneNoise: vi.fn(),
  providerCatalog: {
    config: { activeProviderId: "openai" },
    providers: [
      { providerId: "openai", label: "OpenAI", models: ["gpt-5", "gpt-5-mini"] },
      { providerId: "anthropic", label: "Anthropic", models: ["claude-opus-5"] },
    ],
  },
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  autoScorePromptPackBatch: promptPackMocks.autoScorePromptPackBatch,
  autoScorePromptPackTest: promptPackMocks.autoScorePromptPackTest,
  cancelPromptPackBenchmark: promptPackMocks.cancelPromptPackBenchmark,
  cancelPromptRetuneCampaign: promptPackMocks.cancelPromptRetuneCampaign,
  createPromptRetuneCampaign: promptPackMocks.createPromptRetuneCampaign,
  dispositionPromptRetunePass: promptPackMocks.dispositionPromptRetunePass,
  exportPromptPackReport: promptPackMocks.exportPromptPackReport,
  fetchPromptPackBenchmark: promptPackMocks.fetchPromptPackBenchmark,
  fetchPromptPackExport: promptPackMocks.fetchPromptPackExport,
  fetchPromptPackReplayRegressionStatus: promptPackMocks.fetchPromptPackReplayRegressionStatus,
  fetchPromptPackReport: promptPackMocks.fetchPromptPackReport,
  fetchPromptPacks: promptPackMocks.fetchPromptPacks,
  fetchPromptPackTests: promptPackMocks.fetchPromptPackTests,
  fetchPromptPackTrends: promptPackMocks.fetchPromptPackTrends,
  fetchPromptRetuneCampaign: promptPackMocks.fetchPromptRetuneCampaign,
  fetchSettings: promptPackMocks.fetchSettings,
  importPromptPack: promptPackMocks.importPromptPack,
  resetPromptPack: promptPackMocks.resetPromptPack,
  runPromptPackBenchmark: promptPackMocks.runPromptPackBenchmark,
  runPromptPackReplayRegression: promptPackMocks.runPromptPackReplayRegression,
  runPromptPackTest: promptPackMocks.runPromptPackTest,
  scorePromptPackTest: promptPackMocks.scorePromptPackTest,
  startPromptRetuneCandidate: promptPackMocks.startPromptRetuneCandidate,
  startPromptRetuneNoise: promptPackMocks.startPromptRetuneNoise,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    config: promptPackMocks.providerCatalog.config,
    providers: promptPackMocks.providerCatalog.providers,
    loadModelsForProvider: promptPackMocks.loadModelsForProvider,
  }),
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (
    _topic: string,
    callback: () => Promise<void>,
    options?: { onFallbackStateChange?: (refreshing: boolean) => void },
  ) => {
    promptPackMocks.refreshCallback = callback;
    promptPackMocks.refreshFallback = options?.onFallbackStateChange;
  },
}));

const pack = {
  packId: "pack-1",
  name: "Operator trust pack",
  testCount: 3,
  createdAt: "2026-04-22T00:00:00.000Z",
  updatedAt: "2026-04-22T00:10:00.000Z",
};

const retuneCampaign = {
  campaignId: "retune-1",
  packId: "pack-1",
  status: "draft",
  baselineContentSha256: "prompt-hash",
  policyHash: "policy-hash",
  scoringSnapshot: { schemaVersion: "v3" },
  testCodes: ["TEST-03", "TEST-06", "TEST-10", "TEST-12", "TEST-15", "TEST-28"],
  providers: [{ providerId: "openai", model: "gpt-5" }],
  executionStyle: "single_turn_harness",
  repeatCount: 3,
  maxBenchmarkRuns: 12,
  successBar: {
    minWeightedScoreDelta: 0,
    requirePassRateNonRegression: true,
    maxFailureRateDelta: 0,
  },
  passes: [],
  createdAt: "2026-04-22T00:00:00.000Z",
  updatedAt: "2026-04-22T00:00:00.000Z",
};

const tests = [
  {
    testId: "test-1",
    packId: "pack-1",
    code: "TEST-01",
    title: "Trace a local failure",
    prompt: "Review <LOCAL PATH> and cite the runtime truth.",
    orderIndex: 1,
    mode: "chat",
    diagnosticMetadata: {
      capabilityTargets: ["routing", "truth"],
      expectedRuntimeSignals: ["tool_call"],
      likelyFailureClasses: ["unsupported_access_claim"],
    },
    createdAt: "2026-04-22T00:00:00.000Z",
  },
  {
    testId: "test-2",
    packId: "pack-1",
    code: "TEST-02",
    title: "Handle failed tool output",
    prompt: "Explain the failed command.",
    orderIndex: 2,
    mode: "cowork",
    diagnosticMetadata: {
      capabilityTargets: ["handoff"],
      expectedRuntimeSignals: ["trace_update"],
      likelyFailureClasses: ["run_failed"],
    },
    createdAt: "2026-04-22T00:00:00.000Z",
  },
  {
    testId: "test-3",
    packId: "pack-1",
    code: "TEST-03",
    title: "Needs scoring",
    prompt: "Summarize the durable handoff.",
    orderIndex: 3,
    mode: "code",
    createdAt: "2026-04-22T00:00:00.000Z",
  },
] as const;

const completedRun = {
  runId: "run-1",
  packId: "pack-1",
  testId: "test-1",
  sessionId: "session-1",
  status: "completed",
  providerId: "openai",
  model: "gpt-5",
  mode: "chat",
  executionStyle: "agentic_surface",
  responseText: "The runtime path produced grounded evidence.",
  trace: {
    model: "gpt-5",
    toolRuns: [{ id: "tool-1", name: "shell", status: "completed" }],
    routing: {
      primaryProviderId: "openai",
      primaryModel: "gpt-5",
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5",
      fallbackProviderId: "anthropic",
      fallbackModel: "claude-opus-5",
      fallbackReason: "primary throttled",
      fallbackUsed: true,
    },
  },
  citations: [{ sourceId: "src-1", label: "runtime.log" }],
  integrity: {
    validationStatus: "valid",
    signals: ["complete"],
    outputTokenCount: 42,
  },
  startedAt: "2026-04-22T00:01:00.000Z",
  finishedAt: "2026-04-22T00:02:00.000Z",
};

const failedRun = {
  runId: "run-2",
  packId: "pack-1",
  testId: "test-2",
  sessionId: "session-2",
  status: "failed",
  providerId: "anthropic",
  model: "claude-opus-5",
  mode: "cowork",
  executionStyle: "single_turn_harness",
  error: "Tool failed",
  trace: { toolRuns: [] },
  integrity: { validationStatus: "invalid", signals: ["missing_output"] },
  startedAt: "2026-04-22T00:03:00.000Z",
  finishedAt: "2026-04-22T00:04:00.000Z",
};

const unscoredRun = {
  runId: "run-3",
  packId: "pack-1",
  testId: "test-3",
  sessionId: "session-3",
  status: "completed",
  providerId: "openai",
  model: "gpt-5-mini",
  mode: "code",
  executionStyle: "single_turn_harness",
  responseText: "Needs a score.",
  trace: { toolRuns: [] },
  integrity: { validationStatus: "unknown", signals: [] },
  startedAt: "2026-04-22T00:05:00.000Z",
  finishedAt: "2026-04-22T00:06:00.000Z",
};

const autoScore = {
  autoScoreId: "auto-1",
  packId: "pack-1",
  testId: "test-1",
  runId: "run-1",
  scoringSchemaVersion: "v3",
  scorerVersion: "scorer-v3",
  judgeRubricVersion: "judge-v3",
  policyHash: "hash",
  policySource: "repo_default",
  scoreState: "passed",
  protocol: { protocolPass: true, reasonCodes: [] },
  hardFailReasons: [],
  applicability: {},
  outcomeScores: {},
  executionScores: {},
  ruleScores: { taskSuccess: 4, truthfulness: 4, evidenceGrounding: 3 },
  judgeScores: { taskSuccess: 4, truthfulness: 3, evidenceGrounding: 3 },
  finalScores: {
    taskSuccess: 4,
    truthfulness: 4,
    evidenceGrounding: 3,
    formatAdherence: 4,
    operatorUsefulness: 4,
    toolUseQuality: 3,
    orchestrationQuality: 3,
    efficiency: 4,
    recoveryQuality: 4,
  },
  disagreement: { truthfulness: 1 },
  weightedScore: 88.4,
  autoVerdict: "pass",
  reviewReasons: ["minor_disagreement"],
  degradedReasons: [],
  mergeProvenance: {},
  attribution: {
    primary: "model_behavior",
    confidence: "medium",
    evidence: ["Judge found minor disagreement."],
  },
  judgeStatus: "ok",
  judgeProviderId: "openai",
  judgeModel: "gpt-5",
  createdAt: "2026-04-22T00:07:00.000Z",
};

const exportRecord = {
  packId: "pack-1",
  path: "artifacts/prompt-packs/latest.json",
  exists: true,
  sizeBytes: 1024,
  updatedAt: "2026-04-22T00:08:00.000Z",
  latestSnapshotPath: "artifacts/prompt-packs/archive/snapshot.json",
};

const benchmarkStatus = {
  run: {
    benchmarkRunId: "bench-1",
    packId: "pack-1",
    status: "running",
    testCodes: ["TEST-01"],
    providers: [{ providerId: "openai", model: "gpt-5" }],
    executionStyle: "agentic_surface",
    startedAt: "2026-04-22T00:09:00.000Z",
  },
  progress: { totalItems: 2, completedItems: 1 },
  modelSummaries: [
    {
      providerId: "openai",
      model: "gpt-5",
      total: 2,
      scored: 1,
      averageTotalScore: 8,
      averageWeightedScore: 82,
      passRate: 0.5,
      reviewRate: 0.25,
      runFailures: 0,
      degradedCount: 0,
      approvalPausedCount: 0,
      noOutputCount: 0,
      topFailureSignals: [],
    },
  ],
};

const regressionStatus = {
  run: {
    regressionRunId: "reg-1",
    packId: "pack-1",
    status: "completed",
    testCodes: ["TEST-01"],
    startedAt: "2026-04-22T00:10:00.000Z",
    finishedAt: "2026-04-22T00:11:00.000Z",
  },
  results: [
    {
      resultId: "reg-result-1",
      regressionRunId: "reg-1",
      testCode: "TEST-01",
      capability: "honesty",
      scoreDelta: -0.5,
      passDelta: 0,
      latencyDeltaMs: 120,
      createdAt: "2026-04-22T00:11:00.000Z",
    },
  ],
};

function buildReport() {
  return {
    pack,
    tests: [...tests],
    runs: [completedRun, failedRun, unscoredRun],
    scores: [],
    autoScoresV2: [autoScore],
    humanReviewsV2: [
      {
        reviewId: "review-1",
        packId: "pack-1",
        testId: "test-1",
        runId: "run-1",
        reviewerId: "operator:test",
        scores: {
          taskSuccess: 4,
          honesty: 4,
          executionQuality: 3,
          robustness: 3,
          usability: 4,
        },
        applicability: {},
        overrideVerdict: "pass",
        notes: "Looks grounded.",
        createdAt: "2026-04-22T00:12:00.000Z",
      },
    ],
    latestAssessments: [
      {
        testId: "test-1",
        runId: "run-1",
        autoScore,
        humanReview: {
          reviewId: "review-1",
          packId: "pack-1",
          testId: "test-1",
          runId: "run-1",
          reviewerId: "operator:test",
          scores: {
            taskSuccess: 4,
            honesty: 4,
            executionQuality: 3,
            robustness: 3,
            usability: 4,
          },
          applicability: {},
          overrideVerdict: "pass",
          notes: "Looks grounded.",
          createdAt: "2026-04-22T00:12:00.000Z",
        },
        currentGeneration: true,
        scoreState: "passed",
        autoVerdict: "pass",
        effectiveVerdict: "pass",
      },
    ],
    summary: {
      totalTests: 3,
      completedRuns: 2,
      failedRuns: 1,
      runFailureCount: 1,
      invalidLatestRuns: 1,
      scoreFailureCount: 0,
      needsScoreCount: 1,
      staleLatestAutoScoreCount: 0,
      durableRuns: 1,
      approvalPausedRuns: 0,
      backgroundedRuns: 0,
      judgeFallbackCount: 0,
      judgeErrorCount: 0,
      autoScoredRuns: 1,
      humanReviewedRuns: 1,
      degradedScoreCount: 0,
      passCount: 1,
      failCount: 1,
      reviewCount: 0,
      effectivePassRate: 0.33,
      reviewRate: 0,
      activeScoringSchemaVersion: "v3",
      attributionBreakdown: [{ attribution: "model_behavior", count: 1 }],
      passThreshold: 75,
      averageTotalScore: 8,
      averageWeightedScore: 82,
      passRate: 0.33,
      failingCodes: ["TEST-02"],
    },
  };
}

function setupApiSuccess() {
  promptPackMocks.fetchSettings.mockResolvedValue({
    features: { promptRetuneCampaignV1Enabled: false },
  });
  promptPackMocks.fetchPromptPacks.mockResolvedValue({
    items: [
      pack,
      {
        packId: "pack-2",
        name: "Secondary pack",
        testCount: 1,
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
  });
  promptPackMocks.fetchPromptPackTests.mockResolvedValue({ items: [...tests] });
  promptPackMocks.fetchPromptPackReport.mockImplementation(() => Promise.resolve(buildReport()));
  promptPackMocks.fetchPromptPackExport.mockResolvedValue(exportRecord);
  promptPackMocks.fetchPromptPackTrends.mockResolvedValue({
    items: [
      {
        capability: "honesty",
        points: [{ timestamp: "2026-04-22T00:00:00.000Z", value: 0.85 }],
        threshold: 0.8,
        breached: false,
      },
    ],
  });
  promptPackMocks.runPromptPackTest.mockResolvedValue({
    ...completedRun,
    runId: "run-new",
    startedAt: "2026-04-22T00:13:00.000Z",
  });
  promptPackMocks.autoScorePromptPackTest.mockResolvedValue({
    score: autoScore,
    run: completedRun,
  });
  promptPackMocks.autoScorePromptPackBatch.mockResolvedValue({
    items: [{ score: autoScore, run: completedRun }],
    skipped: 1,
  });
  promptPackMocks.exportPromptPackReport.mockResolvedValue(exportRecord);
  promptPackMocks.scorePromptPackTest.mockResolvedValue({
    reviewId: "review-new",
    packId: "pack-1",
    testId: "test-1",
    runId: "run-1",
  });
  promptPackMocks.runPromptPackBenchmark.mockResolvedValue({ benchmarkRunId: "bench-1" });
  promptPackMocks.fetchPromptPackBenchmark.mockResolvedValue(benchmarkStatus);
  promptPackMocks.cancelPromptPackBenchmark.mockResolvedValue({
    ...benchmarkStatus,
    run: {
      ...benchmarkStatus.run,
      status: "cancelled",
      finishedAt: "2026-04-22T00:14:00.000Z",
    },
  });
  promptPackMocks.runPromptPackReplayRegression.mockResolvedValue({ regressionRunId: "reg-1" });
  promptPackMocks.fetchPromptPackReplayRegressionStatus.mockResolvedValue(regressionStatus);
  promptPackMocks.createPromptRetuneCampaign.mockResolvedValue(retuneCampaign);
  promptPackMocks.fetchPromptRetuneCampaign.mockResolvedValue(retuneCampaign);
  promptPackMocks.resetPromptPack.mockResolvedValue({ deletedRuns: 3, deletedScores: 2 });
  promptPackMocks.importPromptPack.mockResolvedValue({
    pack: { ...pack, packId: "pack-imported", name: "Imported pack" },
    tests: [{ ...tests[0], testId: "test-imported", packId: "pack-imported" }],
  });
}

function installBrowser() {
  vi.stubGlobal("window", {
    location: new URL("http://localhost:5173/library/prompt-packs"),
  });
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderWorkbench(props: Record<string, unknown> = {}) {
  const { PromptPacksWorkbenchPage } = await import("./PromptPacksWorkbenchPage");
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(PromptPacksWorkbenchPage, {
        workspaceId: "workspace-1",
        variant: "library",
        navigate: vi.fn(),
        ...props,
      }),
    );
  });
  await flush();
  return renderer;
}

function readNodeText(node: ReactTestInstance | string | number | null | undefined): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node) {
    return "";
  }
  return node.children.map((child) => readNodeText(child as never)).join("");
}

function findButton(renderer: ReactTestRenderer, text: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => readNodeText(node).replace(/\s+/g, " ").includes(text));
  if (!button) {
    throw new Error(`Missing button ${text}`);
  }
  return button;
}

function findInput(renderer: ReactTestRenderer, placeholder: string) {
  const input = renderer.root.findAllByType("input").find((node) => node.props.placeholder === placeholder);
  if (!input) {
    throw new Error(`Missing input ${placeholder}`);
  }
  return input;
}

function findTextarea(renderer: ReactTestRenderer, placeholder: string) {
  const textarea = renderer.root.findAllByType("textarea").find((node) => node.props.placeholder === placeholder);
  if (!textarea) {
    throw new Error(`Missing textarea ${placeholder}`);
  }
  return textarea;
}

function findSelectContaining(renderer: ReactTestRenderer, text: string) {
  const select = renderer.root.findAllByType("select").find((node) => readNodeText(node).includes(text));
  if (!select) {
    throw new Error(`Missing select containing ${text}`);
  }
  return select;
}

async function click(button: ReactTestInstance) {
  await act(async () => {
    button.props.onClick();
  });
  await flush();
}

async function change(node: ReactTestInstance, value: string, checked?: boolean) {
  await act(async () => {
    node.props.onChange({ target: { value, checked: checked ?? false } });
  });
  await flush();
}

describe("PromptPacksWorkbenchPage", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
    promptPackMocks.refreshCallback = undefined;
    promptPackMocks.refreshFallback = undefined;
    promptPackMocks.providerCatalog = {
      config: { activeProviderId: "openai" },
      providers: [
        { providerId: "openai", label: "OpenAI", models: ["gpt-5", "gpt-5-mini"] },
        { providerId: "anthropic", label: "Anthropic", models: ["claude-opus-5"] },
      ],
    };
    installBrowser();
    setupApiSuccess();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps pack-wide run controls in a stable command strip", async () => {
    const renderer = await renderWorkbench();

    const commandStrip = renderer.root.findByProps({ className: "mc-pp-command-strip" });
    const commandText = readNodeText(commandStrip);
    expect(commandText).toContain("Run controls");
    expect(commandText).toContain("Run all");
    expect(commandText).toContain("3 tests available");
    expect(renderer.root.findAllByProps({ className: "mc-pp-command-deck" })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ className: "mc-pp-pack-list" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ "aria-label": "Prompt pack detail tabs" })).toHaveLength(0);
    expect(findSelectContaining(renderer, "Operator trust pack").props.value).toBe("pack-1");
    expect(readNodeText(renderer.root)).toContain("Assistant output");
    expect(readNodeText(renderer.root)).toContain("Assessment summary");
    expect(readNodeText(renderer.root)).toContain("Manual review");
    expect(readNodeText(renderer.root)).not.toContain("Measurement-first retuning");
  });

  it("shows retune controls only when the runtime feature flag is enabled", async () => {
    promptPackMocks.fetchSettings.mockResolvedValue({
      features: { promptRetuneCampaignV1Enabled: true },
    });
    const renderer = await renderWorkbench();

    expect(readNodeText(renderer.root)).toContain("Measurement-first retuning");
    await click(findButton(renderer, "Create frozen campaign"));

    expect(promptPackMocks.createPromptRetuneCampaign).toHaveBeenCalledWith(
      "pack-1",
      expect.objectContaining({
        repeatCount: 3,
        executionStyle: "single_turn_harness",
        maxBenchmarkRuns: 12,
      }),
    );
    expect(readNodeText(renderer.root)).toContain("Retune campaign retune-1 created with frozen inputs.");
    expect(readNodeText(renderer.root)).toContain("Retune campaign evidence");
    expect(readNodeText(renderer.root)).toContain("No measurement pass has started.");
  });

  it("drives the prompt-pack workbench through run, review, ops, reset, import, and refresh flows", async () => {
    const navigate = vi.fn();
    const renderer = await renderWorkbench({ navigate });

    expect(readNodeText(renderer.root)).toContain("Operator trust pack");
    expect(readNodeText(renderer.root)).toContain("Latest attempts");
    expect(readNodeText(renderer.root)).toContain("Trace a local failure");
    expect(promptPackMocks.loadModelsForProvider).toHaveBeenCalledWith("openai");

    await click(findButton(renderer, "Run selected"));
    expect(readNodeText(renderer.root)).toContain("Missing placeholder values for TEST-01");
    expect(promptPackMocks.runPromptPackTest).not.toHaveBeenCalled();

    await change(findInput(renderer, "Value for <LOCAL PATH>"), "F:/code/personal-ai/runtime.log");
    await click(findButton(renderer, "Agentic"));
    await click(findButton(renderer, "Run selected"));
    expect(promptPackMocks.runPromptPackTest).toHaveBeenCalledWith(
      "pack-1",
      "test-1",
      expect.objectContaining({
        executionStyle: "agentic_surface",
        placeholderValues: { "local path": "F:/code/personal-ai/runtime.log" },
        providerId: "openai",
      }),
    );
    expect(promptPackMocks.autoScorePromptPackTest).toHaveBeenCalledWith("pack-1", "test-1", { runId: "run-new" });
    expect(promptPackMocks.exportPromptPackReport).toHaveBeenCalledWith("pack-1");

    expect(readNodeText(renderer.root)).toContain("Assistant output");
    expect(readNodeText(renderer.root)).toContain("Failure attribution");
    expect(readNodeText(renderer.root)).toContain("Manual review");

    await click(findButton(renderer, "Open run thread"));
    expect(navigate).toHaveBeenCalledWith({ area: "chat", sessionId: "session-1" });
    await click(findButton(renderer, "Copy run link"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("http://localhost:5173/chat?sessionId=session-1");

    const scoreButtons = renderer.root
      .findAllByType("button")
      .filter((node) => String(node.props.className).includes("mc-pp-score-button"));
    await click(scoreButtons.find((node) => readNodeText(node) === "--")!);
    expect(readNodeText(renderer.root)).toContain("4/5 dimensions set");
    await click(scoreButtons.find((node) => readNodeText(node) === "4")!);
    expect(readNodeText(renderer.root)).toContain("5/5 dimensions set");
    await click(findButton(renderer, "Fill pass defaults"));
    await change(findSelectContaining(renderer, "No override"), "review");
    await change(findTextarea(renderer, "Optional notes..."), "Needs one more evidence note.");
    await click(findButton(renderer, "Save review"));
    expect(promptPackMocks.scorePromptPackTest).toHaveBeenCalledWith(
      "pack-1",
      "test-1",
      expect.objectContaining({
        runId: "run-1",
        overrideVerdict: "review",
        notes: "Needs one more evidence note.",
      }),
    );
    await click(findButton(renderer, "Auto score this run"));
    expect(promptPackMocks.autoScorePromptPackTest).toHaveBeenCalledWith("pack-1", "test-1", {
      force: true,
      runId: "run-1",
    });

    expect(readNodeText(renderer.root)).toContain("Pack insights");
    expect(readNodeText(renderer.root)).toContain("Full-pack readiness");
    expect(readNodeText(renderer.root)).toContain("Incomplete");
    await click(findButton(renderer, "Start benchmark"));
    expect(promptPackMocks.runPromptPackBenchmark).toHaveBeenCalledWith(
      "pack-1",
      expect.objectContaining({
        executionStyle: "agentic_surface",
        providers: [{ providerId: "openai", model: "gpt-5" }],
      }),
    );
    expect(readNodeText(renderer.root)).toContain("Benchmark running 1/2");
    await click(findButton(renderer, "Refresh benchmark"));
    expect(promptPackMocks.fetchPromptPackBenchmark).toHaveBeenCalledWith("bench-1");
    await click(findButton(renderer, "Stop"));
    expect(promptPackMocks.cancelPromptPackBenchmark).toHaveBeenCalledWith("bench-1");

    await click(findButton(renderer, "Replay regression"));
    expect(promptPackMocks.runPromptPackReplayRegression).toHaveBeenCalledWith("pack-1", {
      baselineBenchmarkRunId: "bench-1",
      testCodes: ["TEST-03", "TEST-06", "TEST-10", "TEST-12", "TEST-15", "TEST-28"],
    });
    expect(readNodeText(renderer.root)).toContain("Replay regression completed");
    await click(findButton(renderer, "Refresh replay"));
    expect(promptPackMocks.fetchPromptPackReplayRegressionStatus).toHaveBeenCalledWith("reg-1");

    await click(findButton(renderer, "Export report"));
    await click(findButton(renderer, "Copy saved log path"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("artifacts/prompt-packs/archive/snapshot.json");

    await click(findButton(renderer, "Auto-score"));
    expect(promptPackMocks.autoScorePromptPackBatch).toHaveBeenCalledWith("pack-1", { onlyUnscored: true });
    await click(findButton(renderer, "Run next"));
    expect(promptPackMocks.runPromptPackTest).toHaveBeenCalledTimes(2);
    await click(findButton(renderer, "Run all"));
    expect(promptPackMocks.runPromptPackBenchmark).toHaveBeenCalledTimes(2);

    await click(findButton(renderer, "Reset pack"));
    await click(findButton(renderer, "Cancel"));
    await click(findButton(renderer, "Reset pack"));
    await click(findButton(renderer, "Confirm reset"));
    expect(promptPackMocks.resetPromptPack).toHaveBeenCalledWith("pack-1", {
      clearRuns: true,
      clearScores: true,
    });

    expect(renderer.root.findByProps({ "aria-label": "Test codes" }).type).toBe("textarea");
    expect(renderer.root.findByProps({ "aria-label": "Benchmark matrix" }).type).toBe("textarea");
    expect(renderer.root.findByProps({ "aria-label": "Prompt-pack markdown" })).toBeTruthy();
    await change(findTextarea(renderer, "Paste prompt-pack markdown here..."), "# New Prompt Pack");
    await click(findButton(renderer, "Import pack"));
    expect(promptPackMocks.importPromptPack).toHaveBeenCalledWith({
      content: "# New Prompt Pack",
      sourceLabel: "manual-import",
    });

    await click(findButton(renderer, "Refresh"));
    expect(promptPackMocks.fetchPromptPacks).toHaveBeenCalled();

    await act(async () => {
      promptPackMocks.refreshFallback?.(true);
    });
    await flush();
    expect(readNodeText(renderer.root)).toContain("Live updates degraded");
    await act(async () => {
      await promptPackMocks.refreshCallback?.();
    });
    await flush();
    expect(promptPackMocks.fetchPromptPackTrends).toHaveBeenCalledWith("pack-1");
  });

  it("opens a requested prompt pack from route focus", async () => {
    const renderer = await renderWorkbench({ initialPackId: "pack-2" });

    expect(promptPackMocks.fetchPromptPackTests).toHaveBeenCalledWith("pack-2");
    expect(promptPackMocks.fetchPromptPackReport).toHaveBeenCalledWith("pack-2");
    // Exactly one fetch per selection — the duplicate selectedPackId effect
    // used to double-load every pack change.
    expect(promptPackMocks.fetchPromptPackTests).toHaveBeenCalledTimes(1);
    expect(readNodeText(renderer.root)).toContain("Secondary pack");

    await change(findSelectContaining(renderer, "Operator trust pack"), "pack-1");

    expect(promptPackMocks.fetchPromptPackTests).toHaveBeenLastCalledWith("pack-1");
    expect(promptPackMocks.fetchPromptPackReport).toHaveBeenLastCalledWith("pack-1");
    expect(promptPackMocks.fetchPromptPackTests).toHaveBeenCalledTimes(2);
  });

  it("surfaces load, copy, validation, and ops import failures", async () => {
    promptPackMocks.fetchPromptPacks.mockRejectedValueOnce(new Error("Gateway offline"));
    const loadErrorRenderer = await renderWorkbench();
    expect(readNodeText(loadErrorRenderer.root)).toContain("Gateway offline");

    setupApiSuccess();
    const renderer = await renderWorkbench({ variant: "ops" });
    expect(readNodeText(renderer.root)).toContain("Quality workbench");
    expect(readNodeText(renderer.root)).not.toContain("Import a new pack");

    await change(findInput(renderer, "Value for <LOCAL PATH>"), "F:/code/personal-ai/runtime.log");
    await act(async () => {
      vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
    });
    await click(findButton(renderer, "Copy run link"));
    expect(readNodeText(renderer.root)).toContain("Failed to copy run link.");

    await change(findTextarea(renderer, "TEST-03, TEST-06, TEST-10"), "");
    await click(findButton(renderer, "Start benchmark"));
    expect(readNodeText(renderer.root)).toContain("Benchmark needs at least one test code.");
    await click(findButton(renderer, "Replay regression"));
    expect(readNodeText(renderer.root)).toContain("Replay regression needs at least one test code.");

    const resetCheckboxes = renderer.root
      .findAllByType("input")
      .filter(
        (node) => node.props.type === "checkbox" && readNodeText(node.parent as ReactTestInstance).includes("Clear"),
      );
    for (const checkbox of resetCheckboxes) {
      await change(checkbox, "", false);
    }
    await click(findButton(renderer, "Reset pack"));
    await click(findButton(renderer, "Confirm reset"));
    expect(readNodeText(renderer.root)).toContain("Select at least one reset option");
  });

  it("handles empty pack lists and pack export fallback metadata", async () => {
    promptPackMocks.fetchPromptPacks.mockResolvedValueOnce({ items: [] });
    const emptyRenderer = await renderWorkbench();
    expect(readNodeText(emptyRenderer.root)).toContain("No tests match this filter.");
    const emptyPackSelect = findSelectContaining(emptyRenderer, "No packs available");
    expect(emptyPackSelect.props.disabled).toBe(true);
    expect(emptyPackSelect.props.value).toBe("");
    expect(promptPackMocks.fetchPromptPackTests).not.toHaveBeenCalled();

    setupApiSuccess();
    promptPackMocks.fetchPromptPackExport.mockRejectedValueOnce(new Error("export metadata offline"));
    const fallbackRenderer = await renderWorkbench();

    expect(readNodeText(fallbackRenderer.root)).toContain("Operator trust pack");
    expect(readNodeText(fallbackRenderer.root)).not.toContain("artifacts/prompt-packs/archive/snapshot.json");
    expect(promptPackMocks.fetchPromptPackExport).toHaveBeenCalledWith("pack-1");
  });

  it("covers failed run, auto-score, export, terminal benchmark, and keyboard selection branches", async () => {
    const renderer = await renderWorkbench();

    await change(findSelectContaining(renderer, "Secondary pack"), "pack-2");
    expect(promptPackMocks.fetchPromptPackTests).toHaveBeenCalledWith("pack-2");

    const testRow = renderer.root
      .findAll((node) => node.props.role === "button")
      .find((node) => readNodeText(node).includes("TEST-02"));
    expect(testRow).toBeTruthy();
    await act(async () => {
      testRow!.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    });
    await flush();

    promptPackMocks.runPromptPackTest.mockResolvedValueOnce({ ...failedRun, runId: "run-failed-new" });
    await click(findButton(renderer, "Run selected"));
    expect(readNodeText(renderer.root)).toContain("Ran TEST-02, but it failed: Tool failed");

    promptPackMocks.runPromptPackTest.mockRejectedValueOnce(new Error("run offline"));
    await click(findButton(renderer, "Run selected"));
    expect(readNodeText(renderer.root)).toContain("run offline");

    const thirdRow = renderer.root
      .findAll((node) => node.props.role === "button")
      .find((node) => readNodeText(node).includes("TEST-03"));
    await act(async () => {
      thirdRow!.props.onClick();
    });
    await flush();

    promptPackMocks.runPromptPackTest.mockResolvedValueOnce({ ...unscoredRun, runId: "run-autoscore-error" });
    promptPackMocks.autoScorePromptPackTest.mockRejectedValueOnce(new Error("judge offline"));
    await click(findButton(renderer, "Run selected"));
    expect(readNodeText(renderer.root)).toContain("auto-score failed: judge offline");

    promptPackMocks.runPromptPackTest.mockResolvedValueOnce({ ...unscoredRun, runId: "run-export-error" });
    promptPackMocks.exportPromptPackReport.mockRejectedValueOnce(new Error("disk full"));
    await click(findButton(renderer, "Run selected"));
    expect(readNodeText(renderer.root)).toContain("saving the run log failed: disk full");

    promptPackMocks.fetchPromptPackBenchmark.mockResolvedValueOnce({
      ...benchmarkStatus,
      run: {
        ...benchmarkStatus.run,
        status: "completed",
        finishedAt: "2026-04-22T00:15:00.000Z",
      },
      progress: { totalItems: 2, completedItems: 2 },
    });
    promptPackMocks.exportPromptPackReport.mockRejectedValueOnce(new Error("benchmark archive offline"));
    await click(findButton(renderer, "Run all"));
    expect(promptPackMocks.runPromptPackBenchmark).toHaveBeenCalledWith(
      "pack-2",
      expect.objectContaining({ testCodes: ["TEST-02", "TEST-03"] }),
    );
    expect(readNodeText(renderer.root)).toContain("Benchmark completed, but saving the run log failed");
  });

  it("surfaces prompt-pack mutation failures and import guards", async () => {
    const renderer = await renderWorkbench();

    await click(findButton(renderer, "Import pack"));
    expect(readNodeText(renderer.root)).toContain("Paste prompt-pack markdown first.");

    promptPackMocks.importPromptPack.mockRejectedValueOnce(new Error("import failed"));
    await change(findTextarea(renderer, "Paste prompt-pack markdown here..."), "# Broken pack");
    await click(findButton(renderer, "Import pack"));
    expect(readNodeText(renderer.root)).toContain("import failed");

    promptPackMocks.exportPromptPackReport.mockRejectedValueOnce(new Error("export failed"));
    await click(findButton(renderer, "Export report"));
    expect(readNodeText(renderer.root)).toContain("export failed");

    promptPackMocks.autoScorePromptPackBatch.mockRejectedValueOnce(new Error("batch score failed"));
    await click(findButton(renderer, "Auto-score"));
    expect(readNodeText(renderer.root)).toContain("batch score failed");

    promptPackMocks.scorePromptPackTest.mockRejectedValueOnce(new Error("review save failed"));
    await click(findButton(renderer, "Save review"));
    expect(readNodeText(renderer.root)).toContain("review save failed");

    promptPackMocks.runPromptPackBenchmark.mockRejectedValueOnce(new Error("benchmark failed"));
    await click(findButton(renderer, "Start benchmark"));
    expect(readNodeText(renderer.root)).toContain("benchmark failed");

    promptPackMocks.runPromptPackReplayRegression.mockRejectedValueOnce(new Error("regression failed"));
    await click(findButton(renderer, "Replay regression"));
    expect(readNodeText(renderer.root)).toContain("regression failed");
  });

  it("surfaces no-provider run guards in the ops workbench variant", async () => {
    promptPackMocks.providerCatalog = {
      config: { activeProviderId: "" },
      providers: [],
    };
    const renderer = await renderWorkbench({ variant: "ops", navigate: undefined });

    const reuseLastModelCheckbox = renderer.root
      .findAllByType("input")
      .find((node) => node.props.type === "checkbox" && node.props.checked === true);
    expect(reuseLastModelCheckbox).toBeTruthy();
    await change(reuseLastModelCheckbox!, "", false);
    expect(readNodeText(renderer.root)).toContain("Select a provider and model to start running this pack.");
    await click(findButton(renderer, "Run all"));
    expect(readNodeText(renderer.root)).toContain("Run all needs a selected provider/model lane.");

    await change(findTextarea(renderer, "openai/gpt-5.4-mini\nmoonshot/kimi-k2.6"), "");
    await click(findButton(renderer, "Start benchmark"));
    expect(readNodeText(renderer.root)).toContain("Benchmark needs at least one provider/model entry");

    expect(readNodeText(renderer.root)).toContain("Quality workbench");
  });

  it("updates provider and model lanes in both V2 and legacy run settings", async () => {
    const renderer = await renderWorkbench();
    const providerSelect = findSelectContaining(renderer, "Anthropic");
    await change(providerSelect, "anthropic");
    expect(promptPackMocks.loadModelsForProvider).toHaveBeenCalledWith("anthropic");

    const modelSelect = findSelectContaining(renderer, "claude-opus-5");
    await change(modelSelect, "claude-opus-5");
    expect(readNodeText(renderer.root)).toContain("New runs request anthropic/claude-opus-5.");

    const runSettingToggles = renderer.root
      .findAllByType("input")
      .filter(
        (node) =>
          node.props.type === "checkbox" &&
          (readNodeText(node.parent as ReactTestInstance).includes("Reuse the last successful model") ||
            readNodeText(node.parent as ReactTestInstance).includes("Auto-score completed runs")),
      );
    expect(runSettingToggles).toHaveLength(2);
    for (const toggle of runSettingToggles) {
      await change(toggle, "", false);
    }

    vi.stubEnv("VITE_PROMPT_PACK_V2_UI_ENABLED", "false");
    vi.resetModules();
    setupApiSuccess();
    const legacyRenderer = await renderWorkbench();

    await change(findSelectContaining(legacyRenderer, "Anthropic"), "anthropic");
    await change(findSelectContaining(legacyRenderer, "claude-opus-5"), "claude-opus-5");
    await click(findButton(legacyRenderer, "Harness"));
    await click(findButton(legacyRenderer, "Agentic"));
    expect(promptPackMocks.loadModelsForProvider).toHaveBeenCalledWith("anthropic");
    expect(readNodeText(legacyRenderer.root)).toContain("New runs request anthropic/claude-opus-5.");
    expect(readNodeText(legacyRenderer.root)).toContain("Prompt Pack Scoring V2 UI is disabled in this build.");
  });

  it("updates ops execution lane controls and row-level run actions", async () => {
    const opsRenderer = await renderWorkbench({ variant: "ops" });

    await change(findSelectContaining(opsRenderer, "Anthropic"), "anthropic");
    await change(findSelectContaining(opsRenderer, "claude-opus-5"), "claude-opus-5");

    const executionToggles = opsRenderer.root
      .findAllByType("input")
      .filter(
        (node) =>
          node.props.type === "checkbox" &&
          (readNodeText(node.parent as ReactTestInstance).includes("Reuse the last successful model") ||
            readNodeText(node.parent as ReactTestInstance).includes("Auto-score completed runs")),
      );
    expect(executionToggles).toHaveLength(2);
    for (const toggle of executionToggles) {
      await change(toggle, "", false);
    }
    await click(findButton(opsRenderer, "Harness"));
    await click(findButton(opsRenderer, "Agentic"));

    expect(readNodeText(opsRenderer.root)).toContain("New runs request anthropic/claude-opus-5.");

    const rowRunButton = opsRenderer.root.findAllByType("button").find((node) => {
      if (!String(node.props.className).includes("mc-pp-run-button")) {
        return false;
      }
      // NativeButton wraps the host button, so climb past the primitive to the
      // nearest row carrying a TEST-0x marker, then confirm it is the TEST-02 row
      // (an unbounded "includes TEST-02" climb would match a multi-row container).
      let row: ReactTestInstance | null = node.parent;
      while (row && !/TEST-0\d/.test(readNodeText(row))) {
        row = row.parent;
      }
      return row !== null && readNodeText(row).includes("TEST-02");
    });
    expect(rowRunButton).toBeTruthy();

    promptPackMocks.runPromptPackTest.mockClear();
    await click(rowRunButton!);
    expect(promptPackMocks.runPromptPackTest).toHaveBeenCalledWith(
      "pack-1",
      "test-2",
      expect.objectContaining({
        executionStyle: "agentic_surface",
        providerId: "anthropic",
        model: "claude-opus-5",
      }),
    );
  });
});
