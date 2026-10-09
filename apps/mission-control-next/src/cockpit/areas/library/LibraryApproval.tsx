import { useLibraryOperation } from "./use-library-operation";
import { useQuery } from "@tanstack/react-query";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ApprovalDecisionBar } from "../inbox/ApprovalDecisionBar";
import { approvalDecisionMessage } from "../inbox/approval-settlement";
import { Callout } from "../../ui/Callout";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

/** Shared Library projection of the existing Chat/Inbox decision owner. */
export function LibraryApproval({ approvalId, workspaceId, onRefresh }: { approvalId: string; workspaceId: string; onRefresh: () => Promise<unknown> }) {
  const access = useLibraryOperation(JSON.stringify(["library-approval", workspaceId, approvalId]));
  const query = useQuery({ queryKey: ["library", "approval", workspaceId, approvalId, access.identity], queryFn: ({ signal }) => fetchApproval(approvalId, { workspaceId, signal }), staleTime: 0 });
  async function refresh() { await Promise.all([query.refetch(), onRefresh()]); }
  const approval = query.data;
  return <section className="grid gap-3 rounded-md border border-line p-3" aria-label="Library approval">
    {query.isPending ? <p role="status">Reading persisted approval…</p> : null}
    {query.error ? <Callout tone="error">{describeApiError(query.error).summary}</Callout> : null}
    {approval ? <><p className="text-sm text-fg-secondary">{approval.status === "pending" ? "Pending approval. The requested change has not been confirmed." : approvalDecisionMessage(approval)}</p><ApprovalDecisionBar approval={approval} workspaceId={workspaceId} checking={query.isFetching || query.isError} onResolved={() => void refresh()} onInvalidated={() => void refresh()} /></> : null}
    <Button disabled={query.isFetching} onClick={() => void refresh()}>Refresh approval and record</Button>
    <NativeOwnerLink scope={workspaceId} href={`/inbox?approvalId=${encodeURIComponent(approvalId)}&shell=cockpit`}>Open this approval in Inbox</NativeOwnerLink>
  </section>;
}
