import { useCallback, useEffect, useMemo, useState } from "react";
import {
  acceptMemoryMaintenanceRecommendation,
  addMemoryDecisionRetrospective,
  fetchDurableRun,
  fetchDurableRunTimeline,
  fetchMemoryDecisions,
  fetchMemoryEntities,
  fetchMemoryFiles,
  fetchMemoryItemHistory,
  fetchMemoryItems,
  fetchMemoryMaintenanceRecommendations,
  fetchMemoryMaintenanceRunProvenance,
  fetchMemoryMaintenanceRuns,
  fetchMemoryMaintenanceStatus,
  fetchMemoryRelations,
  fetchMemoryQmdStats,
  fetchSettings,
  forgetMemoryItem,
  patchMemoryItem,
  patchMemoryMaintenancePolicy,
  rejectMemoryMaintenanceRecommendation,
  runMemoryMaintenanceNow,
} from "../api/client";
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

type MemoryOperatorSectionErrors = {
  settings: string | null;
  files: string | null;
  qmdStats: string | null;
  memoryItems: string | null;
  memoryEntities: string | null;
  memoryRelations: string | null;
  memoryDecisions: string | null;
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
  memoryItems: Awaited<ReturnType<typeof fetchMemoryItems>>["items"];
  memoryEntities: Awaited<ReturnType<typeof fetchMemoryEntities>>["items"];
  memoryRelations: Awaited<ReturnType<typeof fetchMemoryRelations>>["items"];
  memoryDecisions: Awaited<ReturnType<typeof fetchMemoryDecisions>>["items"];
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
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [policyDraft, setPolicyDraft] = useState<MemoryMaintenancePolicyDraft | null>(null);
  const [policyDirty, setPolicyDirty] = useState(false);

  const load = useCallback(async () => {
    const sectionErrors = createEmptySectionErrors();
    const [settings, filesRes, qmdStats] = await Promise.all([
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
    ]);

    const memoryAdminState: MemoryAdminState = settings
      ? settings.features.memoryLifecycleAdminV1Enabled
        ? "enabled"
        : "disabled"
      : "unknown";
    const memoryAdminEnabled = memoryAdminState === "enabled";
    const maintenanceEnabled = settings?.features.memoryMaintenanceV1Enabled ?? false;
    const maintenanceDurableReady = settings?.features.durableKernelV1Enabled ?? false;

    const [itemsRes, entitiesRes, relationsRes, decisionsRes] = memoryAdminEnabled
      ? await Promise.all([
          fetchMemoryItems({ limit: 200, status: "all" }).catch((itemsError) => {
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
        ])
      : [{ items: [] }, { items: [] }, { items: [] }, { items: [] }];

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
      memoryItems: memoryAdminEnabled ? itemsRes.items : [],
      memoryEntities: memoryAdminEnabled ? entitiesRes.items : [],
      memoryRelations: memoryAdminEnabled ? relationsRes.items : [],
      memoryDecisions: memoryAdminEnabled ? decisionsRes.items : [],
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
    setError(null);
    try {
      const next = await load();
      setData(next);
      setSelectedItemId((current) => current ?? next.memoryItems[0]?.itemId ?? null);
      setSelectedRunId((current) => current ?? next.maintenanceRuns[0]?.runId ?? null);
      if (!policyDirty && next.maintenanceStatus?.policy) {
        setPolicyDraft(toMemoryMaintenancePolicyDraft(next.maintenanceStatus.policy));
      }
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    }
  }, [load, policyDirty]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void load()
      .then((next) => {
        if (cancelled) {
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
        if (!cancelled) {
          setError(getErrorMessage(loadError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
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

  useEffect(() => {
    const selectedRun = data?.maintenanceRuns.find((run) => run.runId === selectedRunId);
    if (!selectedRun) {
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
      fetchMemoryMaintenanceRunProvenance(selectedRun.runId)
        .then((provenance) => ({ value: provenance, error: null }))
        .catch((provenanceError) => ({ value: null, error: getErrorMessage(provenanceError) })),
      selectedRun.durableRunId
        ? fetchDurableRun(selectedRun.durableRunId)
            .then((durableRun) => ({ value: durableRun, error: null }))
            .catch((durableRunError) => ({ value: null, error: getErrorMessage(durableRunError) }))
        : Promise.resolve({ value: null, error: null }),
      selectedRun.durableRunId
        ? fetchDurableRunTimeline(selectedRun.durableRunId, 80)
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
  }, [data?.maintenanceRuns, selectedRunId]);

  const selectedItem = useMemo(
    () => data?.memoryItems.find((item) => item.itemId === selectedItemId) ?? null,
    [data?.memoryItems, selectedItemId],
  );
  const selectedRun = useMemo(
    () => data?.maintenanceRuns.find((run) => run.runId === selectedRunId) ?? null,
    [data?.maintenanceRuns, selectedRunId],
  );

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
      setBusyKey(`item:${itemId}`);
      setNotice(null);
      try {
        const updated = await patchMemoryItem(itemId, patch);
        setData((current) =>
          current
            ? {
                ...current,
                memoryItems: current.memoryItems.map((item) => (item.itemId === itemId ? updated : item)),
              }
            : current,
        );
        setNotice({ tone: "success", message: "Memory item updated." });
      } catch (patchError) {
        setNotice({ tone: "error", message: getErrorMessage(patchError) });
      } finally {
        setBusyKey(null);
      }
    },
    [data?.memoryAdminState],
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
      const updated = await forgetMemoryItem(selectedItem.itemId);
      setData((current) =>
        current
          ? {
              ...current,
              memoryItems: current.memoryItems.map((item) => (item.itemId === updated.itemId ? updated : item)),
            }
          : current,
      );
      setNotice({ tone: "success", message: "Memory item forgotten." });
    } catch (forgetError) {
      setNotice({ tone: "error", message: getErrorMessage(forgetError) });
    } finally {
      setBusyKey(null);
    }
  }, [data?.memoryAdminState, selectedItem]);

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

  return {
    loading,
    error,
    notice,
    busyKey,
    data,
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
    runMaintenance,
    savePolicy,
    resolveRecommendation,
    reviewDecision,
  };
}

function createEmptySectionErrors(): MemoryOperatorSectionErrors {
  return {
    settings: null,
    files: null,
    qmdStats: null,
    memoryItems: null,
    memoryEntities: null,
    memoryRelations: null,
    memoryDecisions: null,
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
