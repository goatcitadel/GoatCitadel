import { WindowedRecordList, type WindowedRecordListHandle } from "../../ui/WindowedRecordList";
import { InboxSourceContext } from "./InboxSourceContext";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { RefreshCw } from "lucide-react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeOperatorInboxError } from "../../data/operator-inbox-error";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { readCockpitHistory, subscribeCockpitHistory } from "../../app/cockpit-history";
import { useInspector } from "../../app/inspector";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { useOperatorInbox } from "../../data/use-operator-inbox";
import { Button } from "../../ui/Button";
import { InboxOwnerLink } from "./InboxOwnerLink";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { EmptyState } from "../../ui/EmptyState";
import { StatusBadge } from "../../ui/StatusBadge";
import { approvalCreatedLabel, approvalExpiryLabel } from "./approval-preview";
import { INBOX_GROUPS, inboxCountIsExact, inboxItemKindLabel, inboxMatchesWorkspace } from "./inbox-presentation";
import { InboxCoverageSummary } from "./InboxCoverageSummary";
import { InboxApprovalDetail } from "./InboxApprovalDetail";
import { InboxChangePlanDetail } from "./InboxChangePlanDetail";
import { InboxCapabilityProposalDetail } from "./InboxCapabilityProposalDetail";
import { InboxDocumentProposalDetail } from "./InboxDocumentProposalDetail";
import { InboxMemoryProposalDetail } from "./InboxMemoryProposalDetail";
import { InboxImprovementProposalDetail } from "./InboxImprovementProposalDetail";
import { InboxRunRecovery } from "./InboxRunRecovery";
import { InboxUserInputDetail } from "./InboxUserInputDetail";
import { inboxUpdateVersion, markInboxUpdateViewed, useInboxViewedUpdates } from "./inbox-viewed-updates";

function RecordViewedUpdate({ onOpened }: { onOpened: () => void }) {
  useEffect(onOpened, [onOpened]);
  return null;
}

export function InboxArea() {
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const workspaceId = activeWorkspaceId ?? "default";
  const { search } = useCockpitRoute();
  const params = new URLSearchParams(search);
  const linkedItem = params.get("item");
  const linkedWorkspace = params.get("workspaceId");
  const handledLink = useRef<string | null>(null);
  const inbox = useOperatorInbox(workspaceId);
  const inspector = useInspector();
  const installation = getGatewayApiBaseUrl();
  const scopeKey = JSON.stringify([installation, workspaceId]);
  const { isViewed } = useInboxViewedUpdates(installation, workspaceId);
  const [showViewedScope, setShowViewedScope] = useState<string | null>(null);
  const showViewed = showViewedScope === scopeKey;
  const scopeMatches = inboxMatchesWorkspace(inbox.data, workspaceId);
  const projection = !inbox.isError && scopeMatches ? inbox.data : undefined;
  const visibleItems = useMemo(
    () => projection?.items.filter((item) => showViewed || !isViewed(item)) ?? [],
    [projection, showViewed, isViewed],
  );
  const orderedItems = useMemo(
    () => INBOX_GROUPS.flatMap((group) => visibleItems.filter((item) => item.group === group.id)),
    [visibleItems],
  );
  const [contextSelection, setContextSelection] = useState<{ scope: string; id: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listHandles = useRef(new Map<string, WindowedRecordListHandle>());
  const mounted = useRef(true);
  const current = useRef({ installation, workspaceId, projection, fetching: inbox.isFetching });
  current.current = { installation, workspaceId, projection, fetching: inbox.isFetching };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const recordOpenedUpdate = useCallback(
    (item: OperatorInboxItem) => {
      const latest = current.current;
      const version = inboxUpdateVersion(item, workspaceId);
      if (
        !mounted.current ||
        latest.fetching ||
        latest.installation !== installation ||
        getGatewayApiBaseUrl() !== installation ||
        latest.workspaceId !== workspaceId ||
        !version ||
        !latest.projection?.items.some((entry) => inboxUpdateVersion(entry, workspaceId) === version)
      )
        return;
      markInboxUpdateViewed(installation, workspaceId, item);
    },
    [installation, workspaceId],
  );

  const inspect = useCallback(
    (item: OperatorInboxItem, focusAction?: "approve" | "deny", explicitDetails = false) =>
      inspector.open({
        source: `inbox:${item.id}`,
        title: item.title,
        body: (
          <div className="grid gap-4 text-sm">
            <div>
              <p className="text-xs font-medium text-fg-muted">
                {inboxItemKindLabel(item.kind)} · {approvalCreatedLabel(item.createdAt)}
              </p>
              <p className="mt-2 text-fg-secondary">{item.summary}</p>
              {item.expiresAt ? <p className="mt-2 text-fg-muted">{approvalExpiryLabel(item.expiresAt)}</p> : null}
            </div>
            {explicitDetails && inboxUpdateVersion(item, workspaceId) ? (
              <RecordViewedUpdate onOpened={() => recordOpenedUpdate(item)} />
            ) : null}
            {item.riskLevel ? <StatusBadge status={presentRiskLevel(item.riskLevel)} /> : null}
            {item.kind === "approval" ? (
              <InboxApprovalDetail item={item} workspaceId={workspaceId} focusAction={focusAction} />
            ) : item.kind === "change_plan" ? (
              <InboxChangePlanDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
            ) : item.kind === "failed_run" || item.kind === "dead_letter" ? (
              <InboxRunRecovery item={item} workspaceId={workspaceId} />
            ) : item.kind === "memory_proposal" ? (
              <InboxMemoryProposalDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
            ) : item.kind === "improvement_proposal" ? (
              <InboxImprovementProposalDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
            ) : item.kind === "capability_proposal" ? (
              <InboxCapabilityProposalDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
            ) : item.kind === "document_proposal" ? (
              <InboxDocumentProposalDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
            ) : item.kind === "user_input" ? (
              <InboxUserInputDetail key={`${workspaceId}:${item.id}`} item={item} workspaceId={workspaceId} />
            ) : (
              <p className="text-xs text-fg-muted">
                This is a read-only summary. Review the current record before deciding.
              </p>
            )}
            {item.source.sessionId ? (
              <InboxSourceContext
                key={JSON.stringify([installation, workspaceId, item.id, item.updatedAt, item.source.sessionId])}
                item={item}
                workspaceId={workspaceId}
              />
            ) : null}
            {item.source.sessionId ? (
              <NativeOwnerLink
                scope={[workspaceId, item.id, item.source.sessionId]}
                href={`/chat?sessionId=${encodeURIComponent(item.source.sessionId)}`}
                className="text-sm font-medium text-accent hover:underline"
              >
                Open source conversation
              </NativeOwnerLink>
            ) : null}
            <InboxOwnerLink item={item} workspaceId={workspaceId} />
          </div>
        ),
      }),
    [inspector, installation, workspaceId, recordOpenedUpdate],
  );

  useEffect(() => {
    const key = JSON.stringify([installation, activeCitadelId, workspaceId, linkedWorkspace, linkedItem, history]);
    if (!linkedItem) {
      handledLink.current = null;
      return;
    }
    if (linkedWorkspace !== workspaceId) {
      handledLink.current = null;
      return;
    }
    if (handledLink.current === key) return;
    // A URL is navigation, not authority. The detail re-reads the scoped canonical record.
    const item =
      projection?.items.find((entry) => entry.id === linkedItem) ??
      (linkedItem.startsWith("approval:") && linkedItem.length > 9
        ? {
            id: linkedItem,
            kind: "approval" as const,
            group: "needs_decision" as const,
            title: "Approval",
            summary: "Review the current approval record.",
            createdAt: "",
            source: { workspaceId, approvalId: linkedItem.slice(9) },
            href: `/ops/approvals?approvalId=${encodeURIComponent(linkedItem.slice(9))}&workspaceId=${encodeURIComponent(workspaceId)}&shell=classic`,
          }
        : undefined);
    if (!item) return;
    handledLink.current = key;
    setSelectedId(item.id);
    inspect(item);
  }, [
    projection,
    inbox.isFetching,
    inspect,
    installation,
    activeCitadelId,
    workspaceId,
    linkedItem,
    linkedWorkspace,
    history,
  ]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !orderedItems.length) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector('[role="dialog"]')) return;
      const key = event.key.toLowerCase();
      if (!["j", "k", "o", "a", "d", "e"].includes(key)) return;
      const currentIndex = orderedItems.findIndex((item) => item.id === selectedId);
      const nextIndex =
        currentIndex < 0
          ? 0
          : key === "j"
            ? Math.min(currentIndex + 1, orderedItems.length - 1)
            : key === "k"
              ? Math.max(currentIndex - 1, 0)
              : currentIndex;
      const nextItem = orderedItems[nextIndex];
      if (!nextItem || ((key === "a" || key === "d") && nextItem.kind !== "approval")) return;
      event.preventDefault();
      setSelectedId(nextItem.id);
      if (key === "a" || key === "d") {
        inspect(nextItem, key === "a" ? "approve" : "deny");
        return;
      }
      if (key === "o") {
        inspect(nextItem, undefined, true);
        return;
      }
      listHandles.current
        .get(nextItem.group)
        ?.focusRecord(nextItem.id, key === "e" ? "[data-inbox-owner]" : "[data-inbox-detail]");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspect, orderedItems, selectedId]);

  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">Inbox</h1>
          <p className="text-sm text-fg-secondary">Decisions and work that need your attention in this workspace.</p>
          <p className="mt-1 text-xs text-fg-muted">
            This view summarizes Gateway records. Open the current record to act.
          </p>
          <p className="mt-1 text-xs text-fg-muted max-sm:hidden pointer-coarse:hidden">
            Keys: J/K select · O details · A/D focus approval actions · E source link. Confirm to decide.
          </p>
        </div>
        <Button size="sm" onClick={() => void inbox.refetch()} disabled={inbox.isFetching}>
          <RefreshCw aria-hidden="true" className="size-4" /> Refresh
        </Button>
      </header>

      {linkedItem && linkedWorkspace !== workspaceId ? (
        <p role="alert" className="text-sm text-fg-secondary">
          This Inbox link belongs to another workspace. Select its workspace to review the current item.
        </p>
      ) : null}
      {linkedItem &&
      linkedWorkspace === workspaceId &&
      projection &&
      !inbox.isFetching &&
      !linkedItem.startsWith("approval:") &&
      !projection.items.some((item) => item.id === linkedItem) ? (
        <p role="status" className="text-sm text-fg-muted">
          The linked item is no longer in the current Inbox. It may have been resolved or moved outside this view’s
          coverage.
        </p>
      ) : null}
      {inbox.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading Inbox…
        </p>
      ) : null}
      {inbox.isError ? (
        <EmptyState
          title="Inbox unavailable"
          description={describeOperatorInboxError(inbox.error).summary}
          action={<Button onClick={() => void inbox.refetch()}>Try again</Button>}
        />
      ) : null}
      {inbox.data && !scopeMatches && !inbox.isError ? (
        <EmptyState
          title="Inbox scope mismatch"
          description="The returned projection contains records outside the selected workspace. No items or counts are shown."
          action={<Button onClick={() => void inbox.refetch()}>Try again</Button>}
        />
      ) : null}

      {projection ? (
        <>
          <InboxCoverageSummary projection={projection} />
          {INBOX_GROUPS.map((group) => {
            const allItems = projection.items.filter((item) => item.group === group.id);
            const items = visibleItems.filter((item) => item.group === group.id);
            const viewedCount = allItems.filter(isViewed).length;
            const count = projection.counts[group.id];
            const exact = inboxCountIsExact(projection, count.complete);
            return (
              <section key={group.id} aria-labelledby={`inbox-${group.id}`} className="grid gap-3">
                <header className="flex items-baseline gap-2">
                  <h2 id={`inbox-${group.id}`} className="font-display text-md font-semibold text-fg">
                    {group.label}
                  </h2>
                  <span aria-label={`${group.label} Gateway count`} className="text-xs text-fg-muted">
                    {exact ? count.known : count.known > 0 ? `${count.known}+` : "0 known"}
                  </span>
                </header>
                {group.id === "updates" ? (
                  <div className="space-y-2 text-xs text-fg-muted">
                    <p>
                      {allItems.length - viewedCount} unviewed · {viewedCount} viewed here from this response. The
                      Gateway count above is unchanged.
                    </p>
                    <p>
                      Viewed updates are hidden in this app session. Gateway records are unchanged; a full reload clears
                      this view.
                    </p>
                    {viewedCount > 0 ? (
                      <Button size="sm" onClick={() => setShowViewedScope(showViewed ? null : scopeKey)}>
                        {showViewed ? "Hide viewed updates" : `Show viewed updates (${viewedCount})`}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {items.length === 0 ? (
                  <p className="text-sm text-fg-muted">
                    {group.id === "updates" && viewedCount > 0
                      ? "No unviewed updates from this response."
                      : exact
                        ? "Nothing waiting here."
                        : "No known items returned in this group."}
                  </p>
                ) : (
                  <WindowedRecordList
                    items={items}
                    itemKey={(item) => item.id}
                    label={group.label}
                    rowAttributes={(item) => ({ "data-inbox-item": true, "data-selected": selectedId === item.id })}
                    listRef={(handle) => {
                      if (handle) listHandles.current.set(group.id, handle);
                      else listHandles.current.delete(group.id);
                    }}
                  >
                    {(item) => (
                      <article
                        data-selected={selectedId === item.id}
                        className="rounded-lg border border-line bg-raised p-4 data-[selected=true]:border-accent"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-fg-muted">
                              {inboxItemKindLabel(item.kind)} · {approvalCreatedLabel(item.createdAt)}
                            </p>
                            <h3 className="mt-1 font-display text-md font-semibold text-fg">{item.title}</h3>
                            <p className="mt-1 text-sm text-fg-secondary">{item.summary}</p>
                          </div>
                          {item.riskLevel ? <StatusBadge status={presentRiskLevel(item.riskLevel)} /> : null}
                        </div>
                        {item.expiresAt ? (
                          <p className="mt-2 text-xs text-fg-muted">{approvalExpiryLabel(item.expiresAt)}</p>
                        ) : null}
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <Button
                            size="sm"
                            data-inbox-detail
                            onClick={() => {
                              setSelectedId(item.id);
                              inspect(item, undefined, true);
                            }}
                          >
                            Details
                          </Button>
                          <InboxOwnerLink item={item} workspaceId={workspaceId} />
                          {item.source.sessionId ? (
                            <Button
                              size="sm"
                              aria-expanded={contextSelection?.scope === scopeKey && contextSelection.id === item.id}
                              onClick={() =>
                                setContextSelection(
                                  contextSelection?.scope === scopeKey && contextSelection.id === item.id
                                    ? null
                                    : { scope: scopeKey, id: item.id },
                                )
                              }
                            >
                              {contextSelection?.scope === scopeKey && contextSelection.id === item.id
                                ? "Hide source context"
                                : "Show source context"}
                            </Button>
                          ) : null}
                        </div>
                        {contextSelection?.scope === scopeKey && contextSelection.id === item.id ? (
                          <div className="mt-3">
                            <InboxSourceContext item={item} workspaceId={workspaceId} />
                          </div>
                        ) : null}
                      </article>
                    )}
                  </WindowedRecordList>
                )}
              </section>
            );
          })}
        </>
      ) : null}
    </section>
  );
}
