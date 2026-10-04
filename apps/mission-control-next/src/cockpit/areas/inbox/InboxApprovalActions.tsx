import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequest, OperatorInboxItem } from "@goatcitadel/contracts";
import { fetchApprovals, resolveApproval } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { presentApprovalStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { RiskApprovalAction } from "../chat/RiskApprovalAction";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { canResolveInboxApproval, inboxApprovalReviewKey, matchesInboxApprovalDecision } from "./inbox-approval-guard";
import {
  beginInboxApprovalAttempt,
  releaseInboxApprovalCheck,
  updateInboxApprovalAttempt,
  useInboxApprovalAttempt,
} from "./inbox-approval-attempts";

interface InboxApprovalActionsProps {
  item: OperatorInboxItem;
  approval: ApprovalRequest;
  workspaceId: string;
  focusAction?: "approve" | "deny";
  onResolved: (message: string) => void;
  onInvalidated: () => void;
}

export function InboxApprovalActions(props: InboxApprovalActionsProps) {
  const { activeWorkspaceId } = useUiPreferences();
  const scope = activeWorkspaceId ?? "default";
  return (
    <ApprovalDecisionReview
      key={inboxApprovalReviewKey(props.item, props.approval, props.workspaceId, scope)}
      {...props}
      activeWorkspaceId={scope}
    />
  );
}

function ApprovalDecisionReview({
  item,
  approval,
  workspaceId,
  focusAction,
  onResolved,
  onInvalidated,
  activeWorkspaceId,
}: InboxApprovalActionsProps & { activeWorkspaceId: string }) {
  const queryClient = useQueryClient();
  const attempt = useInboxApprovalAttempt(workspaceId, approval.approvalId);
  const pending = attempt?.phase === "checking" || attempt?.phase === "submitted";
  const [denyOpen, setDenyOpen] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(true);
  const approveRef = useRef<HTMLSpanElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const scopeChanged = (activeWorkspaceId ?? "default") !== workspaceId;
  const specializedReview = approval.kind === "remote_worker.native_runtime" || approval.kind === "code_mode.run";
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
    if (!current.current || scopeChanged || !canResolveInboxApproval(item, approval, approval, workspaceId)) return;
    const token = beginInboxApprovalAttempt(workspaceId, approval.approvalId);
    if (!token) return;
    setError("");
    let mutationAttempted = false;
    let resolvedMessage: string | undefined;
    try {
      const latest = await fetchApprovals({ status: "pending", workspaceId, limit: 200 });
      // A different selection, workspace, or reviewed record unmounts this review.
      // Cancel before dispatch; after dispatch retain the original action's outcome.
      if (!current.current) return;
      const record = latest.items.find((entry) => entry.approvalId === approval.approvalId);
      if (!canResolveInboxApproval(item, approval, record, workspaceId)) {
        setError("This approval changed or is no longer in the current pending queue. Refresh it before deciding.");
        onInvalidated();
        return;
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
      const message = `${presentApprovalStatus(result.approval.status).label} decision recorded. ${
        result.executedAction || result.approval.followUp?.status === "completed"
          ? "Gateway returned a follow-on outcome; inspect its record for details."
          : "Follow-on execution needs separate verification."
      }`;
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
    }
  }

  if (scopeChanged)
    return (
      <p role="alert" className="text-fg-secondary">
        The selected workspace changed. Open this item again in the current Inbox.
      </p>
    );
  if (specializedReview)
    return <p className="text-fg-muted">This request needs its specialist review in Approvals before a decision.</p>;
  if (expired)
    return <p className="text-fg-muted">This approval has expired. Open Approvals to check its current outcome.</p>;

  return (
    <div className="space-y-2 border-t border-line-subtle pt-3">
      <div className="flex flex-wrap gap-2">
        <span ref={approveRef} className="inline-flex">
          <RiskApprovalAction
            approval={{
              approvalId: approval.approvalId,
              kind: approval.kind,
              riskLevel: approval.riskLevel,
              toolName: approval.linkage?.toolName,
              reason: approval.explanation?.riskExplanation,
              expiresAt: approval.expiresAt,
            }}
            reviewedApproval={approval}
            pending={Boolean(attempt)}
            onApprove={() => void decide("approve")}
          />
        </span>
        <Button
          ref={denyRef}
          type="button"
          size="sm"
          variant="danger"
          disabled={Boolean(attempt)}
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
            The current pending record is checked again before either decision. Approval alone does not prove the
            action ran.
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
          <Button variant="danger" disabled={Boolean(attempt)} onClick={() => void decide("reject")}>
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
