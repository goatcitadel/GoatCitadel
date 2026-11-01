import { useId, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  OUTSIDE_ROOT_WRITE_GRANT_DURATIONS,
  readOutsideRootWriteApprovalDetails,
  type ApprovalRequest,
  type OutsideRootWriteGrantDuration,
} from "@goatcitadel/contracts";
import { approveChatTool } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { queryKeys } from "../../data/query-keys";
import { cockpitInputClass } from "../../ui/input-class";
import { splitApprovalExplanation } from "../inbox/approval-preview";
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
 */
export function OutsideRootWriteGrantOptions({
  approval,
  workspaceId,
  sessionId,
  onResolved,
}: OutsideRootWriteGrantOptionsProps) {
  const details = readOutsideRootWriteApprovalDetails(approval.preview?.outsideRootWrite);
  const queryClient = useQueryClient();
  const attempt = useInboxApprovalAttempt(workspaceId, approval.approvalId);
  const groupName = useId();
  const current = useRef(true);
  const [rootId, setRootId] = useState(details?.candidates[0]?.rootId ?? "");
  const [duration, setDuration] = useState<OutsideRootWriteGrantDuration>(details?.defaultDuration ?? "1h");
  const [scope, setScope] = useState<GrantScope>("session");
  const [error, setError] = useState("");
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

  async function approveAndOpen() {
    if (!chosen || !current.current) return;
    const token = beginInboxApprovalAttempt(workspaceId, approval.approvalId);
    if (!token) return;
    setError("");
    updateInboxApprovalAttempt(workspaceId, approval.approvalId, token, "submitted", "Recording the approval…");
    let message: string | undefined;
    try {
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
        pending={busy || !chosen}
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
      {/* The decision bar's uncertain-outcome alert announces this; the detail stays readable here. */}
      {error ? <p className="text-status-failed">{error}</p> : null}
    </section>
  );
}
