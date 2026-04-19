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
import { OperatorSplitLayout } from "../components/OperatorSplitLayout";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { ConfirmModal } from "../components/ConfirmModal";
import { HelpHint } from "../components/HelpHint";
import { StatusChip } from "../components/StatusChip";
import { StatCard } from "../components/StatCard";
import { SelectOrCustom } from "../components/SelectOrCustom";
import { GCSelect } from "../components/ui";
import { pageCopy } from "../content/copy";
import { useProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import { MemoryMaintenancePanel } from "./memory/MemoryMaintenancePanel";
import { MemoryLifecycleAdminPanel } from "./memory/MemoryLifecycleAdminPanel";
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
    recent: Array<{
      contextId: string;
      scope: string;
      relationScope?: string;
      createdAt: string;
      quality: { status: string };
      citations: Array<{
        candidateId: string;
        sourceRef: string;
        provenance?: {
          freshness: string;
          selectionReason: string;
          sourceTimestamp?: string;
        };
      }>;
    }>;
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
        const settingsPromise = fetchSettings();
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
            relationScope: item.relationScope,
            createdAt: item.createdAt,
            quality: { status: item.quality.status },
            citations: item.citations.map((citation) => ({
              candidateId: citation.candidateId,
              sourceRef: citation.sourceRef,
              provenance: citation.provenance
                ? {
                    freshness: citation.provenance.freshness,
                    selectionReason: citation.provenance.selectionReason,
                    sourceTimestamp: citation.provenance.sourceTimestamp,
                  }
                : undefined,
            })),
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
        density="compact"
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

      <OperatorSplitLayout
        className="memory-operator-layout"
        primary={
          <Panel title="Workspace Areas" subtitle="Largest top-level file areas in this workspace.">
            <ul className="compact-list workspace-area-list">
              {areas.map((area) => (
                <li key={area.area}>
                  <button
                    type="button"
                    className={["gc-button", selectedArea === area.area ? "active" : ""].filter(Boolean).join(" ")}
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
        }
        inspector={
          <Panel
            title={`Files ${selectedArea !== "all" ? `(${selectedArea})` : "(all areas)"}`}
            subtitle="Preview the indexed file inventory before drilling into memory-specific areas."
          >
            {isInitialLoading ? <p>Loading memory workspace...</p> : null}
            {isRefreshing ? <p className="status-banner">Refreshing memory workspace...</p> : null}
            {isFallbackRefreshing ? (
              <p className="status-banner warning">Live updates degraded, checking periodically.</p>
            ) : null}
            {error ? <p className="error">{error}</p> : null}
            <table className="gc-data-table">
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
        }
      />

      <Panel
        title="Workspace Filters"
        subtitle="Filter the file inventory before drilling into memory-heavy areas."
        actions={
          <div className="data-toolbar-secondary">
            <StatusChip tone={selectedArea === "all" ? "muted" : "success"}>{selectedArea}</StatusChip>
            <StatusChip tone="muted">{filtered.length} matches</StatusChip>
          </div>
        }
        rank="muted"
        padding="compact"
        collapsible
        defaultExpanded={false}
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

      <div className="office-kpi-grid memory-summary-grid">
        <StatCard
          label="Workspace files"
          value={files.length}
          note="Tracked across all indexed areas"
          compact
          className="operator-summary-card"
        />
        <StatCard
          label="Workspace size"
          value={formatBytes(totalBytes)}
          note="Total indexed file footprint"
          compact
          className="operator-summary-card"
        />
        <StatCard
          label="Memory namespace"
          value={memoryFilesCount}
          note="Files currently under memory/"
          compact
          className="operator-summary-card"
        />
        <StatCard
          label="Hottest area"
          value={hottestArea?.area ?? "-"}
          note={hottestArea ? `${formatBytes(hottestArea.totalBytes)} total` : "No files indexed"}
          compact
          className="operator-summary-card"
        />
        <StatCard
          label="QMD activity"
          value={qmdStats?.totalRuns ?? 0}
          note={`Generated ${qmdStats?.generatedRuns ?? 0} / cache hits ${qmdStats?.cacheHitRuns ?? 0}`}
          tone="accent"
          compact
          className="operator-summary-card"
        />
        <StatCard
          label="QMD impact"
          value={qmdStats ? describeQmdImpact(qmdStats) : "-"}
          note={
            qmdStats
              ? `From ${qmdStats.originalTokenEstimate} to ${qmdStats.distilledTokenEstimate} tokens (${formatTokenDelta(qmdStats.netTokenDelta)}).`
              : "No QMD samples yet"
          }
          tone="warning"
          compact
          className="operator-summary-card"
        />
      </div>

      <Panel
        title="memory/ Breakdown"
        subtitle="Subspaces discovered under memory/ and their relative footprint."
        rank="muted"
        padding="compact"
        collapsible
        defaultExpanded={false}
      >
        <table className="gc-data-table">
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

      <Panel
        title="Recent Distilled Context Packs"
        subtitle="Recent QMD outputs and their current quality status."
        rank="muted"
        padding="compact"
        collapsible
        defaultExpanded={false}
      >
        <table className="gc-data-table">
          <thead>
            <tr>
              <th>Context ID</th>
              <th>Scope</th>
              <th>Relation</th>
              <th>Status</th>
              <th>Provenance</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {!qmdStats || qmdStats.recent.length === 0 ? (
              <tr>
                <td colSpan={6}>No QMD contexts generated yet.</td>
              </tr>
            ) : (
              qmdStats.recent.slice(0, 20).map((item) => (
                <tr key={item.contextId}>
                  <td>{item.contextId}</td>
                  <td>{item.scope}</td>
                  <td>{item.relationScope ?? "-"}</td>
                  <td>{item.quality.status}</td>
                  <td>
                    {item.citations.length === 0 ? (
                      "-"
                    ) : (
                      <details>
                        <summary>{item.citations.length} citations</summary>
                        <ul className="compact-list">
                          {item.citations.slice(0, 3).map((citation) => (
                            <li key={citation.candidateId}>
                              <strong>{citation.sourceRef}</strong>
                              {citation.provenance?.freshness ? ` | freshness ${citation.provenance.freshness}` : ""}
                              {citation.provenance?.selectionReason ? ` | ${citation.provenance.selectionReason}` : ""}
                              {citation.provenance?.sourceTimestamp
                                ? ` | source ${new Date(citation.provenance.sourceTimestamp).toLocaleString()}`
                                : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                  <td>{new Date(item.createdAt).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      {memoryMaintenanceFeatureEnabled ? (
        <MemoryMaintenancePanel
          memoryMaintenanceDurableReady={memoryMaintenanceDurableReady}
          memoryMaintenanceStatus={memoryMaintenanceStatus}
          memoryMaintenanceError={memoryMaintenanceError}
          memoryMaintenanceDraft={memoryMaintenanceDraft}
          memoryMaintenanceDraftDirty={memoryMaintenanceDraftDirty}
          memoryMaintenanceBusy={memoryMaintenanceBusy}
          selectedMaintenanceProvider={selectedMaintenanceProvider}
          memoryMaintenanceProviderOptions={memoryMaintenanceProviderOptions}
          memoryMaintenanceModelOptions={memoryMaintenanceModelOptions}
          memoryMaintenanceModelsRefreshing={memoryMaintenanceModelsRefreshing}
          memoryMaintenanceEffectiveProviderId={memoryMaintenanceEffectiveProviderId}
          updateMemoryMaintenanceDraft={updateMemoryMaintenanceDraft}
          updateMemoryMaintenanceProviderDraft={updateMemoryMaintenanceProviderDraft}
          applyMemoryMaintenanceLocalOvernightPreset={applyMemoryMaintenanceLocalOvernightPreset}
          refreshMemoryMaintenanceModels={refreshMemoryMaintenanceModels}
          saveMemoryMaintenancePolicy={saveMemoryMaintenancePolicy}
          resetMemoryMaintenancePolicyDraft={resetMemoryMaintenancePolicyDraft}
          runMemoryMaintenance={runMemoryMaintenance}
          workspaceId={workspaceId}
          memoryMaintenanceRuns={memoryMaintenanceRuns}
          selectedMaintenanceRunId={selectedMaintenanceRunId}
          setSelectedMaintenanceRunId={setSelectedMaintenanceRunId}
          memoryMaintenanceRecommendations={memoryMaintenanceRecommendations}
          acceptMaintenanceRecommendation={acceptMaintenanceRecommendation}
          rejectMaintenanceRecommendation={rejectMaintenanceRecommendation}
          selectedMaintenanceRun={selectedMaintenanceRun}
          selectedMaintenanceProvenance={selectedMaintenanceProvenance}
          selectedMaintenanceDurableRun={selectedMaintenanceDurableRun}
          selectedMaintenanceTimeline={selectedMaintenanceTimeline}
          cancelSelectedMaintenanceRun={cancelSelectedMaintenanceRun}
          retrySelectedMaintenanceRun={retrySelectedMaintenanceRun}
        />
      ) : null}

      <MemoryLifecycleAdminPanel
        memoryAdminEnabled={memoryAdminEnabled}
        memoryAdminError={memoryAdminError}
        memoryItems={memoryItems}
        selectedMemoryItemId={selectedMemoryItemId}
        selectedMemoryItem={selectedMemoryItem}
        memoryHistory={memoryHistory}
        memoryBusyItemId={memoryBusyItemId}
        onInspect={(itemId) => {
          setSelectedMemoryItemId(itemId);
          void loadMemoryHistory(itemId);
        }}
        onTogglePin={(itemId, pinned) => {
          void togglePin(itemId, pinned);
        }}
        onRequestForget={(item) => {
          setConfirmForgetItem(item);
        }}
      />
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
