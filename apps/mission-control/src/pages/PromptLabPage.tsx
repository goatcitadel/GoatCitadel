import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PromptPackBenchmarkStatusRecord,
  PromptPackRunRecord,
  PromptPackScoreRecord,
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
import { ActionButton } from "../components/ActionButton";
import { CardSkeleton } from "../components/CardSkeleton";
import { ChatModelPicker, type ChatModelProviderOption } from "../components/ChatModelPicker";
import { ConfirmModal } from "../components/ConfirmModal";
import { GCSelect } from "../components/ui";
import { pageCopy } from "../content/copy";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

interface ScoreDraft {
  routingScore: 0 | 1 | 2;
  honestyScore: 0 | 1 | 2;
  handoffScore: 0 | 1 | 2;
  robustnessScore: 0 | 1 | 2;
  usabilityScore: 0 | 1 | 2;
  notes: string;
}

const DEFAULT_SCORE_DRAFT: ScoreDraft = {
  routingScore: 1,
  honestyScore: 1,
  handoffScore: 1,
  robustnessScore: 1,
  usabilityScore: 1,
  notes: "",
};

interface ActiveRunState {
  mode: "single" | "next" | "all";
  testId?: string;
  testCode?: string;
}

type TestResultFilter =
  | "all"
  | "run_failed"
  | "score_failed"
  | "needs_score"
  | "not_run"
  | "passing";

const DEFAULT_BENCHMARK_TEST_CODES = "TEST-03, TEST-06, TEST-10, TEST-12, TEST-15, TEST-28";

export function PromptLabPage({ workspaceId }: { workspaceId?: string }) {
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
    scores: PromptPackScoreRecord[];
    summary: {
      totalTests: number;
      completedRuns: number;
      failedRuns: number;
      runFailureCount: number;
      scoreFailureCount: number;
      needsScoreCount: number;
      durableRuns?: number;
      approvalPausedRuns?: number;
      backgroundedRuns?: number;
      passThreshold: number;
      averageTotalScore: number;
      passRate: number;
      failingCodes: string[];
    };
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
  const [regressionStatus, setRegressionStatus] = useState<Awaited<ReturnType<typeof fetchPromptPackReplayRegressionStatus>> | null>(null);
  const [trendSeries, setTrendSeries] = useState<Awaited<ReturnType<typeof fetchPromptPackTrends>>["items"]>([]);
  const [exportInfo, setExportInfo] = useState<{
    packId: string;
    path: string;
    exists: boolean;
    sizeBytes: number;
    updatedAt?: string;
  } | null>(null);
  const [scoreDraft, setScoreDraft] = useState<ScoreDraft>(DEFAULT_SCORE_DRAFT);
  const running = activeRun !== null;
  const benchmarkActive = Boolean(
    benchmarkRunId && (benchmarkPending || benchmarkStatus?.run.status === "queued" || benchmarkStatus?.run.status === "running"),
  );
  const regressionActive = Boolean(
    regressionRunId && (regressionPending || regressionStatus?.run.status === "queued" || regressionStatus?.run.status === "running"),
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
      scores: reportResponse.scores,
      summary: reportResponse.summary,
    });
    setExportInfo(exportResponse);
    setSelectedTestId((current) => current && testsResponse.items.some((item) => item.testId === current)
      ? current
      : testsResponse.items[0]?.testId ?? null);
  }, []);

  const load = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background ?? hasLoadedOnceRef.current;
    if (background) {
      setIsRefreshing(true);
    } else {
      setInitialLoading(true);
    }
    try {
      const response = await fetchPromptPacks();
      setPacks(response.items.map((item) => ({
        packId: item.packId,
        name: item.name,
        testCount: item.testCount,
      })));
      const currentSelectedPackId = selectedPackIdRef.current;
      const resolvedPackId = currentSelectedPackId && response.items.some((item) => item.packId === currentSelectedPackId)
        ? currentSelectedPackId
        : response.items[0]?.packId ?? null;
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
  }, [loadPack]);

  useEffect(() => {
    void load();
  }, [load]);

  useRefreshSubscription(
    "promptLab",
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

  const latestScoreByTest = useMemo(() => {
    const map = new Map<string, PromptPackScoreRecord>();
    const orderedScores = [...(report?.scores ?? [])].sort((left, right) => {
      const leftTs = Date.parse(left.createdAt || "1970-01-01T00:00:00.000Z");
      const rightTs = Date.parse(right.createdAt || "1970-01-01T00:00:00.000Z");
      return rightTs - leftTs;
    });
    for (const score of orderedScores) {
      if (!map.has(score.testId)) {
        map.set(score.testId, score);
      }
    }
    return map;
  }, [report?.scores]);

  const selectedTest = tests.find((item) => item.testId === selectedTestId) ?? null;
  const selectedRun = selectedTest ? latestRunByTest.get(selectedTest.testId) : undefined;
  const selectedScore = selectedTest ? latestScoreByTest.get(selectedTest.testId) : undefined;
  const passThreshold = report?.summary.passThreshold ?? PROMPT_PACK_PASS_THRESHOLD;
  const selectedPlaceholders = useMemo(
    () => selectedTest ? extractPromptPlaceholders(selectedTest.prompt) : [],
    [selectedTest],
  );
  const selectedMissingPlaceholders = useMemo(
    () => selectedPlaceholders.filter((token) => !(placeholderValues[normalizePromptPlaceholderKey(token)] ?? "").trim()),
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

  const unscoredCompletedCount = useMemo(() => tests.filter((test) => {
    const run = latestRunByTest.get(test.testId);
    const score = latestScoreByTest.get(test.testId);
    return run?.status === "completed" && !score;
  }).length, [latestRunByTest, latestScoreByTest, tests]);

  const testOutcomeSummary = useMemo(() => {
    let runFailureCount = 0;
    let scoreFailureCount = 0;
    let needsScoreCount = 0;
    let notRunCount = 0;
    let passingCount = 0;

    for (const test of tests) {
      const category = classifyTestResultCategory(
        latestRunByTest.get(test.testId),
        latestScoreByTest.get(test.testId),
        passThreshold,
      );
      if (category === "run_failed") {
        runFailureCount += 1;
      } else if (category === "score_failed") {
        scoreFailureCount += 1;
      } else if (category === "needs_score") {
        needsScoreCount += 1;
      } else if (category === "not_run") {
        notRunCount += 1;
      } else if (category === "passing") {
        passingCount += 1;
      }
    }

    return {
      runFailureCount,
      scoreFailureCount,
      needsScoreCount,
      notRunCount,
      passingCount,
    };
  }, [latestRunByTest, latestScoreByTest, passThreshold, tests]);

  const filteredTests = useMemo(
    () => tests.filter((test) => matchesTestResultFilter(
      testResultFilter,
      latestRunByTest.get(test.testId),
      latestScoreByTest.get(test.testId),
      passThreshold,
    )),
    [latestRunByTest, latestScoreByTest, passThreshold, testResultFilter, tests],
  );

  useEffect(() => {
    if (providerOptions.length === 0) {
      setSelectedModel("");
      return;
    }
    const activeProvider = providerOptions.find((item) => item.providerId === selectedProviderId)
      ?? providerOptions.find((item) => item.providerId === runtimeLlmConfig?.activeProviderId)
      ?? providerOptions[0];
    if (!activeProvider) {
      setSelectedModel("");
      return;
    }
    if (!selectedProviderId || !providerOptions.some((item) => item.providerId === selectedProviderId)) {
      setSelectedProviderId(activeProvider.providerId);
    }
    setSelectedModel((current) => current && activeProvider.models.includes(current)
      ? current
      : activeProvider.models[0] ?? "");
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
    if (selectedScore) {
      setScoreDraft({
        routingScore: selectedScore.routingScore,
        honestyScore: selectedScore.honestyScore,
        handoffScore: selectedScore.handoffScore,
        robustnessScore: selectedScore.robustnessScore,
        usabilityScore: selectedScore.usabilityScore,
        notes: selectedScore.notes ?? "",
      });
      return;
    }
    setScoreDraft(DEFAULT_SCORE_DRAFT);
  }, [selectedScore, selectedTestId]);

  const buildRunInput = useCallback((test: PromptPackTestRecord): {
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
  }, [placeholderValues, selectedRunModel]);

  const runOne = useCallback(async (test: PromptPackTestRecord, mode: ActiveRunState["mode"] = "single") => {
    if (!selectedPackId) {
      return;
    }
    const { input, missingPlaceholders } = buildRunInput(test);
    if (missingPlaceholders.length > 0) {
      setError(
        `Missing placeholder values for ${test.code}: ${missingPlaceholders.join(", ")}.`,
      );
      return;
    }
    setActiveRun({ mode, testId: test.testId, testCode: test.code });
    setError(null);
    setSuccess(null);
    try {
      const run = await runPromptPackTest(selectedPackId, test.testId, input);
      let autoScoreSummary = "";
      if (autoScoreOnRun && run.status === "completed") {
        const auto = await autoScorePromptPackTest(selectedPackId, test.testId, {
          runId: run.runId,
        });
        autoScoreSummary = ` Auto-scored ${auto.score.totalScore}/10.`;
      }
      await loadPack(selectedPackId);
      setSelectedTestId(test.testId);
      if (run.status === "failed") {
        setError(`Ran ${test.code}, but it failed: ${run.error ?? "Unknown error"}`);
      } else {
        setSuccess(`Ran ${test.code}.${autoScoreSummary}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActiveRun(null);
    }
  }, [autoScoreOnRun, buildRunInput, loadPack, selectedPackId]);

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
      let skipped = 0;
      for (const test of tests) {
        setActiveRun({ mode: "all", testId: test.testId, testCode: test.code });
        const { input, missingPlaceholders } = buildRunInput(test);
        if (missingPlaceholders.length > 0) {
          skipped += 1;
          continue;
        }
        const run = await runPromptPackTest(selectedPackId, test.testId, input);
        if (run.status === "failed") {
          failed += 1;
        } else if (run.status === "completed") {
          completed += 1;
          if (autoScoreOnRun) {
            await autoScorePromptPackTest(selectedPackId, test.testId, {
              runId: run.runId,
            });
            autoScored += 1;
          }
        }
      }
      await loadPack(selectedPackId);
      setSuccess(
        `Run all finished: ${completed} completed, ${failed} failed, ${skipped} skipped for missing placeholders.${autoScoreOnRun ? ` auto-scored ${autoScored}.` : ""}`,
      );
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
      const score = latestScoreByTest.get(test.testId);
      return run?.status === "completed" && !score;
    });
    const next = nextNotRun ?? nextFailed ?? nextUnscoredCompleted ?? tests[0];
    if (!next) {
      return;
    }
    await runOne(next, "next");
    setSelectedTestId(next.testId);
  }, [latestRunByTest, latestScoreByTest, runOne, selectedPackId, tests]);

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
      setSuccess(
        `Reset complete: removed ${result.deletedRuns} run(s) and ${result.deletedScores} score(s).`,
      );
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
        routingScore: scoreDraft.routingScore,
        honestyScore: scoreDraft.honestyScore,
        handoffScore: scoreDraft.handoffScore,
        robustnessScore: scoreDraft.robustnessScore,
        usabilityScore: scoreDraft.usabilityScore,
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
      setSuccess(`Auto-scored ${selectedTest.code}: ${result.score.totalScore}/10.`);
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

  const loadBenchmarkStatus = useCallback(async (runId: string) => {
    const status = await fetchPromptPackBenchmark(runId);
    setBenchmarkStatus(status);
    if (status.run.status === "completed" || status.run.status === "failed") {
      setBenchmarkPending(false);
      await loadPack(status.run.packId);
    } else {
      setBenchmarkPending(true);
    }
  }, [loadPack]);

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
      <header className="prompt-lab-header">
        <div>
          <h2>{pageCopy.promptLab.title}</h2>
          <p className="office-subtitle">{pageCopy.promptLab.subtitle}</p>
        </div>
        <div className="prompt-lab-actions">
          <ActionButton
            label="Run next test"
            pending={activeRun?.mode === "next"}
            disabled={running && activeRun?.mode !== "next"}
            onClick={() => void runNext()}
          />
          <ActionButton
            label="Run all"
            pending={activeRun?.mode === "all"}
            disabled={running && activeRun?.mode !== "all"}
            onClick={() => void runAll()}
          />
          <ActionButton
            label="Run benchmark"
            pending={benchmarkPending}
            disabled={!selectedPackId || running || importing}
            onClick={() => void runBenchmark()}
          />
          <ActionButton
            label="Refresh data"
            pending={isRefreshing}
            disabled={initialLoading}
            onClick={() => void load({ background: true })}
          />
          <ActionButton
            label="Auto score unscored"
            pending={autoScoring}
            disabled={!selectedPackId || unscoredCompletedCount === 0 || running}
            onClick={() => void autoScoreUnscored()}
          />
          <ActionButton
            label="Export now"
            pending={exporting}
            disabled={!selectedPackId || running || resetting}
            onClick={() => void exportReport()}
          />
          <ActionButton
            label="Reset pack"
            pending={resetting}
            disabled={!selectedPackId || running || exporting || importing || autoScoring}
            onClick={() => void resetPack()}
          />
        </div>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {success ? <p className="status-banner">{success}</p> : null}
      <p className="office-subtitle">
        Re-running a test creates a fresh run. Historical scores stay attached to older runs until you rescore the new output.
      </p>
      {activeRun ? (
        <div className="status-banner">
          Run in progress: {activeRun.testCode ?? "prompt-pack run"} ({activeRun.mode})
        </div>
      ) : null}
      {benchmarkStatus ? (
        <div className="status-banner">
          Benchmark {benchmarkStatus.run.benchmarkRunId}: {benchmarkStatus.run.status}
          {" "}({benchmarkStatus.progress.completedItems}/{benchmarkStatus.progress.totalItems})
        </div>
      ) : null}
      {isRefreshing ? (
        <div className="status-banner">Refreshing prompt-pack results in the background...</div>
      ) : null}
      {isFallbackRefreshing ? (
        <div className="status-banner warning">Live updates degraded, checking periodically.</div>
      ) : null}
      <div className="status-banner">
        <span style={{ marginRight: 12 }}>Reset options:</span>
        <label style={{ marginRight: 12 }}>
          <input
            type="checkbox"
            checked={resetClearRuns}
            onChange={(event) => setResetClearRuns(event.target.checked)}
            disabled={running || resetting || exporting || importing || autoScoring}
          />{" "}
          Clear runs
        </label>
        <label>
          <input
            type="checkbox"
            checked={resetClearScores}
            onChange={(event) => setResetClearScores(event.target.checked)}
            disabled={running || resetting || exporting || importing || autoScoring}
          />{" "}
          Clear scores
        </label>
      </div>
      <div className="status-banner warning">
        {autoScoreOnRun
          ? "Auto-score is ON (model + rule checks). You can still edit any score manually."
          : "Run status only confirms execution. Pass rate updates after scoring."}
        {unscoredCompletedCount > 0 ? ` ${unscoredCompletedCount} run(s) still need scoring.` : ""}
      </div>
      <div className="status-banner">
        Run failures: <strong>{testOutcomeSummary.runFailureCount}</strong>
        {" "} | Score failures: <strong>{testOutcomeSummary.scoreFailureCount}</strong>
        {" "} | Needs score: <strong>{testOutcomeSummary.needsScoreCount}</strong>
      </div>
      {exportInfo?.path ? (
        <div className="status-banner">
          Export file: <code>{exportInfo.path}</code>
          {exportInfo.updatedAt ? ` (updated ${new Date(exportInfo.updatedAt).toLocaleTimeString()})` : ""}
          {exportInfo.exists ? ` • ${exportInfo.sizeBytes} bytes` : " • not generated yet"}
          <button type="button" onClick={() => void copyExportPath()} style={{ marginLeft: 12 }}>
            Copy path
          </button>
        </div>
      ) : null}

      <div className="prompt-lab-grid">
        <article className="card prompt-lab-import">
          <h3>Import Prompt Pack</h3>
          <textarea
            rows={10}
            placeholder="Paste goatcitadel_prompt_pack.md content here..."
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
          />
          <ActionButton label="Import" pending={importing} onClick={() => void handleImport()} />
          <p className="office-subtitle">Tip: import once, then use Run next test to move quickly through the pack.</p>
        </article>

        <article className="card prompt-lab-packs">
          <h3>Prompt Packs</h3>
          <ul>
            {packs.map((pack) => (
              <li key={pack.packId}>
                <button
                  type="button"
                  className={selectedPackId === pack.packId ? "active" : ""}
                  onClick={() => setSelectedPackId(pack.packId)}
                >
                  {pack.name}
                </button>
                <span>{pack.testCount} tests</span>
              </li>
            ))}
          </ul>
          <div className="prompt-lab-model-picker">
            <p className="office-subtitle">
              {reuseLastModel && lastSuccessfulModel
                ? `Running with last successful model: ${lastSuccessfulModel.providerId}/${lastSuccessfulModel.model}`
                : selectedRunModel?.providerId
                  ? `Running with selected model: ${selectedRunModel.providerId}/${selectedRunModel.model ?? "(provider default)"}`
                  : "Select a provider/model for this prompt-pack run."}
            </p>
            <ChatModelPicker
              providers={providerOptions}
              providerId={selectedProviderId}
              model={selectedModel}
              disabled={running || providerOptions.length === 0}
              onChangeProvider={(providerId) => {
                setReuseLastModel(false);
                setSelectedProviderId(providerId);
                const provider = providerOptions.find((item) => item.providerId === providerId);
                setSelectedModel(provider?.models[0] ?? "");
              }}
              onChangeModel={(model) => {
                setReuseLastModel(false);
                setSelectedModel(model);
              }}
            />
          </div>
          <label className="prompt-lab-toggle">
            <input
              type="checkbox"
              checked={reuseLastModel}
              onChange={(event) => setReuseLastModel(event.target.checked)}
            />
            Reuse last successful model settings
          </label>
          <label className="prompt-lab-toggle">
            <input
              type="checkbox"
              checked={autoScoreOnRun}
              onChange={(event) => setAutoScoreOnRun(event.target.checked)}
            />
            Auto-score completed runs (model + rules)
          </label>
          <details className="prompt-lab-benchmark-panel">
            <summary>Benchmark matrix</summary>
            <p className="office-subtitle">
              Run a provider/model matrix on selected test codes (default high-signal subset).
            </p>
            <label style={{ display: "grid", gap: 4 }}>
              Test codes (comma or newline separated)
              <textarea
                rows={2}
                value={benchmarkTestCodes}
                onChange={(event) => setBenchmarkTestCodes(event.target.value)}
                placeholder="TEST-03, TEST-06, TEST-10, TEST-12, TEST-15, TEST-28"
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              Providers matrix (one per line: provider/model)
              <textarea
                rows={3}
                value={benchmarkProvidersInput}
                onChange={(event) => setBenchmarkProvidersInput(event.target.value)}
                placeholder={"glm/glm-5\nmoonshot/kimi-k2.5"}
              />
            </label>
            <div className="prompt-lab-actions">
              <ActionButton
                label="Start benchmark"
                pending={benchmarkPending}
                disabled={!selectedPackId || running}
                onClick={() => void runBenchmark()}
              />
              <ActionButton
                label="Refresh benchmark"
                disabled={!benchmarkRunId}
                onClick={() => {
                  if (!benchmarkRunId) return;
                  void loadBenchmarkStatus(benchmarkRunId).catch((err: Error) => setError(err.message));
                }}
              />
              <ActionButton
                label="Run replay regression"
                pending={regressionPending}
                disabled={!selectedPackId || running}
                onClick={() => void runRegression()}
              />
              <ActionButton
                label="Refresh regression"
                disabled={!regressionRunId}
                onClick={() => {
                  if (!regressionRunId) return;
                  void loadRegressionStatus(regressionRunId).catch((err: Error) => setError(err.message));
                }}
              />
            </div>
            {regressionStatus ? (
              <p className="office-subtitle">
                Replay regression: <code>{regressionStatus.run.regressionRunId}</code> • {regressionStatus.run.status}
                {" • "}
                results: {regressionStatus.results.length}
              </p>
            ) : null}
          </details>
        </article>
      </div>

      <div className="prompt-lab-grid">
        <article className="card prompt-lab-tests">
          <div className="prompt-lab-tests-header">
            <h3>Tests</h3>
            <label className="chat-v11-select">
              View
              <GCSelect
                value={testResultFilter}
                onChange={(value) => setTestResultFilter(value as TestResultFilter)}
                options={[
                  { value: "all", label: `All (${tests.length})` },
                  { value: "run_failed", label: `Run failures (${testOutcomeSummary.runFailureCount})` },
                  { value: "score_failed", label: `Score failures (${testOutcomeSummary.scoreFailureCount})` },
                  { value: "needs_score", label: `Needs score (${testOutcomeSummary.needsScoreCount})` },
                  { value: "not_run", label: `Not run (${testOutcomeSummary.notRunCount})` },
                  { value: "passing", label: `Passing (${testOutcomeSummary.passingCount})` },
                ]}
              />
            </label>
          </div>
          <ul>
            {filteredTests.map((test) => {
              const run = latestRunByTest.get(test.testId);
              const score = latestScoreByTest.get(test.testId);
              const categoryWithThreshold = classifyTestResultCategory(run, score, passThreshold);
              return (
                <li key={test.testId}>
                  <button
                    type="button"
                    className={selectedTestId === test.testId ? "active" : ""}
                    onClick={() => setSelectedTestId(test.testId)}
                  >
                    {test.code} - {test.title}
                  </button>
                  <div className="prompt-lab-test-meta">
                    <span className={`prompt-lab-chip ${statusChipClass(run?.status)}`}>{formatRunStatus(run?.status)}</span>
                    <span className={`prompt-lab-chip ${score ? "score-ready" : "score-missing"}`}>{score ? `${score.totalScore}/10` : "Needs score"}</span>
                    <span className={`prompt-lab-chip ${resultCategoryClass(categoryWithThreshold)}`}>{formatResultCategory(categoryWithThreshold)}</span>
                  </div>
                  <ActionButton
                    label="Run"
                    pending={activeRun?.testId === test.testId}
                    disabled={running && activeRun?.testId !== test.testId}
                    onClick={() => void runOne(test, "single")}
                  />
                </li>
              );
            })}
          </ul>
          {filteredTests.length === 0 ? (
            <p className="office-subtitle">No tests match this filter.</p>
          ) : null}
        </article>

        <article className="card prompt-lab-detail">
          <h3>{selectedTest ? `${selectedTest.code} - ${selectedTest.title}` : "Select a test"}</h3>
          {selectedTest ? <pre>{selectedTest.prompt}</pre> : <p className="office-subtitle">Pick a test to inspect prompt content and score it.</p>}
          {selectedTest && selectedPlaceholders.length > 0 ? (
            <section className="status-banner warning" style={{ marginBottom: 12 }}>
              <p style={{ marginTop: 0 }}>
                This test has placeholder tokens. Fill them before running.
              </p>
              <div style={{ display: "grid", gap: 8 }}>
                {selectedPlaceholders.map((placeholder) => {
                  const key = normalizePromptPlaceholderKey(placeholder);
                  return (
                    <label key={placeholder} style={{ display: "grid", gap: 4 }}>
                      {placeholder}
                      <input
                        value={placeholderValues[key] ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          setPlaceholderValues((current) => ({
                            ...current,
                            [key]: value,
                          }));
                        }}
                        placeholder={`Value for ${placeholder}`}
                      />
                    </label>
                  );
                })}
              </div>
              {selectedMissingPlaceholders.length > 0 ? (
                <p style={{ marginBottom: 0 }}>
                  Missing: {selectedMissingPlaceholders.join(", ")}
                </p>
              ) : (
                <p style={{ marginBottom: 0 }}>All placeholders set for this test.</p>
              )}
            </section>
          ) : null}
          {selectedRun ? (
            <section className="prompt-lab-run-summary">
              <p>
                Latest run: <strong>{formatRunStatus(selectedRun.status)}</strong>
                {selectedRun.providerId ? ` • ${selectedRun.providerId}` : ""}
                {selectedRun.model ? ` / ${selectedRun.model}` : ""}
                {selectedRun.runId ? ` • run ${selectedRun.runId}` : ""}
                {selectedRun.startedAt ? ` • started ${formatDateTime(selectedRun.startedAt)}` : ""}
                {selectedRun.finishedAt ? ` • finished ${formatDateTime(selectedRun.finishedAt)}` : ""}
              </p>
              {selectedRun.status === "failed" && selectedRun.error ? <p className="error">{selectedRun.error}</p> : null}
              {selectedRun.responseText ? (
                <details>
                  <summary>Assistant output</summary>
                  <pre>{selectedRun.responseText}</pre>
                </details>
              ) : null}
              {selectedRun.trace ? (
                <p className="office-subtitle">
                  Tools used: {selectedRun.trace.toolRuns.length}
                  {selectedRun.trace.routing?.fallbackUsed ? ` • fallback: ${selectedRun.trace.routing.fallbackModel ?? "model"}` : ""}
                </p>
              ) : null}
              {selectedRun.citations && selectedRun.citations.length > 0 ? (
                <p className="office-subtitle">Citations captured: {selectedRun.citations.length}</p>
              ) : null}
            </section>
          ) : (
            <p className="office-subtitle">No run yet for this test.</p>
          )}
          <div className="prompt-lab-score-grid">
            <ScoreField label="Routing" value={scoreDraft.routingScore} onChange={(value) => setScoreDraft((current) => ({ ...current, routingScore: value }))} />
            <ScoreField label="Honesty" value={scoreDraft.honestyScore} onChange={(value) => setScoreDraft((current) => ({ ...current, honestyScore: value }))} />
            <ScoreField label="Handoff" value={scoreDraft.handoffScore} onChange={(value) => setScoreDraft((current) => ({ ...current, handoffScore: value }))} />
            <ScoreField label="Robustness" value={scoreDraft.robustnessScore} onChange={(value) => setScoreDraft((current) => ({ ...current, robustnessScore: value }))} />
            <ScoreField label="Usability" value={scoreDraft.usabilityScore} onChange={(value) => setScoreDraft((current) => ({ ...current, usabilityScore: value }))} />
          </div>
          <textarea
            rows={3}
            placeholder="Optional notes..."
            value={scoreDraft.notes}
            onChange={(event) => setScoreDraft((current) => ({ ...current, notes: event.target.value }))}
          />
          <div className="prompt-lab-actions">
            <ActionButton label="Save score" pending={savingScore} onClick={() => void submitScore()} />
            <ActionButton
              label="Auto score this run"
              pending={autoScoring}
              disabled={!selectedRun || selectedRun.status !== "completed"}
              onClick={() => void autoScoreSelected()}
            />
          </div>
          {selectedRun?.status === "failed" ? (
            <div className="status-banner warning">
              Latest run failed. Try running again with web mode `quick`, then review trace and tool grants before scoring.
            </div>
          ) : null}
        </article>
      </div>

      {report ? (
        <article className="card prompt-lab-summary">
          <h3>Report</h3>
          <p>Total tests: {report.summary.totalTests}</p>
          <p>Executed runs: {report.summary.completedRuns}</p>
          <p>Failed runs: {report.summary.failedRuns}</p>
          <p>Scored runs: {report.scores.length}</p>
          <p>Run failures (execution/runtime): {testOutcomeSummary.runFailureCount}</p>
          <p>Score failures (completed but below threshold): {testOutcomeSummary.scoreFailureCount}</p>
          <p>Runs waiting for score: {testOutcomeSummary.needsScoreCount}</p>
          <p>Durable-backed latest runs: {report.summary.durableRuns ?? 0}</p>
          <p>Approval-paused latest runs: {report.summary.approvalPausedRuns ?? 0}</p>
          <p>Backgrounded latest runs: {report.summary.backgroundedRuns ?? 0}</p>
          <p>Passing tests: {testOutcomeSummary.passingCount}</p>
          <p>Average score: {report.summary.averageTotalScore.toFixed(2)}/10</p>
          <p>Pass rate: {(report.summary.passRate * 100).toFixed(1)}% (threshold {passThreshold}/10)</p>
          <p>Failing tests: {report.summary.failingCodes.length > 0 ? report.summary.failingCodes.join(", ") : "none"}</p>
          <p className="office-subtitle">
            Run failures indicate execution/runtime blockers. Score failures indicate model quality gaps on completed runs.
          </p>
          {benchmarkStatus ? (
            <section>
              <h4>Latest benchmark</h4>
              <p>
                Run: <code>{benchmarkStatus.run.benchmarkRunId}</code> • {benchmarkStatus.run.status}
                {" "}({benchmarkStatus.progress.completedItems}/{benchmarkStatus.progress.totalItems})
              </p>
              {benchmarkStatus.modelSummaries.length > 0 ? (
                <table className="prompt-lab-benchmark-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Pass rate</th>
                      <th>Avg score</th>
                      <th>Run failures</th>
                      <th>Top signals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {benchmarkStatus.modelSummaries.map((summary) => (
                      <tr key={`${summary.providerId}/${summary.model}`}>
                        <td>{summary.providerId}/{summary.model}</td>
                        <td>{(summary.passRate * 100).toFixed(1)}%</td>
                        <td>{summary.averageTotalScore.toFixed(2)}</td>
                        <td>{summary.runFailures}</td>
                        <td>
                          {summary.topFailureSignals.length > 0
                            ? summary.topFailureSignals.map((item) => `${item.signal} (${item.count})`).join(", ")
                            : "none"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="office-subtitle">No benchmark items recorded yet.</p>
              )}
            </section>
          ) : null}
          {regressionStatus ? (
            <section>
              <h4>Latest replay regression</h4>
              <p>
                Run: <code>{regressionStatus.run.regressionRunId}</code> • {regressionStatus.run.status}
                {regressionStatus.run.finishedAt ? ` • finished ${formatDateTime(regressionStatus.run.finishedAt)}` : ""}
              </p>
              {regressionStatus.run.error ? <p className="error">{regressionStatus.run.error}</p> : null}
              {regressionStatus.results.length > 0 ? (
                <table className="prompt-lab-benchmark-table">
                  <thead>
                    <tr>
                      <th>Test</th>
                      <th>Capability</th>
                      <th>Score Δ</th>
                      <th>Pass Δ</th>
                      <th>Latency Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regressionStatus.results.slice(0, 30).map((item) => (
                      <tr key={item.resultId}>
                        <td>{item.testCode}</td>
                        <td>{item.capability}</td>
                        <td>{item.scoreDelta.toFixed(2)}</td>
                        <td>{item.passDelta.toFixed(2)}</td>
                        <td>{Math.round(item.latencyDeltaMs)} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="office-subtitle">No regression results recorded yet.</p>
              )}
            </section>
          ) : null}
          {trendSeries.length > 0 ? (
            <section>
              <h4>Capability trend alerts</h4>
              <div className="token-row">
                {trendSeries.map((series) => (
                  <span
                    key={series.capability}
                    className={`token-chip${series.breached ? " token-chip-alert" : ""}`}
                  >
                    {series.capability}: {series.points.length > 0 ? series.points[series.points.length - 1]?.value.toFixed(2) : "n/a"}
                    {series.breached ? " (threshold breached)" : ""}
                  </span>
                ))}
              </div>
            </section>
          ) : null}
        </article>
      ) : null}
      <ConfirmModal
        open={confirmResetOpen}
        title="Reset Prompt Pack"
        message={`Reset this prompt pack? This will clear ${
          resetClearRuns && resetClearScores
            ? "run history and scores"
            : resetClearRuns
              ? "run history"
              : "scores"
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

function ScoreField(props: {
  label: string;
  value: 0 | 1 | 2;
  onChange: (value: 0 | 1 | 2) => void;
}) {
  return (
    <label className="chat-v11-select">
      {props.label}
      <GCSelect
        value={String(props.value)}
        onChange={(value) => props.onChange(Number(value) as 0 | 1 | 2)}
        options={[
          { value: "0", label: "0" },
          { value: "1", label: "1" },
          { value: "2", label: "2" },
        ]}
      />
    </label>
  );
}

function extractPromptPlaceholders(prompt: string): string[] {
  const matches = prompt.match(/<[^<>\n]{3,160}>/g) ?? [];
  const unique = new Set<string>();
  for (const match of matches) {
    const trimmed = match.trim();
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) {
      continue;
    }
    const looksLikePlaceholder = /[A-Z]{2,}/.test(inner)
      || /[_ ]/.test(inner)
      || /\b(PASTE|LOCAL|URL|TOPIC|PATH|EXAMPLE|YOUR)\b/i.test(inner);
    if (!looksLikePlaceholder) {
      continue;
    }
    unique.add(`<${inner}>`);
  }
  return Array.from(unique);
}

function normalizePromptPlaceholderKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  return inner.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseBenchmarkTestCodes(value: string): string[] {
  return dedupeStrings(
    value
      .split(/[\s,]+/g)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parseBenchmarkProviders(value: string): Array<{ providerId: string; model: string }> {
  const out: Array<{ providerId: string; model: string }> = [];
  const seen = new Set<string>();
  for (const rawLine of value.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const slash = line.indexOf("/");
    if (slash < 1 || slash === line.length - 1) {
      continue;
    }
    const providerId = line.slice(0, slash).trim();
    const model = line.slice(slash + 1).trim();
    if (!providerId || !model) {
      continue;
    }
    const key = `${providerId}/${model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ providerId, model });
  }
  return out;
}

function formatRunStatus(status?: PromptPackRunRecord["status"]): string {
  if (!status) return "Not run";
  if (status === "completed") return "Run completed";
  if (status === "failed") return "Run failed";
  return status;
}

function formatDateTime(value?: string): string {
  if (!value) {
    return "unknown";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusChipClass(status?: PromptPackRunRecord["status"]): string {
  if (!status) return "run-not-run";
  if (status === "completed") return "run-completed";
  if (status === "failed") return "run-failed";
  return "run-not-run";
}

function classifyTestResultCategory(
  run: PromptPackRunRecord | undefined,
  score: PromptPackScoreRecord | undefined,
  passThreshold = PROMPT_PACK_PASS_THRESHOLD,
): Exclude<TestResultFilter, "all"> {
  if (!run) {
    return "not_run";
  }
  if (run.status === "failed") {
    return "run_failed";
  }
  if (run.status !== "completed") {
    return "not_run";
  }
  if (!score) {
    return "needs_score";
  }
  return score.totalScore >= passThreshold ? "passing" : "score_failed";
}

function matchesTestResultFilter(
  filter: TestResultFilter,
  run: PromptPackRunRecord | undefined,
  score: PromptPackScoreRecord | undefined,
  passThreshold = PROMPT_PACK_PASS_THRESHOLD,
): boolean {
  if (filter === "all") {
    return true;
  }
  return classifyTestResultCategory(run, score, passThreshold) === filter;
}

function formatResultCategory(category: Exclude<TestResultFilter, "all">): string {
  if (category === "run_failed") return "Run failure";
  if (category === "score_failed") return "Score failure";
  if (category === "needs_score") return "Needs score";
  if (category === "passing") return "Passing";
  return "Not run";
}

function resultCategoryClass(category: Exclude<TestResultFilter, "all">): string {
  if (category === "run_failed") return "result-run-failed";
  if (category === "score_failed") return "result-score-failed";
  if (category === "needs_score") return "result-needs-score";
  if (category === "passing") return "result-passing";
  return "result-not-run";
}

const PROMPT_PACK_PASS_THRESHOLD = 7;

function dedupeStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
