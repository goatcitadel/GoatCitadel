import { LinkedApproval } from "./LinkedApproval";
import { InboxApprovalHistory } from "./InboxApprovalHistory";
import { markOperatorInboxUpdatesRead } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import { WindowedRecordList, type WindowedRecordListHandle } from "../../ui/WindowedRecordList";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { RefreshCw } from "lucide-react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { getGatewayApiBaseUrl, getGatewayAccessRevision } from "@goatcitadel/mission-control-shared/api/client-core";
import { describeOperatorInboxError } from "../../data/operator-inbox-error";
import { useInspector } from "../../app/inspector";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { useOperatorInbox } from "../../data/use-operator-inbox";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { INBOX_GROUPS, inboxCountIsExact, inboxMatchesWorkspace } from "./inbox-presentation";
import { InboxCoverageSummary } from "./InboxCoverageSummary";
import { InboxInspectorBody } from "./InboxInspectorBody";
import { InboxItemCard } from "./InboxItemCard";
import { useInboxLinkedItem } from "./use-inbox-linked-item";
import { inboxUpdateVersion, markInboxUpdateViewed, useInboxViewedUpdates } from "./inbox-viewed-updates";

export function InboxArea() {
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const { search } = useCockpitRoute();
  const params = new URLSearchParams(search);
  const linkedItem = params.get("item");
  const linkedWorkspace = params.get("workspaceId");
  const inbox = useOperatorInbox(workspaceId);
  const inspector = useInspector();
  const installation = getGatewayApiBaseUrl();
  const scopeKey = JSON.stringify([installation, workspaceId]);
  const localReads = useInboxViewedUpdates(installation, workspaceId);
  const [readNotice, setReadNotice] = useState("");
  const [reading, setReading] = useState(false);
  const accessRevision = getGatewayAccessRevision();
  const actorScope = inbox.data?.readStatus?.scopeId;
  const readScope = inbox.data?.readStatus?.scope ?? "unavailable";
  const isLocallyViewed = localReads.isViewed;
  const isViewed = useCallback(
    (item: OperatorInboxItem) =>
      readScope === "operator" ? item.read === true : readScope === "browser_local" && isLocallyViewed(item),
    [readScope, isLocallyViewed],
  );
  async function acknowledge(items: OperatorInboxItem[]) {
    if (reading) return;
    const updates = items.filter((item) => inboxUpdateVersion(item, workspaceId) && !isViewed(item));
    if (!updates.length) return;
    setReading(true);
    setReadNotice("");
    try {
      if (readScope === "browser_local") {
        const saved = await Promise.all(
          updates.map((item) =>
            markInboxUpdateViewed(
              installation,
              workspaceId,
              item,
              () =>
                current.current.workspaceId === workspaceId &&
                getGatewayApiBaseUrl() === installation &&
                getGatewayAccessRevision() === accessRevision,
            ),
          ),
        );
        const failed = saved.some((value) => !value);
        if (failed) setReadNotice("Read storage unavailable. Unacknowledged updates remain unread.");
      } else if (readScope === "operator") {
        let skipped = 0;
        for (let offset = 0; offset < updates.length; offset += 200) {
          if (
            getGatewayAccessRevision() !== accessRevision ||
            getGatewayApiBaseUrl() !== installation ||
            current.current.workspaceId !== workspaceId
          )
            break;
          const result = await markOperatorInboxUpdatesRead(
            workspaceId,
            updates.slice(offset, offset + 200).map((item) => ({ id: item.id, version: item.version! })),
          );
          skipped += result.skipped.length;
        }
        if (skipped)
          setReadNotice(`${skipped} updates were not acknowledged. Changed or unavailable updates remain unread.`);
        await inbox.refetch();
      } else setReadNotice("Read storage unavailable. Unacknowledged updates remain unread.");
    } catch {
      setReadNotice("Read status could not be saved. Refresh to check current receipts.");
    } finally {
      setReading(false);
    }
  }
  const [showViewedScope, setShowViewedScope] = useState<string | null>(null);
  const showViewed = showViewedScope === scopeKey;
  const scopeMatches = inboxMatchesWorkspace(inbox.data, workspaceId);
  const projection = !inbox.isError && scopeMatches ? inbox.data : undefined;
  const visibleItems = useMemo(
    () => projection?.items.filter((item) => showViewed || !isViewed(item)) ?? [],
    [projection, showViewed, isViewed],
  );
  const orderedItems = useMemo(
    () =>
      INBOX_GROUPS.flatMap((group) =>
        visibleItems
          .filter((item) => item.group === group.id)
          .sort((a, b) => {
            const rank = { nuclear: 4, danger: 3, caution: 2, safe: 1 };
            return (
              rank[b.riskLevel ?? "safe"] - rank[a.riskLevel ?? "safe"] ||
              (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity) ||
              Date.parse(a.createdAt) - Date.parse(b.createdAt)
            );
          }),
      ),
    [visibleItems],
  );
  const [contextSelection, setContextSelection] = useState<{ scope: string; id: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shortcutsEnabled, setShortcutsEnabled] = useState(true);
  const priorItems = useRef<OperatorInboxItem[]>([]);
  const listHandles = useRef(new Map<string, WindowedRecordListHandle>());
  useEffect(() => {
    const previous = priorItems.current;
    priorItems.current = orderedItems;
    if (inbox.isFetching || !projection || !selectedId || orderedItems.some((item) => item.id === selectedId)) return;
    if (previous.find((item) => item.id === selectedId)?.group !== "needs_decision") return;
    const next = orderedItems.find((item) => item.group === "needs_decision");
    if (!next) return;
    setSelectedId(next.id);
    if (!document.querySelector('[role="dialog"]'))
      listHandles.current.get(next.group)?.focusRecord(next.id, "[data-inbox-detail]");
  }, [orderedItems, selectedId, inbox.isFetching, projection]);
  const mounted = useRef(true);
  const current = useRef({ installation, workspaceId, projection, fetching: inbox.isFetching });
  current.current = { installation, workspaceId, projection, fetching: inbox.isFetching };
  // Opened-detail receipts must use the latest acknowledge closure (reading guard, read scope, local reads)
  // without re-creating recordOpenedUpdate/inspect on every render.
  const acknowledgeRef = useRef(acknowledge);
  acknowledgeRef.current = acknowledge;
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
        latest.projection?.readStatus?.scopeId !== actorScope ||
        getGatewayAccessRevision() !== accessRevision ||
        !version ||
        !latest.projection?.items.some((entry) => inboxUpdateVersion(entry, workspaceId) === version)
      )
        return;
      void acknowledgeRef.current([item]);
    },
    [installation, workspaceId, actorScope, accessRevision],
  );

  const inspect = useCallback(
    (item: OperatorInboxItem, focusAction?: "approve" | "deny", explicitDetails = false) =>
      inspector.open({
        source: `inbox:${item.id}`,
        title: item.title,
        body: (
          <InboxInspectorBody
            item={item}
            workspaceId={workspaceId}
            installation={installation}
            focusAction={focusAction}
            explicitDetails={explicitDetails}
            onOpened={() => recordOpenedUpdate(item)}
          />
        ),
      }),
    [inspector, installation, workspaceId, recordOpenedUpdate],
  );

  useInboxLinkedItem({
    installation,
    activeCitadelId,
    workspaceId,
    linkedWorkspace,
    linkedItem,
    items: projection?.items,
    isFetching: inbox.isFetching,
    inspect,
    select: setSelectedId,
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!shortcutsEnabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !orderedItems.length)
        return;
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
  }, [inspect, orderedItems, selectedId, shortcutsEnabled]);

  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-fg">Inbox</h1>
          <p className="text-sm text-fg-secondary">Decisions and work that need your attention in this workspace.</p>
          <p className="mt-1 text-xs text-fg-muted">
            Review and answer decisions here. Open linked work for its current outcome.
          </p>
          <p className="mt-1 text-xs text-fg-muted max-sm:hidden pointer-coarse:hidden">
            Keys: J/K select · O details · A/D focus approval actions · E source link. Confirm to decide.
          </p>
          <label className="mt-2 flex items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={shortcutsEnabled}
              onChange={(event) => setShortcutsEnabled(event.target.checked)}
            />
            Enable Inbox letter shortcuts
          </label>
        </div>
        <Button size="sm" onClick={() => void inbox.refetch()} disabled={inbox.isFetching}>
          <RefreshCw aria-hidden="true" className="size-4" /> Refresh
        </Button>
      </header>

      {params.get("approvalId") ? (
        <LinkedApproval key={params.get("approvalId")} approvalId={params.get("approvalId")!} />
      ) : null}
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
          <InboxApprovalHistory key={workspaceId} workspaceId={workspaceId} />
          {INBOX_GROUPS.map((group) => {
            const allItems = projection.items.filter((item) => item.group === group.id);
            const items = orderedItems.filter((item) => item.group === group.id);
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
                      {allItems.length - viewedCount} unread · {viewedCount} read from shown updates.
                    </p>
                    <p>
                      {readScope === "operator"
                        ? "Read status is saved for this operator and workspace."
                        : readScope === "browser_local" && localReads.available
                          ? "Read status is browser-local for this installation and workspace."
                          : "Read storage unavailable."}
                    </p>
                    {readNotice ? <p role="status">{readNotice}</p> : null}
                    <Button
                      size="sm"
                      disabled={
                        reading ||
                        inbox.isFetching ||
                        allItems.length === viewedCount ||
                        readScope === "unavailable" ||
                        (readScope === "browser_local" && !localReads.available)
                      }
                      onClick={() => void acknowledge(allItems)}
                    >
                      Mark all shown updates read
                    </Button>
                    {viewedCount > 0 ? (
                      <Button size="sm" onClick={() => setShowViewedScope(showViewed ? null : scopeKey)}>
                        {showViewed ? "Hide read updates" : `Show read updates (${viewedCount})`}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {items.length === 0 ? (
                  <p className="text-sm text-fg-muted">
                    {group.id === "updates" && viewedCount > 0
                      ? "No unread updates from this response."
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
                      <InboxItemCard
                        item={item}
                        workspaceId={workspaceId}
                        selected={selectedId === item.id}
                        contextOpen={contextSelection?.scope === scopeKey && contextSelection.id === item.id}
                        onDetails={() => {
                          setSelectedId(item.id);
                          inspect(item, undefined, true);
                        }}
                        onToggleContext={() =>
                          setContextSelection(
                            contextSelection?.scope === scopeKey && contextSelection.id === item.id
                              ? null
                              : { scope: scopeKey, id: item.id },
                          )
                        }
                      />
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
