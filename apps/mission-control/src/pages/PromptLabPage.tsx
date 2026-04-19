/* eslint-disable @typescript-eslint/no-unused-vars */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PromptPackBenchmarkStatusRecord,
  PromptPackLatestAssessmentRecordV2,
  PromptPackReportRecord,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import {
  autoScorePromptPackBatch,
  autoScorePromptPackTest,
  exportPromptPackReport,
  fetchPromptPackBenchmark,
  fetchPromptPackReplayRegressionStatus,
  fetchPromptPackTrends,
  fetchPromptPackExport,
  fetchPromptPackReport,
  fetchPromptPacks,
  fetchPromptPackTests,
  importPromptPack,
  resetPromptPack,
  runPromptPackTest,
  runPromptPackBenchmark,
  runPromptPackReplayRegression,
  scorePromptPackTest,
} from "../api/client";
import { CardSkeleton } from "../components/CardSkeleton";
import { type ChatModelProviderOption } from "../components/ChatModelPicker";
import { ConfirmModal } from "../components/ConfirmModal";
import { pageCopy } from "../content/copy";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import "../styles/prompt-lab.css";
import { PromptLabReportPanel } from "./prompt-lab/PromptLabReportPanel";
import { PromptLabSetupPanel } from "./prompt-lab/PromptLabSetupPanel";
import { PromptLabSummaryPanel } from "./prompt-lab/PromptLabSummaryPanel";
import { PromptLabWorkspace } from "./prompt-lab/PromptLabWorkspace";
import {
  PROMPT_PACK_PASS_THRESHOLD,
  classifyTestResultCategory,
  extractPromptPlaceholders,
  formatWeightedScore,
  matchesTestResultFilter,
  normalizePromptPlaceholderKey,
  parseBenchmarkProviders,
  parseBenchmarkTestCodes,
  resolvePromptLabActiveProvider,
  resolvePromptPackRunModelUsage,
  type TestResultFilter,
} from "./prompt-lab/prompt-lab-helpers";
import { DEFAULT_SCORE_DRAFT, type ActiveRunState, type ScoreDraft } from "./prompt-lab/prompt-lab-types";

const DEFAULT_BENCHMARK_TEST_CODES = "TEST-03, TEST-06, TEST-10, TEST-12, TEST-15, TEST-28";

export function PromptLabPage({ workspaceId }: { workspaceId?: string }) {
  const v2UiEnabled = isPromptPackV2UiEnabled();
  const hasLoadedOnceRef = useRef(false);
  const selectedPackIdRef = useRef<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFallbackRefreshing, setIsFallbackRefreshing] = useState(false);
  const [activeRun, setActiveRun] = useState<ActiveRunState | null>(null);
  const [savingScore, setSavingScore] = useState(false);
  const [autoScoring, setAutoScoring] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [resetClearRuns, setResetClearRuns] = useState(true);
  const [resetClearScores, setResetClearScores] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [packs, setPacks] = useState<Array<{ packId: string; name: string; testCount: number }>>([]);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [tests, setTests] = useState<PromptPackTestRecord[]>([]);
  const [importText, setImportText] = useState("");
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>({});
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [testResultFilter, setTestResultFilter] = useState<TestResultFilter>("all");
  const [report, setReport] = useState<{
    runs: PromptPackRunRecord[];
    latestAssessments: PromptPackLatestAssessmentRecordV2[];
    summary: PromptPackReportRecord["summary"];
  } | null>(null);
  const [reuseLastModel, setReuseLastModel] = useState(true);
  const [autoScoreOnRun, setAutoScoreOnRun] = useState(true);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [benchmarkTestCodes, setBenchmarkTestCodes] = useState(DEFAULT_BENCHMARK_TEST_CODES);
  const [benchmarkProvidersInput, setBenchmarkProvidersInput] = useState("");
  const [benchmarkRunId, setBenchmarkRunId] = useState<string | null>(null);
  const [benchmarkStatus, setBenchmarkStatus] = useState<PromptPackBenchmarkStatusRecord | null>(null);
  const [benchmarkPending, setBenchmarkPending] = useState(false);
  const [regressionRunId, setRegressionRunId] = useState<string | null>(null);
  const [regressionPending, setRegressionPending] = useState(false);
  const [regressionStatus, setRegressionStatus] = useState<Awaited<
    ReturnType<typeof fetchPromptPackReplayRegressionStatus>
  > | null>(null);
  const [trendSeries, setTrendSeries] = useState<Awaited<ReturnType<typeof fetchPromptPackTrends>>["items"]>([]);
  const [exportInfo, setExportInfo] = useState<{
    packId: string;
    path: string;
    exists: boolean;
    sizeBytes: number;
    updatedAt?: string;
  } | null>(null);
  const [sidebarView, setSidebarView] = useState<"setup" | "report">("setup");
  const [scoreDraft, setScoreDraft] = useState<ScoreDraft>(DEFAULT_SCORE_DRAFT);
  const running = activeRun !== null;
  const benchmarkActive = Boolean(
    benchmarkRunId &&
    (benchmarkPending || benchmarkStatus?.run.status === "queued" || benchmarkStatus?.run.status === "running"),
  );
  const regressionActive = Boolean(
    regressionRunId &&
    (regressionPending || regressionStatus?.run.status === "queued" || regressionStatus?.run.status === "running"),
  );
  const {
    config: runtimeLlmConfig,
    providers: runtimeProviderCatalog,
    loadModelsForProvider,
  } = useProviderModelCatalog("system");
  const providerOptions = useMemo<ChatModelProviderOption[]>(() => {
    return runtimeProviderCatalog
      .map((provider) => ({
        providerId: provider.providerId,
        label: provider.label,
        models: provider.models,
      }))
      .filter((provider) => provider.models.length > 0);
  }, [runtimeProviderCatalog]);

  useEffect(() => {
    selectedPackIdRef.current = selectedPackId;
  }, [selectedPackId]);

  const loadPack = useCallback(async (packId: string) => {
    const [testsResponse, reportResponse, exportResponse] = await Promise.all([
      fetchPromptPackTests(packId),
      fetchPromptPackReport(packId),
      fetchPromptPackExport(packId).catch(() => ({
        packId,
        path: "",
        exists: false,
        sizeBytes: 0,
      })),
    ]);
    setTests(testsResponse.items);
    setReport({
      runs: reportResponse.runs,
      latestAssessments: reportResponse.latestAssessments,
      summary: reportResponse.summary,
    });
    setExportInfo(exportResponse);
    setSelectedTestId((current) =>
      current && testsResponse.items.some((item) => item.testId === current)
        ? current
        : (testsResponse.items[0]?.testId ?? null),
    );
  }, []);

  const load = useCallback(
    async (options?: { background?: boolean }) => {
      const background = options?.background ?? hasLoadedOnceRef.current;
      if (background) {
        setIsRefreshing(true);
      } else {
        setInitialLoading(true);
      }
      try {
        const response = await fetchPromptPacks();
        setPacks(
          response.items.map((item) => ({
            packId: item.packId,
            name: item.name,
            testCount: item.testCount,
          })),
        );
        const currentSelectedPackId = selectedPackIdRef.current;
        const resolvedPackId =
          currentSelectedPackId && response.items.some((item) => item.packId === currentSelectedPackId)
            ? currentSelectedPackId
            : (response.items[0]?.packId ?? null);
        setSelectedPackId(resolvedPackId);
        if (resolvedPackId) {
          await loadPack(resolvedPackId);
        } else {
          setTests([]);
          setReport(null);
          setExportInfo(null);
        }
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (background) {
          setIsRefreshing(false);
        } else {
          setInitialLoading(false);
          hasLoadedOnceRef.current = true;
        }
      }
    },
    [loadPack],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useRefreshSubscription(
    "quality",
    async () => {
      await load({ background: true });
      await Promise.all([
        benchmarkActive && benchmarkRunId
          ? loadBenchmarkStatus(benchmarkRunId).catch(() => undefined)
          : Promise.resolve(),
        regressionActive && regressionRunId
          ? loadRegressionStatus(regressionRunId).catch(() => undefined)
          : Promise.resolve(),
      ]);
    },
    {
      enabled: !initialLoading,
      coalesceMs: 1200,
      staleMs: 20000,
      pollIntervalMs: benchmarkActive || regressionActive ? 2500 : 15000,
      onFallbackStateChange: setIsFallbackRefreshing,
    },
  );

  useEffect(() => {
    if (!selectedPackId) {
      return;
    }
    void loadPack(selectedPackId).catch((err: Error) => setError(err.message));
  }, [loadPack, selectedPackId]);

  useEffect(() => {
    if (!report && sidebarView === "report") {
      setSidebarView("setup");
    }
  }, [report, sidebarView]);

  const latestRunByTest = useMemo(() => {
    const map = new Map<string, PromptPackRunRecord>();
    const orderedRuns = [...(report?.runs ?? [])].sort((left, right) => {
      const leftTs = Date.parse(left.startedAt || left.finishedAt || "1970-01-01T00:00:00.000Z");
      const rightTs = Date.parse(right.startedAt || right.finishedAt || "1970-01-01T00:00:00.000Z");
      return rightTs - leftTs;
    });
    for (const run of orderedRuns) {
      if (!map.has(run.testId)) {
        map.set(run.testId, run);
      }
    }
    return map;
  }, [report?.runs]);

  const latestAssessmentByTest = useMemo(() => {
    return new Map((report?.latestAssessments ?? []).map((assessment) => [assessment.testId, assessment] as const));
  }, [report?.latestAssessments]);

  const selectedTest = tests.find((item) => item.testId === selectedTestId) ?? null;
  const selectedRun = selectedTest ? latestRunByTest.get(selectedTest.testId) : undefined;
  const selectedAssessment = selectedTest ? latestAssessmentByTest.get(selectedTest.testId) : undefined;
  const selectedRunModelUsage = useMemo(() => resolvePromptPackRunModelUsage(selectedRun), [selectedRun]);
  const passThreshold = report?.summary.passThreshold ?? PROMPT_PACK_PASS_THRESHOLD;
  const selectedPlaceholders = useMemo(
    () => (selectedTest ? extractPromptPlaceholders(selectedTest.prompt) : []),
    [selectedTest],
  );
  const selectedMissingPlaceholders = useMemo(
    () =>
      selectedPlaceholders.filter((token) => !(placeholderValues[normalizePromptPlaceholderKey(token)] ?? "").trim()),
    [placeholderValues, selectedPlaceholders],
  );

  const lastSuccessfulModel = useMemo(() => {
    for (const run of report?.runs ?? []) {
      if (run.status === "completed" && run.providerId && run.model) {
        return { providerId: run.providerId, model: run.model };
      }
    }
    return undefined;
  }, [report?.runs]);

  const unscoredCompletedCount = useMemo(
    () =>
      tests.filter((test) => {
        const run = latestRunByTest.get(test.testId);
        const assessment = latestAssessmentByTest.get(test.testId);
        return run?.status === "completed" && !assessment?.autoScore;
      }).length,
    [latestAssessmentByTest, latestRunByTest, tests],
  );

  const testOutcomeSummary = useMemo(() => {
    let runFailureCount = 0;
    let approvalPausedCount = 0;
    let scoreFailureCount = 0;
    let needsScoreCount = 0;
    let notRunCount = 0;
    let passingCount = 0;
    let reviewCount = 0;

    for (const test of tests) {
      const category = classifyTestResultCategory(
        latestRunByTest.get(test.testId),
        latestAssessmentByTest.get(test.testId),
      );
      if (category === "approval_paused") {
        approvalPausedCount += 1;
      } else if (category === "run_failed") {
        runFailureCount += 1;
      } else if (category === "score_failed") {
        scoreFailureCount += 1;
      } else if (category === "review") {
        reviewCount += 1;
      } else if (category === "needs_score") {
        needsScoreCount += 1;
      } else if (category === "not_run") {
        notRunCount += 1;
      } else if (category === "passing") {
        passingCount += 1;
      }
    }

    return {
      approvalPausedCount,
      runFailureCount,
      scoreFailureCount,
      needsScoreCount,
      notRunCount,
      passingCount,
      reviewCount,
    };
  }, [latestAssessmentByTest, latestRunByTest, tests]);

  const filteredTests = useMemo(
    () =>
      tests.filter((test) =>
        matchesTestResultFilter(
          testResultFilter,
          latestRunByTest.get(test.testId),
          latestAssessmentByTest.get(test.testId),
        ),
      ),
    [latestAssessmentByTest, latestRunByTest, testResultFilter, tests],
  );

  useEffect(() => {
    if (providerOptions.length === 0) {
      setSelectedModel("");
      return;
    }
    const activeProvider = resolvePromptLabActiveProvider(providerOptions, {
      selectedProviderId,
      runtimeActiveProviderId: runtimeLlmConfig?.activeProviderId,
    });
    if (!activeProvider) {
      setSelectedModel("");
      return;
    }
    if (!selectedProviderId || !providerOptions.some((item) => item.providerId === selectedProviderId)) {
      setSelectedProviderId(activeProvider.providerId);
    }
    setSelectedModel((current) =>
      current && activeProvider.models.includes(current) ? current : (activeProvider.models[0] ?? ""),
    );
  }, [providerOptions, runtimeLlmConfig?.activeProviderId, selectedProviderId]);

  useEffect(() => {
    if (!selectedProviderId) {
      return;
    }
    void loadModelsForProvider(selectedProviderId);
  }, [loadModelsForProvider, selectedProviderId]);

  const selectedRunModel = useMemo(() => {
    if (reuseLastModel && lastSuccessfulModel) {
      return {
        providerId: lastSuccessfulModel.providerId,
        model: lastSuccessfulModel.model,
      };
    }
    if (!selectedProviderId) {
      return undefined;
    }
    return {
      providerId: selectedProviderId,
      model: selectedModel || undefined,
    };
  }, [lastSuccessfulModel, reuseLastModel, selectedModel, selectedProviderId]);

  useEffect(() => {
    if (benchmarkProvidersInput.trim().length > 0) {
      return;
    }
    if (!selectedRunModel?.providerId) {
      return;
    }
    const model = selectedRunModel.model ?? selectedModel;
    if (!model) {
      return;
    }
    setBenchmarkProvidersInput(`${selectedRunModel.providerId}/${model}`);
  }, [benchmarkProvidersInput, selectedModel, selectedRunModel]);

  useEffect(() => {
    if (selectedAssessment?.humanReview) {
      setScoreDraft({
        taskSuccess: selectedAssessment.humanReview.scores.taskSuccess ?? null,
        honesty: selectedAssessment.humanReview.scores.honesty ?? null,
        executionQuality: selectedAssessment.humanReview.scores.executionQuality ?? null,
        robustness: selectedAssessment.humanReview.scores.robustness ?? null,
        usability: selectedAssessment.humanReview.scores.usability ?? null,
        overrideVerdict: selectedAssessment.humanReview.overrideVerdict ?? "",
        notes: selectedAssessment.humanReview.notes ?? "",
      });
      return;
    }
    setScoreDraft(DEFAULT_SCORE_DRAFT);
  }, [selectedAssessment, selectedTestId]);

  const buildRunInput = useCallback(
    (
      test: PromptPackTestRecord,
    ): {
      input: {
        sessionId?: string;
        providerId?: string;
        model?: string;
        placeholderValues?: Record<string, string>;
      };
      missingPlaceholders: string[];
    } => {
      const placeholders = extractPromptPlaceholders(test.prompt);
      const missingPlaceholders: string[] = [];
      const resolvedPlaceholderValues: Record<string, string> = {};

      for (const placeholder of placeholders) {
        const key = normalizePromptPlaceholderKey(placeholder);
        const value = (placeholderValues[key] ?? "").trim();
        if (!value) {
          missingPlaceholders.push(placeholder);
          continue;
        }
        resolvedPlaceholderValues[key] = value;
      }

      return {
        input: {
          ...selectedRunModel,
          placeholderValues: Object.keys(resolvedPlaceholderValues).length > 0 ? resolvedPlaceholderValues : undefined,
        },
        missingPlaceholders,
      };
    },
    [placeholderValues, selectedRunModel],
  );

  const runOne = useCallback(
    async (test: PromptPackTestRecord, mode: ActiveRunState["mode"] = "single") => {
      if (!selectedPackId) {
        return;
      }
      const { input, missingPlaceholders } = buildRunInput(test);
      if (missingPlaceholders.length > 0) {
        setError(`Missing placeholder values for ${test.code}: ${missingPlaceholders.join(", ")}.`);
        return;
      }
      setActiveRun({ mode, testId: test.testId, testCode: test.code });
      setError(null);
      setSuccess(null);
      try {
        const run = await runPromptPackTest(selectedPackId, test.testId, input);
        let autoScoreSummary = "";
        let autoScoreError: string | null = null;
        if (autoScoreOnRun && run.status === "completed") {
          try {
            const auto = await autoScorePromptPackTest(selectedPackId, test.testId, {
              runId: run.runId,
            });
            autoScoreSummary = ` Auto-scored ${formatWeightedScore(auto.score.weightedScore)} (${auto.score.autoVerdict}).`;
          } catch (err) {
            autoScoreError = (err as Error).message;
          }
        }
        await loadPack(selectedPackId);
        setSelectedTestId(test.testId);
        if (run.status === "failed") {
          setError(`Ran ${test.code}, but it failed: ${run.error ?? "Unknown error"}`);
        } else if (autoScoreError) {
          setSuccess(`Ran ${test.code}.`);
          setError(`Ran ${test.code}, but auto-score failed: ${autoScoreError}`);
        } else {
          setSuccess(`Ran ${test.code}.${autoScoreSummary}`);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setActiveRun(null);
      }
    },
    [autoScoreOnRun, buildRunInput, loadPack, selectedPackId],
  );

  const runAll = useCallback(async () => {
    if (!selectedPackId || tests.length === 0) {
      return;
    }
    setActiveRun({ mode: "all" });
    setError(null);
    setSuccess(null);
    try {
      let completed = 0;
      let failed = 0;
      let autoScored = 0;
      let scoreFailed = 0;
      let skipped = 0;
      const issues: string[] = [];
      for (const test of tests) {
        setActiveRun({ mode: "all", testId: test.testId, testCode: test.code });
        const { input, missingPlaceholders } = buildRunInput(test);
        if (missingPlaceholders.length > 0) {
          skipped += 1;
          continue;
        }
        let run: PromptPackRunRecord;
        try {
          run = await runPromptPackTest(selectedPackId, test.testId, input);
        } catch (err) {
          failed += 1;
          issues.push(`${test.code}: ${(err as Error).message}`);
          continue;
        }
        if (run.status === "failed") {
          failed += 1;
          issues.push(`${test.code}: ${run.error ?? "Unknown run failure"}`);
        } else if (run.status === "completed") {
          completed += 1;
          if (autoScoreOnRun) {
            try {
              await autoScorePromptPackTest(selectedPackId, test.testId, {
                runId: run.runId,
              });
              autoScored += 1;
            } catch (err) {
              scoreFailed += 1;
              issues.push(`${test.code} auto-score: ${(err as Error).message}`);
            }
          }
        }
      }
      await loadPack(selectedPackId);
      setSuccess(
        `Run all finished: ${completed} completed, ${failed} failed, ${skipped} skipped for missing placeholders.${autoScoreOnRun ? ` auto-scored ${autoScored}${scoreFailed > 0 ? `, ${scoreFailed} score failed` : ""}.` : ""}`,
      );
      if (issues.length > 0) {
        const sample = issues.slice(0, 3).join(" | ");
        const remainder = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
        setError(`Some runs need attention: ${sample}${remainder}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActiveRun(null);
    }
  }, [autoScoreOnRun, buildRunInput, loadPack, selectedPackId, tests]);

  const runNext = useCallback(async () => {
    if (!selectedPackId || tests.length === 0) {
      return;
    }
    const nextNotRun = tests.find((test) => !latestRunByTest.get(test.testId));
    const nextFailed = tests.find((test) => latestRunByTest.get(test.testId)?.status === "failed");
    const nextUnscoredCompleted = tests.find((test) => {
      const run = latestRunByTest.get(test.testId);
      const assessment = latestAssessmentByTest.get(test.testId);
      return run?.status === "completed" && !assessment?.autoScore;
    });
    const next = nextNotRun ?? nextFailed ?? nextUnscoredCompleted ?? tests[0];
    if (!next) {
      return;
    }
    await runOne(next, "next");
    setSelectedTestId(next.testId);
  }, [latestAssessmentByTest, latestRunByTest, runOne, selectedPackId, tests]);

  const exportReport = useCallback(async () => {
    if (!selectedPackId) {
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const info = await exportPromptPackReport(selectedPackId);
      setExportInfo(info);
      setSuccess(`Exported report to ${info.path}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  }, [selectedPackId]);

  const resetPack = useCallback(async () => {
    if (!selectedPackId) {
      return;
    }
    if (!resetClearRuns && !resetClearScores) {
      setError("Select at least one reset option (runs or scores).");
      return;
    }
    setConfirmResetOpen(true);
  }, [resetClearRuns, resetClearScores, selectedPackId]);

  const confirmResetPack = useCallback(async () => {
    if (!selectedPackId) {
      return;
    }
    setResetting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await resetPromptPack(selectedPackId, {
        clearRuns: resetClearRuns,
        clearScores: resetClearScores,
      });
      await loadPack(selectedPackId);
      setSuccess(`Reset complete: removed ${result.deletedRuns} run(s) and ${result.deletedScores} score(s).`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResetting(false);
    }
  }, [loadPack, resetClearRuns, resetClearScores, selectedPackId]);

  const copyExportPath = useCallback(async () => {
    if (!exportInfo?.path) {
      return;
    }
    try {
      await navigator.clipboard.writeText(exportInfo.path);
      setSuccess("Copied export path.");
    } catch {
      setError("Failed to copy export path.");
    }
  }, [exportInfo?.path]);

  const submitScore = useCallback(async () => {
    if (!selectedPackId || !selectedTest || !selectedRun) {
      return;
    }
    setSavingScore(true);
    setError(null);
    setSuccess(null);
    try {
      await scorePromptPackTest(selectedPackId, selectedTest.testId, {
        runId: selectedRun.runId,
        taskSuccess: scoreDraft.taskSuccess,
        honesty: scoreDraft.honesty,
        executionQuality: scoreDraft.executionQuality,
        robustness: scoreDraft.robustness,
        usability: scoreDraft.usability,
        overrideVerdict: scoreDraft.overrideVerdict || undefined,
        notes: scoreDraft.notes.trim() || undefined,
      });
      await loadPack(selectedPackId);
      setSuccess(`Saved score for ${selectedTest.code}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingScore(false);
    }
  }, [loadPack, scoreDraft, selectedPackId, selectedRun, selectedTest]);

  const autoScoreSelected = useCallback(async () => {
    if (!selectedPackId || !selectedTest || !selectedRun) {
      return;
    }
    setAutoScoring(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await autoScorePromptPackTest(selectedPackId, selectedTest.testId, {
        runId: selectedRun.runId,
        force: true,
      });
      await loadPack(selectedPackId);
      setSuccess(
        `Auto-scored ${selectedTest.code}: ${formatWeightedScore(result.score.weightedScore)} (${result.score.autoVerdict}).`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAutoScoring(false);
    }
  }, [loadPack, selectedPackId, selectedRun, selectedTest]);

  const autoScoreUnscored = useCallback(async () => {
    if (!selectedPackId) {
      return;
    }
    setAutoScoring(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await autoScorePromptPackBatch(selectedPackId, {
        onlyUnscored: true,
      });
      await loadPack(selectedPackId);
      setSuccess(`Auto-scored ${result.items.length} run(s); skipped ${result.skipped}.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAutoScoring(false);
    }
  }, [loadPack, selectedPackId]);

  const loadBenchmarkStatus = useCallback(
    async (runId: string) => {
      const status = await fetchPromptPackBenchmark(runId);
      setBenchmarkStatus(status);
      if (status.run.status === "completed" || status.run.status === "failed") {
        setBenchmarkPending(false);
        await loadPack(status.run.packId);
      } else {
        setBenchmarkPending(true);
      }
    },
    [loadPack],
  );

  const runBenchmark = useCallback(async () => {
    if (!selectedPackId) {
      return;
    }
    const testCodes = parseBenchmarkTestCodes(benchmarkTestCodes);
    if (testCodes.length < 1) {
      setError("Benchmark needs at least one test code.");
      return;
    }
    const providers = parseBenchmarkProviders(benchmarkProvidersInput);
    if (providers.length < 1) {
      setError("Benchmark needs at least one provider/model entry (provider/model).");
      return;
    }
    setBenchmarkPending(true);
    setError(null);
    setSuccess(null);
    try {
      const started = await runPromptPackBenchmark(selectedPackId, {
        testCodes,
        providers,
      });
      setBenchmarkRunId(started.benchmarkRunId);
      await loadBenchmarkStatus(started.benchmarkRunId);
      setSuccess(`Benchmark started: ${started.benchmarkRunId}`);
    } catch (err) {
      setBenchmarkPending(false);
      setError((err as Error).message);
    }
  }, [benchmarkProvidersInput, benchmarkTestCodes, loadBenchmarkStatus, selectedPackId]);

  const loadTrends = useCallback(async (packId: string) => {
    const response = await fetchPromptPackTrends(packId);
    setTrendSeries(response.items);
  }, []);

  const loadRegressionStatus = useCallback(async (runId: string) => {
    const status = await fetchPromptPackReplayRegressionStatus(runId);
    setRegressionStatus(status);
    if (status.run.status !== "queued" && status.run.status !== "running") {
      setRegressionPending(false);
    }
  }, []);

  const runRegression = useCallback(async () => {
    if (!selectedPackId) {
      return;
    }
    const testCodes = parseBenchmarkTestCodes(benchmarkTestCodes);
    if (testCodes.length < 1) {
      setError("Replay regression needs at least one test code.");
      return;
    }
    setRegressionPending(true);
    setError(null);
    setSuccess(null);
    try {
      const started = await runPromptPackReplayRegression(selectedPackId, {
        testCodes,
        baselineRef: benchmarkRunId ?? undefined,
      });
      setRegressionRunId(started.regressionRunId);
      await loadRegressionStatus(started.regressionRunId);
      setSuccess(`Replay regression started: ${started.regressionRunId}`);
    } catch (err) {
      setRegressionPending(false);
      setError((err as Error).message);
    }
  }, [benchmarkRunId, benchmarkTestCodes, loadRegressionStatus, selectedPackId]);

  const refreshBenchmark = useCallback(() => {
    if (!benchmarkRunId) {
      return;
    }
    void loadBenchmarkStatus(benchmarkRunId).catch((err: Error) => setError(err.message));
  }, [benchmarkRunId, loadBenchmarkStatus]);

  const refreshRegression = useCallback(() => {
    if (!regressionRunId) {
      return;
    }
    void loadRegressionStatus(regressionRunId).catch((err: Error) => setError(err.message));
  }, [loadRegressionStatus, regressionRunId]);

  useEffect(() => {
    if (!selectedPackId) {
      setTrendSeries([]);
      return;
    }
    void loadTrends(selectedPackId).catch((err: Error) => {
      setTrendSeries([]);
      setError(err.message || "Failed to load capability trend series.");
    });
  }, [loadTrends, selectedPackId]);

  const handleImport = useCallback(async () => {
    const content = importText.trim();
    if (!content) {
      setError("Paste prompt-pack markdown first.");
      return;
    }
    setImporting(true);
    setError(null);
    setSuccess(null);
    try {
      const imported = await importPromptPack({
        content,
        sourceLabel: "manual-import",
      });
      setImportText("");
      await load();
      setSelectedPackId(imported.pack.packId);
      setSuccess(`Imported ${imported.tests.length} tests.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  }, [importText, load]);

  const selectedPack = packs.find((pack) => pack.packId === selectedPackId) ?? null;
  const promptLabOverviewCards = [
    {
      label: "Pack",
      value: selectedPack?.name ?? "No pack selected",
      detail: selectedPack ? `${selectedPack.testCount} tests loaded` : "Import or select a pack to start evaluating.",
    },
    {
      label: "Coverage",
      value: `${tests.length - testOutcomeSummary.notRunCount}/${tests.length || 0}`,
      detail: tests.length > 0 ? `${testOutcomeSummary.notRunCount} tests still not run` : "No prompt tests loaded yet",
    },
    {
      label: "Quality",
      value: report ? `${(report.summary.passRate * 100).toFixed(1)}% pass` : "No report yet",
      detail: report
        ? `${report.summary.averageWeightedScore.toFixed(1)}/100 average at threshold ${passThreshold}/100`
        : "Run and score a pack to generate the scorecard.",
    },
    {
      label: "Model lane",
      value:
        reuseLastModel && lastSuccessfulModel
          ? `${lastSuccessfulModel.providerId}/${lastSuccessfulModel.model}`
          : selectedRunModel?.providerId
            ? `${selectedRunModel.providerId}/${selectedRunModel.model ?? "provider default"}`
            : "No model selected",
      detail: activeRun
        ? `Currently running ${activeRun.testCode ?? "prompt-pack run"} in ${activeRun.mode} mode`
        : unscoredCompletedCount > 0
          ? `${unscoredCompletedCount} completed run(s) still need scoring`
          : "Ready for the next evaluation pass.",
    },
  ];

  if (initialLoading) {
    return (
      <section>
        <h2>{pageCopy.promptLab.title}</h2>
        <CardSkeleton lines={10} />
      </section>
    );
  }

  return (
    <section className="prompt-lab">
      <PromptLabSummaryPanel
        title={pageCopy.promptLab.title}
        subtitle={pageCopy.promptLab.subtitle}
        overviewCards={promptLabOverviewCards}
        activeRun={activeRun}
        benchmarkStatus={benchmarkStatus}
        isRefreshing={isRefreshing}
        isFallbackRefreshing={isFallbackRefreshing}
        error={error}
        success={success}
        resetClearRuns={resetClearRuns}
        resetClearScores={resetClearScores}
        hasSelectedPack={Boolean(selectedPackId)}
        running={running}
        resetting={resetting}
        exporting={exporting}
        importing={importing}
        autoScoring={autoScoring}
        autoScoreOnRun={autoScoreOnRun}
        unscoredCompletedCount={unscoredCompletedCount}
        exportInfo={exportInfo}
        benchmarkPending={benchmarkPending}
        testOutcomeSummary={testOutcomeSummary}
        onResetClearRunsChange={setResetClearRuns}
        onResetClearScoresChange={setResetClearScores}
        onCopyExportPath={() => void copyExportPath()}
        onRunNext={() => void runNext()}
        onRunAll={() => void runAll()}
        onRunBenchmark={() => void runBenchmark()}
        onRefreshData={() => void load({ background: true })}
        onAutoScoreUnscored={() => void autoScoreUnscored()}
        onExportNow={() => void exportReport()}
        onResetPack={() => void resetPack()}
      />

      <div className="prompt-lab-console">
        <aside className="prompt-lab-sidebar">
          <div className="card prompt-lab-sidebar-header">
            <div>
              <p className="prompt-lab-overview-label">Control Panel</p>
              <h3 className="prompt-lab-sidebar-title">Quality setup</h3>
            </div>
            <div className="prompt-lab-sidebar-tabs" role="tablist" aria-label="Quality side panels">
              <button
                type="button"
                role="tab"
                aria-selected={sidebarView === "setup"}
                className={[
                  "gc-button",
                  "prompt-lab-sidebar-tab",
                  sidebarView === "setup" ? "prompt-lab-sidebar-tab-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => setSidebarView("setup")}
              >
                Setup
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sidebarView === "report"}
                className={[
                  "gc-button",
                  "prompt-lab-sidebar-tab",
                  sidebarView === "report" ? "prompt-lab-sidebar-tab-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => setSidebarView("report")}
                disabled={!report}
              >
                Report
              </button>
            </div>
          </div>

          <div className="prompt-lab-sidebar-panel">
            {sidebarView === "report" && report ? (
              <PromptLabReportPanel
                report={report}
                testOutcomeSummary={testOutcomeSummary}
                passThreshold={passThreshold}
                benchmarkStatus={benchmarkStatus}
                regressionStatus={regressionStatus}
                trendSeries={trendSeries}
              />
            ) : (
              <PromptLabSetupPanel
                importText={importText}
                importing={importing}
                packs={packs}
                selectedPackId={selectedPackId}
                providerOptions={providerOptions}
                selectedProviderId={selectedProviderId}
                selectedModel={selectedModel}
                reuseLastModel={reuseLastModel}
                autoScoreOnRun={autoScoreOnRun}
                lastSuccessfulModel={lastSuccessfulModel ?? null}
                selectedRunModel={selectedRunModel ?? null}
                benchmarkTestCodes={benchmarkTestCodes}
                benchmarkProvidersInput={benchmarkProvidersInput}
                benchmarkPending={benchmarkPending}
                benchmarkRunId={benchmarkRunId}
                regressionPending={regressionPending}
                regressionRunId={regressionRunId}
                regressionStatus={regressionStatus}
                running={running}
                onImportTextChange={setImportText}
                onImport={() => void handleImport()}
                onSelectedPackIdChange={setSelectedPackId}
                onSelectedProviderIdChange={(providerId) => {
                  setReuseLastModel(false);
                  setSelectedProviderId(providerId);
                  const provider = providerOptions.find((item) => item.providerId === providerId);
                  setSelectedModel(provider?.models[0] ?? "");
                }}
                onSelectedModelChange={(model) => {
                  setReuseLastModel(false);
                  setSelectedModel(model);
                }}
                onReuseLastModelChange={setReuseLastModel}
                onAutoScoreOnRunChange={setAutoScoreOnRun}
                onBenchmarkTestCodesChange={setBenchmarkTestCodes}
                onBenchmarkProvidersInputChange={setBenchmarkProvidersInput}
                onRunBenchmark={() => void runBenchmark()}
                onRefreshBenchmark={refreshBenchmark}
                onRunRegression={() => void runRegression()}
                onRefreshRegression={refreshRegression}
              />
            )}
          </div>
        </aside>

        <PromptLabWorkspace
          v2UiEnabled={v2UiEnabled}
          tests={tests}
          filteredTests={filteredTests}
          testResultFilter={testResultFilter}
          onTestResultFilterChange={setTestResultFilter}
          testOutcomeSummary={testOutcomeSummary}
          latestRunByTest={latestRunByTest}
          latestAssessmentByTest={latestAssessmentByTest}
          selectedTestId={selectedTestId}
          onSelectedTestIdChange={setSelectedTestId}
          activeRun={activeRun}
          running={running}
          runOne={runOne}
          selectedTest={selectedTest}
          selectedPlaceholders={selectedPlaceholders}
          placeholderValues={placeholderValues}
          onPlaceholderValuesChange={setPlaceholderValues}
          selectedMissingPlaceholders={selectedMissingPlaceholders}
          selectedRun={selectedRun}
          selectedRunModelUsage={selectedRunModelUsage}
          selectedAssessment={selectedAssessment}
          scoreDraft={scoreDraft}
          onScoreDraftChange={setScoreDraft}
          savingScore={savingScore}
          submitScore={submitScore}
          autoScoring={autoScoring}
          autoScoreSelected={autoScoreSelected}
        />
      </div>
      <ConfirmModal
        open={confirmResetOpen}
        title="Reset Prompt Pack"
        message={`Reset this prompt pack? This will clear ${
          resetClearRuns && resetClearScores ? "run history and scores" : resetClearRuns ? "run history" : "scores"
        } for this pack.`}
        confirmLabel="Reset"
        danger
        pending={resetting}
        cancelDisabled={resetting}
        disableDismiss={resetting}
        onCancel={() => setConfirmResetOpen(false)}
        onConfirm={() => {
          void confirmResetPack().finally(() => {
            setConfirmResetOpen(false);
          });
        }}
      />
    </section>
  );
}

function isPromptPackV2UiEnabled(): boolean {
  const raw = (import.meta.env.VITE_PROMPT_PACK_V2_UI_ENABLED as string | undefined)?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !["0", "false", "off", "no", "disabled"].includes(raw);
}
