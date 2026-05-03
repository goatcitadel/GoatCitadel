import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApprovalRequest, RuntimeLifecycleResponse } from "@goatcitadel/contracts";
import {
  fetchApprovalReplay,
  fetchApprovals,
  fetchDevDiagnostics,
  fetchDurableRun,
  fetchDurableRunTimeline,
  fetchRuntimeLifecycle,
  resolveApproval,
  resolveApprovalsBulk,
  resumeDurableRun,
  type ApprovalReplayResponse,
  type ApprovalResolveResponse,
  type ApprovalsResponse,
} from "../api/client.js";
import {
  getCanonicalDurableRunId,
  hasRecoveryLinkage,
  isBlockedDurableStatus,
  isExpiredApproval,
  mergeApprovals,
} from "../content/approval-helpers.js";
import { useAction } from "./useAction.js";
import { useRefreshSubscription } from "./useRefreshSubscription.js";

export interface ApprovalDurableStatus {
  runId: string;
  status: string;
  blockedStep?: string;
  blockedReason?: string;
  updatedAt: string;
}

export type ApprovalView = "pending" | "history" | "recovery";

interface UseApprovalQueueOptions {
  focusedApprovalId?: string | null;
  enabled?: boolean;
}

export function useApprovalQueue(options: UseApprovalQueueOptions = {}) {
  const [data, setData] = useState<ApprovalsResponse | null>(null);
  const [replayById, setReplayById] = useState<Record<string, ApprovalReplayResponse>>({});
  const [lifecycleByApprovalId, setLifecycleByApprovalId] = useState<Record<string, RuntimeLifecycleResponse>>({});
  const [durableByApprovalId, setDurableByApprovalId] = useState<Record<string, ApprovalDurableStatus | null>>({});
  const [durableBusyByApprovalId, setDurableBusyByApprovalId] = useState<Record<string, boolean>>({});
  const [tracePreviewByApprovalId, setTracePreviewByApprovalId] = useState<Record<string, string[]>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ApprovalView>("pending");
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const resolveAction = useAction();
  const bulkResolveAction = useAction();

  const load = useCallback(async () => {
    try {
      const [pending, approved, rejected, edited] = await Promise.all([
        fetchApprovals("pending"),
        fetchApprovals("approved"),
        fetchApprovals("rejected"),
        fetchApprovals("edited"),
      ]);
      setData({
        items: mergeApprovals([pending.items, approved.items, rejected.items, edited.items]),
      });
      setError(null);
    } catch (nextError) {
      setError((nextError as Error).message);
    }
  }, []);

  useEffect(() => {
    if (options.enabled === false) {
      return;
    }
    void load();
  }, [load, options.enabled]);

  useRefreshSubscription(
    "approvals",
    async () => {
      await load();
    },
    {
      enabled: options.enabled ?? true,
      coalesceMs: 1000,
      staleMs: 15000,
      pollIntervalMs: 15000,
    },
  );

  const applyResolvedApprovalResult = useCallback((result: ApprovalResolveResponse) => {
    setReplayById((current) => ({ ...current, [result.approval.approvalId]: result.replay }));
    setData((current) =>
      current
        ? {
            ...current,
            items: mergeApprovals([
              current.items.filter((item) => item.approvalId !== result.approval.approvalId),
              [result.approval],
            ]),
          }
        : {
            items: [result.approval],
          },
    );
    setDurableByApprovalId((current) => {
      if (!result.durableRunId) {
        return current;
      }
      return {
        ...current,
        [result.approval.approvalId]: {
          runId: result.durableRunId,
          status: result.approval.status,
          updatedAt: result.approval.resolvedAt ?? result.approval.createdAt,
        },
      };
    });
    setLifecycleByApprovalId((current) => ({
      ...current,
      [result.approval.approvalId]: {
        query: {
          approvalId: result.approval.approvalId,
          sessionId: result.approval.linkage?.sessionId,
          turnId: result.approval.linkage?.turnId,
          runId: result.durableRunId ?? result.approval.linkage?.durableRunId,
          taskId: result.approval.linkage?.taskId,
        },
        canonical: {
          approvalId: result.approval.approvalId,
          sessionId: result.approval.linkage?.sessionId,
          turnId: result.approval.linkage?.turnId,
          runId: result.durableRunId ?? result.approval.linkage?.durableRunId,
          taskId: result.approval.linkage?.taskId,
        },
        linked: {
          sessionIds: result.approval.linkage?.sessionId ? [result.approval.linkage.sessionId] : [],
          turnIds: result.approval.linkage?.turnId ? [result.approval.linkage.turnId] : [],
          runIds: result.durableRunId
            ? [result.durableRunId]
            : result.approval.linkage?.durableRunId
              ? [result.approval.linkage.durableRunId]
              : [],
          proactiveRunIds: result.approval.linkage?.proactiveRunId ? [result.approval.linkage.proactiveRunId] : [],
          approvalIds: [result.approval.approvalId],
          taskIds: result.approval.linkage?.taskId ? [result.approval.linkage.taskId] : [],
          workspaceIds: result.approval.linkage?.workspaceId ? [result.approval.linkage.workspaceId] : [],
        },
        approval: result.approval,
        approvalEffects: result.effects,
        turns: [],
        toolRuns: [],
      },
    }));
  }, []);

  const onResolve = useCallback(
    async (approvalId: string, decision: "approve" | "reject"): Promise<boolean> => {
      try {
        setSummary(null);
        const result = await resolveAction.run(async () => resolveApproval(approvalId, decision));
        if (result.executedAction) {
          setSummary(
            `Approval ${approvalId} resolved and action ${result.executedAction.outcome}: ${result.executedAction.policyReason}`,
          );
        } else if (result.approval.followUp && result.approval.followUp.status !== "none") {
          setSummary(
            `Approval ${approvalId} resolved. ${formatApprovalFollowUpSummary(result.approval.followUp.status)}.`,
          );
        } else if (result.effects.length > 0) {
          setSummary(`Approval ${approvalId} resolved. ${result.effects.length} follow-on effects queued.`);
        } else {
          setSummary(`Approval ${approvalId} resolved.`);
        }
        applyResolvedApprovalResult(result);
        setError(null);
        return true;
      } catch (nextError) {
        setSummary(null);
        setError((nextError as Error).message);
        return false;
      }
    },
    [applyResolvedApprovalResult, resolveAction],
  );

  const onRejectAllPending = useCallback(async () => {
    try {
      setError(null);
      const result = await bulkResolveAction.run(async () =>
        resolveApprovalsBulk({
          decision: "reject",
          status: "pending",
          resolutionNote: "Bulk rejected from the approvals queue.",
        }),
      );
      setSummary(
        `Rejected ${result.resolvedCount} pending approvals. Skipped ${result.skippedCount}. Failed ${result.failedCount}.`,
      );
      await load();
    } catch (nextError) {
      setSummary(null);
      setError((nextError as Error).message);
    }
  }, [bulkResolveAction, load]);

  const onReplay = useCallback(async (approvalId: string) => {
    try {
      const replay = await fetchApprovalReplay(approvalId);
      setReplayById((current) => ({ ...current, [approvalId]: replay }));
      setError(null);
    } catch (nextError) {
      setError((nextError as Error).message);
    }
  }, []);

  const resolveDurableStatus = useCallback(async (approvalId: string) => {
    const lifecycle = await fetchRuntimeLifecycle({ approvalId });
    const runId = getCanonicalDurableRunId(lifecycle);
    if (!runId) {
      return {
        lifecycle,
        durable: null,
      };
    }
    const run = lifecycle.durableRun ?? (await fetchDurableRun(runId));
    let blockedStep: string | undefined;
    let blockedReason: string | undefined;
    if (isBlockedDurableStatus(run.status)) {
      const timeline = await fetchDurableRunTimeline(runId, 120);
      const blockingEvent = [...timeline.items]
        .reverse()
        .find((event) => event.eventType === "run_paused" || event.eventType === "run_waiting");
      blockedStep = (blockingEvent?.payload?.stepKey as string | undefined) ?? blockingEvent?.stepKey;
      const nextBlockedReason = blockingEvent?.payload?.reason;
      blockedReason = typeof nextBlockedReason === "string" ? nextBlockedReason : undefined;
    }
    return {
      lifecycle,
      durable: {
        runId,
        status: run.status,
        blockedStep,
        blockedReason,
        updatedAt: run.updatedAt,
      } satisfies ApprovalDurableStatus,
    };
  }, []);

  const loadDurableStatus = useCallback(
    async (approvalId: string) => {
      setDurableBusyByApprovalId((current) => ({ ...current, [approvalId]: true }));
      try {
        const resolved = await resolveDurableStatus(approvalId);
        setLifecycleByApprovalId((current) => ({ ...current, [approvalId]: resolved.lifecycle }));
        setDurableByApprovalId((current) => ({ ...current, [approvalId]: resolved.durable }));
        if (!resolved.durable?.runId) {
          setError("No canonical durable run is linked to this approval yet.");
          return;
        }
        setError(null);
      } catch (nextError) {
        setError((nextError as Error).message);
      } finally {
        setDurableBusyByApprovalId((current) => ({ ...current, [approvalId]: false }));
      }
    },
    [resolveDurableStatus],
  );

  const resumeFromCheckpoint = useCallback(
    async (approvalId: string) => {
      setDurableBusyByApprovalId((current) => ({ ...current, [approvalId]: true }));
      try {
        let current = durableByApprovalId[approvalId];
        if (!current?.runId) {
          const resolved = await resolveDurableStatus(approvalId);
          setLifecycleByApprovalId((prev) => ({ ...prev, [approvalId]: resolved.lifecycle }));
          setDurableByApprovalId((prev) => ({ ...prev, [approvalId]: resolved.durable }));
          current = resolved.durable;
        }
        if (!current?.runId) {
          setError("No canonical durable run is linked to this approval yet.");
          return;
        }
        if (current.status !== "paused") {
          setError(`Run ${current.runId} is ${current.status}, so there is no paused checkpoint to resume.`);
          return;
        }
        await resumeDurableRun(current.runId, "operator");
        const refreshed = await resolveDurableStatus(approvalId);
        setLifecycleByApprovalId((prev) => ({ ...prev, [approvalId]: refreshed.lifecycle }));
        setDurableByApprovalId((prev) => ({ ...prev, [approvalId]: refreshed.durable }));
        setError(null);
      } catch (nextError) {
        setError((nextError as Error).message);
      } finally {
        setDurableBusyByApprovalId((current) => ({ ...current, [approvalId]: false }));
      }
    },
    [durableByApprovalId, resolveDurableStatus],
  );

  const loadTracePreview = useCallback(async (approvalId: string, correlationId?: string) => {
    if (!correlationId) {
      return;
    }
    try {
      const response = await fetchDevDiagnostics({
        correlationId,
        limit: 12,
      });
      setTracePreviewByApprovalId((current) => ({
        ...current,
        [approvalId]: response.items.map(
          (item) => `${new Date(item.timestamp).toLocaleTimeString()} ${item.event}: ${item.message}`,
        ),
      }));
      setError(null);
    } catch (nextError) {
      setError((nextError as Error).message);
    }
  }, []);

  const allItems = useMemo(() => data?.items ?? [], [data]);
  const pendingItems = useMemo(
    () => allItems.filter((item) => item.status === "pending" && !isExpiredApproval(item)),
    [allItems],
  );
  const historyItems = useMemo(
    () =>
      allItems.filter(
        (item) =>
          item.status === "approved" ||
          item.status === "rejected" ||
          item.status === "edited" ||
          isExpiredApproval(item),
      ),
    [allItems],
  );
  const recoveryItems = useMemo(() => allItems.filter((item) => hasRecoveryLinkage(item)), [allItems]);

  const visibleItems = useMemo(
    () => (view === "pending" ? pendingItems : view === "history" ? historyItems : recoveryItems),
    [historyItems, pendingItems, recoveryItems, view],
  );

  const selectedApproval =
    visibleItems.find((approval) => approval.approvalId === selectedApprovalId) ??
    visibleItems.find((approval) => approval.approvalId === options.focusedApprovalId) ??
    visibleItems[0] ??
    null;

  useEffect(() => {
    if (visibleItems.length === 0) {
      if (selectedApprovalId !== null) {
        setSelectedApprovalId(null);
      }
      return;
    }
    const preferredId =
      visibleItems.find((approval) => approval.approvalId === selectedApprovalId)?.approvalId ??
      visibleItems.find((approval) => approval.approvalId === options.focusedApprovalId)?.approvalId ??
      visibleItems[0]?.approvalId ??
      null;
    if (preferredId !== selectedApprovalId) {
      setSelectedApprovalId(preferredId);
    }
  }, [options.focusedApprovalId, selectedApprovalId, visibleItems]);

  const pendingRiskCounts = useMemo(() => {
    return pendingItems.reduce<Record<ApprovalRequest["riskLevel"], number>>(
      (counts, item) => {
        counts[item.riskLevel] = (counts[item.riskLevel] ?? 0) + 1;
        return counts;
      },
      { safe: 0, caution: 0, danger: 0, nuclear: 0 },
    );
  }, [pendingItems]);

  return {
    loading: data === null,
    allItems,
    pendingItems,
    historyItems,
    recoveryItems,
    visibleItems,
    selectedApproval,
    selectedApprovalId,
    setSelectedApprovalId,
    view,
    setView,
    replayById,
    lifecycleByApprovalId,
    durableByApprovalId,
    durableBusyByApprovalId,
    tracePreviewByApprovalId,
    summary,
    error,
    pendingRiskCounts,
    hasPendingApprovals: pendingItems.length > 0,
    replayCount: Object.keys(replayById).length,
    resolvePending: resolveAction.pending,
    bulkResolvePending: bulkResolveAction.pending,
    onResolve,
    onRejectAllPending,
    onReplay,
    loadTracePreview,
    loadDurableStatus,
    resumeFromCheckpoint,
  };
}

function formatApprovalFollowUpSummary(status: NonNullable<ApprovalRequest["followUp"]>["status"]): string {
  switch (status) {
    case "queued":
      return "Follow-on work is queued";
    case "running":
      return "Follow-on work is running";
    case "completed":
      return "Follow-on work completed";
    case "skipped":
      return "Follow-on work was skipped";
    case "failed":
      return "Follow-on work failed";
    case "none":
      return "No follow-on work was needed";
  }
  return "Follow-on work status is unknown";
}
