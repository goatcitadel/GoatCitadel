import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { AlertTriangle, Clock, History, Play, RefreshCw, Waypoints } from "lucide-react";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { StatusChip, ThreePartChip } from "../primitives";
import {
  buildApprovalEvidenceModel,
  findTraceMetadata,
  formatInferredIds,
  getCanonicalDurableRunId,
  isExpiredApproval,
} from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { useApprovalQueue } from "@goatcitadel/mission-control-shared/hooks/useApprovalQueue";
import { buildAppHref, type AppRoute } from "@next/app/route-model";
import { NativeCard, NativeGrid, NativePageFrame } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import { ShellExplanationList } from "./ShellExplanationList";
import "../native-routes.css";

const APPROVAL_COUNT_FLASH_MS = 1500;
const APPROVAL_ENTER_MARK_MS = 260;

type ApprovalConfirmation =
  | { kind: "bulk-reject" }
  | { kind: "decision"; approvalId: string; decision: "approve" | "reject" }
  | { kind: "resume"; approvalId: string };

export function ApprovalsRoutePage({ route, activeWorkspaceName, pendingApprovals, navigate }: NativeRoutePagesProps) {
  const [pendingConfirmation, setPendingConfirmation] = useState<ApprovalConfirmation | null>(null);
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
  const displayedPendingCount = approvals.pendingLaneFailed
    ? Math.max(queueCounts.pending, pendingApprovals)
    : (approvals.loading || approvals.error) && queueCounts.pending === 0
      ? pendingApprovals
      : queueCounts.pending;

  const pendingApprovalIds = useMemo(
    () => approvals.pendingItems.map((item) => item.approvalId),
    [approvals.pendingItems],
  );
  const seenPendingIdsRef = useRef<Set<string>>(new Set());
  const previousPendingCountRef = useRef<number>(displayedPendingCount);
  const [newApprovalIds, setNewApprovalIds] = useState<ReadonlySet<string>>(() => new Set());
  const [countFlashKey, setCountFlashKey] = useState<number>(0);
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>("");

  useEffect(() => {
    const previouslySeen = seenPendingIdsRef.current;
    const arrivedIds = pendingApprovalIds.filter((id) => !previouslySeen.has(id));
    // On the first observed snapshot, prime the seen set without animating the
    // initial batch — only true new arrivals after first paint should flash.
    if (previouslySeen.size === 0 && pendingApprovalIds.length > 0) {
      seenPendingIdsRef.current = new Set(pendingApprovalIds);
      return;
    }
    if (arrivedIds.length === 0) {
      // Still update the seen set so removed items can re-trigger if they
      // return later in a separate refresh cycle.
      seenPendingIdsRef.current = new Set(pendingApprovalIds);
      return;
    }
    seenPendingIdsRef.current = new Set(pendingApprovalIds);
    setNewApprovalIds(new Set(arrivedIds));
    const clearTimer = setTimeout(() => {
      setNewApprovalIds(new Set());
    }, APPROVAL_ENTER_MARK_MS);
    return () => clearTimeout(clearTimer);
  }, [pendingApprovalIds]);

  useEffect(() => {
    const previousCount = previousPendingCountRef.current;
    if (displayedPendingCount > previousCount) {
      const arrived = displayedPendingCount - previousCount;
      setCountFlashKey((value) => value + 1);
      setLiveAnnouncement(
        arrived === 1
          ? `1 new approval pending. ${displayedPendingCount} total awaiting decision.`
          : `${arrived} new approvals pending. ${displayedPendingCount} total awaiting decision.`,
      );
    }
    previousPendingCountRef.current = displayedPendingCount;
  }, [displayedPendingCount]);

  useEffect(() => {
    if (countFlashKey === 0) {
      return;
    }
    const handle = setTimeout(() => setCountFlashKey(0), APPROVAL_COUNT_FLASH_MS);
    return () => clearTimeout(handle);
  }, [countFlashKey]);

  const isCountFlashing = countFlashKey > 0;
  const emptyApprovalsLabel =
    approvals.view === "pending" && displayedPendingCount > 0 && approvals.error
      ? "Pending approvals exist, but the queue details could not be loaded."
      : "No approvals in this view.";
  const confirmationCopy = pendingConfirmation ? buildApprovalConfirmationCopy(pendingConfirmation) : null;
  const confirmationPending =
    pendingConfirmation?.kind === "bulk-reject"
      ? approvals.bulkResolvePending
      : pendingConfirmation?.kind === "decision"
        ? approvals.resolvePending
        : pendingConfirmation?.kind === "resume"
          ? Boolean(approvals.durableBusyByApprovalId[pendingConfirmation.approvalId])
          : false;
  const confirmationDanger =
    pendingConfirmation?.kind === "bulk-reject" ||
    (pendingConfirmation?.kind === "decision" && pendingConfirmation.decision === "reject");
  const confirmPendingAction = () => {
    const confirmation = pendingConfirmation;
    if (!confirmation) {
      return;
    }
    const action =
      confirmation.kind === "bulk-reject"
        ? approvals.onRejectAllPending()
        : confirmation.kind === "decision"
          ? approvals.onResolve(confirmation.approvalId, confirmation.decision)
          : approvals.resumeFromCheckpoint(confirmation.approvalId);
    void Promise.resolve(action).finally(() => {
      setPendingConfirmation(null);
    });
  };

  return (
    <>
      <NativePageFrame
        area="ops"
        kicker="Ops · Approvals"
        title="Approvals"
        description="Pending decisions, history, replay, and durable recovery in one operator view."
        loading={approvals.loading && !approvals.error}
        error={approvals.error}
        metrics={[
          { label: "Pending", value: String(displayedPendingCount), flash: isCountFlashing },
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
              onClick={() => setPendingConfirmation({ kind: "bulk-reject" })}
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
              { label: "Pending", value: String(displayedPendingCount) },
              { label: "Workspace", value: activeWorkspaceName },
              { label: "Replay trails", value: String(approvals.replayCount) },
            ]}
          >
            <div className="mc-next-approvals-toolbar">
              <div className="mc-next-approvals-view-switch" role="tablist" aria-label="Approval views">
                <ApprovalViewButton
                  active={approvals.view === "pending"}
                  label={`Pending (${displayedPendingCount})`}
                  onClick={() => approvals.setView("pending")}
                  flash={isCountFlashing}
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
                  onClick={() => setPendingConfirmation({ kind: "bulk-reject" })}
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
            <div
              className="mc-next-approvals-list"
              aria-live="polite"
              aria-relevant="additions"
              aria-atomic="false"
              aria-label={`Approvals queue, ${
                approvals.view === "pending"
                  ? `${displayedPendingCount} pending`
                  : approvals.view === "history"
                    ? `${queueCounts.history} in history`
                    : `${queueCounts.recovery} in recovery`
              }`}
            >
              {approvals.visibleItems.length === 0 ? (
                <p className="mc-next-directory-empty">{emptyApprovalsLabel}</p>
              ) : (
                approvals.visibleItems.map((approval) => {
                  const expired = isExpiredApproval(approval);
                  const effectiveStatus = expired ? "expired" : approval.status;
                  const selected = approval.approvalId === selectedApproval?.approvalId;
                  const isNewArrival = approvals.view === "pending" && newApprovalIds.has(approval.approvalId);
                  return (
                    <button
                      key={approval.approvalId}
                      type="button"
                      className={`mc-next-approvals-list-item${selected ? " is-selected" : ""}`}
                      data-mc-approval-new={isNewArrival ? "true" : undefined}
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
                ? "Replay trail, durable recovery, and runtime linkage in one operator view."
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
                onApprove={() =>
                  setPendingConfirmation({
                    kind: "decision",
                    approvalId: selectedApproval.approvalId,
                    decision: "approve",
                  })
                }
                onReject={() =>
                  setPendingConfirmation({
                    kind: "decision",
                    approvalId: selectedApproval.approvalId,
                    decision: "reject",
                  })
                }
                onReplay={() => void approvals.onReplay(selectedApproval.approvalId)}
                onLoadTracePreview={(correlationId) =>
                  void approvals.loadTracePreview(selectedApproval.approvalId, correlationId)
                }
                onLoadDurableStatus={() => void approvals.loadDurableStatus(selectedApproval.approvalId)}
                onResumeCheckpoint={() =>
                  setPendingConfirmation({ kind: "resume", approvalId: selectedApproval.approvalId })
                }
                onOpenLiveLane={
                  liveLaneRoute
                    ? (event) => {
                        if (!shouldHandleClientNavigation(event)) {
                          return;
                        }
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
        open={Boolean(pendingConfirmation)}
        title={confirmationCopy?.title ?? "Confirm approval action"}
        message={confirmationCopy?.message ?? "Confirm the selected approval action before continuing."}
        confirmLabel={
          confirmationPending
            ? (confirmationCopy?.pendingLabel ?? "Working...")
            : (confirmationCopy?.confirmLabel ?? "Confirm")
        }
        pending={confirmationPending}
        danger={confirmationDanger}
        onCancel={() => setPendingConfirmation(null)}
        onConfirm={confirmPendingAction}
      />
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="mc-next-sr-only"
        data-mc-approval-announcer="true"
      >
        {liveAnnouncement}
      </div>
    </>
  );
}

function buildApprovalConfirmationCopy(confirmation: ApprovalConfirmation): {
  title: string;
  message: string;
  confirmLabel: string;
  pendingLabel: string;
} {
  if (confirmation.kind === "bulk-reject") {
    return {
      title: "Reject all pending approvals?",
      message: "This keeps GoatCitadel paused at every pending checkpoint in the current queue.",
      confirmLabel: "Reject all pending",
      pendingLabel: "Rejecting...",
    };
  }
  if (confirmation.kind === "resume") {
    return {
      title: "Resume paused run?",
      message: "This resumes the durable run linked to the selected approval from its current paused checkpoint.",
      confirmLabel: "Resume run",
      pendingLabel: "Resuming...",
    };
  }
  if (confirmation.decision === "approve") {
    return {
      title: "Approve this request?",
      message: "This resolves the selected approval and lets the linked action or follow-up continue.",
      confirmLabel: "Approve",
      pendingLabel: "Approving...",
    };
  }
  return {
    title: "Reject this request?",
    message: "This rejects the selected approval and keeps the linked action stopped.",
    confirmLabel: "Reject",
    pendingLabel: "Rejecting...",
  };
}

function shouldHandleClientNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  const isPrimaryClick = event.button === undefined || event.button === 0;
  const target = event.currentTarget?.target;
  return (
    isPrimaryClick &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!target || target === "_self")
  );
}

function ApprovalViewButton({
  active,
  label,
  onClick,
  flash = false,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  flash?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`mc-next-approvals-view-button${active ? " is-active" : ""}`}
      data-mc-approval-flash={flash ? "true" : undefined}
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
  const decisionCopy = buildApprovalDecisionCopy(approval, effectiveStatus);
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
  const liveLaneHref = liveLaneRoute ? buildAppHref(liveLaneRoute) : null;

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
          <p className="mc-next-approvals-kicker">{decisionCopy.kicker}</p>
          <h3>{decisionCopy.title}</h3>
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
          {liveLaneHref && onOpenLiveLane ? (
            <a href={liveLaneHref} className="mc-next-approvals-link-button" onClick={onOpenLiveLane}>
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
              disabled={durableBusy || durable?.status !== "paused"}
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
              <p>Canonical and inferred runtime relationships surfaced directly in one operator view.</p>
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

function buildApprovalDecisionCopy(
  approval: ApprovalRequest,
  effectiveStatus: string,
): { kicker: string; title: string } {
  if (effectiveStatus === "pending") {
    return {
      kicker: "Human decision required",
      title: approval.explanation?.summary ?? `Review the ${approval.kind} request before GoatCitadel continues.`,
    };
  }
  if (effectiveStatus === "expired") {
    return {
      kicker: "Approval expired",
      title: approval.explanation?.summary ?? `The ${approval.kind} request expired before a decision was recorded.`,
    };
  }
  if (effectiveStatus === "approved" || effectiveStatus === "rejected") {
    return {
      kicker: "Decision recorded",
      title: approval.explanation?.summary ?? `${capitalizeApprovalStatus(effectiveStatus)} ${approval.kind} request.`,
    };
  }
  return {
    kicker: "Approval state recorded",
    title: approval.explanation?.summary ?? `The ${approval.kind} request is ${effectiveStatus}.`,
  };
}

function capitalizeApprovalStatus(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildLiveLaneRoute(approval: ApprovalRequest): AppRoute | null {
  if (!approval.linkage?.sessionId) {
    return null;
  }
  const codeModeLinked =
    approval.kind === "code_mode.run" ||
    approval.linkage.actionType === "code_mode.run" ||
    approval.linkage.toolName === "code_mode.run";
  const area =
    approval.linkage.originSurface === "cowork" || approval.linkage.originSurface === "code"
      ? approval.linkage.originSurface
      : codeModeLinked
        ? "code"
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
