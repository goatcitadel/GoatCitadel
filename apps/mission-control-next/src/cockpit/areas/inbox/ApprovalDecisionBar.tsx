import { useApprovalDecisionFocus } from "./use-approval-decision-focus";
import { useChatAllowanceControls } from "./use-chat-allowance-controls";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import type { SpecialistEvidence } from "./specialist-approval-evidence";
import { specialistEvidenceKey } from "./specialist-approval-key";
import { specialistApprovalCode } from "./load-specialist-approval-code";
import { useDeferredApprovalCode } from "./use-deferred-approval-code";
import { connectorSetupHref } from "../../app/routes";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { scopeDiffers } from "./installation-settings-approval";
import {
  canOfferChatToolGrant,
  canonicalJsonString,
  type ApprovalRequest,
  type ChatToolGrantDuration,
  type OperatorInboxItem,
  type ToolGrantRecord,
} from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { RiskApprovalAction } from "../chat/RiskApprovalAction";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { hasExpired, useMinuteClock } from "./use-minute-clock";
import { approvalReviewRecord, CHANGED_APPROVAL_RECORD, canResolveInboxApproval } from "./inbox-approval-guard";
import { ApprovalDecisionPreview, ApprovalDecisionHelp } from "./ApprovalDecisionPreview";
import { ApprovalReviewSummaryContent } from "./ApprovalReviewSummaryContent";
import { useApprovalReviewEvidence } from "./use-approval-review-evidence";
import { splitApprovalExplanation } from "./approval-preview";
import { approvalDecisionMessage, approvalResolutionLine } from "./approval-settlement";
import { nullWhenMissing } from "./inbox-record-read";
import type { PrepareApprove } from "./prepare-approve";
import {
  beginInboxApprovalAttempt,
  releaseInboxApprovalCheck,
  releaseUncertainInboxApprovalAttempt,
  settleUncertainInboxApprovalAttempt,
  useInboxApprovalAttempt,
} from "./inbox-approval-attempts";

const STILL_PENDING = "The approval is still pending and unchanged. Decide again when ready.";

interface ApprovalDecisionBarProps {
  specialistEvidence?: SpecialistEvidence;
  item?: OperatorInboxItem;
  sessionId?: string;
  approval: ApprovalRequest;
  /**
   * The workspace the approval belongs to. `null` is an approval that belongs to none (a skill change): it is read
   * without a workspace, since a read scoped to one would not find it, and the active workspace stands in everywhere
   * else (the review, the attempt lock, the Inbox it refreshes).
   */
  workspaceId: string | null;
  focusAction?: "approve" | "deny";
  /**
   * The owner record is being re-read in the background. Decisions stay available: every decision re-reads
   * the pending record before dispatch, so a background refetch is not a reason to swallow the click.
   * Owners may keep passing it; it no longer disables the controls.
   */
  checking?: boolean;
  /** The surrounding view already states the expiry (Inbox approval detail), so the review summary leaves it out. */
  expiryShownNearby?: boolean;
  /** A reviewer directly above the decision bar already presents the exact request. */
  summaryShownNearby?: boolean;
  /** An in-row decision: the buttons and their outcome only. The detail panel keeps the full review. */
  compact?: boolean;
  /** Pin the Approve/Deny buttons to the bottom of the scrolling panel so they never need a scroll to reach. */
  stickyDecisions?: boolean;
  /**
   * The approval's full review is already in front of the operator, so a danger-level Approve is one click: the bar
   * sits inside a dialog that is this approval's review (Settings), or in the Inbox inspector, below the full review of
   * a skill change that belongs to no workspace and that the operator asked for themselves.
   */
  reviewedInPlace?: boolean;
  /**
   * The caller is a Settings change dialog, whose change applies to the whole installation. Only an approval that is
   * also the exact install-wide Settings shape (see isInstallationSettingsApproval) is then decided from any selected
   * workspace; it is still read and decided in the workspace it was created in.
   */
  installationSetting?: boolean;
  /** Lets the conversation card open its ordinary danger review without an overlay. */
  inlineDangerReview?: boolean;
  /** The conversation refreshed an MCP action after a stale decision. */
  reviewAgain?: boolean;
  /** Wording for the one-click approve button, when the action has its own ("Run it"). */
  approveLabel?: string;
  /** Styles the approve button as a danger action with a shield. */
  approveDanger?: boolean;
  /** Leaves out the approve button, so only Deny is offered (the action cannot run here). */
  withholdApprove?: boolean;
  /**
   * Runs after the record is re-read and before the approval is sent (see PrepareApprove). If it throws, nothing is
   * approved and the error is shown beside the buttons. It may change things the operator asked for, so a click it
   * outlives (the review remounted for a changed record) goes to `onInvalidated`, never silence.
   */
  prepareApprove?: PrepareApprove;
  onResolved: (message: string) => void;
  onApproved?: () => void;
  onTemporaryGrantResolved?: (message: string, grant?: ToolGrantRecord) => void;
  /** Chat owns this receipt so it can outlive the pending review when another tab settles it. */
  conflictRecovery?: {
    isCurrent: () => boolean;
    onDecision: (decision: "approve" | "reject", message: string) => void;
  };
  /**
   * The click was not sent. `message` says why when it is not that the record changed, and `line` is that message as
   * the bar shows it, with the link to its next step when there is one.
   */
  onInvalidated: (message?: string, line?: ReactNode) => void;
}

export function ApprovalDecisionBar(props: ApprovalDecisionBarProps) {
  const { activeWorkspaceId } = useUiPreferences();
  const scope = activeWorkspaceId ?? "default";
  const access = useProjectAccess(scope);
  const detached = props.workspaceId === null;
  return (
    <ApprovalDecisionReview
      key={canonicalJsonString([
        props.item,
        approvalReviewRecord(props.approval),
        props.workspaceId,
        scope,
        props.sessionId,
        access.identity,
        props.specialistEvidence ? specialistEvidenceKey(props.specialistEvidence) : undefined,
      ])}
      {...props}
      // A detached approval is shown in the active workspace: the scope check below then follows only the session,
      // and the review remounts (by its key) when the active workspace changes.
      workspaceId={props.workspaceId ?? scope}
      detached={detached}
      activeWorkspaceId={scope}
    />
  );
}

type ApprovalDecisionReviewProps = Omit<ApprovalDecisionBarProps, "workspaceId"> & {
  workspaceId: string;
  /** The approval belongs to no workspace, so it is re-read without one. */
  detached: boolean;
  activeWorkspaceId: string;
};

function ApprovalDecisionReview({
  item,
  specialistEvidence,
  sessionId,
  approval,
  workspaceId,
  focusAction,
  expiryShownNearby = false,
  summaryShownNearby = false,
  compact = false,
  stickyDecisions = false,
  reviewedInPlace = false,
  installationSetting = false,
  inlineDangerReview = false,
  reviewAgain = false,
  approveLabel,
  approveDanger = false,
  withholdApprove = false,
  prepareApprove,
  onResolved,
  onApproved,
  onTemporaryGrantResolved,
  conflictRecovery,
  onInvalidated,
  detached,
  activeWorkspaceId,
}: ApprovalDecisionReviewProps) {
  const access = useProjectAccess(workspaceId);
  const queryClient = useQueryClient();
  const attempt = useInboxApprovalAttempt(workspaceId, approval.approvalId);
  const [error, setError] = useState<ReactNode>("");
  const [notice, setNotice] = useState("");
  const [rechecking, setRechecking] = useState(false);
  const current = useRef(true);
  // The selected-workspace comparison is the one check an install-wide Settings approval skips; the rest still apply.
  const scopeChanged =
    scopeDiffers(installationSetting, approval, activeWorkspaceId, workspaceId) ||
    Boolean(sessionId && approval.linkage?.sessionId && sessionId !== approval.linkage.sessionId);
  const specialist = useDeferredApprovalCode(specialistApprovalCode, Boolean(specialistEvidence));
  const specialistReady = Boolean(
    specialistEvidence && specialist.code?.specialistEvidenceMatches(approval, specialistEvidence),
  );
  const review = useApprovalReviewEvidence(approval);
  const hasPreview = Boolean(review.evidence) || specialistReady;
  const offerTemporaryGrant = Boolean(
    onTemporaryGrantResolved &&
    sessionId &&
    hasPreview &&
    !withholdApprove &&
    canOfferChatToolGrant(approval, sessionId, workspaceId),
  );
  const specializedReview =
    Boolean(approval.mcpElicitation) || ["remote_worker.native_runtime", "code_mode.run"].includes(approval.kind);
  // One shared minute clock plus a single re-render at the expiry moment, instead of a per-second re-render (IN-05).
  const expired = hasExpired(approval.expiresAt, useMinuteClock(approval.expiresAt));
  useLayoutEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const { approveRef, denyRef } = useApprovalDecisionFocus(
    focusAction,
    approval.approvalId,
    hasPreview,
    specialistReady,
  );

  /** The current record, read where it lives: in its workspace, or unscoped for a detached approval. */
  function readCurrent() {
    return nullWhenMissing(fetchApproval(approval.approvalId, detached ? {} : { workspaceId }));
  }

  function invalidateOwnerReads() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
    void queryClient.invalidateQueries({
      queryKey: ["approvals", "record", detached ? null : workspaceId, approval.approvalId],
    });
    void queryClient.invalidateQueries({ queryKey: ["approval-settlement", workspaceId, approval.approvalId] });
  }

  async function decide(decision: "approve" | "reject", duration?: ChatToolGrantDuration) {
    if (
      !current.current ||
      !access.current() ||
      (!hasPreview && decision !== "reject") ||
      scopeChanged ||
      (duration && (!offerTemporaryGrant || decision !== "approve" || !sessionId)) ||
      !canResolveInboxApproval(
        item,
        approval,
        approval,
        workspaceId,
        Date.now(),
        specialistReady || decision === "reject",
      )
    )
      return;
    const token = beginInboxApprovalAttempt(workspaceId, approval.approvalId);
    if (!token) return;
    setError("");
    setNotice("");
    let result: Awaited<ReturnType<typeof import("./submit-inbox-approval").submitInboxApproval>>;
    try {
      const { submitInboxApproval } = await import("./submit-inbox-approval");
      result = await submitInboxApproval({
        approval,
        decision,
        workspaceId,
        item,
        token,
        specializedReview,
        specialistReady,
        specialistEvidence,
        specialistCode: specialist.code,
        prepareApprove,
        readCurrent,
        isCurrent: () => current.current && access.current(),
        canRecoverConflict: conflictRecovery?.isCurrent,
        temporaryGrant: duration && sessionId ? { sessionId, duration } : undefined,
        onError: setError,
        onInvalidated,
      });
    } catch (cause) {
      if (current.current && access.current()) {
        setError(`Could not check the current approval. ${describeApiError(cause).summary}`);
      }
    } finally {
      releaseInboxApprovalCheck(workspaceId, approval.approvalId, token);
    }
    if (result) {
      if (result.decisionElsewhere) {
        if (conflictRecovery?.isCurrent()) conflictRecovery.onDecision(result.decisionElsewhere, result.message);
      } else {
        if (decision === "approve" && access.current()) onApproved?.();
        if (duration) onTemporaryGrantResolved?.(result.message, result.grant);
        else if (current.current) onResolved(result.message);
      }
      invalidateOwnerReads();
    }
  }

  /**
   * After an uncertain outcome, read the owner record again. Still pending means the earlier dispatch did not
   * settle it, so the lock is released (an unchanged record can be decided again; a changed one goes back to
   * review). A settled record keeps the lock and shows the Gateway's recorded outcome. Nothing is dispatched.
   */
  async function checkAgain() {
    if (!current.current || !access.current() || attempt?.phase !== "uncertain" || rechecking) return;
    setRechecking(true);
    setError("");
    setNotice("");
    try {
      const latest = await readCurrent();
      if (!current.current || !access.current()) return;
      if (latest?.status === "pending") {
        releaseUncertainInboxApprovalAttempt(workspaceId, approval.approvalId);
        if (canResolveInboxApproval(item, approval, latest, workspaceId, Date.now(), true)) {
          setNotice(STILL_PENDING);
        } else {
          setError(CHANGED_APPROVAL_RECORD);
          onInvalidated();
        }
        return;
      }
      if (latest) {
        settleUncertainInboxApprovalAttempt(workspaceId, approval.approvalId, approvalDecisionMessage(latest));
        invalidateOwnerReads();
        return;
      }
      setError(CHANGED_APPROVAL_RECORD);
      onInvalidated();
    } catch (cause) {
      if (current.current) setError(`Could not check the current approval. ${describeApiError(cause).summary}`);
    } finally {
      if (current.current) setRechecking(false);
    }
  }

  const allowance = useChatAllowanceControls(
    offerTemporaryGrant,
    Boolean(attempt),
    (duration) => void decide("approve", duration),
  );
  if (scopeChanged)
    return (
      <p role="alert" className="text-fg-secondary">
        The selected workspace changed. Open this item again in the current Inbox.
      </p>
    );
  if (approval.status !== "pending") {
    const resolution = approvalResolutionLine(approval);
    return (
      <section aria-label="Recorded approval decision" className="space-y-2">
        <ApprovalReviewSummaryContent
          approval={approval}
          workspaceId={workspaceId}
          evidence={review.evidence}
          showExpiry={!expiryShownNearby}
        />
        <p role="status">{approvalDecisionMessage(approval)}</p>
        {resolution ? <p className="text-fg-secondary">{resolution}</p> : null}
      </section>
    );
  }
  if (approval.mcpElicitation)
    return (
      <>
        <ApprovalReviewSummaryContent
          approval={approval}
          workspaceId={workspaceId}
          evidence={review.evidence}
          showExpiry={!expiryShownNearby}
        />
        <p className="text-fg-muted">
          This request carries an MCP server question, which can&apos;t be decided here. Pending MCP server requests are
          listed in Capabilities › Connectors › Advanced setup.{" "}
          <NativeOwnerLink
            href={connectorSetupHref("mcp")}
            scope={[workspaceId, approval.approvalId]}
            className="font-medium text-accent hover:underline"
          >
            Open MCP servers
          </NativeOwnerLink>
        </p>
      </>
    );
  if (expired)
    return (
      // The surrounding detail or card shows the Expired badge; the bar says only what it means (IN-R04).
      <p className="text-fg-muted">This approval has expired and can no longer be decided.</p>
    );
  // Without the exact action preview nothing can be approved, but denying withholds the action, so Deny stays.
  const canApprove = (hasPreview || specializedReview) && !withholdApprove;
  const reviewInCard =
    inlineDangerReview && approval.riskLevel === "danger" && !specializedReview && !reviewedInPlace && canApprove;

  return (
    <div className="space-y-2 border-t border-line-subtle pt-3">
      <ApprovalDecisionPreview
        approval={approval}
        workspaceId={workspaceId}
        review={review}
        loading={specialist.loading}
        unavailable={specialist.unavailable}
        showSummary={!compact && !reviewInCard && !summaryShownNearby}
        hasPreview={hasPreview || specializedReview}
        showExpiry={!expiryShownNearby}
      />
      <div
        role="group"
        aria-label="Approval decisions"
        className={
          stickyDecisions
            ? "sticky bottom-0 z-10 flex flex-wrap gap-2 border-t border-line-subtle bg-raised py-2"
            : "flex flex-wrap gap-2"
        }
      >
        {canApprove ? (
          <div ref={approveRef} className={reviewInCard ? "contents" : "inline-flex"}>
            <RiskApprovalAction
              workspaceId={workspaceId}
              approval={{
                approvalId: approval.approvalId,
                kind: approval.kind,
                riskLevel: approval.riskLevel,
                toolName: approval.linkage?.toolName,
                // A model-written explanation is advisory; the review summary labels it instead (#499).
                reason: splitApprovalExplanation(approval).owner?.riskExplanation,
                expiresAt: approval.expiresAt,
              }}
              reviewedApproval={approval}
              reviewEvidence={review.evidence}
              specialistReview={
                specialistReady && specialistEvidence && specialist.code ? (
                  <specialist.code.SpecialistApprovalReview approval={approval} evidence={specialistEvidence} />
                ) : undefined
              }
              pending={Boolean(attempt) || (specializedReview && !specialistReady)}
              reviewedInPlace={reviewedInPlace}
              inlineDangerReview={reviewInCard}
              reviewLabel={reviewAgain ? "Review again" : undefined}
              approveLabel={approveLabel}
              approveDanger={approveDanger}
              onApprove={() => void decide("approve")}
            />
          </div>
        ) : null}
        <Button ref={denyRef} type="button" size="sm" disabled={Boolean(attempt)} onClick={() => void decide("reject")}>
          Deny
        </Button>
        {allowance.trigger}
      </div>
      {allowance.panel}
      {attempt || notice ? (
        <p role={attempt?.phase === "uncertain" ? "alert" : "status"} className="text-fg-muted">
          {attempt?.message ?? notice}
        </p>
      ) : null}
      {attempt?.phase === "uncertain" ? (
        <Button type="button" size="sm" disabled={rechecking} onClick={() => void checkAgain()}>
          Check again
        </Button>
      ) : null}
      {error && !(reviewAgain && error === CHANGED_APPROVAL_RECORD) ? (
        <p role="alert" className="text-status-failed">
          {error}
        </p>
      ) : null}
      {compact ? null : <ApprovalDecisionHelp />}
    </div>
  );
}
