import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import type { SpecialistEvidence } from "./specialist-approval-evidence";
import { specialistEvidenceKey } from "./specialist-approval-key";
import { specialistApprovalCode } from "./load-specialist-approval-code";
import { useDeferredApprovalCode } from "./use-deferred-approval-code";
import { connectorSetupHref } from "../../app/routes";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalJsonString, type ApprovalRequest, type OperatorInboxItem } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { RiskApprovalAction } from "../chat/RiskApprovalAction";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { hasExpired, useMinuteClock } from "./use-minute-clock";
import { CHANGED_APPROVAL_RECORD, canResolveInboxApproval } from "./inbox-approval-guard";
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
        props.approval,
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
  compact = false,
  stickyDecisions = false,
  reviewedInPlace = false,
  approveLabel,
  approveDanger = false,
  withholdApprove = false,
  prepareApprove,
  onResolved,
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
  const approveRef = useRef<HTMLSpanElement>(null);
  const approveFocus = useRef<{ origin: Element | null; cancel: () => void } | null>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const sessionChanged = Boolean(sessionId && approval.linkage?.sessionId && sessionId !== approval.linkage.sessionId);
  const scopeChanged = (activeWorkspaceId ?? "default") !== workspaceId || sessionChanged;
  const specialist = useDeferredApprovalCode(specialistApprovalCode, Boolean(specialistEvidence));
  const specialistCode = specialist.code;
  const specialistReady = Boolean(
    specialistEvidence && specialistCode?.specialistEvidenceMatches(approval, specialistEvidence),
  );
  const review = useApprovalReviewEvidence(approval);
  const hasPreview = Boolean(review.evidence) || specialistReady;
  const specializedReview =
    Boolean(approval.mcpElicitation) ||
    approval.kind === "remote_worker.native_runtime" ||
    approval.kind === "code_mode.run";
  // One shared minute clock plus a single re-render at the expiry moment, instead of a per-second re-render (IN-05).
  const now = useMinuteClock(approval.expiresAt);
  const expired = hasExpired(approval.expiresAt, now);
  useLayoutEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  useEffect(() => {
    if (focusAction !== "approve") return;
    const origin = document.activeElement;
    const cancel = () => {
      approveFocus.current = null;
      document.removeEventListener("focusin", onFocus);
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target !== origin) cancel();
    };
    // An explicit keyboard request can outlive a cold preview. Moving focus gives it up.
    approveFocus.current = { origin, cancel };
    document.addEventListener("focusin", onFocus);
    return cancel;
  }, [focusAction, approval.approvalId]);
  useEffect(() => {
    const request = approveFocus.current;
    if (!request || !hasPreview) return;
    if (document.activeElement !== request.origin || request.origin === denyRef.current) {
      request.cancel();
      return;
    }
    const button = approveRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (!button) return;
    request.cancel();
    button.focus();
  }, [focusAction, approval.approvalId, hasPreview, specialistReady]);
  useEffect(() => {
    if (focusAction === "deny") denyRef.current?.focus();
  }, [focusAction, approval.approvalId]);

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

  async function decide(decision: "approve" | "reject") {
    if (
      !current.current ||
      !access.current() ||
      (!hasPreview && decision !== "reject") ||
      scopeChanged ||
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
    let resolvedMessage: string | undefined;
    try {
      const { submitInboxApproval } = await import("./submit-inbox-approval");
      resolvedMessage = await submitInboxApproval({
        approval,
        decision,
        workspaceId,
        item,
        token,
        specializedReview,
        specialistReady,
        specialistEvidence,
        specialistCode,
        prepareApprove,
        readCurrent,
        isCurrent: () => current.current && access.current(),
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
    if (resolvedMessage) {
      if (current.current) onResolved(resolvedMessage);
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

  return (
    <div className="space-y-2 border-t border-line-subtle pt-3">
      {review.loading || specialist.loading ? (
        <p role="status">Loading the exact approval preview…</p>
      ) : review.unavailable || specialist.unavailable ? (
        <p role="alert">The approval preview could not load. Reopen the review or use Deny.</p>
      ) : hasPreview || specializedReview ? (
        compact ? null : (
          <ApprovalReviewSummaryContent
            approval={approval}
            workspaceId={workspaceId}
            evidence={review.evidence}
            showExpiry={!expiryShownNearby}
          />
        )
      ) : (
        <p role="alert">
          The exact action preview is unavailable, so this approval can&apos;t be approved. You can still deny it.
        </p>
      )}
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
          <span ref={approveRef} className="inline-flex">
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
                specialistReady && specialistEvidence && specialistCode ? (
                  <specialistCode.SpecialistApprovalReview approval={approval} evidence={specialistEvidence} />
                ) : undefined
              }
              pending={Boolean(attempt) || (specializedReview && !specialistReady)}
              reviewedInPlace={reviewedInPlace}
              approveLabel={approveLabel}
              approveDanger={approveDanger}
              onApprove={() => void decide("approve")}
            />
          </span>
        ) : null}
        <Button ref={denyRef} type="button" size="sm" disabled={Boolean(attempt)} onClick={() => void decide("reject")}>
          Deny
        </Button>
      </div>
      {attempt ? (
        <p role={attempt.phase === "uncertain" ? "alert" : "status"} className="text-fg-muted">
          {attempt.message}
        </p>
      ) : null}
      {attempt?.phase === "uncertain" ? (
        <Button type="button" size="sm" disabled={rechecking} onClick={() => void checkAgain()}>
          Check again
        </Button>
      ) : null}
      {notice ? (
        <p role="status" className="text-fg-muted">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-status-failed">
          {error}
        </p>
      ) : null}
      {compact ? null : (
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer font-medium text-fg-secondary">How this decision works</summary>
          <div className="mt-1 space-y-1">
            <p>
              The current pending record is checked again before either decision. Approval alone does not prove the
              action ran.
            </p>
            <p>
              To change this request, open its source and submit a new request. Editing an approval withdraws the
              original action; it does not authorize a replacement. Project-wide always-allow is unavailable here.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}
