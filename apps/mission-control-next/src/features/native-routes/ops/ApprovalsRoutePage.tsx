import { useMemo, useState, type MouseEvent } from "react";
import { AlertTriangle, Clock, History, Play, RefreshCw, Waypoints } from "lucide-react";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";
import { ThreePartChip } from "../primitives";
import {
  buildApprovalEvidenceModel,
  findTraceMetadata,
  formatInferredIds,
  getCanonicalDurableRunId,
  isExpiredApproval,
} from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { useApprovalQueue } from "@goatcitadel/mission-control-shared/hooks/useApprovalQueue";
import type { AppRoute } from "@next/app/route-model";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import { ShellExplanationList } from "./ShellExplanationList";
import "../native-routes.css";

export function ApprovalsRoutePage({ route, activeWorkspaceName, pendingApprovals, navigate }: NativeRoutePagesProps) {
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const approvals = useApprovalQueue({
    focusedApprovalId: route.approvalId ?? null,
  });

  const selectedApproval = approvals.selectedApproval;
  const liveLaneRoute = selectedApproval ? buildLiveLaneRoute(selectedApproval) : null;
  const queueCounts = useMemo(
    () => ({
      pending: approvals.pendingItems.length,
      history: approvals.historyItems.length,
      recovery: approvals.recoveryItems.length,
    }),
    [approvals.historyItems.length, approvals.pendingItems.length, approvals.recoveryItems.length],
  );

  return (
    <>
      <NativePageFrame
        area="ops"
        kicker="Ops · Approvals"
        title="Approvals"
        description="Pending decisions, history, replay, and durable recovery in the canonical next shell."
        loading={approvals.loading}
        error={approvals.error}
        metrics={[
          { label: "Pending", value: String(queueCounts.pending || pendingApprovals) },
          { label: "History", value: String(queueCounts.history) },
          { label: "Recovery", value: String(queueCounts.recovery) },
          { label: "Replay trails", value: String(approvals.replayCount) },
        ]}
        actions={
          approvals.view === "pending" ? (
            <button
              type="button"
              className="gc-button danger"
              disabled={!approvals.hasPendingApprovals || approvals.bulkResolvePending}
              onClick={() => setBulkRejectOpen(true)}
            >
              {approvals.bulkResolvePending ? "Rejecting..." : "Reject all pending"}
            </button>
          ) : null
        }
      >
        <NativeGrid>
          <NativeCard
            title="Approval queue"
            subtitle="Work the pending queue, audit history, or jump straight to recovery-linked approvals."
            stats={[
              { label: "Pending", value: String(queueCounts.pending || pendingApprovals) },
              { label: "Workspace", value: activeWorkspaceName },
              { label: "Replay trails", value: String(approvals.replayCount) },
            ]}
          >
            <div className="mc-next-approvals-toolbar">
              <div className="mc-next-approvals-view-switch" role="tablist" aria-label="Approval views">
                <ApprovalViewButton
                  active={approvals.view === "pending"}
                  label={`Pending (${queueCounts.pending})`}
                  onClick={() => approvals.setView("pending")}
                />
                <ApprovalViewButton
                  active={approvals.view === "history"}
                  label={`History (${queueCounts.history})`}
                  onClick={() => approvals.setView("history")}
                />
                <ApprovalViewButton
                  active={approvals.view === "recovery"}
                  label={`Recovery (${queueCounts.recovery})`}
                  onClick={() => approvals.setView("recovery")}
                />
              </div>
              {approvals.view === "pending" ? (
                <button
                  type="button"
                  className="gc-button danger"
                  disabled={!approvals.hasPendingApprovals || approvals.bulkResolvePending}
                  onClick={() => setBulkRejectOpen(true)}
                >
                  {approvals.bulkResolvePending ? "Rejecting..." : "Reject all pending"}
                </button>
              ) : null}
            </div>
            <div className="mc-next-approvals-risk-strip">
              <StatusChip tone={approvals.pendingRiskCounts.safe > 0 ? "success" : "muted"}>
                Safe {approvals.pendingRiskCounts.safe}
              </StatusChip>
              <StatusChip tone={approvals.pendingRiskCounts.caution > 0 ? "warning" : "muted"}>
                Caution {approvals.pendingRiskCounts.caution}
              </StatusChip>
              <StatusChip tone={approvals.pendingRiskCounts.danger > 0 ? "warning" : "muted"}>
                Danger {approvals.pendingRiskCounts.danger}
              </StatusChip>
              <StatusChip tone={approvals.pendingRiskCounts.nuclear > 0 ? "critical" : "muted"}>
                Nuclear {approvals.pendingRiskCounts.nuclear}
              </StatusChip>
            </div>
            <div className="mc-next-approvals-list">
              {approvals.visibleItems.length === 0 ? (
                <p className="mc-next-directory-empty">No approvals in this view.</p>
              ) : (
                approvals.visibleItems.map((approval) => {
                  const expired = isExpiredApproval(approval);
                  const effectiveStatus = expired ? "expired" : approval.status;
                  const selected = approval.approvalId === selectedApproval?.approvalId;
                  return (
                    <button
                      key={approval.approvalId}
                      type="button"
                      className={`mc-next-approvals-list-item${selected ? " is-selected" : ""}`}
                      onClick={() => approvals.setSelectedApprovalId(approval.approvalId)}
                    >
                      <div className="mc-next-directory-list-head">
                        <strong>{approval.kind || approval.approvalId}</strong>
                        <span>{formatDateTime(approval.createdAt)}</span>
                      </div>
                      <div className="mc-next-approvals-chip-row">
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
                        {approval.linkage?.durableRunId ? <StatusChip tone="default">durable</StatusChip> : null}
                        {approval.followUp && approval.followUp.status !== "none" ? (
                          <StatusChip tone={approvalFollowUpTone(approval.followUp.status)}>
                            {formatApprovalFollowUp(approval.followUp.status)}
                          </StatusChip>
                        ) : null}
                      </div>
                      <p>{approval.explanation?.summary || approval.resolutionNote || "Operator decision required."}</p>
                    </button>
                  );
                })
              )}
            </div>
          </NativeCard>
          <NativeCard
            title={selectedApproval ? selectedApproval.kind || selectedApproval.approvalId : "Approval detail"}
            subtitle={
              selectedApproval
                ? "Replay trail, durable recovery, and runtime linkage without dropping back to legacy routes."
                : "Select a queue item to inspect evidence, replay, and failure context."
            }
            stats={
              selectedApproval
                ? [
                    {
                      label: "Status",
                      value: isExpiredApproval(selectedApproval) ? "expired" : selectedApproval.status,
                    },
                    { label: "Risk", value: selectedApproval.riskLevel },
                  ]
                : undefined
            }
          >
            {selectedApproval ? (
              <ApprovalInspectorCard
                approval={selectedApproval}
                replay={approvals.replayById[selectedApproval.approvalId]}
                lifecycle={approvals.lifecycleByApprovalId[selectedApproval.approvalId]}
                durable={approvals.durableByApprovalId[selectedApproval.approvalId]}
                durableBusy={Boolean(approvals.durableBusyByApprovalId[selectedApproval.approvalId])}
                tracePreview={approvals.tracePreviewByApprovalId[selectedApproval.approvalId]}
                resolvePending={approvals.resolvePending}
                onApprove={() => void approvals.onResolve(selectedApproval.approvalId, "approve")}
                onReject={() => void approvals.onResolve(selectedApproval.approvalId, "reject")}
                onReplay={() => void approvals.onReplay(selectedApproval.approvalId)}
                onLoadTracePreview={(correlationId) =>
                  void approvals.loadTracePreview(selectedApproval.approvalId, correlationId)
                }
                onLoadDurableStatus={() => void approvals.loadDurableStatus(selectedApproval.approvalId)}
                onResumeCheckpoint={() => void approvals.resumeFromCheckpoint(selectedApproval.approvalId)}
                onOpenLiveLane={
                  liveLaneRoute
                    ? (event) => {
                        event.preventDefault();
                        navigate(liveLaneRoute);
                      }
                    : undefined
                }
                liveLaneRoute={liveLaneRoute}
              />
            ) : (
              <p className="mc-next-directory-empty">
                Select a queue item to inspect its replay trail and recovery state.
              </p>
            )}
            {approvals.summary ? <p className="mc-next-approvals-summary">{approvals.summary}</p> : null}
          </NativeCard>
        </NativeGrid>
      </NativePageFrame>
      <ConfirmModal
        open={bulkRejectOpen}
        title="Reject all pending approvals?"
        message="This keeps GoatCitadel paused at every pending checkpoint in the current queue."
        confirmLabel={approvals.bulkResolvePending ? "Rejecting..." : "Reject all pending"}
        pending={approvals.bulkResolvePending}
        onCancel={() => setBulkRejectOpen(false)}
        onConfirm={() => {
          void approvals.onRejectAllPending().finally(() => {
            setBulkRejectOpen(false);
          });
        }}
      />
    </>
  );
}

function ApprovalViewButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`mc-next-approvals-view-button${active ? " is-active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function ApprovalInspectorCard(props: {
  approval: ApprovalRequest;
  replay?: ReturnType<typeof useApprovalQueue>["replayById"][string];
  lifecycle?: ReturnType<typeof useApprovalQueue>["lifecycleByApprovalId"][string];
  durable?: ReturnType<typeof useApprovalQueue>["durableByApprovalId"][string];
  durableBusy: boolean;
  tracePreview?: string[];
  resolvePending: boolean;
  onApprove: () => void;
  onReject: () => void;
  onReplay: () => void;
  onLoadTracePreview: (correlationId?: string) => void;
  onLoadDurableStatus: () => void;
  onResumeCheckpoint: () => void;
  liveLaneRoute: AppRoute | null;
  onOpenLiveLane?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const {
    approval,
    replay,
    lifecycle,
    durable,
    durableBusy,
    tracePreview,
    resolvePending,
    onApprove,
    onReject,
    onReplay,
    onLoadTracePreview,
    onLoadDurableStatus,
    onResumeCheckpoint,
    liveLaneRoute,
    onOpenLiveLane,
  } = props;
  const expired = isExpiredApproval(approval);
  const effectiveStatus = expired ? "expired" : approval.status;
  const evidence = buildApprovalEvidenceModel(approval.preview, replay?.pendingAction?.request);
  const traceMetadata =
    approval.linkage?.correlationId || approval.linkage?.traceId
      ? {
          correlationId: approval.linkage.correlationId,
          traceId: approval.linkage.traceId,
        }
      : replay?.approval.linkage?.correlationId || replay?.approval.linkage?.traceId
        ? {
            correlationId: replay.approval.linkage?.correlationId,
            traceId: replay.approval.linkage?.traceId,
          }
        : (findTraceMetadata(replay?.pendingAction?.request) ??
          findTraceMetadata(approval.payload) ??
          findTraceMetadata(approval.preview));

  return (
    <div className="mc-next-approvals-inspector">
      <div className="mc-next-approvals-chip-row">
        <StatusChip
          tone={approval.riskLevel === "nuclear" ? "critical" : approval.riskLevel === "danger" ? "warning" : "muted"}
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
        {approval.explanationStatus ? (
          <StatusChip
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
            {approval.explanationStatus}
          </StatusChip>
        ) : null}
        {approval.followUp && approval.followUp.status !== "none" ? (
          <StatusChip tone={approvalFollowUpTone(approval.followUp.status)}>
            {formatApprovalFollowUp(approval.followUp.status)}
          </StatusChip>
        ) : null}
      </div>

      <div className="mc-next-approvals-decision-shell">
        <div className="mc-next-approvals-copy">
          <p className="mc-next-approvals-kicker">Human decision required</p>
          <h3>
            {approval.explanation?.summary ?? `Review the ${approval.kind} request before GoatCitadel continues.`}
          </h3>
          {approval.explanation?.riskExplanation ? <p>{approval.explanation.riskExplanation}</p> : null}
        </div>
        <div className="mc-next-approvals-actions">
          {approval.status === "pending" && !expired ? (
            <ThreePartChip tone="caution" state="awaiting approval" mid={approval.kind ?? "decision"} age="—" />
          ) : null}
          {approval.status === "pending" && !expired ? (
            <>
              <button type="button" className="gc-button" disabled={resolvePending} onClick={onApprove}>
                Approve now
              </button>
              <button type="button" className="gc-button danger" disabled={resolvePending} onClick={onReject}>
                Reject
              </button>
            </>
          ) : null}
          <button type="button" className="gc-button subtle" onClick={onReplay}>
            Load replay trail
          </button>
          {liveLaneRoute && onOpenLiveLane ? (
            <a href="#" className="mc-next-approvals-link-button" onClick={onOpenLiveLane}>
              Open live session
            </a>
          ) : null}
        </div>
      </div>

      {approval.explanationError ? (
        <div className="mc-next-directory-alert">
          <AlertTriangle className="h-4 w-4" />
          <div className="mc-next-approvals-explainer-error">
            <strong>Approval summary unavailable</strong>
            <span>{formatApprovalExplanationError(approval.explanationError)}</span>
          </div>
        </div>
      ) : null}

      {approval.followUp && approval.followUp.status !== "none" ? (
        <div className="mc-next-directory-alert">
          <Clock className="h-4 w-4" />
          <div>
            <strong>{formatApprovalFollowUp(approval.followUp.status)}</strong>
            <span>
              {approval.followUp.reason ??
                `${approval.followUp.effectKind ?? "Follow-up"} for ${approval.followUp.targetKind ?? "target"} ${
                  approval.followUp.targetId ?? ""
                }`.trim()}
            </span>
          </div>
        </div>
      ) : null}

      <div className="mc-next-approvals-support-grid">
        {evidence ? (
          <div className="mc-next-directory-card mc-next-directory-card-compact">
            <div className="mc-next-directory-card-head">
              <div>
                <h2>Operator evidence</h2>
                <p>Paths, commands, and supporting context pulled from the approval payload.</p>
              </div>
            </div>
            {evidence.targets.length > 0 ? (
              <ul className="mc-next-approvals-compact-list">
                {evidence.targets.map((line) => (
                  <li key={`${approval.approvalId}-${line}`}>{line}</li>
                ))}
              </ul>
            ) : null}
            {evidence.commands.length > 0 ? (
              <ShellExplanationList commands={evidence.commands} explanations={approval.shellExplanations} />
            ) : null}
            {evidence.supporting.length > 0 ? (
              <ul className="mc-next-approvals-compact-list">
                {evidence.supporting.map((line) => (
                  <li key={`${approval.approvalId}-support-${line}`}>{line}</li>
                ))}
              </ul>
            ) : null}
            {evidence.changes.map((block) => (
              <details key={`${approval.approvalId}-${block.label}`} className="mc-next-approvals-details">
                <summary>{block.label}</summary>
                <pre>{block.content}</pre>
              </details>
            ))}
          </div>
        ) : null}

        <div className="mc-next-directory-card mc-next-directory-card-compact">
          <div className="mc-next-directory-card-head">
            <div>
              <h2>Recovery</h2>
              <p>Inspect the current durable checkpoint and resume a paused run without starting over.</p>
            </div>
          </div>
          <div className="mc-next-approvals-inline-actions">
            <button type="button" className="gc-button subtle" disabled={durableBusy} onClick={onLoadDurableStatus}>
              <Waypoints className="h-4 w-4" />
              {durableBusy ? "Loading..." : "Load durable status"}
            </button>
            <button
              type="button"
              className="gc-button subtle"
              disabled={durableBusy || (durable != null && durable.status !== "paused")}
              onClick={onResumeCheckpoint}
            >
              <Play className="h-4 w-4" />
              Resume paused run
            </button>
          </div>
          {durable ? (
            <ul className="mc-next-approvals-compact-list">
              <li>Run: {durable.runId}</li>
              <li>Status: {durable.status}</li>
              {durable.blockedStep ? <li>Blocked step: {durable.blockedStep}</li> : null}
              {durable.blockedReason ? <li>Reason: {durable.blockedReason}</li> : null}
              <li>Updated: {formatDateTime(durable.updatedAt)}</li>
            </ul>
          ) : (
            <p className="mc-next-directory-empty">No checkpoint details loaded yet.</p>
          )}
        </div>

        {(traceMetadata?.traceId || traceMetadata?.correlationId) && (
          <div className="mc-next-directory-card mc-next-directory-card-compact">
            <div className="mc-next-directory-card-head">
              <div>
                <h2>Trace linkage</h2>
                <p>Inspect operator-visible trace correlation without leaving approvals.</p>
              </div>
            </div>
            <ul className="mc-next-approvals-compact-list">
              {traceMetadata.traceId ? <li>trace: {traceMetadata.traceId}</li> : null}
              {traceMetadata.correlationId ? <li>correlation: {traceMetadata.correlationId}</li> : null}
            </ul>
            {traceMetadata.correlationId ? (
              <button
                type="button"
                className="gc-button subtle"
                onClick={() => onLoadTracePreview(traceMetadata.correlationId)}
              >
                <RefreshCw className="h-4 w-4" />
                {tracePreview ? "Refresh trace detail" : "Load trace detail"}
              </button>
            ) : null}
          </div>
        )}
      </div>

      {tracePreview?.length ? (
        <div className="mc-next-directory-card mc-next-directory-card-compact">
          <div className="mc-next-directory-card-head">
            <div>
              <h2>Trace detail</h2>
              <p>Recent diagnostic breadcrumbs correlated to this approval.</p>
            </div>
          </div>
          <ul className="mc-next-approvals-compact-list">
            {tracePreview.map((item) => (
              <li key={`${approval.approvalId}-${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {lifecycle ? (
        <div className="mc-next-directory-card mc-next-directory-card-compact">
          <div className="mc-next-directory-card-head">
            <div>
              <h2>Runtime linkage</h2>
              <p>Canonical and inferred runtime relationships surfaced directly in the next shell.</p>
            </div>
          </div>
          <ul className="mc-next-approvals-compact-list">
            <li>
              Canonical session: {lifecycle.canonical?.sessionId ?? lifecycle.approval?.linkage?.sessionId ?? "absent"}
            </li>
            <li>Canonical task: {lifecycle.canonical?.taskId ?? lifecycle.approval?.linkage?.taskId ?? "absent"}</li>
            <li>Canonical run: {getCanonicalDurableRunId(lifecycle) ?? "absent"}</li>
            <li>
              Inferred sessions:{" "}
              {formatInferredIds(
                lifecycle.linked.sessionIds,
                lifecycle.canonical?.sessionId ?? lifecycle.approval?.linkage?.sessionId,
              )}
            </li>
            <li>
              Inferred tasks:{" "}
              {formatInferredIds(
                lifecycle.linked.taskIds,
                lifecycle.canonical?.taskId ?? lifecycle.approval?.linkage?.taskId,
              )}
            </li>
            <li>Inferred runs: {formatInferredIds(lifecycle.linked.runIds, getCanonicalDurableRunId(lifecycle))}</li>
            {lifecycle.approvalWaitDurableRun ? (
              <li>
                Wait mapping: {lifecycle.approvalWaitDurableRun.runId} ({lifecycle.approvalWaitDurableRun.status})
              </li>
            ) : null}
            {approval.linkage?.proactiveRunId || lifecycle.proactiveRuns?.length ? (
              <li>
                Proactive run: {approval.linkage?.proactiveRunId ?? lifecycle.proactiveRuns?.[0]?.runId ?? "none"}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {(lifecycle?.approvalEffects?.length ?? 0) > 0 || (replay?.effects?.length ?? 0) > 0 ? (
        <div className="mc-next-directory-card mc-next-directory-card-compact">
          <div className="mc-next-directory-card-head">
            <div>
              <h2>Approval effects</h2>
              <p>Queued or attempted follow-on work driven by the approval resolution.</p>
            </div>
          </div>
          <ul className="mc-next-approvals-compact-list">
            {(lifecycle?.approvalEffects ?? replay?.effects ?? []).map((effect) => (
              <li key={effect.effectId}>
                <strong>{effect.effectKind}</strong> | {effect.status} | {effect.targetKind}:{effect.targetId}
                {effect.attemptCount > 0 ? ` | attempts ${effect.attemptCount}` : ""}
                {effect.lastError ? ` | error ${effect.lastError}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {replay ? (
        <details className="mc-next-approvals-details">
          <summary>
            <History className="h-4 w-4" />
            Replay trail and pending action
          </summary>
          <div className="mc-next-directory-card mc-next-directory-card-compact">
            <ul className="mc-next-approvals-compact-list">
              {replay.events.map((event) => (
                <li key={event.eventId}>
                  <strong>{event.eventType}</strong> by {event.actorId} at {formatDateTime(event.timestamp)}
                </li>
              ))}
            </ul>
            {replay.pendingAction ? <pre>{JSON.stringify(replay.pendingAction, null, 2)}</pre> : null}
          </div>
        </details>
      ) : null}

      <details className="mc-next-approvals-details">
        <summary>Raw request and preview payload</summary>
        <div className="mc-next-directory-card mc-next-directory-card-compact">
          <h3>Raw request payload</h3>
          <pre>{JSON.stringify(approval.payload, null, 2)}</pre>
          <h3>Preview payload</h3>
          <pre>{JSON.stringify(approval.preview, null, 2)}</pre>
        </div>
      </details>
    </div>
  );
}

function buildLiveLaneRoute(approval: ApprovalRequest): AppRoute | null {
  if (!approval.linkage?.sessionId) {
    return null;
  }
  const area =
    approval.linkage.originSurface === "cowork" || approval.linkage.originSurface === "code"
      ? approval.linkage.originSurface
      : "chat";
  return {
    area,
    sessionId: approval.linkage.sessionId,
    turnId: approval.linkage.turnId,
    approvalId: approval.approvalId,
  };
}

function formatDateTime(value?: string): string {
  if (!value) {
    return "Unknown time";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString();
}

function formatApprovalExplanationError(error: string): string {
  const message = error.trim();
  if (!message) {
    return "The approval is still usable. GoatCitadel could not generate the optional plain-English summary.";
  }
  if (/authentication parameter not received|401 unauthorized|unable to authenticate/i.test(message)) {
    return "The approval is still usable, but the optional explainer could not authenticate with the configured model provider.";
  }
  if (/unsupported parameter:\s*temperature/i.test(message)) {
    return "The approval is still usable, but the optional explainer sent a parameter this model provider does not accept.";
  }
  return `The approval is still usable. Explainer detail: ${message}`;
}

function formatApprovalFollowUp(status: NonNullable<ApprovalRequest["followUp"]>["status"]): string {
  switch (status) {
    case "queued":
      return "Accepted, waking worker";
    case "running":
      return "Worker wake running";
    case "completed":
      return "Worker resumed";
    case "skipped":
      return "Wake skipped";
    case "failed":
      return "Wake failed";
  }
  return "Follow-up status unknown";
}

function approvalFollowUpTone(
  status: NonNullable<ApprovalRequest["followUp"]>["status"],
): "critical" | "warning" | "success" | "muted" | "default" {
  switch (status) {
    case "failed":
      return "critical";
    case "queued":
    case "running":
      return "warning";
    case "completed":
      return "success";
    case "skipped":
    case "none":
      return "muted";
  }
  return "muted";
}
