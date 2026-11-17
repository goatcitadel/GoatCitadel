import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { queryKeys } from "../../data/query-keys";
import { ApprovalDecisionBar } from "./ApprovalDecisionBar";
import { inboxApprovalRecordKey, readInboxApproval } from "./inbox-record-read";

/** Quick decisions are limited to safe reads whose single destination can be shown in full on the row. */
export function canDecideInRow(item: OperatorInboxItem): boolean {
  return (
    item.kind === "approval" &&
    Boolean(item.source.approvalId) &&
    item.riskLevel === "safe" &&
    !item.source.installWide &&
    item.source.toolName === "fs.read" &&
    /^Path: \S/u.test(item.summary)
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
  const eligible = canDecideInRow(item);
  const queryKey = inboxApprovalRecordKey(workspaceId, false, approvalId!, access.identity);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => readInboxApproval(approvalId!, { workspaceId, installWide: false, signal }),
    enabled: eligible,
    staleTime: 15_000,
  });
  const approval = query.data;
  if (
    !eligible ||
    !approval ||
    approval.status !== "pending" ||
    approval.riskLevel !== "safe" ||
    (approval.linkage?.toolName ?? approval.kind) !== "fs.read" ||
    approval.mcpElicitation ||
    approval.preview?.outsideRootRead === true ||
    typeof approval.preview?.path !== "string" ||
    item.summary !== `Path: ${approval.preview.path}`
  )
    return null;
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
