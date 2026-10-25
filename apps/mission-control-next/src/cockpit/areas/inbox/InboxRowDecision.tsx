import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { queryKeys } from "../../data/query-keys";
import { ApprovalDecisionBar } from "./ApprovalDecisionBar";
import { nullWhenMissing } from "./inbox-record-read";

/** Only the two lowest risk tiers may be decided straight from the list; everything else opens for review. */
export function canDecideInRow(item: OperatorInboxItem): boolean {
  return (
    item.kind === "approval" &&
    Boolean(item.source.approvalId) &&
    (item.riskLevel === "safe" || item.riskLevel === "caution")
  );
}

/**
 * In-row "Approve once" and "Deny". It reads the same owner record as the detail panel (same cache key) and mounts the
 * same decision bar, so the pre-dispatch re-read, risk gate, idempotency lock and settlement are identical.
 */
export function InboxRowDecision({
  item,
  workspaceId,
  onDecision,
}: {
  item: OperatorInboxItem;
  workspaceId: string;
  onDecision: (message: string, settled: boolean) => void;
}) {
  const access = useProjectAccess(workspaceId);
  const queryClient = useQueryClient();
  const approvalId = item.source.approvalId;
  const queryKey = ["approvals", "record", workspaceId, approvalId, access.identity];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => nullWhenMissing(fetchApproval(approvalId!, { workspaceId, signal })),
    enabled: Boolean(approvalId),
    staleTime: 15_000,
  });
  const approval = query.data;
  if (!approval || approval.status !== "pending") return null;
  const refresh = (message: string, settled: boolean) => {
    onDecision(message, settled);
    void queryClient.resetQueries({ queryKey, exact: true });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
  };
  return (
    <ApprovalDecisionBar
      compact
      item={item}
      approval={approval}
      workspaceId={workspaceId}
      onResolved={(message) => refresh(message, true)}
      onInvalidated={(message) =>
        refresh(message ?? "The approval changed. Review the refreshed record before deciding.", false)
      }
    />
  );
}
