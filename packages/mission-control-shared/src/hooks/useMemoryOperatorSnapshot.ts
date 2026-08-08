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
import { MEMORY_BATCH_MAX_OPERATIONS } from "@goatcitadel/contracts";
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

export function useMemoryOperatorSnapshot(workspaceId = "default") {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [data, setData] = useState<MemoryOperatorSnapshot | null>(null);
  // HX-402 P1: mutation verbs request `memory.lifecycle` approvals instead of
  // mutating directly. Pending approvals are surfaced honestly so the page can
  // show that nothing changed yet and where to resolve the request.
  const [pendingMutationApprovals, setPendingMutationApprovals] = useState<MemoryPendingMutationApproval[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<MemoryMaintenancePolicyDraft | null>(null);
  const [policyDirty, setPolicyDirty] = useState(false);
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
      fetchMemoryFiles("memory").catch((filesError) => {
        sectionErrors.files = getErrorMessage(filesError);
        return { items: [] };
      }),
      fetchMemoryQmdStats(undefined, undefined, 8).catch((qmdError) => {
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
            fetchMemoryItems({ workspaceId, limit: 200, status: "all" }).catch((itemsError) => {
              sectionErrors.memoryItems = getErrorMessage(itemsError);
              return { items: [] };
            }),
            fetchMemoryEntities({ workspaceId, status: "all", limit: 80 }).catch((entitiesError) => {
              sectionErrors.memoryEntities = getErrorMessage(entitiesError);
              return { items: [] };
            }),
            fetchMemoryRelations({ workspaceId, status: "all", limit: 80 }).catch((relationsError) => {
              sectionErrors.memoryRelations = getErrorMessage(relationsError);
              return { items: [] };
            }),
            fetchMemoryDecisions({ workspaceId, status: "all", limit: 80 }).catch((decisionsError) => {
              sectionErrors.memoryDecisions = getErrorMessage(decisionsError);
              return { items: [] };
            }),
            fetchMemoryFeedback({ workspaceId, status: "all", limit: 40 }).catch((feedbackError) => {
              sectionErrors.memoryFeedback = getErrorMessage(feedbackError);
              return { items: [] };
            }),
            fetchMemoryQualityIssues({ workspaceId, status: "all", limit: 40 }).catch((qualityError) => {
              sectionErrors.memoryQualityIssues = getErrorMessage(qualityError);
              return { items: [] };
            }),
            fetchTraceMemoryCandidates({ workspaceId, status: "all", limit: 40 }).catch((traceError) => {
              sectionErrors.traceMemoryCandidates = getErrorMessage(traceError);
              return { items: [] };
            }),
          ])
        : [{ items: [] }, { items: [] }, { items: [] }, { items: [] }, { items: [] }, { items: [] }, { items: [] }];

    const [maintenanceStatusRes, maintenanceRunsRes, maintenanceRecommendationsRes] =
      maintenanceEnabled && maintenanceDurableReady
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
  }, [workspaceId]);

  const reload = useCallback(async () => {
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    setError(null);
    try {
      const next = await load();
      if (loadSequenceRef.current !== loadId) {
        return;
      }
      setData(next);
      setSelectedItemId((current) => current ?? next.memoryItems[0]?.itemId ?? null);
      setSelectedRunId((current) => current ?? next.maintenanceRuns[0]?.runId ?? null);
      if (!policyDirty && next.maintenanceStatus?.policy) {
        setPolicyDraft(toMemoryMaintenancePolicyDraft(next.maintenanceStatus.policy));
      }
    } catch (loadError) {
      if (loadSequenceRef.current !== loadId) {
        return;
      }
      setError(getErrorMessage(loadError));
    }
  }, [load, policyDirty]);

  useEffect(() => {
    const loadId = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadId;
    setLoading(true);
    setError(null);
    void load()
      .then((next) => {
        if (loadSequenceRef.current !== loadId) {
          return;
        }
        setData(next);
        setSelectedItemId(next.memoryItems[0]?.itemId ?? null);
        setSelectedRunId(next.maintenanceRuns[0]?.runId ?? null);
        if (next.maintenanceStatus?.policy) {
          setPolicyDraft(toMemoryMaintenancePolicyDraft(next.maintenanceStatus.policy));
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
  }, [load]);

  useEffect(() => {
    if (!selectedItemId) {
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
  }, [selectedItemId]);

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

  const savePolicy = useCallback(async () => {
    if (!policyDraft) {
      return;
    }
    if (!data?.maintenanceEnabled || !data.maintenanceDurableReady) {
      setNotice({
        tone: "warning",
        message: "Memory maintenance settings are not confirmed, so policy changes are locked.",
      });
      return;
    }
    setBusyKey("maintenance:policy");
    setNotice(null);
    try {
      const updated = await patchMemoryMaintenancePolicy(workspaceId, buildMemoryMaintenancePolicyPatch(policyDraft));
      setPolicyDraft(toMemoryMaintenancePolicyDraft(updated));
      setPolicyDirty(false);
      setNotice({ tone: "success", message: "Memory maintenance policy saved." });
      await reload();
    } catch (policyError) {
      setNotice({ tone: "error", message: getErrorMessage(policyError) });
    } finally {
      setBusyKey(null);
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
        if (decision === "accept") {
          await acceptMemoryMaintenanceRecommendation(recommendationId);
        } else {
          await rejectMemoryMaintenanceRecommendation(recommendationId);
        }
        setNotice({
          tone: "success",
          message: decision === "accept" ? "Recommendation accepted." : "Recommendation rejected.",
        });
        await reload();
      } catch (recommendationError) {
        setNotice({ tone: "error", message: getErrorMessage(recommendationError) });
      } finally {
        setBusyKey(null);
      }
    },
    [data?.maintenanceDurableReady, data?.maintenanceEnabled, reload],
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
