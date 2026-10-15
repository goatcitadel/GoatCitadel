import { ApprovalBulkReject } from "./ApprovalBulkReject";
import { useEffect, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { fetchApprovals } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { hasRecoveryLinkage } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { queryKeys } from "../../data/query-keys";
import { approvalCreatedLabel } from "./approval-preview";
import { approvalOutcomeLabel, approvalResolutionLine } from "./approval-settlement";
import { Button } from "../../ui/Button";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { WindowedRecordList } from "../../ui/WindowedRecordList";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";

type View = "all" | "recovery" | ApprovalRequest["status"];
export function InboxApprovalHistory({ workspaceId }: { workspaceId: string }) {
  const access = useProjectAccess(workspaceId);
  return <ScopedHistory key={access.identity} workspaceId={workspaceId} identity={access.identity} />;
}
function ScopedHistory({ workspaceId, identity }: { workspaceId: string; identity: string }) {
  const route = useCockpitRoute();
  const params = new URLSearchParams(route.search);
  const runId = params.get("runId")?.trim() || undefined;
  const requestedSessionId = params.get("sessionId")?.trim() || undefined;
  const sessionId = runId ? requestedSessionId : undefined;
  const requestedWorkspaceId = params.get("workspaceId")?.trim() || undefined;
  const workspaceMismatch = Boolean(requestedWorkspaceId && requestedWorkspaceId !== workspaceId);
  const invalidFilter = Boolean(
    (params.has("workspaceId") && !requestedWorkspaceId) ||
    (params.has("runId") && !runId) ||
    (params.has("sessionId") && (!requestedSessionId || !runId)),
  );
  const historyScopeCurrent = !workspaceMismatch && !invalidFilter;
  const linkedView = params.get("historyView") ?? params.get("view");
  const historyView: View = ["pending", "recovery", "approved", "rejected", "edited"].includes(linkedView ?? "")
    ? (linkedView as View)
    : "all";
  const linkedHistory = Boolean(runId || params.has("historyView") || (linkedView && linkedView !== "pending"));
  const [open, setOpen] = useState(linkedHistory);
  const [view, setView] = useState<View>(historyView);
  useEffect(() => {
    setOpen(linkedHistory);
    setView(historyView);
  }, [linkedHistory, historyView, runId, sessionId]);
  const queryClient = useQueryClient();
  // An installation-wide rejection settles pending records everywhere: the pending Inbox projection, the nav
  // badge and every approval read (this history included) must re-read, not just this list.
  function afterBulkRejection() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: ["approvals"] });
  }
  function inspect(approvalId: string) {
    const params = new URLSearchParams(route.search);
    params.set("approvalId", approvalId);
    params.set("workspaceId", workspaceId);
    params.set("view", "history");
    params.set("historyView", view);
    route.requestTransition((review) => {
      if (review.isCurrent()) review.navigate(`/inbox?${params}${route.hash}`);
    });
  }
  const history = useInfiniteQuery({
    queryKey: ["approvals", "inbox-history", identity, view, runId, sessionId, requestedWorkspaceId ?? workspaceId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await fetchApprovals({
        workspaceId,
        limit: 100,
        cursor: pageParam,
        ...(runId ? { runId, sessionId } : {}),
        ...(view !== "all" && view !== "recovery" ? { status: view } : {}),
      });
      if (page.items.some((record) => record.linkage?.workspaceId !== workspaceId))
        throw new Error("Approval history returned records outside this workspace. Refresh to retry.");
      if (
        runId &&
        page.items.some((record) => {
          const linkage = record.linkage;
          return (
            (linkage?.runId !== runId && linkage?.durableRunId !== runId) ||
            (sessionId && linkage?.sessionId && linkage.sessionId !== sessionId)
          );
        })
      )
        throw new Error("Approval history returned records outside the linked run or session. Refresh to retry.");
      return page;
    },
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: open && historyScopeCurrent,
    retry: false,
  });
  if (!historyScopeCurrent) {
    const recovery = new URLSearchParams(params);
    recovery.set("workspaceId", workspaceId);
    recovery.set("view", "history");
    recovery.delete("runId");
    recovery.delete("sessionId");
    recovery.delete("approvalId");
    recovery.delete("shell");
    recovery.delete("shellScope");
    return (
      <section className="space-y-3" aria-label="Approval history">
        <Button onClick={() => setOpen(!open)} aria-expanded={open}>
          Approval history and replay
        </Button>
        {open ? (
          <>
            <p role="status">
              {workspaceMismatch
                ? "This history link requests another workspace. Review the linked scope before loading its approval history."
                : "Approval history requires a valid workspace and run before filtering by session. The current history has not been loaded."}
            </p>
            <NativeOwnerLink
              scope={[identity, route.search, route.hash]}
              href={`/inbox?${recovery}${route.hash}`}
              className="inline-block text-sm text-accent hover:underline"
            >
              Open current workspace approval history
            </NativeOwnerLink>
          </>
        ) : null}
      </section>
    );
  }
  const records = [
    ...new Map(
      history.data?.pages.flatMap((page) => page.items).map((record) => [record.approvalId, record]) ?? [],
    ).values(),
  ];
  const visible = view === "recovery" ? records.filter(hasRecoveryLinkage) : records;
  return (
    <section className="space-y-3" aria-label="Approval history">
      <Button onClick={() => setOpen(!open)} aria-expanded={open}>
        Approval history and replay
      </Button>
      {open ? (
        <>
          <p className="text-sm text-fg-muted">
            {runId ? "Approval audit for the linked run, newest first." : "Workspace approval audit, newest first."}
            {" Load older pages to inspect the full retained history. Recovery shows linked work from loaded pages."}
          </p>
          <label className="grid gap-1 text-sm">
            Approval history view
            <select
              value={view}
              onChange={(event) => {
                const next = new URLSearchParams(route.search);
                next.set("view", "history");
                next.set("historyView", event.target.value);
                route.navigate(`/inbox?${next}${route.hash}`);
              }}
              className="rounded-md border border-line bg-raised p-2"
            >
              {(["all", "pending", "approved", "rejected", "edited", "recovery"] as const).map((value) => (
                <option key={value} value={value}>
                  {value === "all" ? "All records" : humanizeToken(value)}
                </option>
              ))}
            </select>
          </label>
          <ApprovalBulkReject onResolved={afterBulkRejection} />
          <Button disabled={history.isFetching} onClick={() => void history.refetch()}>
            Refresh approval history
          </Button>
          {history.isPending ? <p role="status">Loading approval history…</p> : null}
          {history.isError ? (
            <p role="alert">{describeApiError(history.error).summary} Retained pages may be stale.</p>
          ) : null}
          <WindowedRecordList
            items={visible}
            itemKey={(record) => record.approvalId}
            label="Approval records"
            threshold={50}
          >
            {(record) => (
              <article className="mb-2 grid gap-2 rounded-lg border border-line p-3">
                <h3 className="font-medium">{record.explanation?.summary || humanizeToken(record.kind)}</h3>
                <p className="text-sm text-fg-secondary">
                  {humanizeToken(record.kind)}
                  {" · "}
                  {approvalOutcomeLabel(record)}
                  {" · "}
                  {approvalCreatedLabel(record.createdAt)}
                </p>
                {approvalResolutionLine(record) ? (
                  <p className="text-sm text-fg-secondary">{approvalResolutionLine(record)}</p>
                ) : null}
                <Button
                  className="justify-self-start"
                  aria-label={`Inspect decision ${record.approvalId}`}
                  onClick={() => inspect(record.approvalId)}
                >
                  Inspect decision
                </Button>
                <TechnicalDetails>
                  <p className="break-all">Approval {record.approvalId}</p>
                </TechnicalDetails>
              </article>
            )}
          </WindowedRecordList>
          {history.data && !visible.length ? <p>No approvals match this view in the loaded pages.</p> : null}
          {history.hasNextPage ? (
            <Button disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>
              Load more approvals
            </Button>
          ) : history.data && !history.isError ? (
            <p role="status">
              {"End of retained approval history for this view. "}
              {runId ? "Only records canonically linked to this run are included." : ""}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
