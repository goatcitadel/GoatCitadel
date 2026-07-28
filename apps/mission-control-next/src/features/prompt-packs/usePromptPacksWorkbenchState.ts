/* eslint-disable max-lines -- Prompt Lab workbench state keeps variable, benchmark, and retune transitions in one route-owned coordinator. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PromptPackBenchmarkStatusRecord,
  PromptPackExecutionStyle,
  PromptPackExportRecord,
  PromptPackLatestAssessmentRecordV2,
  PromptPackReportRecord,
  PromptPackRecord,
  PromptRetuneCampaignRecord,
  PromptPackRunRecord,
  PromptPackTestRecord,
  RunVariableBindings,
  RunVariableValue,
} from "@goatcitadel/contracts";
import { validateRunVariableBindings } from "@goatcitadel/contracts";
import type { ChatModelProviderOption } from "@goatcitadel/mission-control-shared/components/ChatModelPicker";
import {
  autoScorePromptPackBatch,
  autoScorePromptPackTest,
  cancelPromptPackBenchmark,
  cancelPromptRetuneCampaign,
  createPromptRetuneCampaign,
  dispositionPromptRetunePass,
  exportPromptPackReport,
  fetchPromptPackBenchmark,
  fetchPromptPackExport,
  fetchPromptPackReplayRegressionStatus,
  fetchPromptPackReport,
  fetchPromptPacks,
  fetchPromptPackTests,
  fetchPromptPackTrends,
  fetchPromptRetuneCampaign,
  fetchSettings,
  importPromptPack,
  resetPromptPack,
  runPromptPackBenchmark,
  runPromptPackReplayRegression,
  runPromptPackTest,
  scorePromptPackTest,
  startPromptRetuneCandidate,
  startPromptRetuneNoise,
} from "@goatcitadel/mission-control-shared/api/client";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { useRefreshSubscription } from "@goatcitadel/mission-control-shared/hooks/useRefreshSubscription";
import {
  PROMPT_PACK_PASS_THRESHOLD,
  classifyTestResultCategory,
  extractPromptPlaceholders,
  formatWeightedScore,
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
import {
  DEFAULT_BENCHMARK_TEST_CODES,
  DIMENSION_ROWS,
  buildLatestPromptPackAssessmentByTest,
  buildLatestPromptPackRunByTest,
  buildPromptPackRunRoute,
  buildPromptPackSelectedRunLink,
  chooseNextPromptPackTest,
  computeDraftVerdict,
  computeDraftWeightedScore,
  computePassReadiness,
  filterPromptPackTestsByResult,
  formatPromptPackExecutionStyle,
  isPromptPackV2UiEnabled,
  summarizePromptPackTestOutcomes,
} from "./PromptPacksWorkbenchPage.helpers";
import {
  buildPromptLabRunVariableSessionKey,
  loadPromptLabRunVariableSession,
  savePromptLabRunVariableSession,
} from "./prompt-run-variable-session";

export interface UsePromptPacksWorkbenchStateOptions {
  variant: "library" | "ops";
  navigate?: (route: AppRoute, options?: { replace?: boolean }) => void;
  initialPackId?: string;
}

export function usePromptPacksWorkbenchState(options: UsePromptPacksWorkbenchStateOptions) {
  const { variant, navigate, initialPackId } = options;
  const isOpsVariant = variant === "ops";
  const v2UiEnabled = isPromptPackV2UiEnabled();
  const hasLoadedOnceRef = useRef(false);
  const selectedPackIdRef = useRef<string | null>(null);
  const loadPackEpochRef = useRef(0);
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
  const [packs, setPacks] = useState<PromptPackRecord[]>([]);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [tests, setTests] = useState<PromptPackTestRecord[]>([]);
  const [importText, setImportText] = useState("");
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>({});
  const [runVariableBindings, setRunVariableBindings] = useState<RunVariableBindings>({});
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
  const [retuneCampaign, setRetuneCampaign] = useState<PromptRetuneCampaignRecord | null>(null);
  const [retuneEnabled, setRetuneEnabled] = useState(false);
  const [retuneRepeatCount, setRetuneRepeatCount] = useState(3);
  const [retuneHypothesis, setRetuneHypothesis] = useState("");
  const [retunePending, setRetunePending] = useState(false);
  const [trendSeries, setTrendSeries] = useState<Awaited<ReturnType<typeof fetchPromptPackTrends>>["items"]>([]);
  const [exportInfo, setExportInfo] = useState<PromptPackExportRecord | null>(null);
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
    // Request epoch: if another loadPack starts while this one is in flight
    // (user re-selects a pack during a background refresh), drop the stale
    // responses instead of clobbering the newer pack's state.
    const epoch = ++loadPackEpochRef.current;
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
    if (epoch !== loadPackEpochRef.current) {
      return;
    }
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

  const selectPack = useCallback(
    (packId: string) => {
      setSelectedPackId(packId);
      void loadPack(packId).catch((err: Error) => setError(err.message));
    },
    [loadPack],
  );

  const load = useCallback(
    async (options?: { background?: boolean }) => {
      const background = options?.background ?? hasLoadedOnceRef.current;
      if (background) {
        setIsRefreshing(true);
      } else {
        setInitialLoading(true);
      }

      try {
        const [response, runtimeSettings] = await Promise.all([fetchPromptPacks(), fetchSettings().catch(() => null)]);
        const nextRetuneEnabled = runtimeSettings?.features?.promptRetuneCampaignV1Enabled === true;
        setRetuneEnabled(nextRetuneEnabled);
        if (!nextRetuneEnabled) {
          setRetuneCampaign(null);
        }
        setPacks(response.items);
        const currentSelectedPackId = selectedPackIdRef.current;
        const requestedPackId = initialPackId?.trim();
        const resolvedPackId =
          currentSelectedPackId && response.items.some((item) => item.packId === currentSelectedPackId)
            ? currentSelectedPackId
            : requestedPackId && response.items.some((item) => item.packId === requestedPackId)
              ? requestedPackId
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
    [initialPackId, loadPack],
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

  const latestRunByTest = useMemo(() => buildLatestPromptPackRunByTest(report?.runs), [report?.runs]);

  const latestAssessmentByTest = useMemo(
    () => buildLatestPromptPackAssessmentByTest(report?.latestAssessments),
    [report?.latestAssessments],
  );

  const selectedPack = packs.find((pack) => pack.packId === selectedPackId) ?? null;
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
  const promptLabBindingsStorageKey =
    selectedPackId && selectedTestId ? buildPromptLabRunVariableSessionKey(selectedPackId, selectedTestId) : null;
  const skipNextBindingsPersistRef = useRef(false);
  useEffect(() => {
    if (!promptLabBindingsStorageKey) {
      setRunVariableBindings({});
      setPlaceholderValues({});
      return;
    }
    const stored = loadPromptLabRunVariableSession(
      window.sessionStorage,
      promptLabBindingsStorageKey,
      selectedPack?.runVariableSchema,
    );
    skipNextBindingsPersistRef.current = true;
    setRunVariableBindings(stored.bindings);
    setPlaceholderValues(stored.placeholders);
  }, [promptLabBindingsStorageKey, selectedPack?.runVariableSchema]);
  useEffect(() => {
    if (!promptLabBindingsStorageKey) return;
    if (skipNextBindingsPersistRef.current) {
      skipNextBindingsPersistRef.current = false;
      return;
    }
    try {
      savePromptLabRunVariableSession(window.sessionStorage, promptLabBindingsStorageKey, {
        bindings: runVariableBindings,
        placeholders: placeholderValues,
      });
    } catch {
      // Session-only values are best effort when browser storage is disabled.
    }
  }, [placeholderValues, promptLabBindingsStorageKey, runVariableBindings]);
  const selectedMissingPlaceholders = useMemo(() => {
    if (selectedPack?.runVariableSchema) {
      return selectedPack.runVariableSchema.fields
        .filter(
          (field) =>
            field.required &&
            (!Object.prototype.hasOwnProperty.call(runVariableBindings, field.id) ||
              runVariableBindings[field.id] === ""),
        )
        .map((field) => field.label);
    }
    return selectedPlaceholders.filter(
      (token) => !(placeholderValues[normalizePromptPlaceholderKey(token)] ?? "").trim(),
    );
  }, [placeholderValues, runVariableBindings, selectedPack?.runVariableSchema, selectedPlaceholders]);

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
        runVariableBindings?: RunVariableBindings;
        runVariableSchemaHash?: string;
      };
      missingPlaceholders: string[];
    } => {
      const schema = selectedPack?.runVariableSchema;
      if (schema) {
        const validation = validateRunVariableBindings(schema, runVariableBindings, { allowMissingRequired: true });
        const missingPlaceholders = validation.schema.fields
          .filter((field) => field.required && !Object.prototype.hasOwnProperty.call(validation.bindings, field.id))
          .map((field) => field.label);
        return {
          input: {
            ...selectedRunModel,
            executionStyle,
            runVariableBindings: validation.bindings,
            runVariableSchemaHash: validation.schemaHash,
          },
          missingPlaceholders,
        };
      }
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
    [executionStyle, placeholderValues, runVariableBindings, selectedPack?.runVariableSchema, selectedRunModel],
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
        baselineBenchmarkRunId: benchmarkRunId ?? undefined,
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

  const createRetuneCampaign = useCallback(async () => {
    if (!retuneEnabled || !selectedPackId) return;
    const testCodes = parseBenchmarkTestCodes(benchmarkTestCodes);
    const providers = parseBenchmarkProviders(benchmarkProvidersInput);
    if (testCodes.length < 1 || providers.length < 1) {
      setError("Retuning needs at least one test code and one provider/model entry.");
      return;
    }
    setRetunePending(true);
    setError(null);
    try {
      const campaign = await createPromptRetuneCampaign(selectedPackId, {
        testCodes,
        providers,
        executionStyle,
        repeatCount: retuneRepeatCount,
        maxBenchmarkRuns: Math.max(4, retuneRepeatCount * 4),
      });
      setRetuneCampaign(campaign);
      setSuccess(`Retune campaign ${campaign.campaignId} created with frozen inputs.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRetunePending(false);
    }
  }, [benchmarkProvidersInput, benchmarkTestCodes, executionStyle, retuneEnabled, retuneRepeatCount, selectedPackId]);

  const refreshRetuneCampaign = useCallback(async () => {
    if (!retuneCampaign) return;
    setRetunePending(true);
    setError(null);
    try {
      setRetuneCampaign(await fetchPromptRetuneCampaign(retuneCampaign.campaignId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRetunePending(false);
    }
  }, [retuneCampaign]);

  const measureRetuneNoise = useCallback(async () => {
    if (!retuneCampaign) return;
    setRetunePending(true);
    setError(null);
    try {
      setRetuneCampaign(await startPromptRetuneNoise(retuneCampaign.campaignId));
      setSuccess("A/A measurement started against identical frozen prompt bytes.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRetunePending(false);
    }
  }, [retuneCampaign]);

  const runRetuneCandidate = useCallback(async () => {
    if (!retuneCampaign || !retuneHypothesis.trim()) return;
    setRetunePending(true);
    setError(null);
    try {
      setRetuneCampaign(
        await startPromptRetuneCandidate(retuneCampaign.campaignId, { hypothesis: retuneHypothesis.trim() }),
      );
      setRetuneHypothesis("");
      setSuccess("Candidate measurement started. Prompt promotion remains a manual decision.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRetunePending(false);
    }
  }, [retuneCampaign, retuneHypothesis]);

  const cancelRetune = useCallback(async () => {
    if (!retuneCampaign) return;
    setRetunePending(true);
    setError(null);
    try {
      setRetuneCampaign(await cancelPromptRetuneCampaign(retuneCampaign.campaignId));
      setSuccess("Retune campaign cancelled.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRetunePending(false);
    }
  }, [retuneCampaign]);

  const dispositionRetunePass = useCallback(
    async (passId: string, disposition: "kept" | "rejected" | "inconclusive") => {
      if (!retuneCampaign) return;
      setRetunePending(true);
      setError(null);
      try {
        setRetuneCampaign(await dispositionPromptRetunePass(retuneCampaign.campaignId, passId, { disposition }));
        setSuccess(`Candidate marked ${disposition}. Prompt content was not changed.`);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setRetunePending(false);
      }
    },
    [retuneCampaign],
  );

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
      selectPack(imported.pack.packId);
      setSuccess(`Imported ${imported.tests.length} tests.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  }, [importText, isOpsVariant, load, selectPack]);

  const selectedCategory = classifyTestResultCategory(selectedRun, selectedAssessment);
  const completedDraftDimensions = DIMENSION_ROWS.filter(({ key }) => scoreDraft[key] !== null).length;
  const draftWeightedScore = computeDraftWeightedScore(scoreDraft);
  const draftVerdict = computeDraftVerdict(scoreDraft, scoreDraft.overrideVerdict);
  const executionStyleDescription =
    executionStyle === "agentic_surface"
      ? "Agentic uses the real Chat orchestration path with planning, tools, approvals, and code context inline."
      : "Harness uses the deterministic single-turn Prompt Lab wrapper.";
  const selectedDiagnosticMetadata = selectedRun?.diagnosticMetadata ?? selectedTest?.diagnosticMetadata;
  const { blockers: passReadinessBlockers, complete: passReadinessComplete } = computePassReadiness(report?.summary);
  const passReadinessDetail = report
    ? passReadinessComplete
      ? `${report.summary.averageWeightedScore.toFixed(1)}/100 average, threshold ${passThreshold}/100`
      : `${passReadinessBlockers.slice(0, 2).join(", ")}; ${(report.summary.effectivePassRate * 100).toFixed(1)}% scored pass rate`
    : "Run and score a pack to generate the scorecard.";

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
      label: "Latest attempts",
      value: `${tests.length - testOutcomeSummary.notRunCount}/${tests.length || 0}`,
      detail: tests.length > 0 ? `${testOutcomeSummary.notRunCount} not run` : "No tests loaded",
    },
    {
      label: "Pass readiness",
      value: report
        ? passReadinessComplete
          ? `${(report.summary.effectivePassRate * 100).toFixed(1)}%`
          : "Incomplete"
        : "No report yet",
      detail: passReadinessDetail,
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

  return {
    isOpsVariant,
    v2UiEnabled,
    initialLoading,
    isRefreshing,
    isFallbackRefreshing,
    activeRun,
    savingScore,
    autoScoring,
    exporting,
    resetting,
    confirmResetArmed,
    resetClearRuns,
    resetClearScores,
    importing,
    error,
    success,
    packs,
    selectedPackId,
    tests,
    importText,
    placeholderValues,
    runVariableBindings,
    selectedTestId,
    testResultFilter,
    report,
    reuseLastModel,
    autoScoreOnRun,
    executionStyle,
    selectedProviderId,
    selectedModel,
    benchmarkTestCodes,
    benchmarkProvidersInput,
    benchmarkRunId,
    benchmarkStatus,
    benchmarkPending,
    benchmarkStopping,
    regressionRunId,
    regressionPending,
    regressionStatus,
    retuneEnabled,
    retuneCampaign,
    retuneRepeatCount,
    retuneHypothesis,
    retunePending,
    trendSeries,
    exportInfo,
    scoreDraft,
    running,
    benchmarkActive,
    providerOptions,
    latestRunByTest,
    latestAssessmentByTest,
    selectedTest,
    selectedRun,
    selectedAssessment,
    selectedRunModelUsage,
    selectedRunLink,
    latestSavedLogPath,
    passThreshold,
    selectedPlaceholders,
    selectedMissingPlaceholders,
    lastSuccessfulModel,
    unscoredCompletedCount,
    testOutcomeSummary,
    filteredTests,
    selectedRunModel,
    selectedPack,
    selectedCategory,
    completedDraftDimensions,
    draftWeightedScore,
    draftVerdict,
    executionStyleDescription,
    selectedDiagnosticMetadata,
    summaryCards,
    title,
    subtitle,
    setSelectedPackId,
    selectPack,
    setSelectedProviderId,
    setSelectedModel,
    setReuseLastModel,
    setAutoScoreOnRun,
    setExecutionStyle,
    setBenchmarkTestCodes,
    setBenchmarkProvidersInput,
    setRetuneRepeatCount,
    setRetuneHypothesis,
    setResetClearRuns,
    setResetClearScores,
    setConfirmResetArmed,
    setImportText,
    setPlaceholderValues,
    setRunVariableBindings: (fieldId: string, value: RunVariableValue | undefined) =>
      setRunVariableBindings(
        (current) =>
          Object.fromEntries(
            Object.entries({ ...current, [fieldId]: value }).filter(([, fieldValue]) => fieldValue !== undefined),
          ) as RunVariableBindings,
      ),
    setTestResultFilter,
    setSelectedTestId,
    setScoreDraft,
    load,
    runNext,
    runAll,
    runOne,
    autoScoreUnscored,
    runBenchmark,
    stopBenchmark,
    refreshBenchmark,
    runRegression,
    refreshRegression,
    createRetuneCampaign,
    refreshRetuneCampaign,
    measureRetuneNoise,
    runRetuneCandidate,
    cancelRetune,
    dispositionRetunePass,
    exportReport,
    copyExportPath,
    confirmResetPack,
    openSelectedRun,
    copySelectedRunLink,
    submitScore,
    autoScoreSelected,
    handleImport,
    navigate,
  };
}
