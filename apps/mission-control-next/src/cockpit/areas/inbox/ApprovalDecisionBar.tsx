import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { readSpecialistEvidence, specialistEvidenceMatches, specialistEvidenceKey, type SpecialistEvidence } from "./specialist-approval-evidence";
import { SpecialistApprovalReview } from "./SpecialistApprovalReview";
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
import { canResolveInboxApproval, matchesInboxApprovalDecision } from "./inbox-approval-guard";
import { buildApprovalRequestReviewEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { ApprovalReviewSummary } from "./ApprovalReviewSummary";
import { approvalDecisionMessage } from "./approval-settlement";
import { nullWhenMissing } from "./inbox-record-read";
import {
  beginInboxApprovalAttempt,
  releaseInboxApprovalCheck,
  updateInboxApprovalAttempt,
  useInboxApprovalAttempt,
} from "./inbox-approval-attempts";

interface ApprovalDecisionBarProps {
  specialistEvidence?: SpecialistEvidence;
  item?: OperatorInboxItem;
  sessionId?: string;
  approval: ApprovalRequest;
  workspaceId: string;
  focusAction?: "approve" | "deny";
  /** The record is being checked again: keep the controls (and any open dialog) but disable them. */
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
      key={canonicalJsonString([props.item, props.approval, props.workspaceId, scope, props.sessionId, access.identity, props.specialistEvidence ? specialistEvidenceKey(props.specialistEvidence) : undefined])}
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
  checking = false,
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
  const [, tick] = useState(0);
  useEffect(() => {
    if (!approval.expiresAt) return;
    const timer = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [approval.expiresAt]);
  const expired = Boolean(approval.expiresAt && !(Date.parse(approval.expiresAt) > Date.now()));
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

  async function decide(decision: "approve" | "reject") {
    if (
      !current.current || !access.current() ||
      checking ||
      (!hasPreview && decision !== "reject") ||
      scopeChanged ||
      !canResolveInboxApproval(item, approval, approval, workspaceId, Date.now(), specialistReady || decision === "reject")
    )
      return;
    const token = beginInboxApprovalAttempt(workspaceId, approval.approvalId);
    if (!token) return;
    setError("");
    let mutationAttempted = false;
    let resolvedMessage: string | undefined;
    try {
      const latest = await nullWhenMissing(fetchApproval(approval.approvalId, { workspaceId }));
      // A different selection, workspace, or reviewed record unmounts this review.
      // Cancel before dispatch; after dispatch retain the original action's outcome.
      if (!current.current || !access.current()) return;
      const record = latest ?? undefined;
      if (!canResolveInboxApproval(item, approval, record, workspaceId, Date.now(), specialistReady || decision === "reject")) {
        setError("This approval changed or is no longer in the current pending queue. Refresh it before deciding.");
        onInvalidated();
        return;
      }
      if (specializedReview && decision === "approve") {
        const fresh = await readSpecialistEvidence(approval);
        if (!current.current || !access.current()) return;
        if (!canResolveInboxApproval(item, approval, record, workspaceId, Date.now(), true) || !specialistEvidence || !specialistEvidenceMatches(approval, fresh) || specialistEvidenceKey(fresh) !== specialistEvidenceKey(specialistEvidence)) {
          setError("Specialist evidence changed. Refresh and review the current target before approving.");
          onInvalidated("Specialist evidence changed. Refresh and review the current target before approving."); return;
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
          "Decision outcome is uncertain. Open Approvals to inspect the current record before taking another action.",
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: ["approvals", "record", workspaceId, approval.approvalId] });
      void queryClient.invalidateQueries({ queryKey: ["approval-settlement", workspaceId, approval.approvalId] });
    }
  }

  if (scopeChanged)
    return (
      <p role="alert" className="text-fg-secondary">
        The selected workspace changed. Open this item again in the current Inbox.
      </p>
    );
  if (approval.status !== "pending")
    return (
      <section aria-label="Recorded approval decision" className="space-y-2">
        <ApprovalReviewSummary approval={approval} workspaceId={workspaceId} />
        <p role="status">{approvalDecisionMessage(approval)}</p>
      </section>
    );
  if (approval.mcpElicitation)
    return (
      <>
        <ApprovalReviewSummary approval={approval} workspaceId={workspaceId} />
        <p className="text-fg-muted">
          This request needs its specialist review in Approvals before a decision. Use Inspect persisted approval for
          the governed review.
        </p>
      </>
    );
  if (!hasPreview && !specializedReview)
    return <p role="alert">The exact action preview is unavailable. Open the persisted approval before deciding.</p>;
  if (expired)
    return <p className="text-fg-muted">This approval has expired. Open Approvals to check its current outcome.</p>;

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
            specialistReview={specialistReady && specialistEvidence ? <SpecialistApprovalReview approval={approval} evidence={specialistEvidence} /> : undefined}
            pending={Boolean(attempt) || checking || (specializedReview && !specialistReady)}
            onApprove={() => void decide("approve")}
          />
        </span>
        <Button
          ref={denyRef}
          type="button"
          size="sm"
          variant="danger"
          disabled={Boolean(attempt) || checking}
          onClick={() => setDenyOpen(true)}
        >
          Deny
        </Button>
      </div>
      {attempt ? (
        <p role={attempt.phase === "uncertain" ? "alert" : "status"} className="text-fg-muted">
          {attempt.message}
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
          <Button variant="danger" disabled={Boolean(attempt) || checking} onClick={() => void decide("reject")}>
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
