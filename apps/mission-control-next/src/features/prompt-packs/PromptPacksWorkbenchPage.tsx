/* eslint-disable max-lines -- PromptPacksWorkbenchPage keeps the full quality workbench in one place until the page is split into smaller route-scoped panels. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PromptPackAutoScoreRecord,
  PromptPackBenchmarkStatusRecord,
  PromptPackExecutionStyle,
  PromptPackExportRecord,
  PromptPackScoringSchemaVersion,
  PromptPackLatestAssessmentRecordV2,
  PromptPackReportRecord,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ClipboardCopy,
  Download,
  FlaskConical,
  LoaderCircle,
  Play,
  RefreshCcw,
  RotateCcw,
  Sparkles,
  Upload,
} from "lucide-react";
import type { ChatModelProviderOption } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import {
  autoScorePromptPackBatch,
  autoScorePromptPackTest,
  cancelPromptPackBenchmark,
  exportPromptPackReport,
  fetchPromptPackBenchmark,
  fetchPromptPackExport,
  fetchPromptPackReplayRegressionStatus,
  fetchPromptPackReport,
  fetchPromptPacks,
  fetchPromptPackTests,
  fetchPromptPackTrends,
  importPromptPack,
  resetPromptPack,
  runPromptPackBenchmark,
  runPromptPackReplayRegression,
  runPromptPackTest,
  scorePromptPackTest,
} from "@goatcitadel/mission-control-shared/api/client";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { useRefreshSubscription } from "@goatcitadel/mission-control-shared/hooks/useRefreshSubscription";
import {
  PROMPT_PACK_PASS_THRESHOLD,
  classifyTestResultCategory,
  extractPromptPlaceholders,
  formatDateTime,
  formatPromptPackProviderModel,
  formatResultCategory,
  formatRunStatus,
  formatWeightedScore,
  matchesTestResultFilter,
  normalizePromptPlaceholderKey,
  parseBenchmarkProviders,
  parseBenchmarkTestCodes,
  resolvePromptLabActiveProvider,
  resolvePromptPackRunModelUsage,
  type TestResultFilter,
} from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-helpers";
import {
  DEFAULT_SCORE_DRAFT,
  type ActiveRunState,
  type ScoreDraft,
} from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-types";
import { buildAppHref, type AppRoute } from "@next/app/route-model";
import "./prompt-packs-workbench.css";

const DEFAULT_BENCHMARK_TEST_CODES = "TEST-03, TEST-06, TEST-10, TEST-12, TEST-15, TEST-28";

type DetailTab = "prompt" | "output" | "assessment" | "review" | "insights";

interface PromptPacksWorkbenchPageProps {
  workspaceId?: string;
  variant?: "library" | "ops";
  navigate?: (route: AppRoute, options?: { replace?: boolean }) => void;
}

export function PromptPacksWorkbenchPage({
  workspaceId: _workspaceId,
  variant = "library",
  navigate,
}: PromptPacksWorkbenchPageProps) {
  const isOpsVariant = variant === "ops";
  const v2UiEnabled = isPromptPackV2UiEnabled();
  const hasLoadedOnceRef = useRef(false);
  const selectedPackIdRef = useRef<string | null>(null);
  const exportedBenchmarkRunIdsRef = useRef<Set<string>>(new Set());
  const exportedRegressionRunIdsRef = useRef<Set<string>>(new Set());
  const [initialLoading, setInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFallbackRefreshing, setIsFallbackRefreshing] = useState(false);
  const [activeRun, setActiveRun] = useState<ActiveRunState | null>(null);
  const [savingScore, setSavingScore] = useState(false);
  const [autoScoring, setAutoScoring] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmResetArmed, setConfirmResetArmed] = useState(false);
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
  const [executionStyle, setExecutionStyle] = useState<PromptPackExecutionStyle>("single_turn_harness");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [benchmarkTestCodes, setBenchmarkTestCodes] = useState(DEFAULT_BENCHMARK_TEST_CODES);
  const [benchmarkProvidersInput, setBenchmarkProvidersInput] = useState("");
  const [benchmarkRunId, setBenchmarkRunId] = useState<string | null>(null);
  const [benchmarkStatus, setBenchmarkStatus] = useState<PromptPackBenchmarkStatusRecord | null>(null);
  const [benchmarkPending, setBenchmarkPending] = useState(false);
  const [benchmarkStopping, setBenchmarkStopping] = useState(false);
  const [regressionRunId, setRegressionRunId] = useState<string | null>(null);
  const [regressionPending, setRegressionPending] = useState(false);
  const [regressionStatus, setRegressionStatus] = useState<Awaited<
    ReturnType<typeof fetchPromptPackReplayRegressionStatus>
  > | null>(null);
  const [trendSeries, setTrendSeries] = useState<Awaited<ReturnType<typeof fetchPromptPackTrends>>["items"]>([]);
  const [exportInfo, setExportInfo] = useState<PromptPackExportRecord | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("prompt");
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

  const providerOptions = useMemo<ChatModelProviderOption[]>(
    () =>
      runtimeProviderCatalog
        .map((provider) => ({
          providerId: provider.providerId,
          label: provider.label,
          models: provider.models,
        }))
        .filter((provider) => provider.models.length > 0),
    [runtimeProviderCatalog],
  );

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

  const latestRunByTest = useMemo(() => buildLatestPromptPackRunByTest(report?.runs), [report?.runs]);

  const latestAssessmentByTest = useMemo(
    () => buildLatestPromptPackAssessmentByTest(report?.latestAssessments),
    [report?.latestAssessments],
  );

  const selectedTest = tests.find((item) => item.testId === selectedTestId) ?? null;
  const selectedRun = selectedTest ? latestRunByTest.get(selectedTest.testId) : undefined;
  const selectedAssessment = selectedTest ? latestAssessmentByTest.get(selectedTest.testId) : undefined;
  const selectedRunModelUsage = useMemo(() => resolvePromptPackRunModelUsage(selectedRun), [selectedRun]);
  const selectedRunRoute = useMemo(() => buildPromptPackRunRoute(selectedRun), [selectedRun]);
  const selectedRunHref = useMemo(() => (selectedRunRoute ? buildAppHref(selectedRunRoute) : null), [selectedRunRoute]);
  const selectedRunLink = useMemo(
    () =>
      buildPromptPackSelectedRunLink(
        selectedRunHref,
        typeof window === "undefined" ? undefined : window.location.origin,
      ),
    [selectedRunHref],
  );
  const latestSavedLogPath = exportInfo?.latestSnapshotPath ?? exportInfo?.path ?? "";
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

  const testOutcomeSummary = useMemo(
    () => summarizePromptPackTestOutcomes(tests, latestRunByTest, latestAssessmentByTest),
    [latestAssessmentByTest, latestRunByTest, tests],
  );

  const filteredTests = useMemo(
    () => filterPromptPackTestsByResult(tests, testResultFilter, latestRunByTest, latestAssessmentByTest),
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
        executionStyle?: PromptPackExecutionStyle;
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
          executionStyle,
          placeholderValues: Object.keys(resolvedPlaceholderValues).length > 0 ? resolvedPlaceholderValues : undefined,
        },
        missingPlaceholders,
      };
    },
    [executionStyle, placeholderValues, selectedRunModel],
  );

  const savePromptPackSnapshot = useCallback(async (packId: string): Promise<PromptPackExportRecord> => {
    const info = await exportPromptPackReport(packId);
    setExportInfo(info);
    return info;
  }, []);

  const runOne = useCallback(
    async (test: PromptPackTestRecord, mode: ActiveRunState["mode"] = "single") => {
      if (!selectedPackId) {
        return;
      }
      const { input, missingPlaceholders } = buildRunInput(test);
      if (missingPlaceholders.length > 0) {
        setError(`Missing placeholder values for ${test.code}: ${missingPlaceholders.join(", ")}.`);
        setDetailTab("prompt");
        return;
      }
      setActiveRun({ mode, testId: test.testId, testCode: test.code });
      setError(null);
      setSuccess(null);
      try {
        const run = await runPromptPackTest(selectedPackId, test.testId, input);
        let autoScoreSummary = "";
        let autoScoreError: string | null = null;
        let savedLogPath = "";
        let exportError: string | null = null;
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
        try {
          const exportRecord = await savePromptPackSnapshot(selectedPackId);
          savedLogPath = exportRecord.latestSnapshotPath ?? exportRecord.path;
        } catch (err) {
          exportError = (err as Error).message;
        }
        await loadPack(selectedPackId);
        setSelectedTestId(test.testId);
        setDetailTab(run.status === "completed" ? "output" : "assessment");
        if (run.status === "failed") {
          setError(`Ran ${test.code}, but it failed: ${run.error ?? "Unknown error"}`);
        } else if (autoScoreError) {
          setSuccess(`Ran ${test.code}.${savedLogPath ? ` Saved log to ${savedLogPath}.` : ""}`);
          setError(`Ran ${test.code}, but auto-score failed: ${autoScoreError}`);
        } else if (exportError) {
          setSuccess(`Ran ${test.code}.${autoScoreSummary}`);
          setError(`Ran ${test.code}, but saving the run log failed: ${exportError}`);
        } else {
          setSuccess(`Ran ${test.code}.${autoScoreSummary}${savedLogPath ? ` Saved log to ${savedLogPath}.` : ""}`);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setActiveRun(null);
      }
    },
    [autoScoreOnRun, buildRunInput, loadPack, savePromptPackSnapshot, selectedPackId],
  );

  const loadBenchmarkStatus = useCallback(
    async (runId: string) => {
      const status = await fetchPromptPackBenchmark(runId);
      setBenchmarkStatus(status);
      const terminal =
        status.run.status === "completed" || status.run.status === "failed" || status.run.status === "cancelled";
      if (terminal) {
        setBenchmarkPending(false);
        await loadPack(status.run.packId);
        if (!exportedBenchmarkRunIdsRef.current.has(status.run.benchmarkRunId)) {
          exportedBenchmarkRunIdsRef.current.add(status.run.benchmarkRunId);
          try {
            const exportRecord = await savePromptPackSnapshot(status.run.packId);
            setSuccess(
              `Benchmark ${status.run.status}: ${status.run.benchmarkRunId}. Saved log to ${exportRecord.latestSnapshotPath ?? exportRecord.path}.`,
            );
          } catch (err) {
            setError(`Benchmark ${status.run.status}, but saving the run log failed: ${(err as Error).message}`);
          }
        }
      } else {
        setBenchmarkPending(true);
      }
    },
    [loadPack, savePromptPackSnapshot],
  );

  const runAll = useCallback(async () => {
    if (!selectedPackId || tests.length === 0) {
      return;
    }
    const providerId = selectedRunModel?.providerId;
    const model = selectedRunModel?.model ?? selectedModel;
    if (!providerId || !model) {
      setError("Run all needs a selected provider/model lane.");
      return;
    }
    const runnableTests = tests.filter((test) => buildRunInput(test).missingPlaceholders.length === 0);
    const skipped = tests.length - runnableTests.length;
    if (runnableTests.length === 0) {
      setError("Run all has no runnable tests because required placeholder values are missing.");
      setDetailTab("prompt");
      return;
    }
    setBenchmarkPending(true);
    setActiveRun(null);
    setError(null);
    setSuccess(null);
    try {
      const benchmarkInput = {
        ...(skipped === 0 ? { allTests: true } : { testCodes: runnableTests.map((test) => test.code) }),
        providers: [{ providerId, model }],
        executionStyle,
      };
      const started = await runPromptPackBenchmark(selectedPackId, benchmarkInput);
      setBenchmarkRunId(started.benchmarkRunId);
      await loadBenchmarkStatus(started.benchmarkRunId);
      setSuccess(
        `Run all started in background: ${started.benchmarkRunId}.${skipped > 0 ? ` Skipped ${skipped} placeholder-bound test(s).` : ""}`,
      );
      setDetailTab("insights");
    } catch (err) {
      setBenchmarkPending(false);
      setError((err as Error).message);
    }
  }, [buildRunInput, executionStyle, loadBenchmarkStatus, selectedModel, selectedPackId, selectedRunModel, tests]);

  const runNext = useCallback(async () => {
    if (!selectedPackId || tests.length === 0) {
      return;
    }
    const next = chooseNextPromptPackTest(tests, latestRunByTest, latestAssessmentByTest);
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
      const info = await savePromptPackSnapshot(selectedPackId);
      setSuccess(`Saved prompt-pack log to ${info.latestSnapshotPath ?? info.path}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  }, [savePromptPackSnapshot, selectedPackId]);

  const confirmResetPack = useCallback(async () => {
    if (!selectedPackId) {
      return;
    }
    if (!resetClearRuns && !resetClearScores) {
      setError("Select at least one reset option (runs or scores).");
      return;
    }
    setResetting(true);
    setError(null);
    try {
      const result = await resetPromptPack(selectedPackId, {
        clearRuns: resetClearRuns,
        clearScores: resetClearScores,
      });
      await loadPack(selectedPackId);
      setSuccess(`Reset complete: removed ${result.deletedRuns} run(s) and ${result.deletedScores} score(s).`);
      setConfirmResetArmed(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResetting(false);
    }
  }, [loadPack, resetClearRuns, resetClearScores, selectedPackId]);

  const copyExportPath = useCallback(async () => {
    if (!latestSavedLogPath) {
      return;
    }
    try {
      await navigator.clipboard.writeText(latestSavedLogPath);
      setSuccess("Copied saved log path.");
    } catch {
      setError("Failed to copy saved log path.");
    }
  }, [latestSavedLogPath]);

  const openSelectedRun = useCallback(() => {
    if (!selectedRunRoute || !navigate) {
      return;
    }
    navigate(selectedRunRoute);
  }, [navigate, selectedRunRoute]);

  const copySelectedRunLink = useCallback(async () => {
    if (!selectedRunLink) {
      return;
    }
    try {
      await navigator.clipboard.writeText(selectedRunLink);
      setSuccess("Copied run link.");
      setError(null);
    } catch {
      setError("Failed to copy run link.");
    }
  }, [selectedRunLink]);

  const submitScore = useCallback(async () => {
    if (!selectedPackId || !selectedTest || !selectedRun) {
      return;
    }
    setSavingScore(true);
    setError(null);
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
      setSuccess(`Saved review for ${selectedTest.code}.`);
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
    try {
      const result = await autoScorePromptPackTest(selectedPackId, selectedTest.testId, {
        runId: selectedRun.runId,
        force: true,
      });
      await loadPack(selectedPackId);
      setSuccess(
        `Auto-scored ${selectedTest.code}: ${formatWeightedScore(result.score.weightedScore)} (${result.score.autoVerdict}).`,
      );
      setDetailTab("assessment");
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
    try {
      const started = await runPromptPackBenchmark(selectedPackId, { testCodes, providers, executionStyle });
      setBenchmarkRunId(started.benchmarkRunId);
      await loadBenchmarkStatus(started.benchmarkRunId);
      setSuccess(`Benchmark started: ${started.benchmarkRunId}`);
      setDetailTab("insights");
    } catch (err) {
      setBenchmarkPending(false);
      setError((err as Error).message);
    }
  }, [benchmarkProvidersInput, benchmarkTestCodes, executionStyle, loadBenchmarkStatus, selectedPackId]);

  const loadTrends = useCallback(async (packId: string) => {
    const response = await fetchPromptPackTrends(packId);
    setTrendSeries(response.items);
  }, []);

  const loadRegressionStatus = useCallback(
    async (runId: string) => {
      const status = await fetchPromptPackReplayRegressionStatus(runId);
      setRegressionStatus(status);
      if (status.run.status !== "queued" && status.run.status !== "running") {
        setRegressionPending(false);
        if (selectedPackId && !exportedRegressionRunIdsRef.current.has(status.run.regressionRunId)) {
          exportedRegressionRunIdsRef.current.add(status.run.regressionRunId);
          try {
            const exportRecord = await savePromptPackSnapshot(selectedPackId);
            setSuccess(
              `Replay regression ${status.run.status}: ${status.run.regressionRunId}. Saved log to ${exportRecord.latestSnapshotPath ?? exportRecord.path}.`,
            );
          } catch (err) {
            setError(
              `Replay regression ${status.run.status}, but saving the run log failed: ${(err as Error).message}`,
            );
          }
        }
      }
    },
    [savePromptPackSnapshot, selectedPackId],
  );

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
    try {
      const started = await runPromptPackReplayRegression(selectedPackId, {
        testCodes,
        baselineRef: benchmarkRunId ?? undefined,
      });
      setRegressionRunId(started.regressionRunId);
      await loadRegressionStatus(started.regressionRunId);
      setSuccess(`Replay regression started: ${started.regressionRunId}`);
      setDetailTab("insights");
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

  const stopBenchmark = useCallback(async () => {
    if (!benchmarkRunId) {
      return;
    }
    setBenchmarkStopping(true);
    setError(null);
    try {
      const status = await cancelPromptPackBenchmark(benchmarkRunId);
      setBenchmarkStatus(status);
      setBenchmarkPending(false);
      await loadPack(status.run.packId);
      setSuccess(`Benchmark stopped: ${status.run.benchmarkRunId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBenchmarkStopping(false);
    }
  }, [benchmarkRunId, loadPack]);

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
    try {
      const imported = await importPromptPack({
        content,
        sourceLabel: isOpsVariant ? "ops-workbench" : "manual-import",
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
  }, [importText, load, variant]);

  const selectedPack = packs.find((pack) => pack.packId === selectedPackId) ?? null;
  const selectedCategory = classifyTestResultCategory(selectedRun, selectedAssessment);
  const selectedAutoScore = selectedAssessment?.autoScore;
  const selectedLegacyScore = selectedAssessment?.legacyScore;
  const selectedHumanReview = selectedAssessment?.humanReview;
  const completedDraftDimensions = DIMENSION_ROWS.filter(({ key }) => scoreDraft[key] !== null).length;
  const draftWeightedScore = computeDraftWeightedScore(scoreDraft);
  const draftVerdict = computeDraftVerdict(scoreDraft, scoreDraft.overrideVerdict);
  const executionStyleDescription =
    executionStyle === "agentic_surface"
      ? "Agentic uses the real surface orchestration preset for the selected Chat, Cowork, or Code mode."
      : "Harness uses the deterministic single-turn Prompt Lab wrapper.";
  const selectedDiagnosticMetadata = selectedRun?.diagnosticMetadata ?? selectedTest?.diagnosticMetadata;

  const summaryCards = [
    {
      label: "Selected pack",
      value: selectedPack?.name ?? "No pack selected",
      detail: selectedPack
        ? `${selectedPack.testCount} tests loaded`
        : isOpsVariant
          ? "Select a pack to begin."
          : "Import or select a pack to begin.",
    },
    {
      label: "Coverage",
      value: `${tests.length - testOutcomeSummary.notRunCount}/${tests.length || 0}`,
      detail: tests.length > 0 ? `${testOutcomeSummary.notRunCount} not run` : "No tests loaded",
    },
    {
      label: "Pass rate",
      value: report ? `${(report.summary.passRate * 100).toFixed(1)}%` : "No report yet",
      detail: report
        ? `${report.summary.averageWeightedScore.toFixed(1)}/100 average`
        : "Run and score a pack to generate the scorecard.",
    },
    {
      label: "Model lane",
      value:
        reuseLastModel && lastSuccessfulModel
          ? `${lastSuccessfulModel.providerId}/${lastSuccessfulModel.model}`
          : selectedRunModel?.providerId
            ? `${selectedRunModel.providerId}/${selectedRunModel.model ?? "provider default"}`
            : "Not configured",
      detail: activeRun
        ? `Running ${activeRun.testCode ?? "pack flow"}`
        : unscoredCompletedCount > 0
          ? `${unscoredCompletedCount} completed run(s) need scoring`
          : "Ready for the next pass.",
    },
    {
      label: "Execution style",
      value: formatPromptPackExecutionStyle(executionStyle),
      detail: executionStyle === "agentic_surface" ? "Surface presets enabled" : "Harness wrapper active",
    },
  ];

  const title = isOpsVariant ? "Quality workbench" : "Prompt packs";
  const subtitle = isOpsVariant
    ? "Run quality checks, compare regressions, and keep evidence focused on the selected case."
    : "Manage packs, run tests, and review one selected case at a time.";

  if (initialLoading) {
    return (
      <section className="mc-prompt-packs">
        <div className="mc-pp-loading-shell">
          <div className="mc-pp-loading-block" />
          <div className="mc-pp-loading-grid">
            <div className="mc-pp-loading-block" />
            <div className="mc-pp-loading-block" />
            <div className="mc-pp-loading-block" />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mc-prompt-packs" data-variant={variant}>
      <header className="mc-pp-hero">
        <div className="mc-pp-hero-copy">
          <p className="mc-pp-kicker">{isOpsVariant ? "Quality" : "Prompt Packs"}</p>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <div className="mc-pp-hero-actions">
          <button
            type="button"
            className="mc-next-button"
            onClick={() => void runNext()}
            disabled={!selectedPackId || tests.length === 0 || running}
          >
            {activeRun?.mode === "next" ? <LoaderCircle size={16} className="mc-spin" /> : <Play size={16} />}
            Run next
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-secondary"
            onClick={() => void runAll()}
            disabled={!selectedPackId || tests.length === 0 || running || benchmarkActive}
          >
            {benchmarkActive ? <LoaderCircle size={16} className="mc-spin" /> : <Sparkles size={16} />}
            Run all
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-secondary"
            onClick={() => void autoScoreUnscored()}
            disabled={!selectedPackId || unscoredCompletedCount === 0 || autoScoring || running}
          >
            {autoScoring ? <LoaderCircle size={16} className="mc-spin" /> : <BarChart3 size={16} />}
            Auto-score
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-ghost"
            onClick={() => void load({ background: true })}
            disabled={isRefreshing}
          >
            {isRefreshing ? <LoaderCircle size={16} className="mc-spin" /> : <RefreshCcw size={16} />}
            Refresh
          </button>
        </div>
      </header>

      <section className="mc-pp-summary-row" aria-label="Prompt pack overview">
        {summaryCards.map((card) => (
          <article key={card.label} className="mc-pp-summary-card">
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.detail}</p>
          </article>
        ))}
      </section>

      {error ? (
        <div className="mc-pp-alert danger" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      ) : null}
      {success ? (
        <div className="mc-pp-alert success" role="status">
          <CheckCircle2 size={16} />
          <span>{success}</span>
        </div>
      ) : null}

      {activeRun || benchmarkStatus || regressionStatus || isFallbackRefreshing ? (
        <section className="mc-pp-status-row" aria-label="Prompt pack status">
          {activeRun ? (
            <div className="mc-pp-status-pill">
              <LoaderCircle size={14} className="mc-spin" />
              <span>
                Running {activeRun.testCode ?? "prompt-pack flow"} in {activeRun.mode} mode
              </span>
            </div>
          ) : null}
          {benchmarkStatus ? (
            <div className="mc-pp-status-pill">
              <FlaskConical size={14} />
              <span>
                Benchmark {benchmarkStatus.run.status} {benchmarkStatus.progress.completedItems}/
                {benchmarkStatus.progress.totalItems}
              </span>
            </div>
          ) : null}
          {regressionStatus ? (
            <div className="mc-pp-status-pill">
              <RotateCcw size={14} />
              <span>Replay regression {regressionStatus.run.status}</span>
            </div>
          ) : null}
          {isFallbackRefreshing ? (
            <div className="mc-pp-status-pill">
              <AlertTriangle size={14} />
              <span>Live updates degraded, polling periodically.</span>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="mc-pp-layout">
        <aside className="mc-pp-sidebar">
          <section className="mc-pp-panel">
            <div className="mc-pp-section-heading">
              <div>
                <h4>Pack library</h4>
                <p>
                  {isOpsVariant
                    ? "Switch packs without leaving the active quality review."
                    : "Stay on one pack while you work through tests and reviews."}
                </p>
              </div>
              <ClipboardCopy size={16} />
            </div>
            <div className="mc-pp-pack-list" role="list" aria-label="Prompt packs">
              {packs.map((pack) => (
                <button
                  key={pack.packId}
                  type="button"
                  className={`mc-pp-pack-item${selectedPackId === pack.packId ? " active" : ""}`}
                  onClick={() => {
                    setSelectedPackId(pack.packId);
                    setDetailTab("prompt");
                  }}
                >
                  <span className="mc-pp-pack-copy">
                    <strong>{pack.name}</strong>
                    <span>{pack.testCount} tests</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          {isOpsVariant ? (
            <details className="mc-pp-panel mc-pp-panel-collapsible">
              <summary>
                <div>
                  <h4>Execution lane</h4>
                  <p>Adjust provider, model, and scoring defaults only when the next pass needs a different lane.</p>
                </div>
                <Sparkles size={16} />
              </summary>
              <div className="mc-pp-advanced-grid">
                <label className="mc-pp-field">
                  <span>Provider</span>
                  <select
                    value={selectedProviderId}
                    onChange={(event) => {
                      setReuseLastModel(false);
                      setSelectedProviderId(event.target.value);
                      const provider = providerOptions.find((item) => item.providerId === event.target.value);
                      setSelectedModel(provider?.models[0] ?? "");
                    }}
                  >
                    {providerOptions.map((provider) => (
                      <option key={provider.providerId} value={provider.providerId}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="mc-pp-field">
                  <span>Model</span>
                  <select
                    value={selectedModel}
                    onChange={(event) => {
                      setReuseLastModel(false);
                      setSelectedModel(event.target.value);
                    }}
                  >
                    {(providerOptions.find((provider) => provider.providerId === selectedProviderId)?.models ?? []).map(
                      (model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="mc-pp-toggle">
                  <input
                    type="checkbox"
                    checked={reuseLastModel}
                    onChange={(event) => setReuseLastModel(event.target.checked)}
                  />
                  <span>Reuse the last successful model lane when available</span>
                </label>
                <label className="mc-pp-toggle">
                  <input
                    type="checkbox"
                    checked={autoScoreOnRun}
                    onChange={(event) => setAutoScoreOnRun(event.target.checked)}
                  />
                  <span>Auto-score completed runs after execution</span>
                </label>
                <div className="mc-pp-field">
                  <span>Execution style</span>
                  <div className="mc-pp-filter-row" role="radiogroup" aria-label="Prompt pack execution style">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={executionStyle === "single_turn_harness"}
                      className={`mc-pp-filter-chip${executionStyle === "single_turn_harness" ? " active" : ""}`}
                      onClick={() => setExecutionStyle("single_turn_harness")}
                    >
                      Harness
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={executionStyle === "agentic_surface"}
                      className={`mc-pp-filter-chip${executionStyle === "agentic_surface" ? " active" : ""}`}
                      onClick={() => setExecutionStyle("agentic_surface")}
                    >
                      Agentic
                    </button>
                  </div>
                </div>
                <p className="mc-pp-note">
                  {reuseLastModel && lastSuccessfulModel
                    ? `Reusing ${lastSuccessfulModel.providerId}/${lastSuccessfulModel.model}.`
                    : selectedRunModel?.providerId
                      ? `New runs request ${selectedRunModel.providerId}/${selectedRunModel.model ?? "provider default"}.`
                      : "Select a provider and model to start running this pack."}{" "}
                  {executionStyleDescription}
                </p>
              </div>
            </details>
          ) : (
            <section className="mc-pp-panel">
              <div className="mc-pp-section-heading">
                <div>
                  <h4>Run settings</h4>
                  <p>Set the model lane for the next run, then stay focused on the selected test.</p>
                </div>
                <Sparkles size={16} />
              </div>
              <label className="mc-pp-field">
                <span>Provider</span>
                <select
                  value={selectedProviderId}
                  onChange={(event) => {
                    setReuseLastModel(false);
                    setSelectedProviderId(event.target.value);
                    const provider = providerOptions.find((item) => item.providerId === event.target.value);
                    setSelectedModel(provider?.models[0] ?? "");
                  }}
                >
                  {providerOptions.map((provider) => (
                    <option key={provider.providerId} value={provider.providerId}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mc-pp-field">
                <span>Model</span>
                <select
                  value={selectedModel}
                  onChange={(event) => {
                    setReuseLastModel(false);
                    setSelectedModel(event.target.value);
                  }}
                >
                  {(providerOptions.find((provider) => provider.providerId === selectedProviderId)?.models ?? []).map(
                    (model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="mc-pp-toggle">
                <input
                  type="checkbox"
                  checked={reuseLastModel}
                  onChange={(event) => setReuseLastModel(event.target.checked)}
                />
                <span>Reuse the last successful model lane when available</span>
              </label>
              <label className="mc-pp-toggle">
                <input
                  type="checkbox"
                  checked={autoScoreOnRun}
                  onChange={(event) => setAutoScoreOnRun(event.target.checked)}
                />
                <span>Auto-score completed runs after execution</span>
              </label>
              <div className="mc-pp-field">
                <span>Execution style</span>
                <div className="mc-pp-filter-row" role="radiogroup" aria-label="Prompt pack execution style">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={executionStyle === "single_turn_harness"}
                    className={`mc-pp-filter-chip${executionStyle === "single_turn_harness" ? " active" : ""}`}
                    onClick={() => setExecutionStyle("single_turn_harness")}
                  >
                    Harness
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={executionStyle === "agentic_surface"}
                    className={`mc-pp-filter-chip${executionStyle === "agentic_surface" ? " active" : ""}`}
                    onClick={() => setExecutionStyle("agentic_surface")}
                  >
                    Agentic
                  </button>
                </div>
              </div>
              <p className="mc-pp-note">
                {reuseLastModel && lastSuccessfulModel
                  ? `Reusing ${lastSuccessfulModel.providerId}/${lastSuccessfulModel.model}.`
                  : selectedRunModel?.providerId
                    ? `New runs request ${selectedRunModel.providerId}/${selectedRunModel.model ?? "provider default"}.`
                    : "Select a provider and model to start running this pack."}{" "}
                {executionStyleDescription}
              </p>
            </section>
          )}

          <details className="mc-pp-panel mc-pp-panel-collapsible">
            <summary>
              <div>
                <h4>Advanced quality ops</h4>
                <p>Benchmark, replay, export, and reset stay nearby without crowding the default view.</p>
              </div>
            </summary>
            <div className="mc-pp-advanced-grid">
              <label className="mc-pp-field">
                <span>Test codes</span>
                <textarea
                  rows={2}
                  value={benchmarkTestCodes}
                  onChange={(event) => setBenchmarkTestCodes(event.target.value)}
                  placeholder="TEST-03, TEST-06, TEST-10"
                />
              </label>
              <label className="mc-pp-field">
                <span>Benchmark matrix</span>
                <textarea
                  rows={4}
                  value={benchmarkProvidersInput}
                  onChange={(event) => setBenchmarkProvidersInput(event.target.value)}
                  placeholder={"openai/gpt-5.4-mini\nmoonshot/kimi-k2.5"}
                />
              </label>
              <div className="mc-pp-inline-actions wrap">
                <button
                  type="button"
                  className="mc-next-button mc-next-button-secondary"
                  onClick={() => void runBenchmark()}
                  disabled={!selectedPackId || running || benchmarkPending}
                >
                  {benchmarkPending ? <LoaderCircle size={16} className="mc-spin" /> : <FlaskConical size={16} />}
                  Start benchmark
                </button>
                <button
                  type="button"
                  className="mc-next-button mc-next-button-secondary"
                  onClick={() => void stopBenchmark()}
                  disabled={!benchmarkActive || benchmarkStopping}
                >
                  {benchmarkStopping ? <LoaderCircle size={16} className="mc-spin" /> : <RotateCcw size={16} />}
                  Stop
                </button>
                <button
                  type="button"
                  className="mc-next-button mc-next-button-ghost"
                  onClick={refreshBenchmark}
                  disabled={!benchmarkRunId}
                >
                  <RefreshCcw size={16} />
                  Refresh benchmark
                </button>
                <button
                  type="button"
                  className="mc-next-button mc-next-button-secondary"
                  onClick={() => void runRegression()}
                  disabled={!selectedPackId || running || regressionPending}
                >
                  {regressionPending ? <LoaderCircle size={16} className="mc-spin" /> : <RotateCcw size={16} />}
                  Replay regression
                </button>
                <button
                  type="button"
                  className="mc-next-button mc-next-button-ghost"
                  onClick={refreshRegression}
                  disabled={!regressionRunId}
                >
                  <RefreshCcw size={16} />
                  Refresh replay
                </button>
              </div>
              <div className="mc-pp-inline-actions wrap">
                <button
                  type="button"
                  className="mc-next-button mc-next-button-secondary"
                  onClick={() => void exportReport()}
                  disabled={!selectedPackId || exporting || running}
                >
                  {exporting ? <LoaderCircle size={16} className="mc-spin" /> : <Download size={16} />}
                  Export report
                </button>
                <button
                  type="button"
                  className="mc-next-button mc-next-button-ghost"
                  onClick={() => void copyExportPath()}
                  disabled={!latestSavedLogPath}
                >
                  <ClipboardCopy size={16} />
                  Copy saved log path
                </button>
              </div>
              <div className="mc-pp-reset-box">
                <div className="mc-pp-reset-options">
                  <label className="mc-pp-toggle">
                    <input
                      type="checkbox"
                      checked={resetClearRuns}
                      onChange={(event) => setResetClearRuns(event.target.checked)}
                    />
                    <span>Clear runs</span>
                  </label>
                  <label className="mc-pp-toggle">
                    <input
                      type="checkbox"
                      checked={resetClearScores}
                      onChange={(event) => setResetClearScores(event.target.checked)}
                    />
                    <span>Clear scores</span>
                  </label>
                </div>
                {!confirmResetArmed ? (
                  <button
                    type="button"
                    className="mc-next-button mc-next-button-danger"
                    onClick={() => setConfirmResetArmed(true)}
                    disabled={!selectedPackId || resetting}
                  >
                    <AlertTriangle size={16} />
                    Reset pack
                  </button>
                ) : (
                  <div className="mc-pp-reset-confirm">
                    <p>Reset this pack now? This clears the selected history based on the toggles above.</p>
                    <div className="mc-pp-inline-actions wrap">
                      <button
                        type="button"
                        className="mc-next-button mc-next-button-danger"
                        onClick={() => void confirmResetPack()}
                        disabled={resetting}
                      >
                        {resetting ? <LoaderCircle size={16} className="mc-spin" /> : <AlertTriangle size={16} />}
                        Confirm reset
                      </button>
                      <button
                        type="button"
                        className="mc-next-button mc-next-button-ghost"
                        onClick={() => setConfirmResetArmed(false)}
                        disabled={resetting}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {exportInfo?.path ? (
                <p className="mc-pp-note">
                  Export file: <code>{exportInfo.path}</code>
                  {exportInfo.updatedAt ? ` • updated ${formatDateTime(exportInfo.updatedAt)}` : ""}
                  {exportInfo.exists ? ` • ${exportInfo.sizeBytes} bytes` : " • not generated yet"}
                </p>
              ) : null}
            </div>
          </details>

          {!isOpsVariant ? (
            <details className="mc-pp-panel mc-pp-panel-collapsible">
              <summary>
                <div>
                  <h4>Import a new pack</h4>
                  <p>Open only when you want to paste fresh prompt-pack markdown into the workspace.</p>
                </div>
                <Upload size={16} />
              </summary>
              <label className="mc-pp-field">
                <span>Prompt-pack markdown</span>
                <textarea
                  rows={7}
                  placeholder="Paste prompt-pack markdown here..."
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                />
              </label>
              <div className="mc-pp-inline-actions">
                <button
                  type="button"
                  className="mc-next-button"
                  onClick={() => void handleImport()}
                  disabled={importing}
                >
                  {importing ? <LoaderCircle size={16} className="mc-spin" /> : <Upload size={16} />}
                  Import pack
                </button>
              </div>
            </details>
          ) : null}
        </aside>

        <section className="mc-pp-tests-column">
          <div className="mc-pp-section-heading">
            <div>
              <h4>Tests</h4>
              <p>
                {filteredTests.length} visible of {tests.length}
                {selectedPack ? ` in ${selectedPack.name}` : ""}
              </p>
            </div>
          </div>
          <div className="mc-pp-filter-row" role="tablist" aria-label="Prompt pack test filters">
            {FILTER_OPTIONS.map((option) => {
              const count = option.count(testOutcomeSummary, tests.length);
              const active = testResultFilter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`mc-pp-filter-chip${active ? " active" : ""}`}
                  onClick={() => setTestResultFilter(option.value)}
                >
                  <span>{option.label}</span>
                  <strong>{count}</strong>
                </button>
              );
            })}
          </div>
          <div className="mc-pp-test-list" role="list" aria-label="Prompt pack tests">
            {filteredTests.map((test) => {
              const run = latestRunByTest.get(test.testId);
              const assessment = latestAssessmentByTest.get(test.testId);
              const category = classifyTestResultCategory(run, assessment);
              const score = assessment?.autoScore;
              const selected = selectedTestId === test.testId;
              return (
                <article
                  key={test.testId}
                  className={`mc-pp-test-row${selected ? " active" : ""}`}
                  data-category={category}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    className="mc-pp-test-select"
                    onClick={() => {
                      setSelectedTestId(test.testId);
                      setDetailTab("prompt");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedTestId(test.testId);
                        setDetailTab("prompt");
                      }
                    }}
                  >
                    <span className="mc-pp-test-select-content">
                      <span className={`mc-pp-status-dot ${resultCategoryClass(category)}`} aria-hidden="true" />
                      <span className="mc-pp-test-copy">
                        <span className="mc-pp-test-headline">
                          <span className="mc-pp-test-code">{test.code}</span>
                          <span className={`mc-pp-chip ${statusChipClass(run?.status)}`}>
                            {formatRunStatus(run?.status)}
                          </span>
                        </span>
                        <strong>{test.title}</strong>
                        <span className="mc-pp-test-meta">
                          <span
                            className={`mc-pp-chip ${score || assessment?.legacyScore ? "score-ready" : "score-missing"}`}
                          >
                            {score
                              ? `${formatWeightedScore(score.weightedScore)} • ${assessment?.effectiveVerdict ?? score.autoVerdict}`
                              : assessment?.legacyScore
                                ? `Legacy ${assessment.legacyScore.totalScore}/10`
                                : "Needs score"}
                          </span>
                          {formatResultCategory(category) !== formatRunStatus(run?.status) ? (
                            <span className={`mc-pp-chip ${resultCategoryClass(category)}`}>
                              {formatResultCategory(category)}
                            </span>
                          ) : null}
                          {test.diagnosticMetadata?.capabilityTargets.slice(0, 2).map((target) => (
                            <span key={target} className="mc-pp-chip diagnostic">
                              {target}
                            </span>
                          ))}
                        </span>
                      </span>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="mc-next-button mc-next-button-secondary mc-pp-run-button"
                    onClick={() => void runOne(test, "single")}
                    disabled={running && activeRun?.testId !== test.testId}
                  >
                    {activeRun?.testId === test.testId ? (
                      <LoaderCircle size={15} className="mc-spin" />
                    ) : (
                      <Play size={15} />
                    )}
                    Run
                  </button>
                </article>
              );
            })}
            {filteredTests.length === 0 ? (
              <div className="mc-pp-empty">
                <p>No tests match this filter.</p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="mc-pp-detail">
          {selectedTest ? (
            <>
              <header className="mc-pp-detail-head">
                <div className="mc-pp-detail-copy">
                  <div className="mc-pp-test-headline">
                    <span className="mc-pp-test-code">{selectedTest.code}</span>
                    <span className={`mc-pp-chip ${statusChipClass(selectedRun?.status)}`}>
                      {formatRunStatus(selectedRun?.status)}
                    </span>
                    {formatResultCategory(selectedCategory) !== formatRunStatus(selectedRun?.status) ? (
                      <span className={`mc-pp-chip ${resultCategoryClass(selectedCategory)}`}>
                        {formatResultCategory(selectedCategory)}
                      </span>
                    ) : null}
                  </div>
                  <h4>{selectedTest.title}</h4>
                  <p>
                    Keep the selected test in focus, and open deeper evidence only when you need to inspect scoring,
                    output, or regression context.
                  </p>
                </div>
                <button
                  type="button"
                  className="mc-next-button"
                  onClick={() => void runOne(selectedTest, "single")}
                  disabled={running && activeRun?.testId !== selectedTest.testId}
                >
                  {activeRun?.testId === selectedTest.testId ? (
                    <LoaderCircle size={16} className="mc-spin" />
                  ) : (
                    <Play size={16} />
                  )}
                  Run selected
                </button>
              </header>

              {selectedRunLink ? (
                <div className="mc-pp-detail-actions">
                  {navigate ? (
                    <button type="button" className="mc-next-button mc-next-button-secondary" onClick={openSelectedRun}>
                      Open run thread
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="mc-next-button mc-next-button-secondary"
                    onClick={() => void copySelectedRunLink()}
                  >
                    <ClipboardCopy size={15} />
                    Copy run link
                  </button>
                </div>
              ) : null}

              <div className="mc-pp-detail-summary">
                <div className="mc-pp-detail-card">
                  <span>Run state</span>
                  <strong>{formatRunStatus(selectedRun?.status)}</strong>
                  <p>{selectedRun?.startedAt ? `Started ${formatDateTime(selectedRun.startedAt)}` : "No run yet"}</p>
                </div>
                <div className="mc-pp-detail-card">
                  <span>Requested lane</span>
                  <strong>
                    {formatPromptPackProviderModel(
                      selectedRunModelUsage.requestedProviderId,
                      selectedRunModelUsage.requestedModel,
                    )}
                  </strong>
                  <p>
                    {selectedRun?.finishedAt
                      ? `Finished ${formatDateTime(selectedRun.finishedAt)}`
                      : "Waiting for run output"}
                  </p>
                </div>
                <div className="mc-pp-detail-card">
                  <span>Execution style</span>
                  <strong>{formatPromptPackExecutionStyle(selectedRun?.executionStyle ?? executionStyle)}</strong>
                  <p>{selectedRun?.executionStyle ? "Captured on latest run" : "Next run setting"}</p>
                </div>
                <div className="mc-pp-detail-card">
                  <span>Effective verdict</span>
                  <strong>
                    {selectedAssessment?.effectiveVerdict ?? selectedAutoScore?.autoVerdict ?? "Unscored"}
                  </strong>
                  <p>
                    {selectedHumanReview?.overrideVerdict
                      ? `Human override: ${selectedHumanReview.overrideVerdict}`
                      : "No human override on the latest assessment"}
                  </p>
                </div>
                <div className="mc-pp-detail-card">
                  <span>Output integrity</span>
                  <strong>{selectedRun?.integrity?.validationStatus ?? "n/a"}</strong>
                  <p>
                    {selectedRun?.integrity?.outputTokenCount !== undefined
                      ? `${selectedRun.integrity.outputTokenCount} output tokens`
                      : "No integrity data yet"}
                  </p>
                </div>
              </div>

              <div className="mc-pp-tab-list" role="tablist" aria-label="Prompt pack detail tabs">
                {DETAIL_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={detailTab === tab.id}
                    className={`mc-pp-tab${detailTab === tab.id ? " active" : ""}`}
                    onClick={() => setDetailTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="mc-pp-tab-panel">
                {detailTab === "prompt" ? (
                  <div className="mc-pp-tab-grid">
                    <section className="mc-pp-surface">
                      <div className="mc-pp-section-heading">
                        <div>
                          <h5>Prompt source</h5>
                          <p>Exact markdown used for the selected test.</p>
                        </div>
                      </div>
                      <pre>{selectedTest.prompt}</pre>
                    </section>
                    {selectedDiagnosticMetadata ? (
                      <section className="mc-pp-surface">
                        <div className="mc-pp-section-heading">
                          <div>
                            <h5>Diagnostics</h5>
                            <p>Capability targets and expected runtime signals captured at import.</p>
                          </div>
                        </div>
                        <div className="mc-pp-diagnostic-stack">
                          <DiagnosticChipGroup
                            label="Capability targets"
                            values={selectedDiagnosticMetadata.capabilityTargets}
                          />
                          <DiagnosticChipGroup
                            label="Expected runtime signals"
                            values={selectedDiagnosticMetadata.expectedRuntimeSignals}
                          />
                          <DiagnosticChipGroup
                            label="Likely failure classes"
                            values={selectedDiagnosticMetadata.likelyFailureClasses}
                          />
                        </div>
                      </section>
                    ) : null}
                    {selectedPlaceholders.length > 0 ? (
                      <section className="mc-pp-surface">
                        <div className="mc-pp-section-heading">
                          <div>
                            <h5>Placeholder values</h5>
                            <p>Fill required tokens before running the test.</p>
                          </div>
                        </div>
                        <div className="mc-pp-placeholder-grid">
                          {selectedPlaceholders.map((placeholder) => {
                            const key = normalizePromptPlaceholderKey(placeholder);
                            return (
                              <label key={placeholder} className="mc-pp-field">
                                <span>{placeholder}</span>
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
                        <p className="mc-pp-note">
                          {selectedMissingPlaceholders.length > 0
                            ? `Missing values: ${selectedMissingPlaceholders.join(", ")}`
                            : "All placeholders are set for this test."}
                        </p>
                      </section>
                    ) : null}
                  </div>
                ) : null}

                {detailTab === "output" ? (
                  <div className="mc-pp-tab-grid">
                    <section className="mc-pp-surface">
                      <div className="mc-pp-section-heading">
                        <div>
                          <h5>Assistant output</h5>
                          <p>The latest completion tied to this test run.</p>
                        </div>
                      </div>
                      {selectedRun?.responseText ? (
                        <pre>{selectedRun.responseText}</pre>
                      ) : (
                        <div className="mc-pp-empty">
                          <p>No output available for the latest run.</p>
                        </div>
                      )}
                    </section>
                    <section className="mc-pp-surface">
                      <div className="mc-pp-section-heading">
                        <div>
                          <h5>Run evidence</h5>
                          <p>Requested vs actual model, tools, citations, and fallback behavior.</p>
                        </div>
                      </div>
                      <div className="mc-pp-evidence-stack">
                        <div className="mc-pp-evidence-line">
                          <span>Requested</span>
                          <strong>
                            {formatPromptPackProviderModel(
                              selectedRunModelUsage.requestedProviderId,
                              selectedRunModelUsage.requestedModel,
                            )}
                          </strong>
                        </div>
                        <div className="mc-pp-evidence-line">
                          <span>Actual</span>
                          <strong>
                            {formatPromptPackProviderModel(
                              selectedRunModelUsage.actualProviderId,
                              selectedRunModelUsage.actualModel,
                            )}
                          </strong>
                        </div>
                        <div className="mc-pp-evidence-line">
                          <span>Fallback</span>
                          <strong>
                            {selectedRunModelUsage.fallbackUsed
                              ? formatPromptPackProviderModel(
                                  selectedRunModelUsage.fallbackProviderId,
                                  selectedRunModelUsage.fallbackModel,
                                )
                              : "Not used"}
                          </strong>
                        </div>
                        <div className="mc-pp-evidence-line">
                          <span>Execution style</span>
                          <strong>
                            {formatPromptPackExecutionStyle(selectedRun?.executionStyle ?? executionStyle)}
                          </strong>
                        </div>
                        <div className="mc-pp-evidence-line">
                          <span>Tool runs</span>
                          <strong>{selectedRun?.trace ? selectedRun.trace.toolRuns.length : 0}</strong>
                        </div>
                        <div className="mc-pp-evidence-line">
                          <span>Citations</span>
                          <strong>{selectedRun?.citations?.length ?? 0}</strong>
                        </div>
                        {selectedRun?.status === "failed" && selectedRun.error ? (
                          <p className="mc-pp-note danger">{selectedRun.error}</p>
                        ) : null}
                        {selectedRunModelUsage.fallbackReason ? (
                          <p className="mc-pp-note">Fallback reason: {selectedRunModelUsage.fallbackReason}</p>
                        ) : null}
                      </div>
                    </section>
                  </div>
                ) : null}

                {detailTab === "assessment" ? (
                  <div className="mc-pp-tab-grid">
                    <section className="mc-pp-surface">
                      <div className="mc-pp-section-heading">
                        <div>
                          <h5>Assessment summary</h5>
                          <p>Auto score, effective verdict, and protocol state for the latest run.</p>
                        </div>
                      </div>
                      <div className="mc-pp-assessment-grid">
                        <article className="mc-pp-metric-card">
                          <span>Auto score</span>
                          <strong>
                            {selectedAutoScore ? formatWeightedScore(selectedAutoScore.weightedScore) : "Unavailable"}
                          </strong>
                          <p>
                            {selectedAutoScore
                              ? `${(selectedAutoScore.scoringSchemaVersion ?? "v2").toUpperCase()} ${selectedAutoScore.autoVerdict} • judge ${selectedAutoScore.judgeStatus}`
                              : selectedLegacyScore
                                ? `Legacy score ${selectedLegacyScore.totalScore}/10`
                                : "No scoring evidence yet"}
                          </p>
                        </article>
                        <article className="mc-pp-metric-card">
                          <span>Effective verdict</span>
                          <strong>{selectedAssessment?.effectiveVerdict ?? "Unscored"}</strong>
                          <p>
                            {selectedHumanReview?.overrideVerdict
                              ? `Human override ${selectedHumanReview.overrideVerdict}`
                              : "No manual override"}
                          </p>
                        </article>
                        <article className="mc-pp-metric-card">
                          <span>Protocol</span>
                          <strong>
                            {selectedAutoScore ? (selectedAutoScore.protocol.protocolPass ? "Pass" : "Fail") : "n/a"}
                          </strong>
                          <p>
                            {selectedAutoScore
                              ? `State ${selectedAssessment?.scoreState ?? selectedAutoScore.scoreState}`
                              : "Protocol evidence arrives with auto-score"}
                          </p>
                        </article>
                        <article className="mc-pp-metric-card">
                          <span>Attribution</span>
                          <strong>
                            {selectedAutoScore?.scoringSchemaVersion === "v3"
                              ? formatPromptPackAttribution(selectedAutoScore.attribution.primary)
                              : "n/a"}
                          </strong>
                          <p>
                            {selectedAutoScore?.scoringSchemaVersion === "v3"
                              ? `${selectedAutoScore.attribution.confidence} confidence`
                              : "Available with v3 scoring"}
                          </p>
                        </article>
                      </div>
                      {selectedHumanReview?.notes?.trim() ? (
                        <p className="mc-pp-note">Latest human notes: {selectedHumanReview.notes.trim()}</p>
                      ) : null}
                      {selectedAutoScore ? (
                        <>
                          {selectedAutoScore.hardFailReasons.length > 0 ? (
                            <p className="mc-pp-note danger">
                              Hard-fail reasons: {selectedAutoScore.hardFailReasons.join(", ")}
                            </p>
                          ) : null}
                          {selectedAutoScore.reviewReasons.length > 0 ? (
                            <p className="mc-pp-note">Review reasons: {selectedAutoScore.reviewReasons.join(", ")}</p>
                          ) : null}
                          {selectedAutoScore.degradedReasons.length > 0 ? (
                            <p className="mc-pp-note">
                              Degraded reasons: {selectedAutoScore.degradedReasons.join(", ")}
                            </p>
                          ) : null}
                          {selectedAutoScore.scoringSchemaVersion === "v3" &&
                          selectedAutoScore.attribution.primary !== "not_applicable" ? (
                            <p className="mc-pp-note">
                              Failure attribution: {formatPromptPackAttribution(selectedAutoScore.attribution.primary)}
                              {selectedAutoScore.attribution.evidence.length > 0
                                ? ` • ${selectedAutoScore.attribution.evidence.join("; ")}`
                                : ""}
                            </p>
                          ) : null}
                          <details className="mc-pp-evidence-details" open>
                            <summary>Score evidence</summary>
                            <div className="mc-pp-table-wrap">
                              <table className="mc-pp-table">
                                <thead>
                                  <tr>
                                    <th>Dimension</th>
                                    <th>Rule</th>
                                    <th>Judge</th>
                                    <th>Final</th>
                                    <th>Diff</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {getPromptPackScoreDimensionLabels(
                                    selectedAutoScore.scoringSchemaVersion ?? "v2",
                                  ).map(([dimension, label]) => (
                                    <tr key={dimension}>
                                      <td>{label}</td>
                                      <td>{readPromptPackScoreDimension(selectedAutoScore.ruleScores, dimension)}</td>
                                      <td>{readPromptPackScoreDimension(selectedAutoScore.judgeScores, dimension)}</td>
                                      <td>{readPromptPackScoreDimension(selectedAutoScore.finalScores, dimension)}</td>
                                      <td>{readPromptPackScoreDimension(selectedAutoScore.disagreement, dimension)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </details>
                        </>
                      ) : (
                        <div className="mc-pp-empty">
                          <p>No auto-score evidence is available yet for this test.</p>
                        </div>
                      )}
                    </section>
                  </div>
                ) : null}

                {detailTab === "review" ? (
                  <div className="mc-pp-tab-grid">
                    <section className="mc-pp-surface">
                      <div className="mc-pp-section-heading">
                        <div>
                          <h5>Manual review</h5>
                          <p>Layer human judgment on top of the existing evidence only when it adds signal.</p>
                        </div>
                      </div>
                      {!v2UiEnabled ? (
                        <div className="mc-pp-alert warning">
                          <AlertTriangle size={16} />
                          <span>Prompt Pack Scoring V2 UI is disabled in this build.</span>
                        </div>
                      ) : null}
                      <div className="mc-pp-assessment-grid">
                        <article className="mc-pp-metric-card">
                          <span>Draft score</span>
                          <strong>
                            {draftWeightedScore === null ? "Incomplete" : formatWeightedScore(draftWeightedScore)}
                          </strong>
                          <p>{completedDraftDimensions}/5 dimensions set</p>
                        </article>
                        <article className="mc-pp-metric-card">
                          <span>Draft verdict</span>
                          <strong>{draftVerdict}</strong>
                          <p>
                            {scoreDraft.overrideVerdict
                              ? `Override ${scoreDraft.overrideVerdict}`
                              : "No override selected"}
                          </p>
                        </article>
                      </div>
                      <div className="mc-pp-review-grid">
                        {DIMENSION_ROWS.map((dimension) => (
                          <div key={dimension.key} className="mc-pp-review-row">
                            <div>
                              <strong>{dimension.label}</strong>
                              <p>Weight {dimension.weight}%</p>
                            </div>
                            <div className="mc-pp-score-row">
                              <button
                                type="button"
                                className={`mc-pp-score-button${scoreDraft[dimension.key] === null ? " active" : ""}`}
                                disabled={!v2UiEnabled}
                                onClick={() => setScoreDraft((current) => ({ ...current, [dimension.key]: null }))}
                              >
                                --
                              </button>
                              {[0, 1, 2, 3, 4].map((value) => (
                                <button
                                  key={value}
                                  type="button"
                                  className={`mc-pp-score-button${scoreDraft[dimension.key] === value ? " active" : ""}`}
                                  disabled={!v2UiEnabled}
                                  onClick={() => setScoreDraft((current) => ({ ...current, [dimension.key]: value }))}
                                >
                                  {value}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="mc-pp-review-controls">
                        <label className="mc-pp-field">
                          <span>Override verdict</span>
                          <select
                            value={scoreDraft.overrideVerdict || "none"}
                            disabled={!v2UiEnabled}
                            onChange={(event) =>
                              setScoreDraft((current) => ({
                                ...current,
                                overrideVerdict:
                                  event.target.value === "none"
                                    ? ""
                                    : (event.target.value as "pass" | "fail" | "review"),
                              }))
                            }
                          >
                            <option value="none">No override</option>
                            <option value="pass">Pass</option>
                            <option value="review">Review</option>
                            <option value="fail">Fail</option>
                          </select>
                        </label>
                        <label className="mc-pp-field">
                          <span>Notes</span>
                          <textarea
                            rows={4}
                            placeholder="Optional notes..."
                            disabled={!v2UiEnabled}
                            value={scoreDraft.notes}
                            onChange={(event) =>
                              setScoreDraft((current) => ({
                                ...current,
                                notes: event.target.value,
                              }))
                            }
                          />
                        </label>
                      </div>
                      <div className="mc-pp-inline-actions wrap">
                        <button
                          type="button"
                          className="mc-next-button mc-next-button-secondary"
                          disabled={!v2UiEnabled}
                          onClick={() =>
                            setScoreDraft((current) => ({
                              ...current,
                              taskSuccess: 3,
                              honesty: 3,
                              executionQuality: 3,
                              robustness: 3,
                              usability: 3,
                            }))
                          }
                        >
                          Fill pass defaults
                        </button>
                        <button
                          type="button"
                          className="mc-next-button"
                          disabled={!v2UiEnabled || savingScore || !selectedRun}
                          onClick={() => void submitScore()}
                        >
                          {savingScore ? <LoaderCircle size={16} className="mc-spin" /> : <CheckCircle2 size={16} />}
                          Save review
                        </button>
                        <button
                          type="button"
                          className="mc-next-button mc-next-button-secondary"
                          disabled={!v2UiEnabled || autoScoring || !selectedRun || selectedRun.status !== "completed"}
                          onClick={() => void autoScoreSelected()}
                        >
                          {autoScoring ? <LoaderCircle size={16} className="mc-spin" /> : <Sparkles size={16} />}
                          Auto score this run
                        </button>
                      </div>
                      {selectedRun?.status === "failed" ? (
                        <div className="mc-pp-alert warning">
                          <AlertTriangle size={16} />
                          <span>
                            Latest run failed. Rerun the test and inspect trace or tool grants before scoring.
                          </span>
                        </div>
                      ) : null}
                    </section>
                  </div>
                ) : null}

                {detailTab === "insights" ? (
                  <div className="mc-pp-tab-grid">
                    <section className="mc-pp-surface">
                      <div className="mc-pp-section-heading">
                        <div>
                          <h5>Pack insights</h5>
                          <p>Quality snapshot, benchmark posture, replay status, and trend alerts.</p>
                        </div>
                      </div>
                      <div className="mc-pp-insight-metrics">
                        <article className="mc-pp-metric-card">
                          <span>Total tests</span>
                          <strong>{report?.summary.totalTests ?? 0}</strong>
                          <p>{report?.summary.completedRuns ?? 0} completed runs</p>
                        </article>
                        <article className="mc-pp-metric-card">
                          <span>Passing</span>
                          <strong>{testOutcomeSummary.passingCount}</strong>
                          <p>{testOutcomeSummary.reviewCount} in review</p>
                        </article>
                        <article className="mc-pp-metric-card">
                          <span>Average weighted</span>
                          <strong>{report ? `${report.summary.averageWeightedScore.toFixed(1)}/100` : "n/a"}</strong>
                          <p>Threshold {passThreshold}/100</p>
                        </article>
                        <article className="mc-pp-metric-card">
                          <span>Effective pass rate</span>
                          <strong>{report ? `${(report.summary.effectivePassRate * 100).toFixed(1)}%` : "n/a"}</strong>
                          <p>
                            {report?.summary.reviewRate
                              ? `${(report.summary.reviewRate * 100).toFixed(1)}% review rate`
                              : "No review rate yet"}
                          </p>
                        </article>
                      </div>
                      {trendSeries.length > 0 ? (
                        <div className="mc-pp-trend-row">
                          {trendSeries.map((series) => (
                            <span
                              key={series.capability}
                              className={`mc-pp-chip trend${series.breached ? " breached" : ""}`}
                            >
                              {series.capability}:{" "}
                              {series.points.length > 0
                                ? series.points[series.points.length - 1]?.value.toFixed(2)
                                : "n/a"}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {benchmarkStatus ? (
                        <details className="mc-pp-evidence-details" open>
                          <summary>Latest benchmark</summary>
                          <p className="mc-pp-note">
                            Execution style: {formatPromptPackExecutionStyle(benchmarkStatus.run.executionStyle)}
                          </p>
                          <div className="mc-pp-table-wrap">
                            <table className="mc-pp-table">
                              <thead>
                                <tr>
                                  <th>Model</th>
                                  <th>Pass rate</th>
                                  <th>Review rate</th>
                                  <th>Avg</th>
                                  <th>Failures</th>
                                </tr>
                              </thead>
                              <tbody>
                                {benchmarkStatus.modelSummaries.slice(0, 10).map((summary) => (
                                  <tr key={`${summary.providerId}/${summary.model}`}>
                                    <td>
                                      {summary.providerId}/{summary.model}
                                    </td>
                                    <td>{(summary.passRate * 100).toFixed(1)}%</td>
                                    <td>{(summary.reviewRate * 100).toFixed(1)}%</td>
                                    <td>{summary.averageWeightedScore.toFixed(1)}</td>
                                    <td>{summary.runFailures}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      ) : null}
                      {regressionStatus ? (
                        <details className="mc-pp-evidence-details" open>
                          <summary>Latest replay regression</summary>
                          <div className="mc-pp-table-wrap">
                            <table className="mc-pp-table">
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
                                {regressionStatus.results.slice(0, 12).map((item) => (
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
                          </div>
                        </details>
                      ) : null}
                    </section>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="mc-pp-empty large">
              <h4>Select a test</h4>
              <p>Pick a test from the list to inspect the prompt, output, scoring, and review controls.</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

export function buildLatestPromptPackRunByTest(
  runs: PromptPackRunRecord[] | undefined,
): Map<string, PromptPackRunRecord> {
  const map = new Map<string, PromptPackRunRecord>();
  const orderedRuns = [...(runs ?? [])].sort((left, right) => {
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
}

export function buildLatestPromptPackAssessmentByTest(
  assessments: PromptPackLatestAssessmentRecordV2[] | undefined,
): Map<string, PromptPackLatestAssessmentRecordV2> {
  return new Map((assessments ?? []).map((assessment) => [assessment.testId, assessment] as const));
}

export function summarizePromptPackTestOutcomes(
  tests: PromptPackTestRecord[],
  latestRunByTest: Map<string, PromptPackRunRecord>,
  latestAssessmentByTest: Map<string, PromptPackLatestAssessmentRecordV2>,
): {
  approvalPausedCount: number;
  runFailureCount: number;
  scoreFailureCount: number;
  reviewCount: number;
  needsScoreCount: number;
  notRunCount: number;
  passingCount: number;
} {
  const summary = {
    approvalPausedCount: 0,
    runFailureCount: 0,
    scoreFailureCount: 0,
    reviewCount: 0,
    needsScoreCount: 0,
    notRunCount: 0,
    passingCount: 0,
  };

  for (const test of tests) {
    const category = classifyTestResultCategory(
      latestRunByTest.get(test.testId),
      latestAssessmentByTest.get(test.testId),
    );
    if (category === "approval_paused") {
      summary.approvalPausedCount += 1;
    } else if (category === "run_failed") {
      summary.runFailureCount += 1;
    } else if (category === "score_failed") {
      summary.scoreFailureCount += 1;
    } else if (category === "review") {
      summary.reviewCount += 1;
    } else if (category === "needs_score") {
      summary.needsScoreCount += 1;
    } else if (category === "not_run") {
      summary.notRunCount += 1;
    } else if (category === "passing") {
      summary.passingCount += 1;
    }
  }

  return summary;
}

export function filterPromptPackTestsByResult(
  tests: PromptPackTestRecord[],
  filter: TestResultFilter,
  latestRunByTest: Map<string, PromptPackRunRecord>,
  latestAssessmentByTest: Map<string, PromptPackLatestAssessmentRecordV2>,
): PromptPackTestRecord[] {
  return tests.filter((test) =>
    matchesTestResultFilter(filter, latestRunByTest.get(test.testId), latestAssessmentByTest.get(test.testId)),
  );
}

export function chooseNextPromptPackTest(
  tests: PromptPackTestRecord[],
  latestRunByTest: Map<string, PromptPackRunRecord>,
  latestAssessmentByTest: Map<string, PromptPackLatestAssessmentRecordV2>,
): PromptPackTestRecord | undefined {
  const nextNotRun = tests.find((test) => !latestRunByTest.get(test.testId));
  const nextFailed = tests.find((test) => latestRunByTest.get(test.testId)?.status === "failed");
  const nextUnscoredCompleted = tests.find((test) => {
    const run = latestRunByTest.get(test.testId);
    const assessment = latestAssessmentByTest.get(test.testId);
    return run?.status === "completed" && !assessment?.autoScore;
  });
  return nextNotRun ?? nextFailed ?? nextUnscoredCompleted ?? tests[0];
}

export function buildPromptPackSelectedRunLink(selectedRunHref: string | null, origin?: string): string | null {
  if (!selectedRunHref || !origin) {
    return selectedRunHref;
  }
  return new URL(selectedRunHref, origin).toString();
}

export function DiagnosticChipGroup({ label, values }: { label: string; values: string[] | undefined }) {
  const normalized = values?.filter(Boolean) ?? [];
  return (
    <div className="mc-pp-diagnostic-group">
      <span>{label}</span>
      <div className="mc-pp-test-meta">
        {normalized.length > 0 ? (
          normalized.map((value) => (
            <span key={value} className="mc-pp-chip diagnostic">
              {value}
            </span>
          ))
        ) : (
          <span className="mc-pp-chip">none</span>
        )}
      </div>
    </div>
  );
}

export function formatPromptPackExecutionStyle(style?: PromptPackExecutionStyle): string {
  return style === "agentic_surface" ? "Agentic" : "Harness";
}

const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "prompt", label: "Prompt" },
  { id: "output", label: "Output" },
  { id: "assessment", label: "Assessment" },
  { id: "review", label: "Review" },
  { id: "insights", label: "Insights" },
];

const PROMPT_PACK_V2_DIMENSION_LABELS = [
  ["taskSuccess", "Task success"],
  ["honesty", "Honesty"],
  ["executionQuality", "Execution quality"],
  ["robustness", "Robustness"],
  ["usability", "Usability"],
] as const;

const PROMPT_PACK_V3_DIMENSION_LABELS = [
  ["taskSuccess", "Task success"],
  ["truthfulness", "Truthfulness"],
  ["evidenceGrounding", "Evidence grounding"],
  ["formatAdherence", "Format adherence"],
  ["operatorUsefulness", "Operator usefulness"],
  ["toolUseQuality", "Tool use quality"],
  ["orchestrationQuality", "Orchestration quality"],
  ["efficiency", "Efficiency"],
  ["recoveryQuality", "Recovery quality"],
] as const;

export function getPromptPackScoreDimensionLabels(schemaVersion: PromptPackScoringSchemaVersion) {
  return schemaVersion === "v3" ? PROMPT_PACK_V3_DIMENSION_LABELS : PROMPT_PACK_V2_DIMENSION_LABELS;
}

export function readPromptPackScoreDimension(
  scores: PromptPackAutoScoreRecord["finalScores"] | PromptPackAutoScoreRecord["ruleScores"] | undefined,
  dimension: string,
): string | number {
  if (!scores) {
    return "-";
  }
  const value = (scores as Record<string, number | undefined>)[dimension];
  return value ?? "-";
}

export function formatPromptPackAttribution(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const DIMENSION_ROWS: Array<{
  key: keyof Pick<ScoreDraft, "taskSuccess" | "honesty" | "executionQuality" | "robustness" | "usability">;
  label: string;
  weight: number;
}> = [
  { key: "taskSuccess", label: "Task success", weight: 25 },
  { key: "honesty", label: "Honesty", weight: 20 },
  { key: "executionQuality", label: "Execution quality", weight: 20 },
  { key: "robustness", label: "Robustness", weight: 20 },
  { key: "usability", label: "Usability", weight: 15 },
];

const FILTER_OPTIONS: Array<{
  value: TestResultFilter;
  label: string;
  count: (
    summary: {
      approvalPausedCount: number;
      runFailureCount: number;
      scoreFailureCount: number;
      reviewCount: number;
      needsScoreCount: number;
      notRunCount: number;
      passingCount: number;
    },
    totalTests: number,
  ) => number;
}> = [
  { value: "all", label: "All", count: (_summary, total) => total },
  { value: "approval_paused", label: "Paused", count: (summary) => summary.approvalPausedCount },
  { value: "run_failed", label: "Run failed", count: (summary) => summary.runFailureCount },
  { value: "score_failed", label: "Score failed", count: (summary) => summary.scoreFailureCount },
  { value: "review", label: "Review", count: (summary) => summary.reviewCount },
  { value: "needs_score", label: "Needs score", count: (summary) => summary.needsScoreCount },
  { value: "not_run", label: "Not run", count: (summary) => summary.notRunCount },
  { value: "passing", label: "Passing", count: (summary) => summary.passingCount },
];

export function statusChipClass(status?: PromptPackRunRecord["status"]): string {
  if (!status) {
    return "run-not-run";
  }
  if (status === "completed") {
    return "run-completed";
  }
  if (status === "approval_paused") {
    return "run-paused";
  }
  if (status === "failed") {
    return "run-failed";
  }
  return "run-not-run";
}

export function resultCategoryClass(category: Exclude<TestResultFilter, "all">): string {
  if (category === "approval_paused") {
    return "result-run-paused";
  }
  if (category === "run_failed") {
    return "result-run-failed";
  }
  if (category === "score_failed") {
    return "result-score-failed";
  }
  if (category === "review") {
    return "result-review";
  }
  if (category === "needs_score") {
    return "result-needs-score";
  }
  if (category === "passing") {
    return "result-passing";
  }
  return "result-not-run";
}

export function computeDraftWeightedScore(scoreDraft: ScoreDraft): number | null {
  if (DIMENSION_ROWS.some((dimension) => scoreDraft[dimension.key] === null)) {
    return null;
  }
  const total = DIMENSION_ROWS.reduce(
    (sum, dimension) => sum + Number(scoreDraft[dimension.key]) * dimension.weight,
    0,
  );
  return total / 4;
}

export function computeDraftVerdict(
  scoreDraft: ScoreDraft,
  overrideVerdict: ScoreDraft["overrideVerdict"],
): "pass" | "review" | "fail" | "incomplete" {
  if (overrideVerdict) {
    return overrideVerdict;
  }
  const weighted = computeDraftWeightedScore(scoreDraft);
  if (weighted === null) {
    return "incomplete";
  }
  if (weighted >= 75) {
    return "pass";
  }
  if (weighted >= 60) {
    return "review";
  }
  return "fail";
}

export function buildPromptPackRunRoute(run?: PromptPackRunRecord): AppRoute | null {
  if (!run?.sessionId) {
    return null;
  }
  return {
    area: run.mode === "cowork" ? "cowork" : run.mode === "code" ? "code" : "chat",
    sessionId: run.sessionId,
  };
}

export function isPromptPackV2UiEnabled(): boolean {
  const raw = (import.meta.env.VITE_PROMPT_PACK_V2_UI_ENABLED as string | undefined)?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !["0", "false", "off", "no", "disabled"].includes(raw);
}
