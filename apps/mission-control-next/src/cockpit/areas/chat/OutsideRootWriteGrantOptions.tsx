import { useId, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  canonicalJsonString,
  OUTSIDE_ROOT_WRITE_GRANT_DURATIONS,
  readOutsideRootWriteApprovalDetails,
  type ApprovalRequest,
  type OutsideRootWriteGrantDuration,
} from "@goatcitadel/contracts";
import { approveChatTool } from "@goatcitadel/mission-control-shared/api/client";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { buildApprovalRequestReviewEvidenceModel } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import { cockpitInputClass } from "../../ui/input-class";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { splitApprovalExplanation } from "../inbox/approval-preview";
import { CHANGED_APPROVAL_RECORD, canResolveInboxApproval } from "../inbox/inbox-approval-guard";
import { nullWhenMissing } from "../inbox/inbox-record-read";
import { hasExpired, useMinuteClock } from "../inbox/use-minute-clock";
import { RiskApprovalAction } from "./RiskApprovalAction";
import {
  beginInboxApprovalAttempt,
  releaseInboxApprovalCheck,
  updateInboxApprovalAttempt,
  useInboxApprovalAttempt,
} from "../inbox/inbox-approval-attempts";

const DURATION_LABELS: Record<OutsideRootWriteGrantDuration, string> = {
  "15m": "15 minutes",
  "1h": "1 hour",
  "8h": "8 hours",
};

type GrantScope = "session" | "workspace";

interface OutsideRootWriteGrantOptionsProps {
  approval: ApprovalRequest;
  workspaceId: string;
  sessionId: string;
  onResolved: (message: string) => void;
}

/**
 * An outside-root write approval can also open one folder the Gateway offered, for the approved tool only and
 * for a bounded time. The plain Approve in the decision bar still admits just this one write. The Gateway
 * re-checks the folder against its own record; the preview here is display only. Approving here goes through the
 * same risk tiers as the decision bar's Approve once: danger opens the review, nuclear also needs the typed word.
 * Like the decision bar, a click re-reads the record first and sends nothing unless it is the same pending record.
 */
export function OutsideRootWriteGrantOptions(props: OutsideRootWriteGrantOptionsProps) {
  const { activeWorkspaceId } = useUiPreferences();
  const scope = activeWorkspaceId ?? "default";
  const access = useProjectAccess(scope);
  // Keyed like the decision bar's review: a changed record, chat, workspace or access identity remounts the grant,
  // so an open danger or nuclear review closes and its typed word is cleared, and the change needs its own review.
  return (
    <OutsideRootWriteGrantReview
      key={canonicalJsonString([props.approval, props.workspaceId, props.sessionId, scope, access.identity])}
      {...props}
      activeWorkspaceId={scope}
    />
  );
}

function OutsideRootWriteGrantReview({
  approval,
  workspaceId,
  sessionId,
  onResolved,
  activeWorkspaceId,
}: OutsideRootWriteGrantOptionsProps & { activeWorkspaceId: string }) {
  const details = readOutsideRootWriteApprovalDetails(approval.preview?.outsideRootWrite);
  const queryClient = useQueryClient();
  const access = useProjectAccess(workspaceId);
  const attempt = useInboxApprovalAttempt(workspaceId, approval.approvalId);
  const groupName = useId();
  const current = useRef(true);
  const [rootId, setRootId] = useState(details?.candidates[0]?.rootId ?? "");
  const [duration, setDuration] = useState<OutsideRootWriteGrantDuration>(details?.defaultDuration ?? "1h");
  const [scope, setScope] = useState<GrantScope>("session");
  const [error, setError] = useState("");
  // The shared minute clock plus one re-render at the expiry moment turn the control off on time (IN-05).
  const now = useMinuteClock(approval.expiresAt);
  useLayoutEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);

  if (!details || details.candidates.length === 0 || approval.status !== "pending") return null;
  const toolName = approval.linkage?.toolName ?? "this tool";
  const durations = details.durations.filter((value) => value in OUTSIDE_ROOT_WRITE_GRANT_DURATIONS);
  const chosen = details.candidates.find((candidate) => candidate.rootId === rootId);
  const expired = hasExpired(approval.expiresAt, now);
  const otherChat = Boolean(approval.linkage?.sessionId && approval.linkage.sessionId !== sessionId);
  // The same scope check as the decision bar, which then says the selected workspace changed.
  const scopeChanged = activeWorkspaceId !== workspaceId || otherChat;
  // Without the exact action preview the decision bar offers only Deny and says why; nothing here can approve either.
  const hasPreview = Boolean(buildApprovalRequestReviewEvidenceModel(approval));

  async function approveAndOpen() {
    if (
      !chosen ||
      !current.current ||
      !access.current() ||
      !hasPreview ||
      scopeChanged ||
      !canResolveInboxApproval(undefined, approval, approval, workspaceId, Date.now())
    )
      return;
    const token = beginInboxApprovalAttempt(workspaceId, approval.approvalId);
    if (!token) return;
    setError("");
    let message: string | undefined;
    let dispatched = false;
    try {
      // The same check the decision bar makes before dispatch: the record must still be the reviewed pending one.
      const latest = await nullWhenMissing(fetchApproval(approval.approvalId, { workspaceId }));
      if (!current.current || !access.current()) return;
      if (!canResolveInboxApproval(undefined, approval, latest ?? undefined, workspaceId, Date.now())) {
        setError(CHANGED_APPROVAL_RECORD);
        void queryClient.invalidateQueries({ queryKey: ["approvals", "record", workspaceId, approval.approvalId] });
        return;
      }
      updateInboxApprovalAttempt(workspaceId, approval.approvalId, token, "submitted", "Recording the approval…");
      dispatched = true;
      const result = await approveChatTool(sessionId, approval.approvalId, {
        allowScope: scope,
        writeGrant: { rootId: chosen.rootId, duration },
      });
      const where = scope === "workspace" ? "this workspace" : "this chat";
      // No grant and no grantError means the approval was already decided elsewhere; this click decided nothing.
      message = result.grant
        ? `Approved. ${chosen.path} is open to ${toolName} in ${where} for ${DURATION_LABELS[duration]}.`
        : result.grantError
          ? `Approved this write once. The folder was not opened: ${result.grantError}`
          : "This approval was already decided elsewhere, so nothing was opened. Check the recorded decision below.";
      updateInboxApprovalAttempt(workspaceId, approval.approvalId, token, "resolved", message);
    } catch (cause) {
      if (!dispatched) {
        if (current.current) setError(`Could not check the current approval. ${describeApiError(cause).summary}`);
        return;
      }
      updateInboxApprovalAttempt(
        workspaceId,
        approval.approvalId,
        token,
        "uncertain",
        "Decision outcome is uncertain. Check again to read the current record before taking another action.",
      );
      if (current.current) setError(describeApiError(cause).summary);
    } finally {
      releaseInboxApprovalCheck(workspaceId, approval.approvalId, token);
    }
    if (!message) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: ["approvals", "record", workspaceId, approval.approvalId] });
    void queryClient.invalidateQueries({ queryKey: ["approval-settlement", workspaceId, approval.approvalId] });
    if (current.current) onResolved(message);
  }

  const busy = Boolean(attempt);
  return (
    <section aria-label="Open a folder for this tool" className="space-y-3 border-t border-line-subtle pt-3 text-sm">
      <div>
        <h4 className="font-medium text-fg">Or approve and open a folder</h4>
        <p className="text-xs text-fg-muted">
          Lets {toolName} write inside the chosen folder without asking again, until the time runs out. Other tools,
          deletes, protected runtime folders and network shares stay blocked.
        </p>
      </div>
      <fieldset className="space-y-1" disabled={busy}>
        <legend className="text-xs font-medium text-fg-secondary">Folder</legend>
        {details.candidates.map((candidate) => (
          <label key={candidate.rootId} className="flex items-start gap-2 text-fg-secondary">
            <input
              type="radio"
              name={`${groupName}-root`}
              value={candidate.rootId}
              checked={rootId === candidate.rootId}
              onChange={() => setRootId(candidate.rootId)}
              className="mt-1"
            />
            <span className="font-mono text-xs wrap-anywhere text-fg">{candidate.path}</span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-fg-secondary">
          For how long
          <select
            value={duration}
            disabled={busy}
            onChange={(event) => setDuration(event.target.value as OutsideRootWriteGrantDuration)}
            className={`mt-1 ${cockpitInputClass}`}
          >
            {durations.map((value) => (
              <option key={value} value={value}>
                {DURATION_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="space-y-1" disabled={busy}>
          <legend className="text-xs font-medium text-fg-secondary">Where</legend>
          {(["session", "workspace"] as const).map((value) => (
            <label key={value} className="flex items-center gap-2 text-fg-secondary">
              <input
                type="radio"
                name={`${groupName}-scope`}
                value={value}
                checked={scope === value}
                onChange={() => setScope(value)}
              />
              {value === "session" ? "This chat" : "This workspace"}
            </label>
          ))}
        </fieldset>
      </div>
      {/* Without a risk level or an exact preview the decision bar above already says why nothing can be approved. */}
      {approval.riskLevel && hasPreview ? (
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
          pending={busy || !chosen || expired || scopeChanged}
          // Approve once in the decision bar is the primary choice; also opening a folder stays secondary.
          approveVariant="secondary"
          loading={attempt?.phase === "checking" || attempt?.phase === "submitted"}
          loadingLabel="Approving…"
          approveLabel="Approve and open folder"
          reviewLabel="Review and open folder"
          confirmLabel="Approve and open folder"
          consequence={
            chosen ? (
              <p className="mb-3 text-sm text-fg">
                Approving also opens <span className="font-mono wrap-anywhere">{chosen.path}</span> to {toolName} in{" "}
                {scope === "workspace" ? "this workspace" : "this chat"} for {DURATION_LABELS[duration]}.
              </p>
            ) : undefined
          }
          onApprove={() => void approveAndOpen()}
        />
      ) : null}
      {/* The decision bar's uncertain-outcome alert announces this; the detail stays readable here. */}
      {error ? <p className="text-status-failed">{error}</p> : null}
    </section>
  );
}
