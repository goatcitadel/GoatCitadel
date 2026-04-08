/* eslint-disable @typescript-eslint/no-unused-vars, max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  acceptMemoryMaintenanceRecommendation,
  cancelDurableRun,
  fetchDurableRun,
  fetchDurableRunTimeline,
  fetchFilesList,
  fetchMemoryItemHistory,
  fetchMemoryItems,
  fetchMemoryMaintenanceRecommendations,
  fetchMemoryMaintenanceRunProvenance,
  fetchMemoryMaintenanceRuns,
  fetchMemoryMaintenanceStatus,
  fetchMemoryQmdStats,
  fetchSettings,
  forgetMemoryItem,
  patchMemoryItem,
  patchMemoryMaintenancePolicy,
  rejectMemoryMaintenanceRecommendation,
  retryDurableRun,
  runMemoryMaintenanceNow,
} from "../api/client";
import { ActionButton } from "../components/ActionButton";
import { DataToolbar } from "../components/DataToolbar";
import { FieldHelp } from "../components/FieldHelp";
import { PageHeader } from "../components/PageHeader";
import { PageGuideCard } from "../components/PageGuideCard";
import { Panel } from "../components/Panel";
import { ConfirmModal } from "../components/ConfirmModal";
import { HelpHint } from "../components/HelpHint";
import { StatusChip } from "../components/StatusChip";
import { SelectOrCustom } from "../components/SelectOrCustom";
import { GCSelect } from "../components/ui";
import { pageCopy } from "../content/copy";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import {
  buildMemoryMaintenancePolicyPatch,
  clampNumber,
  dedupeTextOptions,
  describeMaintenanceProviderLocality,
  describeMaintenanceUnavailablePolicy,
  describeQmdImpact,
  formatBytes,
  formatJson,
  formatMaybeDateTime,
  formatMemoryMaintenanceProviderOption,
  formatShortDateTime,
  formatTokenDelta,
  isLikelyLocalProvider,
  isMemoryLifecycleAdminDisabledError,
  pickLatestTimestamp,
  shortId,
  summarizeAreas,
  summarizeMemorySubspaces,
  toMemoryMaintenancePolicyDraft,
  topLevelArea,
  type MemoryMaintenancePolicyDraft,
  type WorkspaceAreaSummary,
  type WorkspaceFile,
} from "./memory/memory-page-helpers";

type MemoryMaintenanceStatusState = Awaited<ReturnType<typeof fetchMemoryMaintenanceStatus>>;
type MemoryMaintenanceRunState = Awaited<ReturnType<typeof fetchMemoryMaintenanceRuns>>["items"][number];
type MemoryMaintenanceRecommendationState = Awaited<
  ReturnType<typeof fetchMemoryMaintenanceRecommendations>
>["items"][number];
type MemoryMaintenanceProvenanceState = Awaited<ReturnType<typeof fetchMemoryMaintenanceRunProvenance>>;
type DurableRunState = Awaited<ReturnType<typeof fetchDurableRun>>;
type DurableTimelineEventState = Awaited<ReturnType<typeof fetchDurableRunTimeline>>["items"][number];

export function MemoryPage({ workspaceId = "default" }: { workspaceId?: string }) {
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFallbackRefreshing, setIsFallbackRefreshing] = useState(false);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [qmdStats, setQmdStats] = useState<{
    totalRuns: number;
    generatedRuns: number;
    cacheHitRuns: number;
    fallbackRuns: number;
    failedRuns: number;
    originalTokenEstimate: number;
    distilledTokenEstimate: number;
    savingsPercent: number;
    netTokenDelta: number;
    compressionPercent: number;
    expansionPercent: number;
    efficiencyLabel: "reduced" | "expanded" | "neutral";
    recent: Array<{ contextId: string; scope: string; createdAt: string; quality: { status: string } }>;
  } | null>(null);
  const [selectedArea, setSelectedArea] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [memoryAdminError, setMemoryAdminError] = useState<string | null>(null);
  const [memoryAdminEnabled, setMemoryAdminEnabled] = useState(true);
  const [memoryItems, setMemoryItems] = useState<
    Array<{
      itemId: string;
      namespace: string;
      title: string;
      content: string;
      pinned: boolean;
      status: "active" | "forgotten";
      updatedAt: string;
      ttlOverrideSeconds?: number;
    }>
  >([]);
  const [selectedMemoryItemId, setSelectedMemoryItemId] = useState<string | null>(null);
  const [memoryHistory, setMemoryHistory] = useState<
    Array<{
      changeId: string;
      changeType: string;
      actorId?: string;
      createdAt: string;
    }>
  >([]);
  const [memoryBusyItemId, setMemoryBusyItemId] = useState<string | null>(null);
  const [confirmForgetItem, setConfirmForgetItem] = useState<{
    itemId: string;
    title: string;
  } | null>(null);
  const memoryAdminEnabledRef = useRef(memoryAdminEnabled);
  const [memoryMaintenanceFeatureEnabled, setMemoryMaintenanceFeatureEnabled] = useState(false);
  const [memoryMaintenanceDurableReady, setMemoryMaintenanceDurableReady] = useState(false);
  const [memoryMaintenanceError, setMemoryMaintenanceError] = useState<string | null>(null);
  const [memoryMaintenanceBusy, setMemoryMaintenanceBusy] = useState<string | null>(null);
  const [memoryMaintenanceStatus, setMemoryMaintenanceStatus] = useState<MemoryMaintenanceStatusState | null>(null);
  const [memoryMaintenanceRuns, setMemoryMaintenanceRuns] = useState<MemoryMaintenanceRunState[]>([]);
  const [memoryMaintenanceRecommendations, setMemoryMaintenanceRecommendations] = useState<
    MemoryMaintenanceRecommendationState[]
  >([]);
  const [memoryMaintenanceDraft, setMemoryMaintenanceDraft] = useState<MemoryMaintenancePolicyDraft | null>(null);
  const [memoryMaintenanceDraftDirty, setMemoryMaintenanceDraftDirty] = useState(false);
  const [selectedMaintenanceRunId, setSelectedMaintenanceRunId] = useState<string | null>(null);
  const [selectedMaintenanceProvenance, setSelectedMaintenanceProvenance] =
    useState<MemoryMaintenanceProvenanceState | null>(null);
  const [selectedMaintenanceDurableRun, setSelectedMaintenanceDurableRun] = useState<DurableRunState | null>(null);
  const [selectedMaintenanceTimeline, setSelectedMaintenanceTimeline] = useState<DurableTimelineEventState[]>([]);
  const [memoryMaintenanceModelsRefreshing, setMemoryMaintenanceModelsRefreshing] = useState(false);
  const memoryMaintenanceFeatureEnabledRef = useRef(memoryMaintenanceFeatureEnabled);
  const memoryMaintenanceDurableReadyRef = useRef(memoryMaintenanceDurableReady);
  const memoryMaintenanceDraftDirtyRef = useRef(memoryMaintenanceDraftDirty);
  const {
    config: runtimeLlmConfig,
    providers: runtimeProviderCatalog,
    loadModelsForProvider,
  } = useProviderModelCatalog("system");

  useEffect(() => {
    memoryAdminEnabledRef.current = memoryAdminEnabled;
  }, [memoryAdminEnabled]);

  useEffect(() => {
    memoryMaintenanceFeatureEnabledRef.current = memoryMaintenanceFeatureEnabled;
  }, [memoryMaintenanceFeatureEnabled]);

  useEffect(() => {
    memoryMaintenanceDurableReadyRef.current = memoryMaintenanceDurableReady;
  }, [memoryMaintenanceDurableReady]);

  useEffect(() => {
    memoryMaintenanceDraftDirtyRef.current = memoryMaintenanceDraftDirty;
  }, [memoryMaintenanceDraftDirty]);

  const workspacePrefix = useMemo(
    () => (workspaceId && workspaceId !== "default" ? `workspaces/${workspaceId}/` : ""),
    [workspaceId],
  );
  const memoryMaintenanceEffectiveProviderId = useMemo(
    () => memoryMaintenanceDraft?.providerId.trim() || runtimeLlmConfig?.activeProviderId || "",
    [memoryMaintenanceDraft?.providerId, runtimeLlmConfig?.activeProviderId],
  );
  const selectedMaintenanceProvider = useMemo(
    () => runtimeProviderCatalog.find((provider) => provider.providerId === memoryMaintenanceEffectiveProviderId),
    [memoryMaintenanceEffectiveProviderId, runtimeProviderCatalog],
  );
  const memoryMaintenanceProviderOptions = useMemo(() => {
    return runtimeProviderCatalog.map((provider) => ({
      value: provider.providerId,
      label: formatMemoryMaintenanceProviderOption(
        provider,
        provider.providerId === runtimeLlmConfig?.activeProviderId,
      ),
    }));
  }, [runtimeLlmConfig?.activeProviderId, runtimeProviderCatalog]);
  const memoryMaintenanceModelOptions = useMemo(() => {
    const provider = runtimeProviderCatalog.find((item) => item.providerId === memoryMaintenanceEffectiveProviderId);
    return dedupeTextOptions([
      provider?.defaultModel,
      ...(provider?.models ?? []),
      memoryMaintenanceDraft?.model,
      runtimeLlmConfig?.activeProviderId === memoryMaintenanceEffectiveProviderId
        ? runtimeLlmConfig.activeModel
        : undefined,
    ]).map((value) => ({ value, label: value }));
  }, [
    memoryMaintenanceDraft?.model,
    memoryMaintenanceEffectiveProviderId,
    runtimeLlmConfig?.activeModel,
    runtimeLlmConfig?.activeProviderId,
    runtimeProviderCatalog,
  ]);

  const loadMemoryMaintenance = useCallback(async () => {
    if (!memoryMaintenanceFeatureEnabledRef.current) {
      setMemoryMaintenanceStatus(null);
      setMemoryMaintenanceRuns([]);
      setMemoryMaintenanceRecommendations([]);
      setMemoryMaintenanceDraft(null);
      setSelectedMaintenanceRunId(null);
      setSelectedMaintenanceProvenance(null);
      setSelectedMaintenanceDurableRun(null);
      setSelectedMaintenanceTimeline([]);
      setMemoryMaintenanceError(null);
      return;
    }
    if (!memoryMaintenanceDurableReadyRef.current) {
      setMemoryMaintenanceStatus(null);
      setMemoryMaintenanceRuns([]);
      setMemoryMaintenanceRecommendations([]);
      setMemoryMaintenanceDraft(null);
      setSelectedMaintenanceRunId(null);
      setSelectedMaintenanceProvenance(null);
      setSelectedMaintenanceDurableRun(null);
      setSelectedMaintenanceTimeline([]);
      setMemoryMaintenanceError(null);
      return;
    }
    try {
      const [statusRes, runsRes, recommendationsRes] = await Promise.all([
        fetchMemoryMaintenanceStatus(workspaceId),
        fetchMemoryMaintenanceRuns(workspaceId, 50),
        fetchMemoryMaintenanceRecommendations(workspaceId, 25),
      ]);
      setMemoryMaintenanceStatus(statusRes);
      setMemoryMaintenanceRuns(runsRes.items);
      setMemoryMaintenanceRecommendations(recommendationsRes.items);
      if (!memoryMaintenanceDraftDirtyRef.current) {
        setMemoryMaintenanceDraft(toMemoryMaintenancePolicyDraft(statusRes.policy));
      }
      setMemoryMaintenanceError(null);
    } catch (maintenanceErr) {
      setMemoryMaintenanceError((maintenanceErr as Error).message);
    }
  }, [workspaceId]);

  const load = useCallback(
    async (options?: { background?: boolean }) => {
      const background = options?.background ?? false;
      if (background) {
        setIsRefreshing(true);
      } else {
        setIsInitialLoading(true);
      }
      try {
        const settingsPromise = background
          ? Promise.resolve<Awaited<ReturnType<typeof fetchSettings>> | null>(null)
          : fetchSettings();
        const [filesRes, stats, settings] = await Promise.all([
          fetchFilesList(".", 3000),
          fetchMemoryQmdStats(),
          settingsPromise,
        ]);
        const durableReady = settings?.features.durableKernelV1Enabled ?? memoryMaintenanceDurableReadyRef.current;
        const memoryMaintenanceAvailable =
          settings?.features.memoryMaintenanceV1Enabled ?? memoryMaintenanceFeatureEnabledRef.current;
        if (settings) {
          setMemoryMaintenanceFeatureEnabled(memoryMaintenanceAvailable);
          setMemoryMaintenanceDurableReady(durableReady);
          memoryMaintenanceFeatureEnabledRef.current = memoryMaintenanceAvailable;
          memoryMaintenanceDurableReadyRef.current = durableReady;
        }
        const memoryAdminAvailable = settings?.features.memoryLifecycleAdminV1Enabled ?? memoryAdminEnabledRef.current;
        if (!memoryAdminAvailable) {
          setMemoryItems([]);
          setSelectedMemoryItemId(null);
          setMemoryHistory([]);
          if (settings) {
            setMemoryAdminEnabled(false);
          }
          setMemoryAdminError(null);
        } else {
          try {
            const memoryRes = await fetchMemoryItems({ limit: 200, status: "all" });
            setMemoryItems(
              memoryRes.items.map((item) => ({
                itemId: item.itemId,
                namespace: item.namespace,
                title: item.title,
                content: item.content,
                pinned: item.pinned,
                status: item.status,
                updatedAt: item.updatedAt,
                ttlOverrideSeconds: item.ttlOverrideSeconds,
              })),
            );
            setSelectedMemoryItemId((current) => current ?? memoryRes.items[0]?.itemId ?? null);
            if (settings) {
              setMemoryAdminEnabled(true);
            }
            setMemoryAdminError(null);
          } catch (memoryErr) {
            const message = (memoryErr as Error).message;
            setMemoryItems([]);
            setSelectedMemoryItemId(null);
            setMemoryHistory([]);
            if (isMemoryLifecycleAdminDisabledError(message)) {
              setMemoryAdminEnabled(false);
              setMemoryAdminError(null);
            } else {
              setMemoryAdminEnabled(true);
              setMemoryAdminError(message);
            }
          }
        }
        if (!memoryMaintenanceAvailable) {
          setMemoryMaintenanceStatus(null);
          setMemoryMaintenanceRuns([]);
          setMemoryMaintenanceRecommendations([]);
          setMemoryMaintenanceDraft(null);
          setSelectedMaintenanceRunId(null);
          setSelectedMaintenanceProvenance(null);
          setSelectedMaintenanceDurableRun(null);
          setSelectedMaintenanceTimeline([]);
          setMemoryMaintenanceError(null);
        } else if (durableReady) {
          await loadMemoryMaintenance();
        } else {
          setMemoryMaintenanceStatus(null);
          setMemoryMaintenanceRuns([]);
          setMemoryMaintenanceRecommendations([]);
          setMemoryMaintenanceDraft(null);
          setSelectedMaintenanceRunId(null);
          setSelectedMaintenanceProvenance(null);
          setSelectedMaintenanceDurableRun(null);
          setSelectedMaintenanceTimeline([]);
          setMemoryMaintenanceError(null);
        }
        const scopedFiles = workspacePrefix
          ? filesRes.items
              .filter((item) => item.relativePath.startsWith(workspacePrefix))
              .map((item) => ({
                ...item,
                relativePath: item.relativePath.slice(workspacePrefix.length),
              }))
          : filesRes.items;
        setFiles(scopedFiles);
        setQmdStats({
          ...stats,
          recent: stats.recent.map((item) => ({
            contextId: item.contextId,
            scope: item.scope,
            createdAt: item.createdAt,
            quality: { status: item.quality.status },
          })),
        });
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (background) {
          setIsRefreshing(false);
        } else {
          setIsInitialLoading(false);
        }
      }
    },
    [loadMemoryMaintenance, workspacePrefix],
  );

  useEffect(() => {
    void load({ background: false });
  }, [load]);

  useRefreshSubscription(
    "memory",
    async () => {
      await load({ background: true });
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 1100,
      staleMs: 20000,
      pollIntervalMs: 15000,
      onFallbackStateChange: setIsFallbackRefreshing,
    },
  );

  const areas = useMemo(() => summarizeAreas(files), [files]);
  const areaOptions = useMemo(() => ["all", ...areas.map((area) => area.area)], [areas]);
  const memoryAreas = useMemo(() => summarizeMemorySubspaces(files), [files]);
  const searchOptions = useMemo(() => {
    const defaults = ["memory/", "data/", "docs/", "skills/", "logs/"];
    const discovered = files.slice(0, 120).map((file) => file.relativePath);
    return [...new Set([...defaults, ...discovered])].map((value) => ({ value, label: value }));
  }, [files]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return files.filter((file) => {
      const fileArea = topLevelArea(file.relativePath);
      if (selectedArea !== "all" && fileArea !== selectedArea) {
        return false;
      }
      if (!query) {
        return true;
      }
      return file.relativePath.toLowerCase().includes(query);
    });
  }, [files, search, selectedArea]);

  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const memoryFilesCount = useMemo(
    () => files.filter((file) => file.relativePath.startsWith("memory/")).length,
    [files],
  );
  const hottestArea = useMemo(() => areas[0], [areas]);
  const selectedMemoryItem = useMemo(
    () => memoryItems.find((item) => item.itemId === selectedMemoryItemId) ?? null,
    [memoryItems, selectedMemoryItemId],
  );
  const selectedMaintenanceRun = useMemo(
    () => memoryMaintenanceRuns.find((item) => item.runId === selectedMaintenanceRunId) ?? null,
    [memoryMaintenanceRuns, selectedMaintenanceRunId],
  );

  const loadMemoryHistory = useCallback(async (itemId: string) => {
    try {
      const history = await fetchMemoryItemHistory(itemId, 100);
      setMemoryHistory(
        history.items.map((item) => ({
          changeId: item.changeId,
          changeType: item.changeType,
          actorId: item.actorId,
          createdAt: item.createdAt,
        })),
      );
    } catch (historyErr) {
      setMemoryAdminError((historyErr as Error).message);
    }
  }, []);

  const togglePin = useCallback(async (itemId: string, pinned: boolean) => {
    setMemoryBusyItemId(itemId);
    try {
      const updated = await patchMemoryItem(itemId, { pinned: !pinned });
      setMemoryItems((current) =>
        current.map((item) =>
          item.itemId === itemId
            ? {
                ...item,
                pinned: updated.pinned,
                ttlOverrideSeconds: updated.ttlOverrideSeconds,
                updatedAt: updated.updatedAt,
              }
            : item,
        ),
      );
      setMemoryAdminError(null);
    } catch (pinErr) {
      setMemoryAdminError((pinErr as Error).message);
    } finally {
      setMemoryBusyItemId(null);
    }
  }, []);

  const forgetItem = useCallback(async (itemId: string) => {
    setMemoryBusyItemId(itemId);
    try {
      const updated = await forgetMemoryItem(itemId);
      setMemoryItems((current) =>
        current.map((item) =>
          item.itemId === itemId
            ? {
                ...item,
                status: updated.status,
                updatedAt: updated.updatedAt,
              }
            : item,
        ),
      );
      setMemoryAdminError(null);
    } catch (forgetErr) {
      setMemoryAdminError((forgetErr as Error).message);
    } finally {
      setMemoryBusyItemId(null);
    }
  }, []);

  const updateMemoryMaintenanceDraft = useCallback((patch: Partial<MemoryMaintenancePolicyDraft>) => {
    setMemoryMaintenanceDraft((current) => (current ? { ...current, ...patch } : current));
    setMemoryMaintenanceDraftDirty(true);
  }, []);
  const updateMemoryMaintenanceProviderDraft = useCallback(
    (nextProviderId: string) => {
      setMemoryMaintenanceDraft((current) => {
        if (!current) {
          return current;
        }
        const normalizedProviderId = nextProviderId.trim();
        const currentProvider = runtimeProviderCatalog.find(
          (provider) => provider.providerId === current.providerId.trim(),
        );
        const nextProvider = runtimeProviderCatalog.find((provider) => provider.providerId === normalizedProviderId);
        const shouldFollowProviderDefault =
          !current.model.trim() || current.model.trim() === (currentProvider?.defaultModel ?? "");
        return {
          ...current,
          providerId: nextProviderId,
          model: shouldFollowProviderDefault ? (nextProvider?.defaultModel ?? current.model) : current.model,
        };
      });
      setMemoryMaintenanceDraftDirty(true);
    },
    [runtimeProviderCatalog],
  );
  const refreshMemoryMaintenanceModels = useCallback(async () => {
    if (!memoryMaintenanceEffectiveProviderId) {
      return;
    }
    setMemoryMaintenanceModelsRefreshing(true);
    try {
      await loadModelsForProvider(memoryMaintenanceEffectiveProviderId, { force: true });
    } finally {
      setMemoryMaintenanceModelsRefreshing(false);
    }
  }, [loadModelsForProvider, memoryMaintenanceEffectiveProviderId]);
  const applyMemoryMaintenanceLocalOvernightPreset = useCallback(() => {
    const localProvider = runtimeProviderCatalog.find((provider) => isLikelyLocalProvider(provider.baseUrl));
    const fallbackProvider =
      localProvider ??
      runtimeProviderCatalog.find((provider) => provider.providerId === runtimeLlmConfig?.activeProviderId) ??
      selectedMaintenanceProvider;
    updateMemoryMaintenanceDraft({
      enabled: true,
      runMode: "hybrid",
      timingStrategy: "recommendation_first",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || memoryMaintenanceDraft?.timeZone || "UTC",
      providerId: fallbackProvider?.providerId ?? memoryMaintenanceDraft?.providerId ?? "",
      model: fallbackProvider?.defaultModel ?? memoryMaintenanceDraft?.model ?? runtimeLlmConfig?.activeModel ?? "",
      executionTarget: "local",
      unavailableModelPolicy: "skip",
      scheduleFrequency: "daily",
      scheduleHour: 3,
      scheduleMinute: 0,
    });
    if (fallbackProvider?.providerId) {
      void loadModelsForProvider(fallbackProvider.providerId);
    }
  }, [
    loadModelsForProvider,
    memoryMaintenanceDraft?.model,
    memoryMaintenanceDraft?.providerId,
    memoryMaintenanceDraft?.timeZone,
    runtimeLlmConfig?.activeModel,
    runtimeLlmConfig?.activeProviderId,
    runtimeProviderCatalog,
    selectedMaintenanceProvider,
    updateMemoryMaintenanceDraft,
  ]);

  useEffect(() => {
    if (!memoryMaintenanceEffectiveProviderId) {
      return;
    }
    void loadModelsForProvider(memoryMaintenanceEffectiveProviderId);
  }, [loadModelsForProvider, memoryMaintenanceEffectiveProviderId]);

  const loadMemoryMaintenanceRunDetails = useCallback(async (run: MemoryMaintenanceRunState) => {
    setMemoryMaintenanceBusy((current) => (current ? current : "inspect"));
    try {
      const provenancePromise = fetchMemoryMaintenanceRunProvenance(run.runId);
      const durablePromise = run.durableRunId
        ? Promise.all([fetchDurableRun(run.durableRunId), fetchDurableRunTimeline(run.durableRunId, 120)])
        : Promise.resolve<[DurableRunState | null, { items: DurableTimelineEventState[] }]>([null, { items: [] }]);
      const [provenance, durableDetail] = await Promise.all([provenancePromise, durablePromise]);
      setSelectedMaintenanceProvenance(provenance);
      setSelectedMaintenanceDurableRun(durableDetail[0]);
      setSelectedMaintenanceTimeline(durableDetail[1].items);
      setMemoryMaintenanceError(null);
    } catch (maintenanceErr) {
      setMemoryMaintenanceError((maintenanceErr as Error).message);
    } finally {
      setMemoryMaintenanceBusy((current) => (current === "inspect" ? null : current));
    }
  }, []);

  useEffect(() => {
    if (memoryMaintenanceRuns.length === 0) {
      setSelectedMaintenanceRunId(null);
      setSelectedMaintenanceProvenance(null);
      setSelectedMaintenanceDurableRun(null);
      setSelectedMaintenanceTimeline([]);
      return;
    }
    if (!selectedMaintenanceRunId || !memoryMaintenanceRuns.some((run) => run.runId === selectedMaintenanceRunId)) {
      setSelectedMaintenanceRunId(memoryMaintenanceStatus?.lastRun?.runId ?? memoryMaintenanceRuns[0]?.runId ?? null);
    }
  }, [memoryMaintenanceRuns, memoryMaintenanceStatus?.lastRun?.runId, selectedMaintenanceRunId]);

  useEffect(() => {
    if (!selectedMaintenanceRun) {
      return;
    }
    void loadMemoryMaintenanceRunDetails(selectedMaintenanceRun);
  }, [loadMemoryMaintenanceRunDetails, selectedMaintenanceRun]);

  const saveMemoryMaintenancePolicy = useCallback(async () => {
    if (!memoryMaintenanceDraft) {
      return;
    }
    setMemoryMaintenanceBusy("save");
    try {
      await patchMemoryMaintenancePolicy(workspaceId, buildMemoryMaintenancePolicyPatch(memoryMaintenanceDraft));
      setMemoryMaintenanceDraftDirty(false);
      await loadMemoryMaintenance();
      setMemoryMaintenanceError(null);
    } catch (maintenanceErr) {
      setMemoryMaintenanceError((maintenanceErr as Error).message);
    } finally {
      setMemoryMaintenanceBusy(null);
    }
  }, [loadMemoryMaintenance, memoryMaintenanceDraft, workspaceId]);

  const resetMemoryMaintenancePolicyDraft = useCallback(() => {
    if (!memoryMaintenanceStatus) {
      return;
    }
    setMemoryMaintenanceDraft(toMemoryMaintenancePolicyDraft(memoryMaintenanceStatus.policy));
    setMemoryMaintenanceDraftDirty(false);
    setMemoryMaintenanceError(null);
  }, [memoryMaintenanceStatus]);

  const runMemoryMaintenance = useCallback(async () => {
    setMemoryMaintenanceBusy("run");
    try {
      const run = await runMemoryMaintenanceNow({ workspaceId, triggerSource: "manual" });
      setSelectedMaintenanceRunId(run.runId);
      await loadMemoryMaintenance();
      setMemoryMaintenanceError(null);
    } catch (maintenanceErr) {
      setMemoryMaintenanceError((maintenanceErr as Error).message);
    } finally {
      setMemoryMaintenanceBusy(null);
    }
  }, [loadMemoryMaintenance, workspaceId]);

  const acceptMaintenanceRecommendation = useCallback(
    async (recommendationId: string) => {
      setMemoryMaintenanceBusy("accept");
      try {
        await acceptMemoryMaintenanceRecommendation(recommendationId);
        setMemoryMaintenanceDraftDirty(false);
        await loadMemoryMaintenance();
        setMemoryMaintenanceError(null);
      } catch (maintenanceErr) {
        setMemoryMaintenanceError((maintenanceErr as Error).message);
      } finally {
        setMemoryMaintenanceBusy(null);
      }
    },
    [loadMemoryMaintenance],
  );

  const rejectMaintenanceRecommendation = useCallback(
    async (recommendationId: string) => {
      setMemoryMaintenanceBusy("reject");
      try {
        await rejectMemoryMaintenanceRecommendation(recommendationId);
        await loadMemoryMaintenance();
        setMemoryMaintenanceError(null);
      } catch (maintenanceErr) {
        setMemoryMaintenanceError((maintenanceErr as Error).message);
      } finally {
        setMemoryMaintenanceBusy(null);
      }
    },
    [loadMemoryMaintenance],
  );

  const cancelSelectedMaintenanceRun = useCallback(async () => {
    if (!selectedMaintenanceRun?.durableRunId) {
      return;
    }
    setMemoryMaintenanceBusy("cancel");
    try {
      await cancelDurableRun(selectedMaintenanceRun.durableRunId, "memory-page");
      await loadMemoryMaintenance();
      await loadMemoryMaintenanceRunDetails(selectedMaintenanceRun);
      setMemoryMaintenanceError(null);
    } catch (maintenanceErr) {
      setMemoryMaintenanceError((maintenanceErr as Error).message);
    } finally {
      setMemoryMaintenanceBusy(null);
    }
  }, [loadMemoryMaintenance, loadMemoryMaintenanceRunDetails, selectedMaintenanceRun]);

  const retrySelectedMaintenanceRun = useCallback(async () => {
    if (!selectedMaintenanceRun?.durableRunId) {
      return;
    }
    setMemoryMaintenanceBusy("retry");
    try {
      await retryDurableRun(selectedMaintenanceRun.durableRunId, {
        actorId: "memory-page",
        reason: "MemoryPage requested retry",
      });
      await loadMemoryMaintenance();
      await loadMemoryMaintenanceRunDetails(selectedMaintenanceRun);
      setMemoryMaintenanceError(null);
    } catch (maintenanceErr) {
      setMemoryMaintenanceError((maintenanceErr as Error).message);
    } finally {
      setMemoryMaintenanceBusy(null);
    }
  }, [loadMemoryMaintenance, loadMemoryMaintenanceRunDetails, selectedMaintenanceRun]);

  return (
    <section className="workflow-page memory-v2">
      <PageHeader
        eyebrow="Knowledge"
        title={pageCopy.memory.title}
        subtitle={pageCopy.memory.subtitle}
        hint="Review what GoatCitadel stores, where it lives, and which learned items can still influence future turns."
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone="muted">{files.length} files</StatusChip>
            <StatusChip tone="muted">{memoryFilesCount} memory files</StatusChip>
            <StatusChip tone={memoryItems.length > 0 ? "success" : "muted"}>
              {memoryItems.length} memory items
            </StatusChip>
            {hottestArea ? <StatusChip tone="warning">{hottestArea.area}</StatusChip> : null}
          </div>
        }
      />
      <PageGuideCard
        pageId="memory"
        what={pageCopy.memory.guide?.what ?? ""}
        when={pageCopy.memory.guide?.when ?? ""}
        mostCommonAction={pageCopy.memory.guide?.mostCommonAction}
        actions={pageCopy.memory.guide?.actions ?? []}
        terms={pageCopy.memory.guide?.terms}
      />
      <div className="workflow-status-stack">
        {isInitialLoading ? <p>Loading memory workspace...</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing memory workspace...</p> : null}
        {isFallbackRefreshing ? (
          <p className="status-banner warning">Live updates degraded, checking periodically.</p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        <FieldHelp>
          Inspect the workspace memory footprint, recent context packs, and learned items when you need explicit
          operator control.
        </FieldHelp>
      </div>

      <div className="office-kpi-grid">
        <Panel className="stat-card" title="Workspace files" subtitle="Tracked across all indexed areas.">
          <p className="stat-card-value">{files.length}</p>
          <p className="stat-card-note">Tracked across all areas</p>
        </Panel>
        <Panel className="stat-card" title="Workspace size" subtitle="Total indexed file footprint.">
          <p className="stat-card-value">{formatBytes(totalBytes)}</p>
          <p className="stat-card-note">Total bytes in indexed files</p>
        </Panel>
        <Panel className="stat-card" title="Memory namespace" subtitle="Files currently under memory/.">
          <p className="stat-card-value">{memoryFilesCount}</p>
          <p className="stat-card-note">Files under memory/</p>
        </Panel>
        <Panel className="stat-card" title="Hottest area" subtitle="Largest top-level area by bytes.">
          <p className="stat-card-value">{hottestArea?.area ?? "-"}</p>
          <p className="stat-card-note">
            {hottestArea ? `${formatBytes(hottestArea.totalBytes)} total` : "No files indexed"}
          </p>
        </Panel>
        <Panel
          className="stat-card stat-card-accent"
          title="QMD Runs (24h)"
          subtitle={
            <>
              How many query-time memory distillation runs happened in the last 24 hours.
              <HelpHint
                label="QMD runs help"
                text="Generated means GoatCitadel built fresh context; cache hits means it reused a recent pack."
              />
            </>
          }
        >
          <p className="office-kpi-label">QMD activity</p>
          <p className="stat-card-value">{qmdStats?.totalRuns ?? 0}</p>
          <p className="stat-card-note">
            Generated {qmdStats?.generatedRuns ?? 0} / cache hits {qmdStats?.cacheHitRuns ?? 0}
          </p>
        </Panel>
        <Panel
          className="stat-card stat-card-warning"
          title="QMD Context Impact"
          subtitle={
            <>
              Whether distilled context reduced or expanded token usage.
              <HelpHint
                label="QMD context impact help"
                text="Negative savings means the distilled result grew instead of shrinking."
              />
            </>
          }
        >
          <p className="office-kpi-label">QMD impact</p>
          <p className="stat-card-value">{qmdStats ? describeQmdImpact(qmdStats) : "-"}</p>
          <p className="stat-card-note">
            {qmdStats
              ? `Went from ${qmdStats.originalTokenEstimate} tokens to ${qmdStats.distilledTokenEstimate} (${formatTokenDelta(qmdStats.netTokenDelta)}).`
              : "No QMD samples yet"}
          </p>
        </Panel>
      </div>

      <Panel
        title="Workspace Filters"
        subtitle="Filter the file inventory before drilling into memory-heavy areas."
        actions={
          <div className="data-toolbar-secondary">
            <StatusChip tone={selectedArea === "all" ? "muted" : "success"}>{selectedArea}</StatusChip>
            <StatusChip tone="muted">{filtered.length} matches</StatusChip>
          </div>
        }
      >
        <DataToolbar
          primary={
            <>
              <GCSelect
                value={selectedArea}
                onChange={(value) => setSelectedArea(value)}
                options={areaOptions.map((option) => ({ value: option, label: option }))}
              />
              <SelectOrCustom
                value={search}
                onChange={setSearch}
                options={searchOptions}
                customPlaceholder="Filter by path text"
                customLabel="Path filter"
              />
            </>
          }
        />
      </Panel>

      <div className="split-grid memory-workspace-grid">
        <Panel title="Workspace Areas" subtitle="Largest top-level file areas in this workspace.">
          <ul className="compact-list workspace-area-list">
            {areas.map((area) => (
              <li key={area.area}>
                <button
                  type="button"
                  className={selectedArea === area.area ? "active" : ""}
                  onClick={() => setSelectedArea(area.area)}
                >
                  <strong>{area.area}</strong>
                  <span>{area.files.length} files</span>
                  <span>{formatBytes(area.totalBytes)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title={`Files ${selectedArea !== "all" ? `(${selectedArea})` : "(all areas)"}`}
          subtitle="Preview the indexed file inventory before drilling into memory-specific areas."
        >
          <table>
            <thead>
              <tr>
                <th>Path</th>
                <th>Area</th>
                <th>Size</th>
                <th>Modified</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 300).map((file) => (
                <tr key={file.relativePath}>
                  <td>{file.relativePath}</td>
                  <td>{topLevelArea(file.relativePath)}</td>
                  <td>{formatBytes(file.size)}</td>
                  <td>{new Date(file.modifiedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 300 ? (
            <p className="office-subtitle">Showing first 300 rows of {filtered.length} matching files.</p>
          ) : null}
        </Panel>
      </div>

      <Panel title="memory/ Breakdown" subtitle="Subspaces discovered under memory/ and their relative footprint.">
        <table>
          <thead>
            <tr>
              <th>Memory Workspace</th>
              <th>Files</th>
              <th>Total Size</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>
            {memoryAreas.length === 0 ? (
              <tr>
                <td colSpan={4}>No memory/* subspaces discovered.</td>
              </tr>
            ) : (
              memoryAreas.map((area) => (
                <tr key={area.area}>
                  <td>{area.area}</td>
                  <td>{area.files.length}</td>
                  <td>{formatBytes(area.totalBytes)}</td>
                  <td>{area.latestModifiedAt ? new Date(area.latestModifiedAt).toLocaleString() : "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      <Panel title="Recent Distilled Context Packs" subtitle="Recent QMD outputs and their current quality status.">
        <table>
          <thead>
            <tr>
              <th>Context ID</th>
              <th>Scope</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {!qmdStats || qmdStats.recent.length === 0 ? (
              <tr>
                <td colSpan={4}>No QMD contexts generated yet.</td>
              </tr>
            ) : (
              qmdStats.recent.slice(0, 20).map((item) => (
                <tr key={item.contextId}>
                  <td>{item.contextId}</td>
                  <td>{item.scope}</td>
                  <td>{item.quality.status}</td>
                  <td>{new Date(item.createdAt).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      {memoryMaintenanceFeatureEnabled ? (
        <Panel
          title={
            <>
              Memory Maintenance
              <HelpHint
                label="Memory maintenance help"
                text="Dream runs a workspace-scoped consolidation pass with durable-run provenance, explicit history, and recommendation-first retiming."
              />
            </>
          }
          subtitle="Configure Dream policy, inspect due state, run history, and recommendation-driven timing changes."
          actions={
            <div className="workflow-summary-strip">
              <StatusChip tone={memoryMaintenanceStatus?.policy.enabled ? "success" : "muted"}>
                {memoryMaintenanceStatus?.policy.enabled ? "enabled" : "disabled"}
              </StatusChip>
              <StatusChip tone="muted">{memoryMaintenanceStatus?.policy.runMode ?? "manual"}</StatusChip>
              <StatusChip tone="muted">
                {memoryMaintenanceStatus?.state.changedSessionCount ?? 0} changed sessions
              </StatusChip>
              {memoryMaintenanceStatus?.nextDueAt ? (
                <StatusChip tone="warning">
                  next {new Date(memoryMaintenanceStatus.nextDueAt).toLocaleString()}
                </StatusChip>
              ) : null}
            </div>
          }
        >
          {!memoryMaintenanceDurableReady ? (
            <p className="office-subtitle">
              Dream is blocked because `durableKernelV1Enabled` is off. Re-enable the durable kernel before changing or
              running memory maintenance.
            </p>
          ) : (
            <>
              {memoryMaintenanceError ? <p className="error">{memoryMaintenanceError}</p> : null}
              {memoryMaintenanceDraft ? (
                <>
                  <div className="office-kpi-grid">
                    <Panel className="stat-card" title="Last run" subtitle="Most recent workspace maintenance pass.">
                      <p className="stat-card-value">{memoryMaintenanceStatus?.lastRun?.status ?? "-"}</p>
                      <p className="stat-card-note">
                        {memoryMaintenanceStatus?.lastRun?.finishedAt
                          ? new Date(memoryMaintenanceStatus.lastRun.finishedAt).toLocaleString()
                          : "No completed runs yet"}
                      </p>
                    </Panel>
                    <Panel className="stat-card" title="Next due" subtitle="Current schedule and threshold evaluation.">
                      <p className="stat-card-value">
                        {memoryMaintenanceStatus?.nextDueAt
                          ? formatShortDateTime(memoryMaintenanceStatus.nextDueAt)
                          : "-"}
                      </p>
                      <p className="stat-card-note">{memoryMaintenanceDraft.timeZone}</p>
                    </Panel>
                    <Panel
                      className="stat-card"
                      title="Provider / model"
                      subtitle="Pinned execution override for maintenance runs."
                    >
                      <p className="stat-card-value">{memoryMaintenanceDraft.providerId || "(active provider)"}</p>
                      <p className="stat-card-note">
                        {memoryMaintenanceDraft.model || "(active model)"}
                        {selectedMaintenanceProvider
                          ? ` · ${describeMaintenanceProviderLocality(selectedMaintenanceProvider.baseUrl)}`
                          : ""}
                      </p>
                    </Panel>
                    <Panel className="stat-card" title="Execution target" subtitle="Where Dream is allowed to execute.">
                      <p className="stat-card-value">{memoryMaintenanceDraft.executionTarget}</p>
                      <p className="stat-card-note">
                        {describeMaintenanceUnavailablePolicy(memoryMaintenanceDraft.unavailableModelPolicy)}
                      </p>
                    </Panel>
                  </div>

                  <div className="split-grid">
                    <div>
                      <h4>Policy</h4>
                      <div className="controls-row">
                        <label>
                          <input
                            type="checkbox"
                            checked={memoryMaintenanceDraft.enabled}
                            onChange={(event) => updateMemoryMaintenanceDraft({ enabled: event.target.checked })}
                          />{" "}
                          Enable Dream
                        </label>
                        <label>
                          Run mode
                          <GCSelect
                            value={memoryMaintenanceDraft.runMode}
                            onChange={(value) =>
                              updateMemoryMaintenanceDraft({
                                runMode: value as MemoryMaintenancePolicyDraft["runMode"],
                              })
                            }
                            options={[
                              { value: "manual", label: "manual" },
                              { value: "scheduled", label: "scheduled" },
                              { value: "hybrid", label: "hybrid" },
                            ]}
                          />
                        </label>
                        <label>
                          Timing strategy
                          <GCSelect
                            value={memoryMaintenanceDraft.timingStrategy}
                            onChange={(value) =>
                              updateMemoryMaintenanceDraft({
                                timingStrategy: value as MemoryMaintenancePolicyDraft["timingStrategy"],
                              })
                            }
                            options={[
                              { value: "fixed", label: "fixed" },
                              { value: "recommendation_first", label: "recommendation_first" },
                            ]}
                          />
                        </label>
                      </div>

                      <div className="controls-row">
                        <label>
                          Time zone
                          <input
                            value={memoryMaintenanceDraft.timeZone}
                            onChange={(event) => updateMemoryMaintenanceDraft({ timeZone: event.target.value })}
                            placeholder="America/Los_Angeles"
                          />
                        </label>
                        <label>
                          Provider
                          <SelectOrCustom
                            value={memoryMaintenanceDraft.providerId}
                            onChange={updateMemoryMaintenanceProviderDraft}
                            options={memoryMaintenanceProviderOptions}
                            customPlaceholder="provider id"
                            customLabel="Custom provider"
                          />
                        </label>
                        <label>
                          Model
                          <SelectOrCustom
                            value={memoryMaintenanceDraft.model}
                            onChange={(value) => updateMemoryMaintenanceDraft({ model: value })}
                            options={memoryMaintenanceModelOptions}
                            customPlaceholder="model id"
                            customLabel="Custom model"
                          />
                        </label>
                      </div>
                      <FieldHelp className="office-subtitle">
                        Dream uses this pinned provider/model for maintenance runs only. Leave either blank to follow
                        the active runtime default. For an overnight local run, pin a local provider, keep execution
                        target on `local`, keep unavailable-model policy on `skip`, and use `hybrid` or `scheduled` with
                        a late-night hour in your timezone.
                      </FieldHelp>
                      <div className="controls-row">
                        <ActionButton
                          label="Apply overnight local preset"
                          disabled={!memoryMaintenanceDraft}
                          onClick={applyMemoryMaintenanceLocalOvernightPreset}
                        />
                        <ActionButton
                          label={memoryMaintenanceModelsRefreshing ? "Refreshing models..." : "Refresh models"}
                          disabled={!memoryMaintenanceEffectiveProviderId || memoryMaintenanceModelsRefreshing}
                          onClick={() => void refreshMemoryMaintenanceModels()}
                        />
                      </div>
                      <p className="office-subtitle">
                        {selectedMaintenanceProvider
                          ? `${selectedMaintenanceProvider.providerId} resolves to ${selectedMaintenanceProvider.baseUrl}. ${describeMaintenanceProviderLocality(selectedMaintenanceProvider.baseUrl)}.`
                          : "Choose a provider to pin Dream to a specific runtime instead of the active chat default."}
                      </p>

                      <div className="controls-row">
                        <label>
                          Execution target
                          <GCSelect
                            value={memoryMaintenanceDraft.executionTarget}
                            onChange={(value) =>
                              updateMemoryMaintenanceDraft({
                                executionTarget: value as MemoryMaintenancePolicyDraft["executionTarget"],
                              })
                            }
                            options={[
                              { value: "auto", label: "auto" },
                              { value: "local", label: "local" },
                              { value: "cloud", label: "cloud" },
                            ]}
                          />
                        </label>
                        <label>
                          Unavailable model policy
                          <GCSelect
                            value={memoryMaintenanceDraft.unavailableModelPolicy}
                            onChange={(value) =>
                              updateMemoryMaintenanceDraft({
                                unavailableModelPolicy: value as MemoryMaintenancePolicyDraft["unavailableModelPolicy"],
                              })
                            }
                            options={[
                              { value: "skip", label: "skip" },
                              { value: "error", label: "error" },
                            ]}
                          />
                        </label>
                        <label>
                          Min hours since last success
                          <input
                            type="number"
                            min={1}
                            value={memoryMaintenanceDraft.minHoursSinceLastSuccess}
                            onChange={(event) =>
                              updateMemoryMaintenanceDraft({
                                minHoursSinceLastSuccess: clampNumber(
                                  event.target.value,
                                  1,
                                  720,
                                  memoryMaintenanceDraft.minHoursSinceLastSuccess,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          Min changed sessions
                          <input
                            type="number"
                            min={1}
                            value={memoryMaintenanceDraft.minChangedSessions}
                            onChange={(event) =>
                              updateMemoryMaintenanceDraft({
                                minChangedSessions: clampNumber(
                                  event.target.value,
                                  1,
                                  500,
                                  memoryMaintenanceDraft.minChangedSessions,
                                ),
                              })
                            }
                          />
                        </label>
                      </div>

                      <div className="controls-row">
                        <label>
                          <input
                            type="checkbox"
                            checked={memoryMaintenanceDraft.runMode !== "manual"}
                            disabled
                            readOnly
                          />{" "}
                          Schedule active
                        </label>
                        <label>
                          Frequency
                          <GCSelect
                            value={memoryMaintenanceDraft.scheduleFrequency}
                            onChange={(value) =>
                              updateMemoryMaintenanceDraft({
                                scheduleFrequency: value as MemoryMaintenancePolicyDraft["scheduleFrequency"],
                              })
                            }
                            options={[
                              { value: "daily", label: "daily" },
                              { value: "weekly", label: "weekly" },
                            ]}
                            disabled={memoryMaintenanceDraft.runMode === "manual"}
                          />
                        </label>
                        {memoryMaintenanceDraft.scheduleFrequency === "weekly" ? (
                          <label>
                            Weekday
                            <GCSelect
                              value={String(memoryMaintenanceDraft.scheduleWeekday)}
                              onChange={(value) =>
                                updateMemoryMaintenanceDraft({
                                  scheduleWeekday: clampNumber(value, 0, 6, memoryMaintenanceDraft.scheduleWeekday),
                                })
                              }
                              options={[
                                { value: "0", label: "Sunday" },
                                { value: "1", label: "Monday" },
                                { value: "2", label: "Tuesday" },
                                { value: "3", label: "Wednesday" },
                                { value: "4", label: "Thursday" },
                                { value: "5", label: "Friday" },
                                { value: "6", label: "Saturday" },
                              ]}
                              disabled={memoryMaintenanceDraft.runMode === "manual"}
                            />
                          </label>
                        ) : null}
                        <label>
                          Hour
                          <input
                            type="number"
                            min={0}
                            max={23}
                            value={memoryMaintenanceDraft.scheduleHour}
                            disabled={memoryMaintenanceDraft.runMode === "manual"}
                            onChange={(event) =>
                              updateMemoryMaintenanceDraft({
                                scheduleHour: clampNumber(
                                  event.target.value,
                                  0,
                                  23,
                                  memoryMaintenanceDraft.scheduleHour,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          Minute
                          <input
                            type="number"
                            min={0}
                            max={59}
                            value={memoryMaintenanceDraft.scheduleMinute}
                            disabled={memoryMaintenanceDraft.runMode === "manual"}
                            onChange={(event) =>
                              updateMemoryMaintenanceDraft({
                                scheduleMinute: clampNumber(
                                  event.target.value,
                                  0,
                                  59,
                                  memoryMaintenanceDraft.scheduleMinute,
                                ),
                              })
                            }
                          />
                        </label>
                      </div>

                      <div className="controls-row">
                        <ActionButton
                          label={memoryMaintenanceBusy === "save" ? "Saving..." : "Save policy"}
                          disabled={memoryMaintenanceBusy === "save" || !memoryMaintenanceDraftDirty}
                          onClick={() => void saveMemoryMaintenancePolicy()}
                        />
                        <ActionButton
                          label="Reset"
                          disabled={!memoryMaintenanceDraftDirty}
                          onClick={resetMemoryMaintenancePolicyDraft}
                        />
                        <ActionButton
                          label={memoryMaintenanceBusy === "run" ? "Running..." : "Run now"}
                          disabled={memoryMaintenanceBusy === "run"}
                          onClick={() => void runMemoryMaintenance()}
                        />
                      </div>
                    </div>

                    <div>
                      <h4>Status</h4>
                      <ul className="compact-list">
                        <li>
                          <strong>Workspace:</strong> {workspaceId}
                        </li>
                        <li>
                          <strong>Active run:</strong> {memoryMaintenanceStatus?.state.activeRunId ?? "-"}
                        </li>
                        <li>
                          <strong>Last successful run:</strong>{" "}
                          {formatMaybeDateTime(memoryMaintenanceStatus?.state.lastSuccessfulRunAt)}
                        </li>
                        <li>
                          <strong>Last eligibility check:</strong>{" "}
                          {formatMaybeDateTime(memoryMaintenanceStatus?.state.lastEligibilityAt)}
                        </li>
                        <li>
                          <strong>Last recommendation:</strong>{" "}
                          {formatMaybeDateTime(memoryMaintenanceStatus?.state.lastRecommendationAt)}
                        </li>
                        <li>
                          <strong>Changed sessions:</strong> {memoryMaintenanceStatus?.state.changedSessionCount ?? 0}
                        </li>
                        <li>
                          <strong>Last run summary:</strong> {memoryMaintenanceStatus?.lastRun?.summary ?? "-"}
                        </li>
                      </ul>
                    </div>
                  </div>

                  <div className="split-grid">
                    <div>
                      <h4>Run history</h4>
                      <table>
                        <thead>
                          <tr>
                            <th>Run</th>
                            <th>Status</th>
                            <th>Trigger</th>
                            <th>Provider / model</th>
                            <th>Created</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {memoryMaintenanceRuns.length === 0 ? (
                            <tr>
                              <td colSpan={6}>No maintenance runs recorded yet.</td>
                            </tr>
                          ) : (
                            memoryMaintenanceRuns.map((run) => (
                              <tr
                                key={run.runId}
                                className={selectedMaintenanceRunId === run.runId ? "row-selected" : ""}
                              >
                                <td>
                                  <strong>{shortId(run.runId)}</strong>
                                  <div className="office-subtitle">
                                    {run.sourceSessionCount} sessions / {run.changedArtifactCount} artifacts
                                  </div>
                                </td>
                                <td>{run.status}</td>
                                <td>{run.triggerSource}</td>
                                <td>
                                  {run.providerId ?? "(active)"} / {run.model ?? "(active)"}
                                </td>
                                <td>{new Date(run.createdAt).toLocaleString()}</td>
                                <td className="actions">
                                  <ActionButton
                                    label="Inspect"
                                    onClick={() => setSelectedMaintenanceRunId(run.runId)}
                                  />
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>

                    <div>
                      <h4>Recommendations</h4>
                      {memoryMaintenanceRecommendations.length === 0 ? (
                        <p className="office-subtitle">No timing recommendations queued.</p>
                      ) : (
                        <ul className="compact-list">
                          {memoryMaintenanceRecommendations.map((recommendation) => (
                            <li key={recommendation.recommendationId}>
                              <strong>{recommendation.kind}</strong> · {recommendation.status}
                              <div>{recommendation.summary}</div>
                              {recommendation.rationale ? (
                                <div className="office-subtitle">{recommendation.rationale}</div>
                              ) : null}
                              <div className="controls-row">
                                <ActionButton
                                  label="Accept"
                                  disabled={recommendation.status !== "queued" || memoryMaintenanceBusy === "accept"}
                                  onClick={() => void acceptMaintenanceRecommendation(recommendation.recommendationId)}
                                />
                                <ActionButton
                                  label="Reject"
                                  disabled={recommendation.status !== "queued" || memoryMaintenanceBusy === "reject"}
                                  onClick={() => void rejectMaintenanceRecommendation(recommendation.recommendationId)}
                                />
                              </div>
                              <pre>{formatJson(recommendation.proposedPatch)}</pre>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  <div className="split-grid">
                    <div>
                      <h4>Selected run</h4>
                      {!selectedMaintenanceRun ? (
                        <p className="office-subtitle">Select a run to inspect provenance and durable state.</p>
                      ) : (
                        <>
                          <p>
                            <strong>Run ID:</strong> {selectedMaintenanceRun.runId}
                          </p>
                          <p>
                            <strong>Status:</strong> {selectedMaintenanceRun.status}
                          </p>
                          <p>
                            <strong>Summary:</strong> {selectedMaintenanceRun.summary ?? "-"}
                          </p>
                          <p>
                            <strong>Error:</strong> {selectedMaintenanceRun.error ?? "-"}
                          </p>
                          <h5>Changes</h5>
                          {selectedMaintenanceProvenance?.changes.length ? (
                            <ul className="compact-list">
                              {selectedMaintenanceProvenance.changes.map((change) => (
                                <li key={change.changeId}>
                                  <strong>{change.changeKind}</strong> · {change.targetKind} · {change.targetRef}
                                  <div>{change.summary}</div>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="office-subtitle">No persisted changes recorded for this run yet.</p>
                          )}
                          <h5>Sources</h5>
                          {selectedMaintenanceProvenance?.sources.length ? (
                            <ul className="compact-list">
                              {selectedMaintenanceProvenance.sources.map((source) => (
                                <li key={source.sourceId}>
                                  <strong>{source.sourceKind}</strong> · {source.sourceRef}
                                  {source.modifiedAt ? ` · ${new Date(source.modifiedAt).toLocaleString()}` : ""}
                                  {source.tokenEstimate ? ` · ${source.tokenEstimate} tokens` : ""}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="office-subtitle">No source provenance captured yet.</p>
                          )}
                        </>
                      )}
                    </div>

                    <div>
                      <h4>Durable inspector</h4>
                      {!selectedMaintenanceRun?.durableRunId ? (
                        <p className="office-subtitle">This run has no durable run id attached.</p>
                      ) : (
                        <>
                          <p>
                            <strong>Durable run:</strong> {selectedMaintenanceRun.durableRunId}
                          </p>
                          <p>
                            <strong>Status:</strong> {selectedMaintenanceDurableRun?.status ?? "-"}
                          </p>
                          <div className="controls-row">
                            <ActionButton
                              label={memoryMaintenanceBusy === "cancel" ? "Cancelling..." : "Cancel"}
                              disabled={memoryMaintenanceBusy === "cancel"}
                              onClick={() => void cancelSelectedMaintenanceRun()}
                            />
                            <ActionButton
                              label={memoryMaintenanceBusy === "retry" ? "Retrying..." : "Retry"}
                              disabled={memoryMaintenanceBusy === "retry"}
                              onClick={() => void retrySelectedMaintenanceRun()}
                            />
                          </div>
                          {selectedMaintenanceTimeline.length === 0 ? (
                            <p className="office-subtitle">No durable timeline events loaded.</p>
                          ) : (
                            <details open>
                              <summary>Timeline ({selectedMaintenanceTimeline.length})</summary>
                              <ul className="compact-list">
                                {selectedMaintenanceTimeline
                                  .slice(-16)
                                  .reverse()
                                  .map((event) => (
                                    <li key={event.eventId}>
                                      <strong>{event.eventType}</strong>
                                      {event.stepKey ? ` · ${event.stepKey}` : ""}
                                      {" · "}
                                      {new Date(event.createdAt).toLocaleString()}
                                    </li>
                                  ))}
                              </ul>
                            </details>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <p className="office-subtitle">Loading memory-maintenance policy...</p>
              )}
            </>
          )}
        </Panel>
      ) : null}

      <Panel
        title={
          <>
            Memory Lifecycle Admin
            <HelpHint
              label="Memory lifecycle admin help"
              text="This panel lets you inspect, pin, and forget saved memory records directly. It is for operator review, not normal day-to-day chatting."
            />
          </>
        }
        subtitle="Inspect, pin, and forget saved memory records directly when lifecycle admin is enabled."
      >
        {!memoryAdminEnabled ? (
          <p className="office-subtitle">
            Memory lifecycle admin is disabled right now. File inventory and QMD context tracking are still available
            above.
          </p>
        ) : memoryAdminError ? (
          <p className="error">{memoryAdminError}</p>
        ) : memoryItems.length === 0 ? (
          <p className="office-subtitle">No memory lifecycle records available.</p>
        ) : (
          <div className="split-grid">
            <div>
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Namespace</th>
                    <th>
                      Status
                      <HelpHint
                        label="Memory status help"
                        text="Active memory can influence future replies. Forgotten memory stays in history but should no longer be reused. Pinned memory stays favored until you unpin it."
                      />
                    </th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {memoryItems.slice(0, 80).map((item) => (
                    <tr key={item.itemId} className={item.itemId === selectedMemoryItemId ? "row-selected" : ""}>
                      <td>{item.title}</td>
                      <td>{item.namespace}</td>
                      <td>
                        {item.status}
                        {item.pinned ? " • pinned" : ""}
                      </td>
                      <td>{new Date(item.updatedAt).toLocaleString()}</td>
                      <td className="actions">
                        <ActionButton
                          label="Inspect"
                          onClick={() => {
                            setSelectedMemoryItemId(item.itemId);
                            void loadMemoryHistory(item.itemId);
                          }}
                        />
                        <ActionButton
                          label={item.pinned ? "Unpin" : "Pin"}
                          disabled={memoryBusyItemId === item.itemId}
                          onClick={() => void togglePin(item.itemId, item.pinned)}
                        />
                        <ActionButton
                          label="Forget"
                          danger
                          disabled={item.status === "forgotten" || memoryBusyItemId === item.itemId}
                          onClick={() => setConfirmForgetItem({ itemId: item.itemId, title: item.title })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h4>{selectedMemoryItem ? selectedMemoryItem.title : "Select a memory item"}</h4>
              {selectedMemoryItem ? (
                <>
                  <p>
                    <strong>Item ID:</strong> {selectedMemoryItem.itemId}
                  </p>
                  <p>
                    <strong>Status:</strong> {selectedMemoryItem.status}
                  </p>
                  <p>
                    <strong>
                      TTL Override
                      <HelpHint
                        label="TTL override help"
                        text="Optional per-item expiration in seconds. Blank means the normal memory lifecycle rules apply instead."
                      />
                    </strong>
                    : {selectedMemoryItem.ttlOverrideSeconds ?? "-"}
                  </p>
                  <pre>{selectedMemoryItem.content}</pre>
                </>
              ) : null}
              <h4>Change History</h4>
              {memoryHistory.length === 0 ? (
                <p className="office-subtitle">
                  No history loaded yet. Inspect an item to see pin, forget, and edit events.
                </p>
              ) : null}
              <ul className="compact-list">
                {memoryHistory.map((event) => (
                  <li key={event.changeId}>
                    <strong>{event.changeType}</strong> · {new Date(event.createdAt).toLocaleString()}
                    {event.actorId ? ` · ${event.actorId}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Panel>
      <ConfirmModal
        open={Boolean(confirmForgetItem)}
        title="Forget Memory Item"
        message={`Forget "${confirmForgetItem?.title ?? "this memory item"}"? This cannot be undone.`}
        confirmLabel={memoryBusyItemId ? "Forgetting..." : "Forget"}
        danger
        onCancel={() => setConfirmForgetItem(null)}
        onConfirm={() => {
          const target = confirmForgetItem;
          if (!target) {
            return;
          }
          setConfirmForgetItem(null);
          void forgetItem(target.itemId);
        }}
      />
    </section>
  );
}
