import { useQuery } from "@tanstack/react-query";
import type { ApprovalRequest, ChatToolRunRecord } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { formatAbsoluteTime } from "@goatcitadel/mission-control-shared/content/format";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { approvalExpiredUnresolved, approvalOutcomeLabel } from "../inbox/approval-settlement";
import { presentActor } from "../inbox/inbox-vocabulary";
import { nullWhenMissing } from "../inbox/inbox-record-read";

/** "Approved by an operator", or "Expired without an operator decision" for an expiry sweep. */
export function approvalDecisionText(record: ApprovalRequest): string {
  if (approvalExpiredUnresolved(record)) return "Expired without an operator decision";
  const outcome = approvalOutcomeLabel(record);
  if (!record.resolvedBy) return outcome;
  const actor = presentActor(record.resolvedBy);
  return `${outcome} by ${actor === "An operator" ? "an operator" : actor}`;
}

/** The persisted approval record, read once `enabled`. `record` is set only for the requested id. */
export function useApprovalRecord(approvalId: string | undefined, enabled: boolean) {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const query = useQuery({
    // The same key as the Chat approval card and the Inbox detail, so a decision there is a cache hit here.
    queryKey: ["approvals", "record", workspaceId, approvalId],
    queryFn: ({ signal }) => nullWhenMissing(fetchApproval(approvalId!, { workspaceId, signal })),
    enabled: enabled && Boolean(approvalId),
    // A decided record does not change; a pending one is re-read so the line appears once it is decided.
    staleTime: (cached) => (cached.state.data && cached.state.data.status !== "pending" ? Infinity : 0),
  });
  const record = query.data?.approvalId === approvalId ? (query.data ?? undefined) : undefined;
  return { record, unavailable: query.isError || query.data === null };
}

/**
 * The persisted decision on an approval-gated tool call, so the thread keeps it after the approval card clears
 * (#499). It states the decision only: the row's own status says whether the tool ran.
 */
export function ChatToolApprovalLine({ tool }: { tool: ChatToolRunRecord }) {
  // While the tool waits, the approval card above owns the decision; read the record once it has moved on.
  const decisionDue = Boolean(tool.approvalId) && tool.status !== "approval_required";
  const { record, unavailable } = useApprovalRecord(tool.approvalId, decisionDue);
  if (!decisionDue) return null;
  if (record && record.status !== "pending") {
    return (
      <p className="w-full">
        {approvalDecisionText(record)}
        {record.resolvedAt ? (
          <>
            {" · "}
            <time dateTime={record.resolvedAt}>{formatAbsoluteTime(record.resolvedAt)}</time>
          </>
        ) : null}
      </p>
    );
  }
  if (unavailable) {
    return <p className="w-full">Needed approval. The decision record could not be loaded.</p>;
  }
  return null;
}
