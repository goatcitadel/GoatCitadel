import { useCallback, useEffect, useMemo, useState } from "react";
import {
  acceptMemoryMaintenanceRecommendation,
  fetchDurableRun,
  fetchDurableRunTimeline,
  fetchMemoryFiles,
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

type MemoryOperatorSnapshot = {
  files: Awaited<ReturnType<typeof fetchMemoryFiles>>["items"];
  qmdStats: Awaited<ReturnType<typeof fetchMemoryQmdStats>> | null;
  memoryItems: Awaited<ReturnType<typeof fetchMemoryItems>>["items"];
  memoryHistory: Awaited<ReturnType<typeof fetchMemoryItemHistory>>["items"];
  maintenanceStatus: Awaited<ReturnType<typeof fetchMemoryMaintenanceStatus>> | null;
  maintenanceRuns: Awaited<ReturnType<typeof fetchMemoryMaintenanceRuns>>["items"];
  maintenanceRecommendations: Awaited<ReturnType<typeof fetchMemoryMaintenanceRecommendations>>["items"];
  selectedRunProvenance: Awaited<ReturnType<typeof fetchMemoryMaintenanceRunProvenance>> | null;
  selectedDurableRun: Awaited<ReturnType<typeof fetchDurableRun>> | null;
  selectedDurableTimeline: Awaited<ReturnType<typeof fetchDurableRunTimeline>>["items"];
  memoryAdminEnabled: boolean;
  maintenanceEnabled: boolean;
  maintenanceDurableReady: boolean;
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
    const [settings, filesRes, qmdStats, itemsRes] = await Promise.all([
      fetchSettings().catch(() => null),
      fetchMemoryFiles("memory").catch(() => ({ items: [] })),
      fetchMemoryQmdStats(undefined, undefined, 8).catch(() => null),
      fetchMemoryItems({ limit: 200, status: "all" }).catch(() => ({ items: [] })),
    ]);

    const memoryAdminEnabled = settings?.features.memoryLifecycleAdminV1Enabled ?? true;
    const maintenanceEnabled = settings?.features.memoryMaintenanceV1Enabled ?? false;
    const maintenanceDurableReady = settings?.features.durableKernelV1Enabled ?? false;

    const [maintenanceStatusRes, maintenanceRunsRes, maintenanceRecommendationsRes] =
      maintenanceEnabled && maintenanceDurableReady
        ? await Promise.all([
            fetchMemoryMaintenanceStatus(workspaceId).catch(() => null),
            fetchMemoryMaintenanceRuns(workspaceId, 40).catch(() => ({ items: [] })),
            fetchMemoryMaintenanceRecommendations(workspaceId, 20).catch(() => ({ items: [] })),
          ])
        : [null, { items: [] }, { items: [] }];

    return {
      files: filesRes.items,
      qmdStats,
      memoryItems: memoryAdminEnabled ? itemsRes.items : [],
      memoryHistory: [],
      maintenanceStatus: maintenanceStatusRes,
      maintenanceRuns: maintenanceRunsRes.items,
      maintenanceRecommendations: maintenanceRecommendationsRes.items,
      selectedRunProvenance: null,
      selectedDurableRun: null,
      selectedDurableTimeline: [],
      memoryAdminEnabled,
      maintenanceEnabled,
      maintenanceDurableReady,
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
              }
            : current,
        );
      })
      .catch(() => undefined);
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
      fetchMemoryMaintenanceRunProvenance(selectedRun.runId).catch(() => null),
      selectedRun.durableRunId ? fetchDurableRun(selectedRun.durableRunId).catch(() => null) : Promise.resolve(null),
      selectedRun.durableRunId
        ? fetchDurableRunTimeline(selectedRun.durableRunId, 80).catch(() => ({ items: [] }))
        : Promise.resolve({ items: [] }),
    ]).then(([provenance, durableRun, durableTimeline]) => {
      if (cancelled) {
        return;
      }
      setData((current) =>
        current
          ? {
              ...current,
              selectedRunProvenance: provenance,
              selectedDurableRun: durableRun,
              selectedDurableTimeline: durableTimeline.items,
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
    [],
  );

  const forgetSelectedItem = useCallback(async () => {
    if (!selectedItem) {
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
  }, [selectedItem]);

  const runMaintenance = useCallback(async () => {
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
  }, [reload, workspaceId]);

  const savePolicy = useCallback(async () => {
    if (!policyDraft) {
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
  }, [policyDraft, reload, workspaceId]);

  const resolveRecommendation = useCallback(
    async (recommendationId: string, decision: "accept" | "reject") => {
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
    [reload],
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
  };
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong.";
}
