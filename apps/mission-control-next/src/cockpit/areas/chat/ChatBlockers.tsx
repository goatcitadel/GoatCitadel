import { useChatSpecialistApproval } from "./use-chat-specialist-approval";
import { ChatExpiredApprovalRecovery } from "./ChatExpiredApprovalRecovery";
import { errandScreenshotAttachmentId, useChatApprovalFeedback } from "./use-chat-approval-feedback";
import { RiskBadge } from "../../ui/RiskBadge";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { isBackgroundChatUserInputPrompt, type ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { lazy, useEffect, useRef, useState } from "react";
import { AttachmentImage } from "../../ui/AttachmentImage";
import { ChatApprovalRenderer } from "./ChatApprovalRenderer";
import { ChatAllowanceReceipt } from "./ChatAllowances";
import { approvalExpiryLabel } from "../inbox/approval-preview";
import { useGatewayUnavailable } from "../../app/gateway-unavailable-context";
import { approvalExpiredUnresolved } from "../inbox/approval-settlement";
import { hasExpired, useMinuteClock } from "../inbox/use-minute-clock";
import { useApprovalDeadlineCheck } from "./use-approval-deadline-check";
import { CHANGED_APPROVAL_RECORD } from "../inbox/inbox-approval-guard";
import { DeferredChatLeaf } from "./DeferredChatLeaves";
import { presentApprovalAction } from "./chat-vocabulary";
import { approvalTargetLine } from "../inbox/approval-target";
import { presentApprovalStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { Button } from "../../ui/Button";
import { useReportWaitingDecision } from "./chat-jump-to-latest";
const ChatPendingQuestion = lazy(async () => ({
  default: (await import("./ChatPendingQuestion")).ChatPendingQuestion,
}));

type Blockers = Pick<
  MissionThreadedActiveSessionSurfaceProps,
  | "pendingApproval"
  | "pendingUserInput"
  | "selectedSessionId"
  | "approvalPending"
  | "userInputPending"
  | "onApprovePending"
  | "onDenyPending"
  | "onSubmitUserInput"
  | "onRefreshThread"
> &
  Partial<Pick<MissionThreadedActiveSessionSurfaceProps, "composerRef" | "thread" | "onDraftChange" | "draft">>;

export function ChatBlockers({ props, latestTurn }: { props: Blockers; latestTurn?: ChatThreadTurnRecord }) {
  // The Gateway cannot be reached, so decisions cannot be sent.
  const gatewayUnavailable = useGatewayUnavailable();
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const { search, hash } = useCockpitRoute();
  const pendingApproval = props.pendingApproval;
  const approvalId = pendingApproval?.approvalId;
  const {
    linkedRead,
    readTitle,
    readStatus,
    recordQuery,
    noticeScope,
    notice,
    setReceipt,
    currentChatAccess,
    chatAccessScope,
    otherTabNotice,
    setOtherTabReceipt,
    temporaryGrantNotice,
    setTemporaryGrantReceipt,
    rereview,
    refreshMcpReview,
    setApprovedRead,
  } = useChatApprovalFeedback(workspaceId, props.selectedSessionId, approvalId, latestTurn);
  // CH-18: a decision replaces its buttons. If focus was inside and fell to <body>, move it once to the
  // settlement message, or to the composer when the whole card is gone.
  const focusWithin = useRef(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const composerRef = props.composerRef;
  useEffect(() => {
    if (!focusWithin.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    focusWithin.current = false;
    const composer = composerRef?.current;
    if (noticeRef.current) noticeRef.current.focus({ preventScroll: true });
    else if (composer && !composer.disabled) composer.focus({ preventScroll: true });
  });
  // CH-02: a failed read is an error, not "checking"; a missing record is its own state. Both offer a way forward.
  const recordFailed = recordQuery.isError && !recordQuery.data;
  const reviewedApproval = recordQuery.data?.approvalId === approvalId ? recordQuery.data : undefined;
  // Retained stream signals can omit risk metadata. Hydrate only from the
  // matching pending canonical record; unavailable/settled records stay closed.
  const approval =
    pendingApproval &&
    !pendingApproval.riskLevel &&
    reviewedApproval?.approvalId === pendingApproval.approvalId &&
    reviewedApproval.status === "pending"
      ? {
          ...pendingApproval,
          kind: reviewedApproval.kind,
          riskLevel: reviewedApproval.riskLevel,
          expiresAt: reviewedApproval.expiresAt,
        }
      : pendingApproval;
  // A code_mode.request approval belongs to the Code Mode card in the reply, which asks once with its own wording.
  const ownedByCodeModeCard =
    approval?.kind === "code_mode.request" ||
    approval?.toolName === "code_mode.request" ||
    reviewedApproval?.kind === "code_mode.request";
  const { specialistEvidence, specialistStatus } = useChatSpecialistApproval(workspaceId, reviewedApproval);
  // A browser errand step shows the picture of the page the errand is about to act on, above the decision.
  const errandScreenshotId =
    reviewedApproval?.kind === "browser.errand.action" || approval?.kind === "browser.errand.action"
      ? errandScreenshotAttachmentId(reviewedApproval?.preview)
      : undefined;
  const input = props.pendingUserInput;
  const questionScope = input ? JSON.stringify([workspaceId, props.selectedSessionId, input.promptId]) : "";
  // Skipping hides an optional question on this screen only; the Gateway keeps the prompt and nothing is sent.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const setQuestionSkipped = (skip: boolean) =>
    setSkipped((current) => {
      const next = new Set(current);
      if (skip) next.add(questionScope);
      else next.delete(questionScope);
      return next;
    });
  // The persisted record outranks the retained prompt: once it is decided, the card reports the decision
  // instead of asking for one while Chat waits for the queue to clear it.
  const targetLine = approvalTargetLine(reviewedApproval?.kind, reviewedApproval?.preview);
  const decided = reviewedApproval && reviewedApproval.status !== "pending" ? reviewedApproval : undefined;

  const expiry = decided ? null : approvalExpiryLabel(approval?.expiresAt);
  // An approval that ran out of time leaves the action undone: the way forward is to ask again.
  const expiresAt = reviewedApproval?.expiresAt ?? approval?.expiresAt;
  const now = useMinuteClock(expiresAt);
  // The expiry sweep records an expired approval as a rejection with an expired outcome; it is still expired.
  const sweptExpired = Boolean(
    decided && (decided.resolutionOutcome === "expired" || approvalExpiredUnresolved(decided)),
  );
  const expired = Boolean(approval) && sweptExpired;
  // The deadline passed on this clock but the record still reads pending: the approval may have been decided elsewhere,
  // so nothing says the action did not run until a fresh read of the record does.
  const lapsed = Boolean(approval) && !decided && hasExpired(expiresAt, now);
  // Jump to latest names a decision only while its card offers one: not decided, not past its deadline, not skipped,
  // not owned by the Code Mode card.
  const approvalWaiting = Boolean(approval) && !ownedByCodeModeCard && !decided && !lapsed;
  useReportWaitingDecision(approvalWaiting ? "approval" : input && !skipped.has(questionScope) ? "question" : null);
  const deadlineCheck = useApprovalDeadlineCheck({ approvalId, lapsed, read: () => recordQuery.refetch() });
  function continuationHref(destination: "/inbox", selectedApprovalId?: string) {
    const parameters = new URLSearchParams(search);
    parameters.set("workspaceId", workspaceId);
    if (props.selectedSessionId) parameters.set("sessionId", props.selectedSessionId);
    else parameters.delete("sessionId");
    if (selectedApprovalId) parameters.set("approvalId", selectedApprovalId);
    else parameters.delete("approvalId");
    parameters.delete("shell");
    parameters.delete("shellScope");
    return `${destination}?${parameters}${hash}`;
  }
  return (
    <div
      onFocusCapture={() => {
        focusWithin.current = true;
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focusWithin.current = false;
      }}
    >
      {otherTabNotice ? (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {otherTabNotice}
        </p>
      ) : null}
      {temporaryGrantNotice?.grant && props.selectedSessionId ? (
        <ChatAllowanceReceipt
          key={temporaryGrantNotice.grant.grantId}
          workspaceId={workspaceId}
          sessionId={props.selectedSessionId}
          grant={temporaryGrantNotice.grant}
          message={temporaryGrantNotice.message}
        />
      ) : temporaryGrantNotice ? (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {temporaryGrantNotice.message}
        </p>
      ) : null}
      {readStatus && readTitle ? (
        <section
          aria-label={
            linkedRead?.toolName === "browser.storage.get" ? "Browser storage approval" : `${readTitle} approval`
          }
          className="mt-3 rounded-md border border-line-subtle bg-raised p-3 text-sm"
        >
          <h3 className="font-semibold text-fg">{readTitle}</h3>
          <p ref={noticeRef} role="status" tabIndex={-1} className="mt-1 text-fg-secondary outline-none">
            {readStatus}
          </p>
        </section>
      ) : approval && !ownedByCodeModeCard ? (
        <section
          aria-label={decided ? "Decided approval" : "Pending approval"}
          tabIndex={-1}
          data-chat-waiting-decision={approvalWaiting ? "" : undefined}
          className={`mt-3 rounded-md border bg-raised p-3 text-sm ${decided ? "border-line-subtle" : "border-status-waiting"}`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold text-fg">
                {sweptExpired
                  ? "Approval expired"
                  : decided
                    ? `Approval decided: ${presentApprovalStatus(decided.status).label}`
                    : lapsed
                      ? "Approval time has passed"
                      : "Approval needed"}
              </h3>
              <p className="mt-1 text-fg-secondary">{presentApprovalAction(approval.toolName, approval.kind)}</p>
              {targetLine ? <p className="mt-1 text-xs text-fg-secondary wrap-anywhere">{targetLine}</p> : null}
            </div>
            {approval.riskLevel ? <RiskBadge risk={approval.riskLevel} /> : null}
          </div>
          {approval.reason ? <p className="mt-2 text-fg-secondary">{approval.reason}</p> : null}
          {approval.affectedResources?.length ? (
            <p className="mt-2 text-xs text-fg-secondary">Touches: {approval.affectedResources.join(", ")}</p>
          ) : null}
          {approval.codePreview ? (
            <details className="mt-2 text-xs text-fg-secondary">
              <summary>Code preview</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-sunken p-2">
                {approval.codePreview}
              </pre>
            </details>
          ) : null}
          {expiry ? <p className="mt-2 text-xs text-fg-muted">{expiry}</p> : null}
          {approval.toolName || approval.kind ? (
            <TechnicalDetails label="Action technical details">
              <p className="font-mono text-xs wrap-anywhere">
                {[approval.toolName && `Tool: ${approval.toolName}`, approval.kind && `Kind: ${approval.kind}`]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </TechnicalDetails>
          ) : null}
          {notice ? (
            <p ref={noticeRef} role="status" tabIndex={-1} className="outline-none">
              {notice}
            </p>
          ) : null}
          {rereview && !decided ? (
            <div className="mt-2 space-y-1">
              <p role="alert" className="text-status-failed">
                This MCP action changed. Review the updated action before deciding.
              </p>
              {rereview.phase === "checking" ? (
                <p role="status" className="text-fg-muted">
                  Refreshing the action…
                </p>
              ) : rereview.phase === "failed" && reviewedApproval ? (
                <Button size="sm" onClick={() => void refreshMcpReview()}>
                  Retry refresh
                </Button>
              ) : null}
            </div>
          ) : null}
          {specialistStatus}
          {errandScreenshotId ? (
            <AttachmentImage
              attachmentId={errandScreenshotId}
              alt="The page the browser errand is about to act on"
              className="mt-2 max-h-72 w-auto max-w-full rounded-md border border-line bg-sunken"
            />
          ) : null}
          <ChatApprovalRenderer
            key={rereview?.sequence}
            approvalId={approval.approvalId}
            approval={reviewedApproval}
            workspaceId={workspaceId}
            sessionId={props.selectedSessionId ?? undefined}
            inlineDangerReview
            reviewAgain={Boolean(rereview)}
            withholdApprove={Boolean(
              rereview &&
              (rereview.phase !== "ready" ||
                reviewedApproval?.preview?.reviewKind !== "mcp.operation" ||
                typeof reviewedApproval.preview.requestArguments !== "string" ||
                reviewedApproval.riskLevel !== "danger"),
            )}
            specialistEvidence={specialistEvidence}
            recordPending={recordQuery.isPending && !recordQuery.isError}
            recovery={{
              failed: recordFailed,
              retrying: recordQuery.isFetching,
              onRetry: () => void (rereview ? refreshMcpReview() : recordQuery.refetch()),
              onDeny: props.onDenyPending,
              denying: props.approvalPending,
            }}
            checking={recordQuery.isFetching || props.approvalPending}
            onApproved={() => {
              if (latestTurn && linkedRead?.approvalId === approval.approvalId) {
                setApprovedRead({ workspaceId, turnId: latestTurn.turnId, toolRunId: linkedRead.toolRunId });
              }
            }}
            onTemporaryGrantResolved={(message, grant) => {
              if (!currentChatAccess()) return;
              setTemporaryGrantReceipt({
                scope: chatAccessScope,
                approvalId: approval.approvalId,
                turnId: reviewedApproval?.linkage?.turnId,
                message,
                grant,
              });
              void recordQuery.refetch();
              props.onRefreshThread();
            }}
            conflictRecovery={
              reviewedApproval?.preview?.reviewKind === "mcp.operation" ||
              reviewedApproval?.preview?.reviewKind === "knowledge.operation"
                ? {
                    isCurrent: currentChatAccess,
                    onDecision: (decision, message) => {
                      setOtherTabReceipt({
                        scope: chatAccessScope,
                        approvalId: approval.approvalId,
                        turnId: reviewedApproval.linkage?.turnId ?? latestTurn?.turnId,
                        message,
                      });
                      if (decision === "approve" && latestTurn && linkedRead?.approvalId === approval.approvalId) {
                        setApprovedRead({ workspaceId, turnId: latestTurn.turnId, toolRunId: linkedRead.toolRunId });
                      }
                      void recordQuery.refetch();
                      props.onRefreshThread();
                    },
                  }
                : undefined
            }
            onResolved={(message) => {
              setReceipt({ scope: noticeScope, message });
              void recordQuery.refetch();
              props.onRefreshThread();
            }}
            onInvalidated={(message) => {
              if (
                message === CHANGED_APPROVAL_RECORD &&
                reviewedApproval?.preview?.reviewKind === "mcp.operation" &&
                reviewedApproval.kind.startsWith("mcp.")
              ) {
                void refreshMcpReview();
              } else {
                void recordQuery.refetch();
              }
              props.onRefreshThread();
            }}
            onFollowOnChange={props.onRefreshThread}
            connectionLost={gatewayUnavailable}
          />
          {lapsed ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p>
                {deadlineCheck.checking
                  ? "The time for this approval has passed. Checking whether it was decided…"
                  : "The time for this approval has passed. What happened to it is not confirmed yet."}
              </p>
              {deadlineCheck.checking ? null : (
                <Button type="button" size="sm" variant="secondary" onClick={deadlineCheck.check}>
                  Check again
                </Button>
              )}
            </div>
          ) : null}
          {expired ? <ChatExpiredApprovalRecovery props={props} turnId={reviewedApproval?.linkage?.turnId} /> : null}
          <NativeOwnerLink
            href={continuationHref("/inbox", approval.approvalId)}
            scope={noticeScope}
            className="mt-2 inline-block font-medium text-accent hover:underline"
          >
            Inspect persisted approval
          </NativeOwnerLink>
        </section>
      ) : null}
      {/* CH-N06: blockers only render inside the Chat transcript, so no "open in Chat" link. */}
      {input && skipped.has(questionScope) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
          <p>You skipped “{input.title || "this question"}”. The work goes on without your answer.</p>
          <Button variant="ghost" size="sm" onClick={() => setQuestionSkipped(false)}>
            Show the question again
          </Button>
        </div>
      ) : input ? (
        <DeferredChatLeaf
          key={questionScope}
          identity={questionScope}
          label="Answer controls"
          fallback={
            <section
              aria-label="Pending question"
              tabIndex={-1}
              data-chat-waiting-decision=""
              className="mt-3 border-l-2 border-status-waiting pl-3 text-sm"
            >
              <h3 className="font-semibold text-fg">{input.title || "Your input is needed"}</h3>
              {isBackgroundChatUserInputPrompt(input) ? (
                <p className="mt-1 text-xs text-fg-muted">Optional · Work continues</p>
              ) : null}
              <p className="mt-1 text-fg-secondary">{input.question}</p>
              <p aria-busy="true" className="mt-2 text-xs text-fg-muted">
                Loading answer controls…
              </p>
            </section>
          }
        >
          <ChatPendingQuestion
            prompt={input}
            pending={props.userInputPending}
            onSubmit={props.onSubmitUserInput}
            onSkip={() => setQuestionSkipped(true)}
          />
        </DeferredChatLeaf>
      ) : null}
    </div>
  );
}
