import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  acceptMemoryMaintenanceRecommendation,
  addMemoryDecisionRetrospective,
  batchMutateMemoryItems,
  fetchDurableRun,
  fetchDurableRunTimeline,
  fetchMemoryDecisions,
  fetchMemoryEntities,
  fetchMemoryFeedback,
  fetchMemoryFiles,
  fetchMemoryItemHistory,
  fetchMemoryItems,
  fetchMemoryMaintenanceRecommendations,
  fetchMemoryMaintenanceRunProvenance,
  fetchMemoryMaintenanceRuns,
  fetchMemoryMaintenanceStatus,
  fetchMemoryQualityIssues,
  fetchMemoryRetrievalStatus,
  fetchMemoryRelations,
  fetchMemoryQmdStats,
  fetchTraceMemoryCandidates,
  fetchSettings,
  forgetMemoryItem,
  patchMemoryItem,
  patchMemoryMaintenancePolicy,
  patchMemoryQualityIssue,
  promoteTraceMemoryCandidate,
  rejectMemoryMaintenanceRecommendation,
  rejectTraceMemoryCandidate,
  runMemoryMaintenanceNow,
  runMemoryQualityScan,
} from "../api/client";
import { MEMORY_BATCH_MAX_OPERATIONS, type MemoryItemListPage } from "@goatcitadel/contracts";
import { isApiRequestError } from "../api/http-internal";
import {
  buildMemoryMaintenancePolicyPatch,
  type MemoryMaintenancePolicyDraft,
  toMemoryMaintenancePolicyDraft,
} from "../content/memory-helpers";

type Notice = {
  tone: "success" | "warning" | "error" | "info";
  message: string;
};

type MemoryAdminState = "enabled" | "disabled" | "unknown";

type MemoryBatchMutationOperations = Parameters<typeof batchMutateMemoryItems>[0]["operations"];
type MemoryMutationApprovalEnvelope = Awaited<ReturnType<typeof batchMutateMemoryItems>>;
type MemoryPendingMutationApproval = MemoryMutationApprovalEnvelope["pendingApproval"];

type MemoryOperatorSectionErrors = {
  settings: string | null;
  files: string | null;
  qmdStats: string | null;
  memoryRetrievalStatus: string | null;
  memoryItems: string | null;
  memoryEntities: string | null;
  memoryRelations: string | null;
  memoryDecisions: string | null;
  memoryFeedback: string | null;
  memoryQualityIssues: string | null;
  traceMemoryCandidates: string | null;
  memoryHistory: string | null;
  maintenanceStatus: string | null;
  maintenanceRuns: string | null;
  maintenanceRecommendations: string | null;
  selectedRunProvenance: string | null;
  selectedDurableRun: string | null;
  selectedDurableTimeline: string | null;
};

type MemoryOperatorSnapshot = {
  files: Awaited<ReturnType<typeof fetchMemoryFiles>>["items"];
  qmdStats: Awaited<ReturnType<typeof fetchMemoryQmdStats>> | null;
  memoryRetrievalStatus: Awaited<ReturnType<typeof fetchMemoryRetrievalStatus>> | null;
  memoryItems: Awaited<ReturnType<typeof fetchMemoryItems>>["items"];
  memoryItemsPage: Omit<MemoryItemListPage, "items"> | null;
  memoryItemsScopeKey: string;
  memoryEntities: Awaited<ReturnType<typeof fetchMemoryEntities>>["items"];
  memoryRelations: Awaited<ReturnType<typeof fetchMemoryRelations>>["items"];
  memoryDecisions: Awaited<ReturnType<typeof fetchMemoryDecisions>>["items"];
  memoryFeedback: Awaited<ReturnType<typeof fetchMemoryFeedback>>["items"];
  memoryQualityIssues: Awaited<ReturnType<typeof fetchMemoryQualityIssues>>["items"];
  traceMemoryCandidates: Awaited<ReturnType<typeof fetchTraceMemoryCandidates>>["items"];
  memoryHistory: Awaited<ReturnType<typeof fetchMemoryItemHistory>>["items"];
  maintenanceStatus: Awaited<ReturnType<typeof fetchMemoryMaintenanceStatus>> | null;
  maintenanceRuns: Awaited<ReturnType<typeof fetchMemoryMaintenanceRuns>>["items"];
  maintenanceRecommendations: Awaited<ReturnType<typeof fetchMemoryMaintenanceRecommendations>>["items"];
  selectedRunProvenance: Awaited<ReturnType<typeof fetchMemoryMaintenanceRunProvenance>> | null;
  selectedDurableRun: Awaited<ReturnType<typeof fetchDurableRun>> | null;
  selectedDurableTimeline: Awaited<ReturnType<typeof fetchDurableRunTimeline>>["items"];
  memoryAdminEnabled: boolean;
  memoryAdminState: MemoryAdminState;
  maintenanceEnabled: boolean;
  maintenanceDurableReady: boolean;
  sectionErrors: MemoryOperatorSectionErrors;
};

export type MemoryOperatorView = "all" | "items" | "quality" | "maintenance" | "graph";
function readWhen<T>(enabled: boolean, read: () => Promise<T>, fallback: T): Promise<T> { return enabled ? read() : Promise.resolve(fallback); }
export function useMemoryOperatorSnapshot(workspaceId = "default", options: { view?: MemoryOperatorView; query?: string; sourcesOpen?: boolean; itemDetailsOpen?: boolean } = {}) {
  const { view = "all", query = "", sourcesOpen = false, itemDetailsOpen = true } = options;
  const qualityOpen = view === "all" || view === "quality";
  const graphOpen = view === "all" || view === "graph";
  const maintenanceOpen = view === "all" || view === "maintenance";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [data, setData] = useState<MemoryOperatorSnapshot | null>(null);
  const [loadingMoreMemoryItems, setLoadingMoreMemoryItems] = useState(false);
  const [memoryItemsPageError, setMemoryItemsPageError] = useState<string | null>(null);
  const itemsPageRequestRef = useRef<object | null>(null);
  const itemsScopeKey = JSON.stringify([workspaceId, query.trim().toLowerCase(), view]);
  // HX-402 P1: mutation verbs request `memory.lifecycle` approvals instead of
  // mutating directly. Pending approvals are surfaced honestly so the page can
  // show that nothing changed yet and where to resolve the request.
  const [pendingMutationApprovals, setPendingMutationApprovals] = useState<MemoryPendingMutationApproval[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<MemoryMaintenancePolicyDraft | null>(null);
  const [policyDirty, setPolicyDirty] = useState(false);
  const policyBaseRevision = useRef<string | undefined>(undefined);
  const policyDraftState = useRef({ draft: policyDraft, dirty: policyDirty });
  policyDraftState.current = { draft: policyDraft, dirty: policyDirty };
  const policySavePending = useRef(false);
  // Monotonic load id: results from a superseded load (overlapping reloads, or a
  // reload that resolves after unmount/workspace switch) are dropped. Mirrors the
  // guard in useCrossProjectRecentSessions / useApprovalQueue.
  const loadSequenceRef = useRef(0);

  const load = useCallback(async () => {
    const sectionErrors = createEmptySectionErrors();
    const [settings, filesRes, qmdStats, memoryRetrievalStatus] = await Promise.all([
      fetchSettings().catch((settingsError) => {
        sectionErrors.settings = getErrorMessage(settingsError);
        return null;
      }),
      readWhen(view === "all" || sourcesOpen, () => fetchMemoryFiles("memory"), { items: [] }).catch((filesError) => {
        sectionErrors.files = getErrorMessage(filesError);
        return { items: [] };
      }),
      readWhen(qualityOpen, () => fetchMemoryQmdStats(undefined, undefined, 8), null).catch((qmdError) => {
        sectionErrors.qmdStats = getErrorMessage(qmdError);
        return null;
      }),
      fetchMemoryRetrievalStatus().catch((statusError) => {
        sectionErrors.memoryRetrievalStatus = getErrorMessage(statusError);
        return null;
      }),
    ]);

    const memoryAdminState: MemoryAdminState = settings
      ? settings.features.memoryLifecycleAdminV1Enabled
        ? "enabled"
        : "disabled"
      : "unknown";
    const memoryAdminEnabled = memoryAdminState === "enabled";
    const maintenanceEnabled = settings?.features.memoryMaintenanceV1Enabled ?? false;
    const maintenanceDurableReady = settings?.features.durableKernelV1Enabled ?? false;

    const [itemsRes, entitiesRes, relationsRes, decisionsRes, feedbackRes, qualityIssuesRes, traceCandidatesRes] =
      memoryAdminEnabled
        ? await Promise.all([
            fetchMemoryItems({ workspaceId, limit: view === "all" ? 200 : 500, status: "all", ...(query.trim() ? { query: query.trim() } : {}) }).catch((itemsError) => {
              sectionErrors.memoryItems = getErrorMessage(itemsError);
              return { items: [] };
            }),
            readWhen(graphOpen, () => fetchMemoryEntities({ workspaceId, status: "all", limit: 80 }), { items: [] }).catch((entitiesError) => {
              sectionErrors.memoryEntities = getErrorMessage(entitiesError);
              return { items: [] };
            }),
            readWhen(graphOpen, () => fetchMemoryRelations({ workspaceId, status: "all", limit: 80 }), { items: [] }).catch((relationsError) => {
              sectionErrors.memoryRelations = getErrorMessage(relationsError);
              return { items: [] };
            }),
            readWhen(graphOpen, () => fetchMemoryDecisions({ workspaceId, status: "all", limit: 80 }), { items: [] }).catch((decisionsError) => {
              sectionErrors.memoryDecisions = getErrorMessage(decisionsError);
              return { items: [] };
            }),
            readWhen(qualityOpen, () => fetchMemoryFeedback({ workspaceId, status: "all", limit: 40 }), { items: [] }).catch((feedbackError) => {
              sectionErrors.memoryFeedback = getErrorMessage(feedbackError);
              return { items: [] };
            }),
            readWhen(qualityOpen, () => fetchMemoryQualityIssues({ workspaceId, status: "all", limit: 40 }), { items: [] }).catch((qualityError) => {
              sectionErrors.memoryQualityIssues = getErrorMessage(qualityError);
              return { items: [] };
            }),
            readWhen(qualityOpen, () => fetchTraceMemoryCandidates({ workspaceId, status: "all", limit: 40 }), { items: [] }).catch((traceError) => {
              sectionErrors.traceMemoryCandidates = getErrorMessage(traceError);
              return { items: [] };
            }),
          ])
        : [{ items: [] }, { items: [] }, { items: [] }, { items: [] }, { items: [] }, { items: [] }, { items: [] }];

    const [maintenanceStatusRes, maintenanceRunsRes, maintenanceRecommendationsRes] =
      maintenanceOpen && maintenanceEnabled && maintenanceDurableReady
        ? await Promise.all([
            fetchMemoryMaintenanceStatus(workspaceId).catch((statusError) => {
              sectionErrors.maintenanceStatus = getErrorMessage(statusError);
              return null;
            }),
            fetchMemoryMaintenanceRuns(workspaceId, 40).catch((runsError) => {
              sectionErrors.maintenanceRuns = getErrorMessage(runsError);
              return { items: [] };
            }),
            fetchMemoryMaintenanceRecommendations(workspaceId, 20).catch((recommendationsError) => {
              sectionErrors.maintenanceRecommendations = getErrorMessage(recommendationsError);
              return { items: [] };
            }),
          ])
        : [null, { items: [] }, { items: [] }];

    return {
      files: filesRes.items,
      qmdStats,
      memoryRetrievalStatus,
      memoryItems: memoryAdminEnabled ? itemsRes.items : [],
      memoryItemsPage: memoryAdminEnabled && "total" in itemsRes && "snapshotAt" in itemsRes
        ? { total: itemsRes.total, snapshotAt: itemsRes.snapshotAt, nextCursor: itemsRes.nextCursor }
        : null,
      memoryItemsScopeKey: itemsScopeKey,
      memoryEntities: memoryAdminEnabled ? entitiesRes.items : [],
      memoryRelations: memoryAdminEnabled ? relationsRes.items : [],
      memoryDecisions: memoryAdminEnabled ? decisionsRes.items : [],
      memoryFeedback: memoryAdminEnabled ? feedbackRes.items : [],
      memoryQualityIssues: memoryAdminEnabled ? qualityIssuesRes.items : [],
      traceMemoryCandidates: memoryAdminEnabled ? traceCandidatesRes.items : [],
      memoryHistory: [],
      maintenanceStatus: maintenanceStatusRes,
      maintenanceRuns: maintenanceRunsRes.items,
      maintenanceRecommendations: maintenanceRecommendationsRes.items,
      selectedRunProvenance: null,
      selectedDurableRun: null,
      selectedDurableTimeline: [],
      memoryAdminEnabled,
      memoryAdminState,
      maintenanceEnabled,
      maintenanceDurableReady,
      sectionErrors,
    } satisfies MemoryOperatorSnapshot;
  }, [workspaceId, view, query, sourcesOpen, qualityOpen, graphOpen, maintenanceOpen, itemsScopeKey]);

  const reload = useCallback(async () => {
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    itemsPageRequestRef.current = null;
    setLoadingMoreMemoryItems(false);
    setMemoryItemsPageError(null);
    setError(null);
    try {
      const next = await load();
      if (loadSequenceRef.current !== loadId) {
        return;
      }
      setData(next);
      // Any committed snapshot — from the initial mount load OR an operator
      // action's reload() — means the surface has data and is no longer in its
      // initial loading state. `loading` is only ever set true by the mount
      // effect and cleared in that effect's `.finally`, but that clear is
      // guarded by `loadSequenceRef`: a reload() that starts while the mount
      // load is still in flight bumps the ref and masks the mount `.finally`,
      // while reload() itself never touched `loading`. That left the memory
      // surface stuck on its loader forever even though `data` was present.
      // Clearing loading here, where the reload commits its snapshot, makes the
      // loader reflect data availability regardless of how mount and reload
      // interleave (mirrors useOpsRuntimeSnapshot's commitData).
      setLoading(false);
      setSelectedItemId((current) => current ?? (view === "all" ? next.memoryItems[0]?.itemId ?? null : null));
      setSelectedRunId((current) => current ?? (view === "all" ? next.maintenanceRuns[0]?.runId ?? null : null));
      if (!policyDraftState.current.dirty && next.maintenanceStatus?.policy) {
        setPolicyDraft(toMemoryMaintenancePolicyDraft(next.maintenanceStatus.policy));
        policyBaseRevision.current = next.maintenanceStatus.policy.revision;
      }
    } catch (loadError) {
      if (loadSequenceRef.current !== loadId) {
        return;
      }
      setError(getErrorMessage(loadError));
    }
  }, [load, view]);

  const loadMoreMemoryItems = useCallback(async () => {
    const previous = data?.memoryItemsPage;
    if (loading || memoryItemsPageError || itemsPageRequestRef.current || !previous?.nextCursor || data?.memoryItemsScopeKey !== itemsScopeKey) return;
    const requestToken = {};
    const loadId = loadSequenceRef.current;
    itemsPageRequestRef.current = requestToken;
    setLoadingMoreMemoryItems(true);
    try {
      const page = await fetchMemoryItems({
        workspaceId, status: "all", limit: view === "all" ? 200 : 500,
        ...(query.trim() ? { query: query.trim() } : {}), cursor: previous.nextCursor,
      });
      if (loadId !== loadSequenceRef.current || itemsPageRequestRef.current !== requestToken) return;
      const items = [...data.memoryItems, ...page.items];
      if (page.snapshotAt !== previous.snapshotAt || page.total !== previous.total ||
          new Set(items.map(item => item.itemId)).size !== items.length || items.length > page.total ||
          (page.nextCursor && (page.nextCursor === previous.nextCursor || page.items.length === 0)) ||
          (!page.nextCursor && items.length !== page.total)) {
        throw new Error("Memory pages no longer agree. Reload memory before continuing.");
      }
      setData(current => current?.memoryItemsScopeKey === itemsScopeKey && current.memoryItemsPage?.nextCursor === previous.nextCursor
        ? { ...current, memoryItems: items, memoryItemsPage: { total: page.total, snapshotAt: page.snapshotAt, nextCursor: page.nextCursor } }
        : current);
    } catch (pageError) {
      if (loadId === loadSequenceRef.current && itemsPageRequestRef.current === requestToken) {
        setMemoryItemsPageError(isApiRequestError(pageError) && (pageError.status === 400 || pageError.status === 409)
          ? "Memory changed or this page expired. Reload memory before continuing."
          : "Could not load more memory. Reload memory to try again.");
      }
    } finally {
      if (itemsPageRequestRef.current === requestToken) {
        itemsPageRequestRef.current = null;
        setLoadingMoreMemoryItems(false);
      }
    }
  }, [data, itemsScopeKey, loading, memoryItemsPageError, query, view, workspaceId]);

  useEffect(() => {
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    itemsPageRequestRef.current = null;
    setLoadingMoreMemoryItems(false);
    setMemoryItemsPageError(null);
    setLoading(true);
    setError(null);
    void load()
      .then((next) => {
        if (loadSequenceRef.current !== loadId) {
          return;
        }
        setData(next);
        setSelectedItemId((current) => current ?? (view === "all" ? next.memoryItems[0]?.itemId ?? null : null));
        setSelectedRunId((current) => current ?? (view === "all" ? next.maintenanceRuns[0]?.runId ?? null : null));
        if (!policyDraftState.current.dirty && next.maintenanceStatus?.policy) {
          setPolicyDraft(toMemoryMaintenancePolicyDraft(next.maintenanceStatus.policy));
          policyBaseRevision.current = next.maintenanceStatus.policy.revision;
        }
      })
      .catch((loadError) => {
        if (loadSequenceRef.current !== loadId) {
          return;
        }
        setError(getErrorMessage(loadError));
      })
      .finally(() => {
        if (loadSequenceRef.current === loadId) {
          setLoading(false);
        }
      });
    return () => {
      // Invalidate this load (and any reload in flight) so a late resolution
      // after unmount or workspace switch cannot setState on an unmounted hook.
      loadSequenceRef.current += 1;
    };
  }, [load, view]);

  useEffect(() => {
    if (!selectedItemId || !itemDetailsOpen) {
      setData((current) => (current ? { ...current, memoryHistory: [] } : current));
      return;
    }
    let cancelled = false;
    void fetchMemoryItemHistory(selectedItemId, 100)
      .then((history) => {
        if (cancelled) {
          return;
        }
        setData((current) =>
          current
            ? {
                ...current,
                memoryHistory: history.items,
                sectionErrors: { ...current.sectionErrors, memoryHistory: null },
              }
            : current,
        );
      })
      .catch((historyError) => {
        if (cancelled) {
          return;
        }
        setData((current) =>
          current
            ? {
                ...current,
                memoryHistory: [],
                sectionErrors: { ...current.sectionErrors, memoryHistory: getErrorMessage(historyError) },
              }
            : current,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [selectedItemId, itemDetailsOpen]);

  // Derive the selected run's *stable identity* (its primitive ids) so the
  // provenance/durable-run fetch effect below depends on those primitives rather
  // than the `maintenanceRuns` array reference. `reload()` (refresh-bus signal /
  // 15s poll) rebuilds `maintenanceRuns` as a brand-new array even when its
  // contents are unchanged; depending on the array reference re-fired the effect
  // and re-issued up to 3 fetches for the same run on every poll. Keying on the
  // ids means an unchanged selected run on a poll does not refetch, while a genuinely
  // new run (or a real change to its ids) still does.
  const selectedRunFetchKey = useMemo(() => {
    const run = data?.maintenanceRuns.find((candidate) => candidate.runId === selectedRunId);
    return {
      runId: run?.runId,
      durableRunId: run?.durableRunId,
    };
  }, [data?.maintenanceRuns, selectedRunId]);

  // Destructure to primitives at render scope so the effect closes over (and depends
  // on) the ids directly. exhaustive-deps then needs only the primitives, not the memo
  // object (which is a fresh reference whenever maintenanceRuns is rebuilt on a poll).
  const { runId: selectedRunFetchRunId, durableRunId: selectedRunFetchDurableRunId } = selectedRunFetchKey;

  useEffect(() => {
    if (!selectedRunFetchRunId) {
      setData((current) =>
        current
          ? {
              ...current,
              selectedRunProvenance: null,
              selectedDurableRun: null,
              selectedDurableTimeline: [],
            }
          : current,
      );
      return;
    }
    let cancelled = false;
    void Promise.all([
      fetchMemoryMaintenanceRunProvenance(selectedRunFetchRunId)
        .then((provenance) => ({ value: provenance, error: null }))
        .catch((provenanceError) => ({ value: null, error: getErrorMessage(provenanceError) })),
      selectedRunFetchDurableRunId
        ? fetchDurableRun(selectedRunFetchDurableRunId)
            .then((durableRun) => ({ value: durableRun, error: null }))
            .catch((durableRunError) => ({ value: null, error: getErrorMessage(durableRunError) }))
        : Promise.resolve({ value: null, error: null }),
      selectedRunFetchDurableRunId
        ? fetchDurableRunTimeline(selectedRunFetchDurableRunId, 80)
            .then((durableTimeline) => ({ value: durableTimeline, error: null }))
            .catch((durableTimelineError) => ({
              value: { items: [] },
              error: getErrorMessage(durableTimelineError),
            }))
        : Promise.resolve({ value: { items: [] }, error: null }),
    ]).then(([provenance, durableRun, durableTimeline]) => {
      if (cancelled) {
        return;
      }
      setData((current) =>
        current
          ? {
              ...current,
              selectedRunProvenance: provenance.value,
              selectedDurableRun: durableRun.value,
              selectedDurableTimeline: durableTimeline.value.items,
              sectionErrors: {
                ...current.sectionErrors,
                selectedRunProvenance: provenance.error,
                selectedDurableRun: durableRun.error,
                selectedDurableTimeline: durableTimeline.error,
              },
            }
          : current,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [selectedRunFetchDurableRunId, selectedRunFetchRunId]);

  const selectedItem = useMemo(
    () => data?.memoryItems.find((item) => item.itemId === selectedItemId) ?? null,
    [data?.memoryItems, selectedItemId],
  );
  const selectedRun = useMemo(
    () => data?.maintenanceRuns.find((run) => run.runId === selectedRunId) ?? null,
    [data?.maintenanceRuns, selectedRunId],
  );

  const trackPendingMutationApproval = useCallback((pendingApproval: MemoryPendingMutationApproval) => {
    setPendingMutationApprovals((current) => [
      pendingApproval,
      ...current.filter((existing) => existing.approvalId !== pendingApproval.approvalId),
    ]);
  }, []);

  const dismissPendingMutationApproval = useCallback((approvalId: string) => {
    setPendingMutationApprovals((current) => current.filter((existing) => existing.approvalId !== approvalId));
  }, []);

  const saveItemPatch = useCallback(
    async (
      itemId: string,
      patch: { title?: string; content?: string; pinned?: boolean; ttlOverrideSeconds?: number | null },
    ) => {
      if (data?.memoryAdminState !== "enabled") {
        setNotice({
          tone: "warning",
          message: "Memory admin settings are not confirmed, so item changes are locked.",
        });
        return;
      }
      // Reject an invalid TTL override rather than letting NaN reach the request, where
      // JSON.stringify(NaN) === "null" would silently clear the override (the server treats
      // null as "use default") instead of surfacing the bad input. Mirrors the server schema
      // (positive integer, max 1 year, or null for default).
      if (
        patch.ttlOverrideSeconds !== undefined &&
        patch.ttlOverrideSeconds !== null &&
        !(
          Number.isInteger(patch.ttlOverrideSeconds) &&
          patch.ttlOverrideSeconds >= 1 &&
          patch.ttlOverrideSeconds <= 31_536_000
        )
      ) {
        setNotice({
          tone: "error",
          message: "TTL override must be a whole number of seconds between 1 and 31536000, or empty for the default.",
        });
        return;
      }
      setBusyKey(`item:${itemId}`);
      setNotice(null);
      try {
        const outcome = await patchMemoryItem(itemId, patch);
        trackPendingMutationApproval(outcome.pendingApproval);
        setNotice({
          tone: "info",
          message: `Memory item update requires approval ${outcome.pendingApproval.approvalId}. Nothing changed yet — resolve it from Approvals to apply.`,
        });
      } catch (patchError) {
        setNotice({ tone: "error", message: getErrorMessage(patchError) });
      } finally {
        setBusyKey(null);
      }
    },
    [data?.memoryAdminState, trackPendingMutationApproval],
  );

  const forgetSelectedItem = useCallback(async () => {
    if (!selectedItem) {
      return;
    }
    if (data?.memoryAdminState !== "enabled") {
      setNotice({
        tone: "warning",
        message: "Memory admin settings are not confirmed, so item changes are locked.",
      });
      return;
    }
    setBusyKey(`forget:${selectedItem.itemId}`);
    setNotice(null);
    try {
      const outcome = await forgetMemoryItem(selectedItem.itemId);
      if (outcome.pendingApproval) {
        trackPendingMutationApproval(outcome.pendingApproval);
        setNotice({
          tone: "info",
          message: `Memory forget requires approval ${outcome.pendingApproval.approvalId}. Nothing changed yet — resolve it from Approvals to apply.`,
        });
      } else {
        setNotice({ tone: "info", message: "Memory item is already forgotten; no approval is needed." });
      }
    } catch (forgetError) {
      setNotice({ tone: "error", message: getErrorMessage(forgetError) });
    } finally {
      setBusyKey(null);
    }
  }, [data?.memoryAdminState, selectedItem, trackPendingMutationApproval]);

  // Shared workhorse for atomic multi-item mutations (forget / pin). HX-402
  // P1: the batch verb routes through the approval flow — one
  // `memory.lifecycle` approval governs the whole batch and nothing mutates
  // until it resolves. The >100 guard mirrors the server's 1..100 schema so an
  // oversized batch fails fast client-side instead of silently splitting into
  // multiple non-atomic requests.
  const runBatchMutation = useCallback(
    async (
      busyKey: string,
      operations: MemoryBatchMutationOperations,
      requestLabel: string,
    ): Promise<MemoryMutationApprovalEnvelope | undefined> => {
      if (data?.memoryAdminState !== "enabled") {
        setNotice({
          tone: "warning",
          message: "Memory admin settings are not confirmed, so item changes are locked.",
        });
        return undefined;
      }
      if (operations.length === 0) {
        return undefined;
      }
      if (operations.length > MEMORY_BATCH_MAX_OPERATIONS) {
        setNotice({
          tone: "error",
          message: `Batch actions are limited to ${MEMORY_BATCH_MAX_OPERATIONS} items at a time.`,
        });
        return undefined;
      }
      setBusyKey(busyKey);
      setNotice(null);
      try {
        const envelope = await batchMutateMemoryItems({ source: "mission-control:library", operations });
        trackPendingMutationApproval(envelope.pendingApproval);
        setNotice({
          tone: "info",
          message: `${requestLabel} requires approval ${envelope.pendingApproval.approvalId}. Nothing changed yet — resolve it from Approvals to apply atomically.`,
        });
        return envelope;
      } catch (batchError) {
        setNotice({
          tone: "error",
          message: `Batch request failed — no changes were applied. ${getErrorMessage(batchError)}`,
        });
        return undefined;
      } finally {
        setBusyKey(null);
      }
    },
    [data?.memoryAdminState, trackPendingMutationApproval],
  );

  const batchForgetItems = useCallback(
    (itemIds: string[]) =>
      runBatchMutation(
        "memory-batch:forget",
        itemIds.map((itemId) => ({ kind: "forget_item" as const, itemId })),
        `Forgetting ${itemIds.length} memory item(s)`,
      ),
    [runBatchMutation],
  );

  const batchSetItemsPinned = useCallback(
    (itemIds: string[], pinned: boolean) =>
      runBatchMutation(
        `memory-batch:pin:${pinned}`,
        itemIds.map((itemId) => ({ kind: "patch_item" as const, itemId, patch: { pinned } })),
        `${pinned ? "Pinning" : "Unpinning"} ${itemIds.length} memory item(s)`,
      ),
    [runBatchMutation],
  );

  const runMaintenance = useCallback(async () => {
    if (!data?.maintenanceEnabled || !data.maintenanceDurableReady) {
      setNotice({
        tone: "warning",
        message: "Memory maintenance settings are not confirmed, so maintenance actions are locked.",
      });
      return;
    }
    setBusyKey("maintenance:run");
    setNotice(null);
    try {
      await runMemoryMaintenanceNow({ workspaceId, triggerSource: "manual" });
      setNotice({ tone: "success", message: "Memory maintenance queued." });
      await reload();
    } catch (runError) {
      setNotice({ tone: "error", message: getErrorMessage(runError) });
    } finally {
      setBusyKey(null);
    }
  }, [data?.maintenanceDurableReady, data?.maintenanceEnabled, reload, workspaceId]);

  const scanMemoryQuality = useCallback(async () => {
    if (data?.memoryAdminState !== "enabled") {
      setNotice({
        tone: "warning",
        message: "Memory admin settings are not confirmed, so quality scans are locked.",
      });
      return;
    }
    setBusyKey("memory-quality:scan");
    setNotice(null);
    try {
      const result = await runMemoryQualityScan({ workspaceId });
      setNotice({
        tone: "success",
        message: `Memory quality scan recorded ${result.issueCount} issue${result.issueCount === 1 ? "" : "s"}.`,
      });
      await reload();
    } catch (scanError) {
      setNotice({ tone: "error", message: getErrorMessage(scanError) });
    } finally {
      setBusyKey(null);
    }
  }, [data?.memoryAdminState, reload, workspaceId]);

  const patchQualityIssue = useCallback(
    async (issueId: string, status: "open" | "resolved" | "dismissed", resolutionNote?: string) => {
      if (data?.memoryAdminState !== "enabled") {
        setNotice({
          tone: "warning",
          message: "Memory admin settings are not confirmed, so quality issue changes are locked.",
        });
        return;
      }
      setBusyKey(`memory-quality:${issueId}:${status}`);
      setNotice(null);
      try {
        const updated = await patchMemoryQualityIssue(issueId, { status, resolutionNote });
        setData((current) =>
          current
            ? {
                ...current,
                memoryQualityIssues: current.memoryQualityIssues.map((issue) =>
                  issue.issueId === issueId ? updated : issue,
                ),
              }
            : current,
        );
        setNotice({
          tone: "success",
          message: status === "open" ? "Memory quality issue reopened." : `Memory quality issue ${status}.`,
        });
      } catch (patchError) {
        setNotice({ tone: "error", message: getErrorMessage(patchError) });
      } finally {
        setBusyKey(null);
      }
    },
    [data?.memoryAdminState],
  );

  const savePolicy = useCallback(async (submitted: MemoryMaintenancePolicyDraft | null = policyDraft, expectedRevision = policyBaseRevision.current) => {
    if (!submitted || policySavePending.current) return null;
    if (!data?.maintenanceEnabled || !data.maintenanceDurableReady) {
      setNotice({ tone: "warning", message: "Memory maintenance settings are not confirmed, so policy changes are locked." });
      return null;
    }
    policySavePending.current = true;
    const draftAtSubmit = policyDraftState.current.draft;
    setBusyKey("maintenance:policy"); setNotice(null);
    try {
      if (!expectedRevision) throw new Error("The policy revision is unavailable. Your draft is preserved; reload the policy before saving.");
      const current = await fetchMemoryMaintenanceStatus(workspaceId);
      if (current.workspaceId !== workspaceId || current.policy.workspaceId !== workspaceId || current.policy.revision !== expectedRevision) {
        throw new Error("The maintenance policy changed. Your draft is preserved; refresh and review the current policy before saving.");
      }
      const patch = buildMemoryMaintenancePolicyPatch(submitted);
      const updated = await patchMemoryMaintenancePolicy(workspaceId, { ...patch, expectedRevision });
      const saved = toMemoryMaintenancePolicyDraft(updated);
      if (updated.workspaceId !== workspaceId || !updated.revision || updated.revision === expectedRevision || JSON.stringify(buildMemoryMaintenancePolicyPatch(saved)) !== JSON.stringify(patch)) {
        throw new Error("The policy response does not confirm the submitted settings. Your draft is preserved; refresh to inspect the outcome.");
      }
      const newerDraft = JSON.stringify(policyDraftState.current.draft) !== JSON.stringify(draftAtSubmit);
      if (!newerDraft) setPolicyDraft(saved);
      policyDraftState.current.dirty = newerDraft;
      policyBaseRevision.current = updated.revision;
      setPolicyDirty(newerDraft);
      setNotice({ tone: "success", message: "Memory maintenance policy saved." });
      await reload();
      return updated;
    } catch (policyError) {
      if (isApiRequestError(policyError) && policyError.status === 409) {
        setNotice({ tone: "warning", message: "The maintenance policy changed. Your draft is preserved; review the current policy before saving again." });
        await reload();
      } else setNotice({ tone: "error", message: getErrorMessage(policyError) });
      return null;
    } finally {
      policySavePending.current = false; setBusyKey(null);
    }
  }, [data?.maintenanceDurableReady, data?.maintenanceEnabled, policyDraft, reload, workspaceId]);

  const resolveRecommendation = useCallback(
    async (recommendationId: string, decision: "accept" | "reject") => {
      if (!data?.maintenanceEnabled || !data.maintenanceDurableReady) {
        setNotice({
          tone: "warning",
          message: "Memory maintenance settings are not confirmed, so recommendations are locked.",
        });
        return;
      }
      setBusyKey(`recommendation:${recommendationId}:${decision}`);
      setNotice(null);
      try {
        const recommendation = data.maintenanceRecommendations.find((item) => item.recommendationId === recommendationId && item.workspaceId === workspaceId);
        if (!recommendation?.revision || recommendation.status !== "queued") {
          throw new Error("The recommendation is unavailable or already resolved. Reload and review it before deciding.");
        }
        const input = { expectedRevision: recommendation.revision };
        if (decision === "accept") {
          const policy = data.maintenanceStatus?.policy;
          if (!policy?.revision || policy.workspaceId !== workspaceId) throw new Error("The current policy is unavailable. Reload it before accepting a recommendation.");
          await acceptMemoryMaintenanceRecommendation(recommendationId, { ...input, expectedPolicyRevision: policy.revision });
        } else {
          await rejectMemoryMaintenanceRecommendation(recommendationId, input);
        }
        setNotice({
          tone: "success",
          message: decision === "accept" ? "Recommendation accepted." : "Recommendation rejected.",
        });
        await reload();
      } catch (recommendationError) {
        if (isApiRequestError(recommendationError) && recommendationError.status === 409) {
          setNotice({ tone: "warning", message: "The recommendation or policy changed. Review the current state before deciding again." });
          await reload();
        } else setNotice({ tone: "error", message: getErrorMessage(recommendationError) });
      } finally {
        setBusyKey(null);
      }
    },
    [data?.maintenanceDurableReady, data?.maintenanceEnabled, data?.maintenanceRecommendations, data?.maintenanceStatus, reload, workspaceId],
  );

  const reviewDecision = useCallback(
    async (decisionId: string) => {
      if (data?.memoryAdminState !== "enabled") {
        setNotice({
          tone: "warning",
          message: "Memory admin settings are not confirmed, so decision retrospectives are locked.",
        });
        return;
      }
      setBusyKey(`decision:${decisionId}:retrospective`);
      setNotice(null);
      try {
        const updated = await addMemoryDecisionRetrospective(decisionId, {
          outcome: "unknown",
          notes: "Reviewed from Mission Control Next Library memory panel.",
        });
        setData((current) =>
          current
            ? {
                ...current,
                memoryDecisions: current.memoryDecisions.map((item) => (item.id === updated.id ? updated : item)),
              }
            : current,
        );
        setNotice({ tone: "success", message: "Decision retrospective recorded." });
      } catch (reviewError) {
        setNotice({ tone: "error", message: getErrorMessage(reviewError) });
      } finally {
        setBusyKey(null);
      }
    },
    [data?.memoryAdminState],
  );

  const resolveTraceMemoryCandidate = useCallback(
    async (candidateId: string, action: "promote" | "reject") => {
      if (data?.memoryAdminState !== "enabled") {
        setNotice({ tone: "warning", message: "Memory admin is not enabled, so trace review is locked." });
        return;
      }
      setBusyKey(`trace:${candidateId}:${action}`);
      setNotice(null);
      try {
        if (action === "promote") {
          await promoteTraceMemoryCandidate(candidateId);
        } else {
          await rejectTraceMemoryCandidate(candidateId);
        }
        await reload();
        setNotice({
          tone: "success",
          message: action === "promote" ? "Trace candidate promoted by operator." : "Trace candidate rejected.",
        });
      } catch (reviewError) {
        setNotice({ tone: "error", message: getErrorMessage(reviewError) });
      } finally {
        setBusyKey(null);
      }
    },
    [data?.memoryAdminState, reload],
  );

  return {
    loading,
    error,
    notice,
    busyKey,
    data,
    loadingMoreMemoryItems,
    memoryItemsPageError,
    loadMoreMemoryItems,
    pendingMutationApprovals,
    dismissPendingMutationApproval,
    selectedItem,
    selectedItemId,
    setSelectedItemId,
    selectedRun,
    selectedRunId,
    setSelectedRunId,
    policyDraft,
    setPolicyDraft,
    policyDirty,
    setPolicyDirty,
    reload,
    saveItemPatch,
    forgetSelectedItem,
    batchForgetItems,
    batchSetItemsPinned,
    scanMemoryQuality,
    patchQualityIssue,
    runMaintenance,
    savePolicy,
    resolveRecommendation,
    resolveTraceMemoryCandidate,
    reviewDecision,
  };
}

function createEmptySectionErrors(): MemoryOperatorSectionErrors {
  return {
    settings: null,
    files: null,
    qmdStats: null,
    memoryRetrievalStatus: null,
    memoryItems: null,
    memoryEntities: null,
    memoryRelations: null,
    memoryDecisions: null,
    memoryFeedback: null,
    memoryQualityIssues: null,
    traceMemoryCandidates: null,
    memoryHistory: null,
    maintenanceStatus: null,
    maintenanceRuns: null,
    maintenanceRecommendations: null,
    selectedRunProvenance: null,
    selectedDurableRun: null,
    selectedDurableTimeline: null,
  };
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong.";
}
