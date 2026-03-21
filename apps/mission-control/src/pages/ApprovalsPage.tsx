import { useEffect, useState } from "react";
import {
  fetchApprovalReplay,
  fetchApprovals,
  fetchDevDiagnostics,
  fetchDurableRun,
  fetchDurableRunTimeline,
  resolveApproval,
  resumeDurableRun,
  type ApprovalReplayResponse,
  type ApprovalsResponse,
} from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { PageGuideCard } from "../components/PageGuideCard";
import { ConfirmModal } from "../components/ConfirmModal";
import { CardSkeleton } from "../components/CardSkeleton";
import { StatusChip } from "../components/StatusChip";
import { useAction } from "../hooks/useAction";
import { pageCopy } from "../content/copy";

interface ApprovalDurableStatus {
  runId: string;
  status: string;
  blockedStep?: string;
  blockedReason?: string;
  updatedAt: string;
}

function findDurableRunId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    const record = current as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (
        typeof value === "string"
        && value.trim().length >= 8
        && /(runid|run_id|durablerunid|durable_run_id)$/i.test(key)
      ) {
        return value.trim();
      }
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return undefined;
}

export function ApprovalsPage() {
  const [data, setData] = useState<ApprovalsResponse | null>(null);
  const [replayById, setReplayById] = useState<Record<string, ApprovalReplayResponse>>({});
  const [durableByApprovalId, setDurableByApprovalId] = useState<Record<string, ApprovalDurableStatus | null>>({});
  const [durableBusyByApprovalId, setDurableBusyByApprovalId] = useState<Record<string, boolean>>({});
  const [tracePreviewByApprovalId, setTracePreviewByApprovalId] = useState<Record<string, string[]>>({});
  const [pendingDecision, setPendingDecision] = useState<{ approvalId: string; decision: "approve" | "reject" } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolveAction = useAction();

  const load = () => {
    void fetchApprovals("pending")
      .then(setData)
      .catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    load();
  }, []);

  const onResolve = async (approvalId: string, decision: "approve" | "reject") => {
    try {
      const result = await resolveAction.run(async () => resolveApproval(approvalId, decision));
      if (result.executedAction) {
        setError(
          `Approval ${approvalId} resolved and action ${result.executedAction.outcome}: ${result.executedAction.policyReason}`,
        );
      }
      load();
      const replay = await fetchApprovalReplay(approvalId);
      setReplayById((prev) => ({ ...prev, [approvalId]: replay }));
    } catch (err) {
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

  const resolveApprovalRunId = async (approvalId: string): Promise<string | null> => {
    const replay = replayById[approvalId] ?? await fetchApprovalReplay(approvalId);
    if (!replayById[approvalId]) {
      setReplayById((prev) => ({ ...prev, [approvalId]: replay }));
    }
    const runId =
      findDurableRunId(replay.pendingAction?.request)
      ?? findDurableRunId(replay.approval.payload)
      ?? findDurableRunId(replay.approval.preview);
    return runId ?? null;
  };

  const loadDurableStatus = async (approvalId: string) => {
    setDurableBusyByApprovalId((prev) => ({ ...prev, [approvalId]: true }));
    try {
      const runId = await resolveApprovalRunId(approvalId);
      if (!runId) {
        setDurableByApprovalId((prev) => ({ ...prev, [approvalId]: null }));
        setError("No durable run id found in this approval payload yet.");
        return;
      }
      const [run, timeline] = await Promise.all([
        fetchDurableRun(runId),
        fetchDurableRunTimeline(runId, 120),
      ]);
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

  const approvalsHeaderActions = (
    <div className="workflow-summary-strip">
      <StatusChip tone={data.items.length > 0 ? "warning" : "success"}>{data.items.length} pending</StatusChip>
      <StatusChip tone="muted">{Object.keys(replayById).length} replay trails loaded</StatusChip>
    </div>
  );

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Governance"
        title={pageCopy.approvals.title}
        subtitle={pageCopy.approvals.subtitle}
        hint="Each approval keeps the action preview, explainer context, replay trail, and checkpoint resume path in one place."
        className="page-header-citadel approvals-header"
        actions={approvalsHeaderActions}
      />
      <PageGuideCard
        pageId="approvals"
        what={pageCopy.approvals.guide?.what ?? ""}
        when={pageCopy.approvals.guide?.when ?? ""}
        actions={pageCopy.approvals.guide?.actions ?? []}
        terms={pageCopy.approvals.guide?.terms}
      />
      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
      </div>
      {data.items.length === 0 ? (
        <Panel
          title="No Pending Approvals"
          subtitle="When risky actions require a human decision, they appear here with replay context and durable resume controls."
          tone="soft"
          className="approval-empty-panel"
        >
          <p className="office-subtitle">Nothing is waiting for review right now.</p>
        </Panel>
      ) : null}
      {data.items.map((approval) => {
        const replay = replayById[approval.approvalId];
        const durable = durableByApprovalId[approval.approvalId];
        const durableBusy = Boolean(durableBusyByApprovalId[approval.approvalId]);
        const tracePreview = tracePreviewByApprovalId[approval.approvalId];
        const traceMetadata = findTraceMetadata(replay?.pendingAction?.request)
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

        const explanationColor =
          approval.explanationStatus === "pending"
            ? "#ffb87a"
            : approval.explanationStatus === "completed"
              ? "#8ee4a1"
              : approval.explanationStatus === "failed"
                ? "#ff8c8c"
                : "#c4885b";

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

            {approval.explanation ? (
              <div className="replay-box">
                <h4>What this action does</h4>
                <p>{approval.explanation.summary}</p>
                <h4>Why it could be risky</h4>
                <p>{approval.explanation.riskExplanation}</p>
                {approval.explanation.saferAlternative ? (
                  <>
                    <h4>Safer alternative</h4>
                    <p>{approval.explanation.saferAlternative}</p>
                  </>
                ) : null}
                <small>
                  Generated {new Date(approval.explanation.generatedAt).toLocaleString()}
                  {approval.explanation.providerId ? ` via ${approval.explanation.providerId}` : ""}
                  {approval.explanation.model ? ` (${approval.explanation.model})` : ""}
                </small>
              </div>
            ) : null}

            {approval.explanationError ? (
              <p className="error">Explainer error: {approval.explanationError}</p>
            ) : null}

            <pre>{JSON.stringify(approval.preview, null, 2)}</pre>
            {traceMetadata?.traceId ? <p>trace: {traceMetadata.traceId}</p> : null}
            {traceMetadata?.correlationId ? <p>correlation: {traceMetadata.correlationId}</p> : null}
            {traceMetadata?.correlationId ? (
              <div className="actions">
                <button type="button" onClick={() => void loadTracePreview(approval.approvalId, traceMetadata.correlationId)}>
                  {tracePreview ? "Refresh trace detail" : "Load trace detail"}
                </button>
              </div>
            ) : null}
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
            <div className="actions">
              <button type="button" onClick={() => setPendingDecision({ approvalId: approval.approvalId, decision: "approve" })}>Approve</button>
              <button type="button" className="danger" onClick={() => setPendingDecision({ approvalId: approval.approvalId, decision: "reject" })}>Reject</button>
              <button type="button" onClick={() => onReplay(approval.approvalId)}>Replay</button>
            </div>
            {replay ? (
              <div className="replay-box">
                <h4>Replay Trail</h4>
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
            ) : null}
            <div className="replay-box">
              <h4>Checkpoint Resume</h4>
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
                  onClick={() => { void resumeFromCheckpoint(approval.approvalId); }}
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

