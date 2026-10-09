import { ApprovalBulkReject } from "./ApprovalBulkReject";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { fetchApprovals } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { hasRecoveryLinkage } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { approvalCreatedLabel } from "./approval-preview";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { WindowedRecordList } from "../../ui/WindowedRecordList";

type View = "all" | "recovery" | ApprovalRequest["status"];
export function InboxApprovalHistory({ workspaceId }: { workspaceId: string }) {
  const access = useProjectAccess(workspaceId);
  return <ScopedHistory key={access.identity} workspaceId={workspaceId} identity={access.identity} />;
}
function ScopedHistory({ workspaceId, identity }: { workspaceId: string; identity: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("all");
  const route = useCockpitRoute();
  function inspect(approvalId: string) {
    const params = new URLSearchParams(route.search);
    params.set("approvalId", approvalId); params.set("workspaceId", workspaceId);
    route.requestTransition(review => { if (review.isCurrent()) review.navigate(`/inbox?${params}${route.hash}`); });
  }
  const history = useInfiniteQuery({
    queryKey: ["approvals", "inbox-history", identity, view],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await fetchApprovals({ workspaceId, limit: 100, cursor: pageParam,
        ...(view !== "all" && view !== "recovery" ? { status: view } : {}) });
      if (page.items.some(record => record.linkage?.workspaceId !== workspaceId))
        throw new Error("Approval history returned records outside this workspace. Refresh to retry.");
      return page;
    },
    getNextPageParam: page => page.nextCursor || undefined,
    enabled: open,
    retry: false,
  });
  const records = [...new Map(history.data?.pages.flatMap(page => page.items).map(record => [record.approvalId, record]) ?? []).values()];
  const visible = view === "recovery" ? records.filter(hasRecoveryLinkage) : records;
  return <section className="space-y-3" aria-label="Approval history">
    <Button onClick={() => setOpen(!open)} aria-expanded={open}>Approval history and replay</Button>
    {open ? <>
      <p className="text-sm text-fg-muted">Workspace approval audit, newest first. Load older pages to inspect the full retained history. Recovery shows linked work from loaded pages.</p>
      <label className="grid gap-1 text-sm">Approval history view
        <select value={view} onChange={event => setView(event.target.value as View)} className="rounded-md border border-line bg-raised p-2">
          {(["all", "pending", "approved", "rejected", "edited", "recovery"] as const).map(value => <option key={value} value={value}>{value === "all" ? "All records" : humanizeToken(value)}</option>)}
        </select>
      </label>
      <ApprovalBulkReject onResolved={() => void history.refetch()} />
      <Button disabled={history.isFetching} onClick={() => void history.refetch()}>Refresh approval history</Button>
      {history.isPending ? <p role="status">Loading approval history…</p> : null}
      {history.isError ? <p role="alert">{describeApiError(history.error).summary} Retained pages may be stale.</p> : null}
      <WindowedRecordList items={visible} itemKey={record => record.approvalId} label="Approval records" threshold={50}>
        {record => <article className="mb-2 grid gap-2 rounded-lg border border-line p-3">
          <h3 className="font-medium">{record.explanation?.summary || humanizeToken(record.kind)}</h3>
          <p className="text-sm text-fg-secondary">{humanizeToken(record.kind)} · {humanizeToken(record.status)} · {approvalCreatedLabel(record.createdAt)}</p>
          <Button className="justify-self-start" aria-label={`Inspect decision ${record.approvalId}`} onClick={() => inspect(record.approvalId)}>Inspect decision</Button>
          <TechnicalDetails><p className="break-all">Approval {record.approvalId}</p></TechnicalDetails>
        </article>}
      </WindowedRecordList>
      {history.data && !visible.length ? <p>No approvals match this view in the loaded pages.</p> : null}
      {history.hasNextPage ? <Button disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>Load more approvals</Button> : history.data && !history.isError ? <p role="status">End of retained approval history for this view.</p> : null}
    </> : null}
  </section>;
}
