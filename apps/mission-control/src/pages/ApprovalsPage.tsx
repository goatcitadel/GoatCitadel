/* eslint-disable @typescript-eslint/no-unused-vars */
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { buildRouteSearch, type ResolvedRoute } from "../content/page-registry";
import {
  type ApprovalsResponse,
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
  type RuntimeLifecycleResponse,
} from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { PageGuideCard } from "../components/PageGuideCard";
import { ConfirmModal } from "../components/ConfirmModal";
import { CardSkeleton } from "../components/CardSkeleton";
import { StatusChip } from "../components/StatusChip";
import { DataToolbar } from "../components/DataToolbar";
import { useEmbeddedPageChrome } from "../components/EmbeddedPageChrome";
import { OperatorSplitLayout } from "../components/OperatorSplitLayout";
import { GCEmptyState } from "../components/ui/GCEmptyState";
import { useAction } from "../hooks/useAction";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import { pageCopy } from "../content/copy";
import {
  buildApprovalEvidenceModel,
  findTraceMetadata,
  type ApprovalEvidenceBlock,
  type ApprovalEvidenceModel,
} from "./approvals/approvals-page-helpers";

interface ApprovalDurableStatus {
  runId: string;
  status: string;
  blockedStep?: string;
  blockedReason?: string;
  updatedAt: string;
}

type ApprovalView = "pending" | "history" | "recovery";

export function ApprovalsPage() {
  const embedded = useEmbeddedPageChrome();
  const [data, setData] = useState<ApprovalsResponse | null>(null);
  const [replayById, setReplayById] = useState<Record<string, ApprovalReplayResponse>>({});
  const [lifecycleByApprovalId, setLifecycleByApprovalId] = useState<Record<string, RuntimeLifecycleResponse>>({});
  const [durableByApprovalId, setDurableByApprovalId] = useState<Record<string, ApprovalDurableStatus | null>>({});
  const [durableBusyByApprovalId, setDurableBusyByApprovalId] = useState<Record<string, boolean>>({});
  const [tracePreviewByApprovalId, setTracePreviewByApprovalId] = useState<Record<string, string[]>>({});
  const [pendingDecision, setPendingDecision] = useState<{ approvalId: string; decision: "approve" | "reject" } | null>(
    null,
  );
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [pendingResumeApprovalId, setPendingResumeApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
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
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRefreshSubscription(
    "approvals",
    async () => {
      await load();
    },
    {
      enabled: true,
      coalesceMs: 1000,
      staleMs: 15000,
      pollIntervalMs: 15000,
    },
  );

  const onResolve = async (approvalId: string, decision: "approve" | "reject") => {
    try {
      setSummary(null);
      const result = await resolveAction.run(async () => resolveApproval(approvalId, decision));
      if (result.executedAction) {
        setSummary(
          `Approval ${approvalId} resolved and action ${result.executedAction.outcome}: ${result.executedAction.policyReason}`,
        );
      } else if (result.effects.length > 0) {
        setSummary(`Approval ${approvalId} resolved. ${result.effects.length} follow-on effects queued.`);
      }
      applyResolvedApprovalResult(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const onRejectAllPending = async () => {
    try {
      setError(null);
      const result = await bulkResolveAction.run(async () =>
        resolveApprovalsBulk({
          decision: "reject",
          status: "pending",
          resolutionNote: "Bulk rejected from the approvals queue.",
        }),
      );
      const message = `Rejected ${result.resolvedCount} pending approvals. Skipped ${result.skippedCount}. Failed ${result.failedCount}.`;
      setSummary(message);
      setError(null);
      await load();
    } catch (err) {
      setSummary(null);
      setError((err as Error).message);
    }
  };

  const onReplay = async (approvalId: string) => {
    try {
      const replay = await fetchApprovalReplay(approvalId);
      setReplayById((prev) => ({ ...prev, [approvalId]: replay }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const applyResolvedApprovalResult = (result: ApprovalResolveResponse) => {
    setReplayById((prev) => ({ ...prev, [result.approval.approvalId]: result.replay }));
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
    setDurableByApprovalId((prev) => {
      if (!result.durableRunId) {
        return prev;
      }
      return {
        ...prev,
        [result.approval.approvalId]: {
          runId: result.durableRunId,
          status: result.approval.status,
          updatedAt: result.approval.resolvedAt ?? result.approval.createdAt,
        },
      };
    });
    setLifecycleByApprovalId((prev) => ({
      ...prev,
      [result.approval.approvalId]: {
        query: {
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
  };

  const resolveDurableStatus = async (approvalId: string) => {
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
  };

  const loadDurableStatus = async (approvalId: string) => {
    setDurableBusyByApprovalId((prev) => ({ ...prev, [approvalId]: true }));
    try {
      const resolved = await resolveDurableStatus(approvalId);
      setLifecycleByApprovalId((prev) => ({ ...prev, [approvalId]: resolved.lifecycle }));
      setDurableByApprovalId((prev) => ({ ...prev, [approvalId]: resolved.durable }));
      if (!resolved.durable?.runId) {
        setDurableByApprovalId((prev) => ({ ...prev, [approvalId]: null }));
        setError("No canonical durable run is linked to this approval yet.");
        return;
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDurableBusyByApprovalId((prev) => ({ ...prev, [approvalId]: false }));
    }
  };

  const resumeFromCheckpoint = async (approvalId: string) => {
    setDurableBusyByApprovalId((prev) => ({ ...prev, [approvalId]: true }));
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDurableBusyByApprovalId((prev) => ({ ...prev, [approvalId]: false }));
    }
  };

  const loadTracePreview = async (approvalId: string, correlationId?: string) => {
    if (!correlationId) {
      return;
    }
    try {
      const response = await fetchDevDiagnostics({
        correlationId,
        limit: 12,
      });
      setTracePreviewByApprovalId((prev) => ({
        ...prev,
        [approvalId]: response.items.map(
          (item) => `${new Date(item.timestamp).toLocaleTimeString()} ${item.event}: ${item.message}`,
        ),
      }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

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
  const pendingRiskCounts = useMemo(() => {
    return pendingItems.reduce<Record<ApprovalsResponse["items"][number]["riskLevel"], number>>(
      (counts, item) => {
        counts[item.riskLevel] = (counts[item.riskLevel] ?? 0) + 1;
        return counts;
      },
      { safe: 0, caution: 0, danger: 0, nuclear: 0 },
    );
  }, [pendingItems]);
  const openLiveLane = useCallback((event: MouseEvent<HTMLAnchorElement>, route: ResolvedRoute) => {
    if (typeof window === "undefined") {
      return;
    }
    event.preventDefault();
    const nextSearch = buildRouteSearch(route);
    window.history.pushState(null, "", nextSearch);
    const routeEvent = typeof PopStateEvent === "function" ? new PopStateEvent("popstate") : new Event("popstate");
    window.dispatchEvent(routeEvent);
  }, []);

  const focusedApprovalId =
    typeof window !== "undefined" && typeof window.location?.search === "string"
      ? new URLSearchParams(window.location.search).get("approvalId")
      : null;
  const visibleItems = view === "pending" ? pendingItems : view === "history" ? historyItems : recoveryItems;
  const hasPendingApprovals = pendingItems.length > 0;
  const replayCount = Object.keys(replayById).length;
  const selectedApproval =
    visibleItems.find((approval) => approval.approvalId === selectedApprovalId) ??
    visibleItems.find((approval) => approval.approvalId === focusedApprovalId) ??
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
      visibleItems.find((approval) => approval.approvalId === focusedApprovalId)?.approvalId ??
      visibleItems[0]?.approvalId ??
      null;
    if (preferredId !== selectedApprovalId) {
      setSelectedApprovalId(preferredId);
    }
  }, [focusedApprovalId, selectedApprovalId, visibleItems]);

  if (!data) {
    return <CardSkeleton lines={7} />;
  }

  const approvalsHeaderActions = (
    <div className="workflow-summary-strip">
      <StatusChip tone={view === "pending" ? "warning" : "muted"}>
        {view === "pending"
          ? `${pendingItems.length} pending`
          : view === "history"
            ? `${historyItems.length} history`
            : `${recoveryItems.length} recovery-linked`}
      </StatusChip>
      {pendingRiskCounts.caution > 0 ? <StatusChip tone="muted">{pendingRiskCounts.caution} caution</StatusChip> : null}
      {pendingRiskCounts.danger > 0 ? <StatusChip tone="warning">{pendingRiskCounts.danger} danger</StatusChip> : null}
      {pendingRiskCounts.nuclear > 0 ? (
        <StatusChip tone="critical">{pendingRiskCounts.nuclear} nuclear</StatusChip>
      ) : null}
      {replayCount > 0 ? <StatusChip tone="muted">{replayCount} replay trails loaded</StatusChip> : null}
    </div>
  );

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Governance"
        title="Approvals & Recovery"
        subtitle="Persisted approval records, history, and runtime recovery live here. Live decisions stay inline in Chat, Cowork, and Code."
        hint="Use this surface for persisted backend records, audit trails, and checkpoint recovery."
        className="page-header-citadel approvals-header"
        actions={embedded ? undefined : approvalsHeaderActions}
      />
      <PageGuideCard
        pageId="approvals"
        what={pageCopy.approvals.guide?.what ?? ""}
        when={pageCopy.approvals.guide?.when ?? ""}
        actions={pageCopy.approvals.guide?.actions ?? []}
        terms={pageCopy.approvals.guide?.terms}
      />
      <DataToolbar
        primary={
          <div className="workflow-summary-strip">
            {(
              [
                { key: "pending", label: `Pending (${pendingItems.length})` },
                { key: "history", label: `History (${historyItems.length})` },
                { key: "recovery", label: `Recovery (${recoveryItems.length})` },
              ] as Array<{ key: ApprovalView; label: string }>
            ).map((item) => (
              <button
                key={item.key}
                type="button"
                className={["gc-button", view === item.key ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => setView(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        }
        center={approvalsHeaderActions}
        secondary={
          hasPendingApprovals ? (
            <button
              type="button"
              className="gc-button danger"
              disabled={bulkResolveAction.pending}
              onClick={() => setBulkRejectOpen(true)}
            >
              {bulkResolveAction.pending ? "Rejecting..." : "Reject all pending"}
            </button>
          ) : undefined
        }
        className={embedded ? "approvals-toolbar" : undefined}
      />
      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {summary ? <p className="office-subtitle">{summary}</p> : null}
        <p className="office-subtitle">
          Live approvals happen inline in Chat, Cowork, and Code. This page is for persisted backend approval records,
          history, and durable recovery.
        </p>
      </div>
      {visibleItems.length === 0 ? (
        <GCEmptyState
          title={
            view === "pending"
              ? "No pending approvals"
              : view === "history"
                ? "No approval history yet"
                : "No recovery records yet"
          }
          subtitle={
            view === "pending"
              ? "The approvals queue is clear right now."
              : view === "history"
                ? "Resolved, rejected, and expired approval records will appear here."
                : "Recovery items appear when approvals are linked to durable runs or checkpoints."
          }
          action={
            <button type="button" className="gc-button" onClick={() => void load()}>
              Refresh approvals
            </button>
          }
          secondaryAction={
            <button
              type="button"
              className="gc-button"
              onClick={() => setView(view === "pending" ? "history" : "pending")}
            >
              {view === "pending" ? "Review history" : "Check pending queue"}
            </button>
          }
          meta={
            <p className="office-subtitle">
              {view === "pending"
                ? "New risky actions still surface inline first when a human decision is needed."
                : view === "history"
                  ? "Use this view to audit what happened after the inline decision."
                  : "Use Recovery to resume or inspect persisted pauses without hunting through chat threads."}
            </p>
          }
          className="approval-empty-panel"
        />
      ) : null}
      {visibleItems.length > 0 ? (
        <OperatorSplitLayout
          primary={
            <Panel
              title={view === "pending" ? "Approval Queue" : view === "history" ? "Approval History" : "Recovery Queue"}
              subtitle="Select a persisted approval to inspect evidence, replay trail, and recovery state without leaving the queue."
              padding="compact"
            >
              <div className="stack-list">
                {visibleItems.map((approval) => {
                  const expired = isExpiredApproval(approval);
                  const effectiveStatus = expired ? "expired" : approval.status;
                  const selected = approval.approvalId === selectedApproval?.approvalId;
                  const liveLaneHref = buildLiveLaneHref(approval);
                  return (
                    <button
                      key={approval.approvalId}
                      type="button"
                      className={`stack-card stack-card-selectable${selected ? " active" : ""}`}
                      onClick={() => setSelectedApprovalId(approval.approvalId)}
                    >
                      <div className="stack-card-header">
                        <div>
                          <strong>{approval.kind}</strong>
                          <p className="office-subtitle">
                            {approval.approvalId}
                            {" | "}
                            {new Date(approval.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <div className="stack-card-chips">
                          <StatusChip
                            tone={
                              approval.riskLevel === "nuclear"
                                ? "critical"
                                : approval.riskLevel === "danger"
                                  ? "warning"
                                  : "muted"
                            }
                          >
                            {approval.riskLevel}
                          </StatusChip>
                          <StatusChip
                            tone={
                              effectiveStatus === "pending"
                                ? "warning"
                                : effectiveStatus === "approved"
                                  ? "success"
                                  : effectiveStatus === "expired"
                                    ? "warning"
                                    : "muted"
                            }
                          >
                            {effectiveStatus}
                          </StatusChip>
                          {liveLaneHref ? <StatusChip tone="default">live lane</StatusChip> : null}
                        </div>
                      </div>
                      <p className="office-subtitle">
                        {approval.explanation?.summary ??
                          `Review the ${approval.kind} request before GoatCitadel continues.`}
                      </p>
                    </button>
                  );
                })}
              </div>
            </Panel>
          }
          inspector={
            selectedApproval ? (
              <ApprovalInspector
                approval={selectedApproval}
                replay={replayById[selectedApproval.approvalId]}
                lifecycle={lifecycleByApprovalId[selectedApproval.approvalId]}
                durable={durableByApprovalId[selectedApproval.approvalId]}
                durableBusy={Boolean(durableBusyByApprovalId[selectedApproval.approvalId])}
                tracePreview={tracePreviewByApprovalId[selectedApproval.approvalId]}
                focused={focusedApprovalId === selectedApproval.approvalId}
                openLiveLane={openLiveLane}
                onResolveDecision={setPendingDecision}
                onReplay={onReplay}
                onLoadTracePreview={loadTracePreview}
                onLoadDurableStatus={loadDurableStatus}
                onResumeCheckpoint={setPendingResumeApprovalId}
              />
            ) : null
          }
          emptyInspector={
            <GCEmptyState
              title="Select an approval"
              subtitle="Choose a queue item to inspect its evidence, replay trail, and recovery posture."
              className="approval-empty-panel"
            />
          }
        />
      ) : null}
      <ConfirmModal
        open={Boolean(pendingDecision)}
        title={pendingDecision?.decision === "approve" ? "Approve Action" : "Reject Approval"}
        message={
          pendingDecision?.decision === "approve"
            ? "Approve this action and execute it now?"
            : "Reject this approval request?"
        }
        confirmLabel={
          resolveAction.pending ? "Applying..." : pendingDecision?.decision === "approve" ? "Approve" : "Reject"
        }
        danger={pendingDecision?.decision === "reject"}
        pending={resolveAction.pending}
        cancelDisabled={resolveAction.pending}
        disableDismiss={resolveAction.pending}
        onCancel={() => setPendingDecision(null)}
        onConfirm={() => {
          if (!pendingDecision) {
            return;
          }
          void onResolve(pendingDecision.approvalId, pendingDecision.decision).finally(() => {
            setPendingDecision(null);
          });
        }}
      />
      <ConfirmModal
        open={Boolean(pendingResumeApprovalId)}
        title="Resume Durable Run"
        message="Resume the durable run from its last checkpoint now?"
        confirmLabel="Resume"
        pending={Boolean(pendingResumeApprovalId && durableBusyByApprovalId[pendingResumeApprovalId])}
        cancelDisabled={Boolean(pendingResumeApprovalId && durableBusyByApprovalId[pendingResumeApprovalId])}
        disableDismiss={Boolean(pendingResumeApprovalId && durableBusyByApprovalId[pendingResumeApprovalId])}
        onCancel={() => setPendingResumeApprovalId(null)}
        onConfirm={() => {
          if (!pendingResumeApprovalId) {
            return;
          }
          void resumeFromCheckpoint(pendingResumeApprovalId).finally(() => {
            setPendingResumeApprovalId(null);
          });
        }}
      />
      <ConfirmModal
        open={bulkRejectOpen}
        title="Reject All Pending Approvals"
        message={`Reject all ${pendingItems.length} pending approvals now? This does not approve or dismiss them locally; it resolves the pending queue with a reject decision and refreshes the shell counts afterward.`}
        confirmLabel={bulkResolveAction.pending ? "Rejecting..." : "Reject all pending"}
        danger
        pending={bulkResolveAction.pending}
        cancelDisabled={bulkResolveAction.pending}
        disableDismiss={bulkResolveAction.pending}
        onCancel={() => setBulkRejectOpen(false)}
        onConfirm={() => {
          void onRejectAllPending().finally(() => {
            setBulkRejectOpen(false);
          });
        }}
      />
    </section>
  );
}

function ApprovalInspector(props: {
  approval: ApprovalsResponse["items"][number];
  replay?: ApprovalReplayResponse;
  lifecycle?: RuntimeLifecycleResponse;
  durable?: ApprovalDurableStatus | null;
  durableBusy: boolean;
  tracePreview?: string[];
  focused: boolean;
  openLiveLane: (event: MouseEvent<HTMLAnchorElement>, route: ResolvedRoute) => void;
  onResolveDecision: (decision: { approvalId: string; decision: "approve" | "reject" }) => void;
  onReplay: (approvalId: string) => void;
  onLoadTracePreview: (approvalId: string, correlationId?: string) => void;
  onLoadDurableStatus: (approvalId: string) => void;
  onResumeCheckpoint: (approvalId: string) => void;
}) {
  const {
    approval,
    replay,
    lifecycle,
    durable,
    durableBusy,
    tracePreview,
    focused,
    openLiveLane,
    onResolveDecision,
    onReplay,
    onLoadTracePreview,
    onLoadDurableStatus,
    onResumeCheckpoint,
  } = props;
  const liveLaneHref = buildLiveLaneHref(approval) ?? undefined;
  const expired = isExpiredApproval(approval);
  const effectiveStatus = expired ? "expired" : approval.status;
  const evidence = buildApprovalEvidenceModel(approval.preview, replay?.pendingAction?.request);
  const explanationSummary =
    approval.explanation?.summary ?? `Review the ${approval.kind} request before GoatCitadel continues.`;
  const consequenceSummary = approval.explanation?.saferAlternative
    ? `Approve to continue this action now. Reject to stop it here. Safer alternative: ${approval.explanation.saferAlternative}`
    : "Approve to continue this action now. Reject to keep the system paused at this checkpoint.";
  const explanationTimestamp = approval.explanation
    ? `Generated ${new Date(approval.explanation.generatedAt).toLocaleString()}`
    : null;
  const traceMetadata =
    approval.linkage?.correlationId || approval.linkage?.traceId
      ? {
          correlationId: approval.linkage?.correlationId,
          traceId: approval.linkage?.traceId,
        }
      : replay?.approval.linkage?.correlationId || replay?.approval.linkage?.traceId
        ? {
            correlationId: replay.approval.linkage?.correlationId,
            traceId: replay.approval.linkage?.traceId,
          }
        : (findTraceMetadata(replay?.pendingAction?.request) ??
          findTraceMetadata(approval.payload) ??
          findTraceMetadata(approval.preview));
  const explanationLabel =
    approval.explanationStatus === "pending"
      ? "Pending explanation"
      : approval.explanationStatus === "completed"
        ? "Explained"
        : approval.explanationStatus === "failed"
          ? "Explanation failed"
          : "Not requested";

  return (
    <Panel
      title={approval.kind}
      className={`approval-card approval-card-${approval.riskLevel}${focused ? " approval-card-focused" : ""}`}
      subtitle={
        <div className="workflow-summary-strip">
          <StatusChip
            tone={
              approval.riskLevel === "nuclear"
                ? "critical"
                : approval.riskLevel === "danger"
                  ? "warning"
                  : "muted"
            }
          >
            {approval.riskLevel} risk
          </StatusChip>
          <StatusChip
            tone={
              effectiveStatus === "pending"
                ? "warning"
                : effectiveStatus === "approved"
                  ? "success"
                  : effectiveStatus === "expired"
                    ? "warning"
                    : "muted"
            }
          >
            {effectiveStatus}
          </StatusChip>
          <StatusChip
            className="approvals-explanation-chip"
            tone={
              approval.explanationStatus === "pending"
                ? "warning"
                : approval.explanationStatus === "completed"
                  ? "success"
                  : approval.explanationStatus === "failed"
                    ? "critical"
                    : "muted"
            }
          >
            {explanationLabel}
          </StatusChip>
        </div>
      }
    >
      <section className="approval-decision-shell" aria-label={`Decision framing for ${approval.kind}`}>
        <div className="approval-decision-copy">
          <p className="approval-decision-kicker">Human decision required</p>
          <h3>{explanationSummary}</h3>
          {approval.explanation?.riskExplanation ? (
            <p className="approval-decision-risk">{approval.explanation.riskExplanation}</p>
          ) : null}
        </div>
        <div className="approval-consequence-box">
          <p className="approval-consequence-title">If approved</p>
          <p>{consequenceSummary}</p>
          {explanationTimestamp ? (
            <small>
              {explanationTimestamp}
              {approval.explanation?.providerId ? ` via ${approval.explanation.providerId}` : ""}
              {approval.explanation?.model ? ` (${approval.explanation.model})` : ""}
            </small>
          ) : null}
        </div>
        <div className="approval-action-row">
          {approval.status === "pending" && !expired ? (
            <>
              <button
                type="button"
                className="gc-button approval-action-primary"
                onClick={() => onResolveDecision({ approvalId: approval.approvalId, decision: "approve" })}
              >
                Approve now
              </button>
              <button
                type="button"
                className="gc-button danger approval-action-secondary"
                onClick={() => onResolveDecision({ approvalId: approval.approvalId, decision: "reject" })}
              >
                Reject
              </button>
            </>
          ) : null}
          <button type="button" className="gc-button approval-action-tertiary" onClick={() => onReplay(approval.approvalId)}>
            Load replay trail
          </button>
          {liveLaneHref ? (
            <a className="approval-action-tertiary" href={liveLaneHref.href} onClick={(event) => openLiveLane(event, liveLaneHref.route)}>
              Open live lane
            </a>
          ) : null}
        </div>
      </section>

      {approval.explanationError ? <p className="error">Explainer error: {approval.explanationError}</p> : null}

      <div className="approval-evidence-grid">
        {evidence ? <ApprovalEvidence approvalId={approval.approvalId} evidence={evidence} /> : null}
        {traceMetadata?.traceId || traceMetadata?.correlationId ? (
          <div className="replay-box approval-support-box">
            <h4>System trace</h4>
            {traceMetadata?.traceId ? <p>trace: {traceMetadata.traceId}</p> : null}
            {traceMetadata?.correlationId ? <p>correlation: {traceMetadata.correlationId}</p> : null}
            {traceMetadata?.correlationId ? (
              <div className="actions">
                <button
                  type="button"
                  onClick={() => onLoadTracePreview(approval.approvalId, traceMetadata.correlationId)}
                  className="gc-button"
                >
                  {tracePreview ? "Refresh trace detail" : "Load trace detail"}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="replay-box approval-support-box">
          <h4>Checkpoint resume</h4>
          <p>
            Load durable status to inspect the current checkpoint. Resume continues from the last checkpoint instead of
            restarting.
          </p>
          <div className="actions">
            <button
              type="button"
              onClick={() => onLoadDurableStatus(approval.approvalId)}
              disabled={durableBusy}
              className="gc-button"
            >
              {durableBusy ? "Loading..." : "Load durable status"}
            </button>
            <button
              type="button"
              onClick={() => onResumeCheckpoint(approval.approvalId)}
              disabled={durableBusy || (durable != null && durable.status !== "paused")}
              className="gc-button"
            >
              Resume paused run
            </button>
          </div>
          {durable ? (
            <p className="office-subtitle">
              Run: {durable.runId} | Status: {durable.status}
              {durable.blockedStep ? ` | Blocked step: ${durable.blockedStep}` : ""}
              {durable.blockedReason ? ` | Reason: ${durable.blockedReason}` : ""}
              {" | "}
              Updated: {new Date(durable.updatedAt).toLocaleString()}
            </p>
          ) : (
            <p className="office-subtitle">No checkpoint details loaded yet.</p>
          )}
        </div>
      </div>
      {tracePreview?.length ? (
        <div className="replay-box">
          <h4>Trace detail</h4>
          <ul className="compact-list">
            {tracePreview.map((item) => (
              <li key={`${approval.approvalId}-${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {lifecycle ? (
        <div className="replay-box">
          <h4>Runtime linkage</h4>
          <p className="office-subtitle">
            Canonical session: {lifecycle.query.sessionId ?? lifecycle.approval?.linkage?.sessionId ?? "absent"}
            {" | "}
            Canonical task: {lifecycle.query.taskId ?? lifecycle.approval?.linkage?.taskId ?? "absent"}
            {" | "}
            Canonical run: {getCanonicalDurableRunId(lifecycle) ?? "absent"}
          </p>
          <p className="office-subtitle">
            Inferred sessions:{" "}
            {formatInferredIds(
              lifecycle.linked.sessionIds,
              lifecycle.query.sessionId ?? lifecycle.approval?.linkage?.sessionId,
            )}
            {" | "}
            Inferred tasks:{" "}
            {formatInferredIds(lifecycle.linked.taskIds, lifecycle.query.taskId ?? lifecycle.approval?.linkage?.taskId)}
            {" | "}
            Inferred runs: {formatInferredIds(lifecycle.linked.runIds, getCanonicalDurableRunId(lifecycle))}
          </p>
          {lifecycle.resolution ? (
            <p className="office-subtitle">
              Provenance: session {lifecycle.resolution.sessionIdSource ?? "absent"}
              {" | "}
              turn {lifecycle.resolution.turnIdSource ?? "absent"}
              {" | "}
              run {lifecycle.resolution.runIdSource ?? "absent"}
              {" | "}
              task {lifecycle.resolution.taskIdSource ?? "absent"}
            </p>
          ) : null}
          {approval.linkage?.proactiveRunId || lifecycle.proactiveRuns?.length ? (
            <p className="office-subtitle">
              Proactive run: {approval.linkage?.proactiveRunId ?? lifecycle.proactiveRuns?.[0]?.runId ?? "none"}
              {" | "}
              Surface: {approval.linkage?.originSurface ?? lifecycle.proactiveRuns?.[0]?.originSurface ?? "unknown"}
            </p>
          ) : null}
          {approval.linkage?.externalReferenceRoots?.length ? (
            <p className="office-subtitle">
              Reference roots:{" "}
              {approval.linkage.externalReferenceRoots.map((root) => `${root.label} (${root.access})`).join(", ")}
            </p>
          ) : null}
          <p className="office-subtitle">
            Execution plans: {lifecycle.executionPlans?.length ?? 0}
            {" | "}
            Delegation runs: {lifecycle.delegationRuns?.length ?? 0}
            {" | "}
            Delegation steps: {lifecycle.delegationSteps?.length ?? 0}
          </p>
          {lifecycle.executionPlans?.length ? (
            <ul className="compact-list">
              {lifecycle.executionPlans.slice(0, 2).map((plan) => (
                <li key={plan.planId}>
                  <strong>{plan.status}</strong>
                  {" | "}
                  {plan.objective}
                  {" | "}
                  {plan.planId}
                </li>
              ))}
            </ul>
          ) : null}
          {lifecycle.delegationSteps?.length ? (
            <ul className="compact-list">
              {lifecycle.delegationSteps.slice(0, 3).map((step) => (
                <li key={step.stepId}>
                  <strong>{step.role}</strong>
                  {" | "}
                  {step.status}
                  {step.durableRunId ? ` | durable ${step.durableRunId}` : ""}
                  {step.childSessionId ? ` | session ${step.childSessionId}` : ""}
                  {step.childTurnId ? ` | turn ${step.childTurnId}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {lifecycle.proactiveRuns?.length ? (
            <ul className="compact-list">
              {lifecycle.proactiveRuns.slice(0, 3).map((run) => (
                <li key={run.runId}>
                  <strong>{run.status}</strong>
                  {" | "}
                  {run.runId}
                  {run.linkedDurableRunId ? ` | durable ${run.linkedDurableRunId}` : ""}
                  {run.nextWakeAt ? ` | wake ${new Date(run.nextWakeAt).toLocaleString()}` : ""}
                  {run.stopReason ? ` | stop ${run.stopReason}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {(lifecycle?.approvalEffects?.length ?? 0) > 0 || (replay?.effects?.length ?? 0) > 0 ? (
        <div className="replay-box">
          <h4>Approval effects</h4>
          <ul className="compact-list">
            {(lifecycle?.approvalEffects ?? replay?.effects ?? []).map((effect) => (
              <li key={effect.effectId}>
                <strong>{effect.effectKind}</strong>
                {" | "}
                {effect.status}
                {" | "}
                {effect.targetKind}:{effect.targetId}
                {effect.attemptCount > 0 ? ` | attempts ${effect.attemptCount}` : ""}
                {effect.lastError ? ` | error ${effect.lastError}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {replay ? (
        <details className="approval-technical-details">
          <summary>Replay trail and pending action</summary>
          <div className="replay-box">
            <h4>Replay trail</h4>
            <ul>
              {replay.events.map((event) => (
                <li key={event.eventId}>
                  <strong>{event.eventType}</strong> by {event.actorId} at {new Date(event.timestamp).toLocaleString()}
                </li>
              ))}
            </ul>
            {replay.pendingAction ? <pre>{JSON.stringify(replay.pendingAction, null, 2)}</pre> : null}
          </div>
        </details>
      ) : null}
      <details className="approval-technical-details">
        <summary>Raw request and preview payload</summary>
        <div className="replay-box">
          <h4>Raw request payload</h4>
          <pre>{JSON.stringify(approval.payload, null, 2)}</pre>
          <h4>Preview payload</h4>
          <pre>{JSON.stringify(approval.preview, null, 2)}</pre>
        </div>
      </details>
    </Panel>
  );
}

function ApprovalEvidence(props: { approvalId: string; evidence: ApprovalEvidenceModel }) {
  const { approvalId, evidence } = props;
  return (
    <div className="replay-box approval-support-box">
      <h4>Operator evidence</h4>
      {evidence.targets.length > 0 ? (
        <ul className="compact-list">
          {evidence.targets.map((line) => (
            <li key={`${approvalId}-${line}`}>{line}</li>
          ))}
        </ul>
      ) : null}
      {evidence.commands.length > 0 ? (
        <div className="approval-evidence-section">
          <p className="approval-evidence-label">Commands</p>
          <ul className="compact-list">
            {evidence.commands.map((line) => (
              <li key={`${approvalId}-command-${line}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {evidence.supporting.length > 0 ? (
        <div className="approval-evidence-section">
          <p className="approval-evidence-label">Supporting context</p>
          <ul className="compact-list">
            {evidence.supporting.map((line) => (
              <li key={`${approvalId}-support-${line}`}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {evidence.changes.map((block) => (
        <details key={`${approvalId}-${block.label}`} className="approval-technical-details">
          <summary>{block.label}</summary>
          <pre>{block.content}</pre>
        </details>
      ))}
    </div>
  );
}

function mergeApprovals(groups: ApprovalsResponse["items"][]): ApprovalsResponse["items"] {
  const byId = new Map<string, ApprovalsResponse["items"][number]>();
  for (const items of groups) {
    for (const item of items) {
      const current = byId.get(item.approvalId);
      if (!current || Date.parse(item.createdAt) >= Date.parse(current.createdAt)) {
        byId.set(item.approvalId, item);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function hasRecoveryLinkage(approval: ApprovalsResponse["items"][number]): boolean {
  return Boolean(
    approval.linkage?.durableRunId ||
    approval.linkage?.proactiveRunId ||
    approval.linkage?.taskId ||
    approval.linkage?.correlationId ||
    approval.linkage?.traceId,
  );
}

function buildLiveLaneHref(
  approval: ApprovalsResponse["items"][number],
): { href: string; route: ResolvedRoute } | null {
  if (!approval.linkage?.sessionId) {
    return null;
  }
  const surface = approval.linkage.originSurface;
  const normalizedSurface = surface === "cowork" || surface === "code" ? surface : "chat";
  const route: ResolvedRoute = {
    space: "operate",
    page: "surface",
    surface: normalizedSurface,
    sessionId: approval.linkage.sessionId,
    approvalId: approval.approvalId,
  };
  if (approval.linkage.turnId) {
    route.turnId = approval.linkage.turnId;
  }
  return {
    href: buildRouteSearch(route),
    route,
  };
}

function isExpiredApproval(approval: ApprovalsResponse["items"][number]): boolean {
  if (approval.status !== "pending" || !approval.expiresAt) {
    return false;
  }
  const expiresAtMs = Date.parse(approval.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function getCanonicalDurableRunId(lifecycle: RuntimeLifecycleResponse): string | null {
  return (
    lifecycle.query.runId ??
    lifecycle.approval?.linkage?.durableRunId ??
    lifecycle.approvalWaitDurableRun?.runId ??
    null
  );
}

function isBlockedDurableStatus(status: string): boolean {
  return status === "paused" || status === "waiting";
}

function formatInferredIds(ids: string[], canonicalId?: string | null): string {
  const inferred = ids.filter((id) => id !== canonicalId);
  return inferred.length > 0 ? inferred.join(", ") : "none";
}
