import { useCallback, useEffect, useState } from "react";
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
import { useAction } from "../hooks/useAction";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import { pageCopy } from "../content/copy";

interface ApprovalDurableStatus {
  runId: string;
  status: string;
  blockedStep?: string;
  blockedReason?: string;
  updatedAt: string;
}

interface ApprovalEvidenceBlock {
  label: string;
  content: string;
}

interface ApprovalEvidenceModel {
  targets: string[];
  commands: string[];
  changes: ApprovalEvidenceBlock[];
  supporting: string[];
}

export function ApprovalsPage() {
  const embedded = useEmbeddedPageChrome();
  const [data, setData] = useState<ApprovalsResponse | null>(null);
  const [replayById, setReplayById] = useState<Record<string, ApprovalReplayResponse>>({});
  const [lifecycleByApprovalId, setLifecycleByApprovalId] = useState<Record<string, RuntimeLifecycleResponse>>({});
  const [durableByApprovalId, setDurableByApprovalId] = useState<Record<string, ApprovalDurableStatus | null>>({});
  const [durableBusyByApprovalId, setDurableBusyByApprovalId] = useState<Record<string, boolean>>({});
  const [tracePreviewByApprovalId, setTracePreviewByApprovalId] = useState<Record<string, string[]>>({});
  const [pendingDecision, setPendingDecision] = useState<{ approvalId: string; decision: "approve" | "reject" } | null>(null);
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [pendingResumeApprovalId, setPendingResumeApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const resolveAction = useAction();
  const bulkResolveAction = useAction();

  const load = useCallback(async () => {
    try {
      const response = await fetchApprovals("pending");
      setData(response);
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
      const result = await bulkResolveAction.run(async () => resolveApprovalsBulk({
        decision: "reject",
        status: "pending",
        resolutionNote: "Bulk rejected from the approvals queue.",
      }));
      const message = `Rejected ${result.resolvedCount} pending approvals. Skipped ${result.skippedCount}. Failed ${result.failedCount}.`;
      setSummary(message);
      setError(null);
      const resolvedApprovalIds = new Set(
        result.items
          .filter((item) => item.outcome === "resolved")
          .map((item) => item.approvalId),
      );
      setData((current) => current
        ? {
          ...current,
          items: current.items.filter((item) => !resolvedApprovalIds.has(item.approvalId)),
        }
        : current);
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
    setData((current) => current
      ? {
        ...current,
        items: current.items.filter((item) => item.approvalId !== result.approval.approvalId),
      }
      : current);
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
          runIds: result.durableRunId ? [result.durableRunId] : result.approval.linkage?.durableRunId ? [result.approval.linkage.durableRunId] : [],
          proactiveRunIds: result.approval.linkage?.proactiveRunId ? [result.approval.linkage.proactiveRunId] : [],
          approvalIds: [result.approval.approvalId],
          taskIds: result.approval.linkage?.taskId ? [result.approval.linkage.taskId] : [],
          workspaceIds: result.approval.linkage?.workspaceId ? [result.approval.linkage.workspaceId] : [],
        },
        approval: result.approval,
        turns: [],
        toolRuns: [],
      },
    }));
  };

  const loadDurableStatus = async (approvalId: string) => {
    setDurableBusyByApprovalId((prev) => ({ ...prev, [approvalId]: true }));
    try {
      const lifecycle = await fetchRuntimeLifecycle({ approvalId });
      setLifecycleByApprovalId((prev) => ({ ...prev, [approvalId]: lifecycle }));
      const runId = lifecycle.query.runId ?? lifecycle.linked.runIds[0] ?? null;
      if (!runId) {
        setDurableByApprovalId((prev) => ({ ...prev, [approvalId]: null }));
        setError("No durable run is linked to this approval yet.");
        return;
      }
      const run = lifecycle.durableRun ?? await fetchDurableRun(runId);
      const timeline = await fetchDurableRunTimeline(runId, 120);
      const blockingEvent = [...timeline.items]
        .reverse()
        .find((event) => event.eventType === "run_paused" || event.eventType === "run_waiting");
      const blockedStep = (blockingEvent?.payload?.stepKey as string | undefined) ?? blockingEvent?.stepKey;
      const blockedReason = blockingEvent?.payload?.reason;
      setDurableByApprovalId((prev) => ({
        ...prev,
        [approvalId]: {
          runId,
          status: run.status,
          blockedStep,
          blockedReason: typeof blockedReason === "string" ? blockedReason : undefined,
          updatedAt: run.updatedAt,
        },
      }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDurableBusyByApprovalId((prev) => ({ ...prev, [approvalId]: false }));
    }
  };

  const resumeFromCheckpoint = async (approvalId: string) => {
    const current = durableByApprovalId[approvalId];
    if (!current?.runId) {
      setError("Load durable status first so we can resume from the exact checkpoint.");
      return;
    }
    setDurableBusyByApprovalId((prev) => ({ ...prev, [approvalId]: true }));
    try {
      await resumeDurableRun(current.runId, "operator");
      await loadDurableStatus(approvalId);
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
        [approvalId]: response.items.map((item) => `${new Date(item.timestamp).toLocaleTimeString()} ${item.event}: ${item.message}`),
      }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!data) {
    return <CardSkeleton lines={7} />;
  }

  const hasPendingApprovals = data.items.length > 0;
  const replayCount = Object.keys(replayById).length;

  const approvalsHeaderActions = hasPendingApprovals ? (
    <div className="workflow-summary-strip">
      <StatusChip tone="warning">{data.items.length} pending</StatusChip>
      {replayCount > 0 ? <StatusChip tone="muted">{replayCount} replay trails loaded</StatusChip> : null}
      <button
        type="button"
        className="danger"
        disabled={bulkResolveAction.pending}
        onClick={() => setBulkRejectOpen(true)}
      >
        {bulkResolveAction.pending ? "Rejecting..." : "Reject all pending"}
      </button>
    </div>
  ) : null;

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Governance"
        title={pageCopy.approvals.title}
        subtitle={pageCopy.approvals.subtitle}
        hint="Review risky actions, explanation status, and checkpoint recovery in one queue."
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
      {embedded && approvalsHeaderActions ? <DataToolbar primary={approvalsHeaderActions} className="approvals-toolbar" /> : null}
      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {summary ? <p className="office-subtitle">{summary}</p> : null}
        <p className="office-subtitle">
          This queue shows backend approval records. The shell decision badge can also include active Mission Control prompts that are not yet persisted here.
        </p>
      </div>
      {!hasPendingApprovals ? (
        <Panel
          title="No Pending Approvals"
          subtitle="The approvals queue is clear right now."
          tone="soft"
          padding="compact"
          className="approval-empty-panel"
        >
          <p className="office-subtitle">New risky actions will appear here when they need a human decision.</p>
        </Panel>
      ) : null}
      {data.items.map((approval) => {
        const replay = replayById[approval.approvalId];
        const lifecycle = lifecycleByApprovalId[approval.approvalId];
        const durable = durableByApprovalId[approval.approvalId];
        const durableBusy = Boolean(durableBusyByApprovalId[approval.approvalId]);
        const tracePreview = tracePreviewByApprovalId[approval.approvalId];
        const evidence = buildApprovalEvidenceModel(approval.preview, replay?.pendingAction?.request);
        const explanationSummary = approval.explanation?.summary ?? `Review the ${approval.kind} request before GoatCitadel continues.`;
        const consequenceSummary = approval.explanation?.saferAlternative
          ? `Approve to continue this action now. Reject to stop it here. Safer alternative: ${approval.explanation.saferAlternative}`
          : "Approve to continue this action now. Reject to keep the system paused at this checkpoint.";
        const explanationTimestamp = approval.explanation
          ? `Generated ${new Date(approval.explanation.generatedAt).toLocaleString()}`
          : null;
        const traceMetadata = approval.linkage?.correlationId || approval.linkage?.traceId
          ? {
            correlationId: approval.linkage?.correlationId,
            traceId: approval.linkage?.traceId,
          }
          : replay?.approval.linkage?.correlationId || replay?.approval.linkage?.traceId
            ? {
              correlationId: replay.approval.linkage?.correlationId,
              traceId: replay.approval.linkage?.traceId,
            }
            : findTraceMetadata(replay?.pendingAction?.request)
              ?? findTraceMetadata(approval.payload)
              ?? findTraceMetadata(approval.preview);
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
            key={approval.approvalId}
            title={approval.kind}
            className={`approval-card approval-card-${approval.riskLevel}`}
            subtitle={(
              <div className="workflow-summary-strip">
                <StatusChip tone={approval.riskLevel === "nuclear" ? "critical" : approval.riskLevel === "danger" ? "warning" : "muted"}>
                  {approval.riskLevel} risk
                </StatusChip>
                <StatusChip className="approvals-explanation-chip" tone={
                  approval.explanationStatus === "pending"
                    ? "warning"
                    : approval.explanationStatus === "completed"
                      ? "success"
                      : approval.explanationStatus === "failed"
                        ? "critical"
                        : "muted"
                }>
                  {explanationLabel}
                </StatusChip>
              </div>
            )}
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
                <button type="button" className="approval-action-primary" onClick={() => setPendingDecision({ approvalId: approval.approvalId, decision: "approve" })}>
                  Approve now
                </button>
                <button type="button" className="danger approval-action-secondary" onClick={() => setPendingDecision({ approvalId: approval.approvalId, decision: "reject" })}>
                  Reject
                </button>
                <button type="button" className="approval-action-tertiary" onClick={() => onReplay(approval.approvalId)}>
                  Load replay trail
                </button>
              </div>
            </section>

            {approval.explanationError ? (
              <p className="error">Explainer error: {approval.explanationError}</p>
            ) : null}

            <div className="approval-evidence-grid">
              {evidence ? (
                <div className="replay-box approval-support-box">
                  <h4>Operator evidence</h4>
                  {evidence.targets.length > 0 ? (
                    <ul className="compact-list">
                      {evidence.targets.map((line) => (
                        <li key={`${approval.approvalId}-${line}`}>{line}</li>
                      ))}
                    </ul>
                  ) : null}
                  {evidence.commands.length > 0 ? (
                    <div className="approval-evidence-section">
                      <p className="approval-evidence-label">Commands</p>
                      <ul className="compact-list">
                        {evidence.commands.map((line) => (
                          <li key={`${approval.approvalId}-command-${line}`}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {evidence.supporting.length > 0 ? (
                    <div className="approval-evidence-section">
                      <p className="approval-evidence-label">Supporting context</p>
                      <ul className="compact-list">
                        {evidence.supporting.map((line) => (
                          <li key={`${approval.approvalId}-support-${line}`}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {evidence.changes.map((block) => (
                    <details key={`${approval.approvalId}-${block.label}`} className="approval-technical-details">
                      <summary>{block.label}</summary>
                      <pre>{block.content}</pre>
                    </details>
                  ))}
                </div>
              ) : null}
              {traceMetadata?.traceId || traceMetadata?.correlationId ? (
                <div className="replay-box approval-support-box">
                  <h4>System trace</h4>
                  {traceMetadata?.traceId ? <p>trace: {traceMetadata.traceId}</p> : null}
                  {traceMetadata?.correlationId ? <p>correlation: {traceMetadata.correlationId}</p> : null}
                  {traceMetadata?.correlationId ? (
                    <div className="actions">
                      <button type="button" onClick={() => void loadTracePreview(approval.approvalId, traceMetadata.correlationId)}>
                        {tracePreview ? "Refresh trace detail" : "Load trace detail"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="replay-box approval-support-box">
                <h4>Checkpoint resume</h4>
                <p>
                  Load durable status to see the exact blocked step. Resume continues from the last checkpoint instead of restarting.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    onClick={() => { void loadDurableStatus(approval.approvalId); }}
                    disabled={durableBusy}
                  >
                    {durableBusy ? "Loading..." : "Load durable status"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingResumeApprovalId(approval.approvalId)}
                    disabled={durableBusy || !durable?.runId}
                  >
                    Resume from checkpoint
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
                <h4>Canonical linkage</h4>
                <p className="office-subtitle">
                  Session: {lifecycle.query.sessionId ?? lifecycle.linked.sessionIds[0] ?? "unlinked"}
                  {" | "}
                  Turns: {lifecycle.linked.turnIds.length > 0 ? lifecycle.linked.turnIds.join(", ") : "none"}
                  {" | "}
                  Task: {lifecycle.query.taskId ?? lifecycle.linked.taskIds[0] ?? "none"}
                </p>
                <p className="office-subtitle">
                  Proactive durable run: {lifecycle.proactiveDurableRun?.runId ?? "none"}
                  {" | "}
                  Approval wait run: {lifecycle.approvalWaitDurableRun?.runId ?? "none"}
                  {" | "}
                  Queried run: {lifecycle.query.runId ?? lifecycle.linked.runIds[0] ?? "none"}
                </p>
                {approval.linkage?.proactiveRunId || lifecycle.proactiveRuns?.length ? (
                  <p className="office-subtitle">
                    Proactive run: {approval.linkage?.proactiveRunId ?? lifecycle.proactiveRuns?.[0]?.runId ?? "none"}
                    {" | "}
                    Surface: {approval.linkage?.originSurface ?? lifecycle.proactiveRuns?.[0]?.originSurface ?? "unknown"}
                  </p>
                ) : null}
                {approval.linkage?.externalReferenceRoots?.length ? (
                  <p className="office-subtitle">
                    Reference roots: {approval.linkage.externalReferenceRoots.map((root) => `${root.label} (${root.access})`).join(", ")}
                  </p>
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
                  {replay.pendingAction ? (
                    <pre>{JSON.stringify(replay.pendingAction, null, 2)}</pre>
                  ) : null}
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
      })}
      <ConfirmModal
        open={Boolean(pendingDecision)}
        title={pendingDecision?.decision === "approve" ? "Approve Action" : "Reject Approval"}
        message={
          pendingDecision?.decision === "approve"
            ? "Approve this action and execute it now?"
            : "Reject this approval request?"
        }
        confirmLabel={resolveAction.pending ? "Applying..." : (pendingDecision?.decision === "approve" ? "Approve" : "Reject")}
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
        message={`Reject all ${data.items.length} pending approvals now? This does not approve or dismiss them locally; it resolves the pending queue with a reject decision and refreshes the shell counts afterward.`}
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

function findTraceMetadata(payload: unknown): { correlationId?: string; traceId?: string } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    const record = current as Record<string, unknown>;
    const correlationId = typeof record.correlationId === "string" ? record.correlationId : undefined;
    const traceId = typeof record.traceId === "string" ? record.traceId : undefined;
    if (correlationId || traceId) {
      return { correlationId, traceId };
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return null;
}

function buildApprovalEvidenceModel(...sources: Array<unknown>): ApprovalEvidenceModel | null {
  const targets = new Set<string>();
  const commands = new Set<string>();
  const supporting = new Set<string>();
  const changes: ApprovalEvidenceBlock[] = [];
  const seenBlocks = new Set<string>();

  for (const source of sources) {
    collectApprovalEvidence(source, {
      targets,
      commands,
      supporting,
      changes,
      seenBlocks,
    });
  }

  if (targets.size === 0 && commands.size === 0 && supporting.size === 0 && changes.length === 0) {
    return null;
  }

  return {
    targets: [...targets].slice(0, 6),
    commands: [...commands].slice(0, 4),
    supporting: [...supporting].slice(0, 4),
    changes: changes.slice(0, 4),
  };
}

function collectApprovalEvidence(
  source: unknown,
  collector: {
    targets: Set<string>;
    commands: Set<string>;
    supporting: Set<string>;
    changes: ApprovalEvidenceBlock[];
    seenBlocks: Set<string>;
  },
): void {
  if (!source || typeof source !== "object") {
    return;
  }

  const visited = new Set<unknown>();
  const stack: unknown[] = [source];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      current.forEach((item) => stack.push(item));
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string") {
        if (isFilesystemKey(key)) {
          collector.targets.add(`${humanizeKey(key)}: ${value}`);
        } else if (isLikelyCommandKey(key) && value.trim()) {
          collector.commands.add(`${humanizeKey(key)}: ${truncateEvidence(value, 140)}`);
        } else if (isLikelyCodeKey(key) && value.includes("\n")) {
          pushEvidenceBlock(collector.changes, collector.seenBlocks, humanizeKey(key), value);
        } else if (isLikelySupportKey(key)) {
          collector.supporting.add(`${humanizeKey(key)}: ${truncateEvidence(value, 180)}`);
        }
      } else if (Array.isArray(value)) {
        if (value.every((item) => typeof item === "string")) {
          const strings = value.filter((item): item is string => typeof item === "string");
          if (isFilesystemKey(key)) {
            collector.targets.add(`${humanizeKey(key)}: ${strings.slice(0, 4).join(", ")}${strings.length > 4 ? "…" : ""}`);
          } else if (isLikelyCommandKey(key)) {
            collector.commands.add(`${humanizeKey(key)}: ${strings.slice(0, 3).join(" | ")}${strings.length > 3 ? "…" : ""}`);
          } else if (isLikelyCodeCollectionKey(key)) {
            for (const item of strings.slice(0, 2)) {
              if (item.includes("\n")) {
                pushEvidenceBlock(collector.changes, collector.seenBlocks, humanizeKey(key), item);
              }
            }
          } else if (isLikelySupportKey(key)) {
            collector.supporting.add(`${humanizeKey(key)}: ${strings.slice(0, 3).join(", ")}${strings.length > 3 ? "…" : ""}`);
          }
        }
        value.forEach((item) => stack.push(item));
      } else if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
}

function pushEvidenceBlock(
  codeBlocks: Array<{ label: string; content: string }>,
  seenBlocks: Set<string>,
  label: string,
  content: string,
): void {
  const normalized = content.trim();
  if (!normalized) {
    return;
  }
  const key = `${label}:${normalized}`;
  if (seenBlocks.has(key)) {
    return;
  }
  seenBlocks.add(key);
  codeBlocks.push({
    label,
    content: truncateEvidence(normalized, 1200),
  });
}

function isFilesystemKey(key: string): boolean {
  return /path|paths|file|files|root|roots|target|targets/i.test(key);
}

function isLikelyCommandKey(key: string): boolean {
  return /command|cmd|script|shell/i.test(key);
}

function isLikelyCodeKey(key: string): boolean {
  return /diff|patch|before|after|code|content|snippet/i.test(key);
}

function isLikelyCodeCollectionKey(key: string): boolean {
  return /diffs|patches|snippets|files/i.test(key);
}

function isLikelySupportKey(key: string): boolean {
  return /url|uri|reason|summary|description|title|selector|field|input|prompt/i.test(key);
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function truncateEvidence(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}\n...` : value;
}

