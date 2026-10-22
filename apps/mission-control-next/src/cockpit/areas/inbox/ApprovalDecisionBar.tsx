import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import {
  readSpecialistEvidence,
  specialistEvidenceMatches,
  specialistEvidenceKey,
  type SpecialistEvidence,
} from "./specialist-approval-evidence";
import { SpecialistApprovalReview } from "./SpecialistApprovalReview";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalJsonString, type ApprovalRequest, type OperatorInboxItem } from "@goatcitadel/contracts";
import { resolveApproval } from "@goatcitadel/mission-control-shared/api/client";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { RiskApprovalAction } from "../chat/RiskApprovalAction";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { StatusBadge } from "../../ui/StatusBadge";
import { presentApprovalOutcome } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useMinuteClock } from "./use-minute-clock";
import { canResolveInboxApproval, matchesInboxApprovalDecision } from "./inbox-approval-guard";
import { buildApprovalRequestReviewEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { ApprovalReviewSummary } from "./ApprovalReviewSummary";
import { approvalDecisionMessage, approvalResolutionLine } from "./approval-settlement";
import { nullWhenMissing } from "./inbox-record-read";
import {
  beginInboxApprovalAttempt,
  releaseInboxApprovalCheck,
  releaseUncertainInboxApprovalAttempt,
  settleUncertainInboxApprovalAttempt,
  updateInboxApprovalAttempt,
  useInboxApprovalAttempt,
} from "./inbox-approval-attempts";

const CHANGED_RECORD =
  "This approval changed or is no longer in the current pending queue. Refresh it before deciding.";
const STILL_PENDING = "The approval is still pending and unchanged. Decide again when ready.";

interface ApprovalDecisionBarProps {
  specialistEvidence?: SpecialistEvidence;
  item?: OperatorInboxItem;
  sessionId?: string;
  approval: ApprovalRequest;
  workspaceId: string;
  focusAction?: "approve" | "deny";
  /**
   * The owner record is being re-read in the background. Decisions stay available: every decision re-reads
   * the pending record before dispatch, so a background refetch is not a reason to swallow the click.
   * Owners may keep passing it; it no longer disables the controls.
   */
  checking?: boolean;
  onResolved: (message: string) => void;
  onInvalidated: (message?: string) => void;
}

export function ApprovalDecisionBar(props: ApprovalDecisionBarProps) {
  const { activeWorkspaceId } = useUiPreferences();
  const scope = activeWorkspaceId ?? "default";
  const access = useProjectAccess(scope);
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
      activeWorkspaceId={scope}
    />
  );
}

function ApprovalDecisionReview({
  item,
  specialistEvidence,
  sessionId,
  approval,
  workspaceId,
  focusAction,
  onResolved,
  onInvalidated,
  activeWorkspaceId,
}: ApprovalDecisionBarProps & { activeWorkspaceId: string }) {
  const access = useProjectAccess(workspaceId);
  const queryClient = useQueryClient();
  const attempt = useInboxApprovalAttempt(workspaceId, approval.approvalId);
  const pending = attempt?.phase === "checking" || attempt?.phase === "submitted";
  const [denyOpen, setDenyOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rechecking, setRechecking] = useState(false);
  const current = useRef(true);
  const approveRef = useRef<HTMLSpanElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const sessionChanged = Boolean(sessionId && approval.linkage?.sessionId && sessionId !== approval.linkage.sessionId);
  const scopeChanged = (activeWorkspaceId ?? "default") !== workspaceId || sessionChanged;
  const specialistReady = Boolean(specialistEvidence && specialistEvidenceMatches(approval, specialistEvidence));
  const hasPreview = Boolean(buildApprovalRequestReviewEvidenceModel(approval)) || specialistReady;
  const specializedReview =
    Boolean(approval.mcpElicitation) ||
    approval.kind === "remote_worker.native_runtime" ||
    approval.kind === "code_mode.run";
  // One shared minute clock plus a single re-render at the expiry moment, instead of a per-second re-render (IN-05).
  const now = useMinuteClock(approval.expiresAt);
  const expired = Boolean(approval.expiresAt && !(Date.parse(approval.expiresAt) > now));
  useLayoutEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  useEffect(() => {
    if (focusAction === "approve")
      approveRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    if (focusAction === "deny") denyRef.current?.focus();
  }, [focusAction, approval.approvalId]);

  function invalidateOwnerReads() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: ["approvals", "record", workspaceId, approval.approvalId] });
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
    let mutationAttempted = false;
    let resolvedMessage: string | undefined;
    try {
      const latest = await nullWhenMissing(fetchApproval(approval.approvalId, { workspaceId }));
      // A different selection, workspace, or reviewed record unmounts this review.
      // Cancel before dispatch; after dispatch retain the original action's outcome.
      if (!current.current || !access.current()) return;
      const record = latest ?? undefined;
      if (
        !canResolveInboxApproval(
          item,
          approval,
          record,
          workspaceId,
          Date.now(),
          specialistReady || decision === "reject",
        )
      ) {
        setError(CHANGED_RECORD);
        onInvalidated();
        return;
      }
      if (specializedReview && decision === "approve") {
        const fresh = await readSpecialistEvidence(approval);
        if (!current.current || !access.current()) return;
        if (
          !canResolveInboxApproval(item, approval, record, workspaceId, Date.now(), true) ||
          !specialistEvidence ||
          !specialistEvidenceMatches(approval, fresh) ||
          specialistEvidenceKey(fresh) !== specialistEvidenceKey(specialistEvidence)
        ) {
          setError("Specialist review changed. Refresh and review the current target before approving.");
          onInvalidated("Specialist review changed. Refresh and review the current target before approving.");
          return;
        }
      }
      updateInboxApprovalAttempt(
        workspaceId,
        approval.approvalId,
        token,
        "submitted",
        "Recording the approval decision…",
      );
      mutationAttempted = true;
      const result = await resolveApproval(approval.approvalId, decision);
      if (!matchesInboxApprovalDecision(item, approval, result.approval, workspaceId, decision)) {
        throw new Error("The returned record does not confirm this approval and decision.");
      }
      const message = approvalDecisionMessage(result.approval, result.effects);
      updateInboxApprovalAttempt(workspaceId, approval.approvalId, token, "resolved", message);
      resolvedMessage = message;
    } catch (cause) {
      if (mutationAttempted) {
        updateInboxApprovalAttempt(
          workspaceId,
          approval.approvalId,
          token,
          "uncertain",
          "Decision outcome is uncertain. Check again to read the current record before taking another action.",
        );
        if (current.current) setDenyOpen(false);
      } else if (current.current) {
        setError(`Could not check the current approval. ${describeApiError(cause).summary}`);
      }
    } finally {
      releaseInboxApprovalCheck(workspaceId, approval.approvalId, token);
    }
    if (resolvedMessage) {
      if (current.current) {
        setDenyOpen(false);
        onResolved(resolvedMessage);
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
      const latest = await nullWhenMissing(fetchApproval(approval.approvalId, { workspaceId }));
      if (!current.current || !access.current()) return;
      if (latest?.status === "pending") {
        releaseUncertainInboxApprovalAttempt(workspaceId, approval.approvalId);
        if (canResolveInboxApproval(item, approval, latest, workspaceId, Date.now(), true)) {
          setNotice(STILL_PENDING);
        } else {
          setError(CHANGED_RECORD);
          onInvalidated();
        }
        return;
      }
      if (latest) {
        settleUncertainInboxApprovalAttempt(workspaceId, approval.approvalId, approvalDecisionMessage(latest));
        invalidateOwnerReads();
        return;
      }
      setError(CHANGED_RECORD);
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
        <ApprovalReviewSummary approval={approval} workspaceId={workspaceId} />
        <p role="status">{approvalDecisionMessage(approval)}</p>
        {resolution ? <p className="text-fg-secondary">{resolution}</p> : null}
      </section>
    );
  }
  if (approval.mcpElicitation)
    return (
      <>
        <ApprovalReviewSummary approval={approval} workspaceId={workspaceId} />
        <p className="text-fg-muted">
          This request carries an MCP server question, which can&apos;t be decided here. Pending MCP server requests are
          listed in Settings.{" "}
          <NativeOwnerLink
            href="/settings/mcp"
            scope={[workspaceId, approval.approvalId]}
            className="font-medium text-accent hover:underline"
          >
            Open MCP servers
          </NativeOwnerLink>
        </p>
      </>
    );
  if (!hasPreview && !specializedReview)
    return <p role="alert">The exact action preview is unavailable, so this approval can&apos;t be decided yet.</p>;
  if (expired)
    return (
      <div className="space-y-2">
        <StatusBadge status={presentApprovalOutcome("expired")} />
        <p className="text-fg-muted">This approval has expired and can no longer be decided.</p>
      </div>
    );

  return (
    <div className="space-y-2 border-t border-line-subtle pt-3">
      <ApprovalReviewSummary approval={approval} workspaceId={workspaceId} />
      <div aria-label="Approval decisions" className="flex flex-wrap gap-2">
        <span ref={approveRef} className="inline-flex">
          <RiskApprovalAction
            workspaceId={workspaceId}
            approval={{
              approvalId: approval.approvalId,
              kind: approval.kind,
              riskLevel: approval.riskLevel,
              toolName: approval.linkage?.toolName,
              reason: approval.explanation?.riskExplanation,
              expiresAt: approval.expiresAt,
            }}
            reviewedApproval={approval}
            specialistReview={
              specialistReady && specialistEvidence ? (
                <SpecialistApprovalReview approval={approval} evidence={specialistEvidence} />
              ) : undefined
            }
            pending={Boolean(attempt) || (specializedReview && !specialistReady)}
            onApprove={() => void decide("approve")}
          />
        </span>
        <Button ref={denyRef} type="button" size="sm" disabled={Boolean(attempt)} onClick={() => setDenyOpen(true)}>
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
      <details className="text-xs text-fg-muted">
        <summary className="cursor-pointer font-medium text-fg-secondary">How this decision works</summary>
        <div className="mt-1 space-y-1">
          <p>
            The current pending record is checked again before either decision. Approval alone does not prove the action
            ran.
          </p>
          <p>
            To change this request, open its source and submit a new request. Editing an approval withdraws the original
            action; it does not authorize a replacement. Project-wide always-allow is unavailable here.
          </p>
        </div>
      </details>
      <Dialog
        open={denyOpen}
        onOpenChange={setDenyOpen}
        title="Deny this approval"
        description="The pending action will not be authorized by this decision."
      >
        <div className="flex gap-2">
          <Button variant="primary" disabled={Boolean(attempt)} onClick={() => void decide("reject")}>
            Confirm deny
          </Button>
          <Button disabled={pending} onClick={() => setDenyOpen(false)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
