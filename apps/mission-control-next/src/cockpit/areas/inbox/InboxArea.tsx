import { LinkedApproval } from "./LinkedApproval";
import { InboxApprovalHistory } from "./InboxApprovalHistory";
import { InboxBulkRejectZone } from "./InboxBulkRejectZone";
import { markOperatorInboxUpdatesRead } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import type { WindowedRecordListHandle } from "../../ui/WindowedRecordList";
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
import { inboxCountIsExact, inboxMatchesWorkspace } from "./inbox-presentation";
import {
  compareInboxItems,
  INBOX_VIEW_GROUPS,
  inboxFiltersActive,
  inboxViewGroup,
  matchesInboxFilters,
  NO_INBOX_FILTERS,
  type InboxFilters,
} from "./inbox-triage";
import { InboxFilterBar } from "./InboxFilterBar";
import { InboxGroupSection } from "./InboxGroupSection";
import { useInboxShortcuts } from "./use-inbox-shortcuts";
import { useInboxDecisionFocus } from "./use-inbox-decision-focus";
import { useMinuteClock } from "./use-minute-clock";
import { useInboxAnnouncer } from "./use-inbox-announcer";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { InboxCoverageSummary, InboxEmptyState } from "./InboxCoverageSummary";
import { InboxShortcutsPanel, InboxShortcutsToggle } from "./InboxShortcutsControl";
import { InboxUpdatesControls } from "./InboxUpdatesControls";
import { useInboxShortcutsPreference } from "./inbox-shortcuts-preference";
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
          setReadNotice(
            `${plural(skipped, "update was", "updates were")} not acknowledged. Changed or unavailable updates remain unread.`,
          );
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
  const [filterState, setFilterState] = useState<{ scope: string; filters: InboxFilters } | null>(null);
  const filters = filterState?.scope === scopeKey ? filterState.filters : NO_INBOX_FILTERS;
  const filtered = inboxFiltersActive(filters);
  const now = useMinuteClock();
  const groupOf = useCallback((item: OperatorInboxItem) => inboxViewGroup(item, now), [now]);
  const orderedItems = useMemo(
    () =>
      INBOX_VIEW_GROUPS.flatMap((group) =>
        visibleItems
          .filter((item) => groupOf(item) === group.id && matchesInboxFilters(item, filters))
          .sort(compareInboxItems),
      ),
    [visibleItems, groupOf, filters],
  );
  // Empty groups are hidden; a group shows once it has a shown or read item or a known count (IN-10).
  const expiredCount = projection?.items.filter((item) => groupOf(item) === "expired").length ?? 0;
  const shownGroups = projection
    ? INBOX_VIEW_GROUPS.map((group) => {
        const allItems = projection.items.filter((item) => groupOf(item) === group.id);
        if (group.id === "expired") return { group, allItems, known: allItems.length, complete: true };
        const count = projection.counts[group.id];
        // Expired decisions are listed under Expired, so Needs decision counts only those still open (IN-05).
        const known = group.id === "needs_decision" ? Math.max(0, count.known - expiredCount) : count.known;
        return { group, allItems, known, complete: count.complete };
      }).filter(({ allItems, known }) => allItems.length > 0 || known > 0)
    : [];
  // The installation-wide rejection shows while this page has open decisions (IN-R01). Once shown it stays for this
  // scope, so the receipt of a successful rejection survives the re-read that empties the page.
  const hasOpenDecisions = shownGroups.some(
    ({ group, allItems }) => group.id === "needs_decision" && allItems.length > 0,
  );
  const [bulkRejectScope, setBulkRejectScope] = useState<string | null>(null);
  if (hasOpenDecisions && bulkRejectScope !== scopeKey) setBulkRejectScope(scopeKey);
  const showBulkReject = hasOpenDecisions || bulkRejectScope === scopeKey;
  const { announce, region: announcer } = useInboxAnnouncer();
  const [contextSelection, setContextSelection] = useState<{ scope: string; id: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shortcutsEnabled, setShortcutsEnabled] = useInboxShortcutsPreference();
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const priorItems = useRef<OperatorInboxItem[]>([]);
  const listHandles = useRef(new Map<string, WindowedRecordListHandle>());
  const decisionFocus = useInboxDecisionFocus({ orderedItems, groupOf, listHandles, select: setSelectedId, announce });
  useEffect(() => {
    const previous = priorItems.current;
    priorItems.current = orderedItems;
    if (inbox.isFetching || !projection || !selectedId || orderedItems.some((item) => item.id === selectedId)) return;
    if (previous.find((item) => item.id === selectedId)?.group !== "needs_decision") return;
    const next = orderedItems.find((item) => groupOf(item) === "needs_decision");
    if (!next) return;
    setSelectedId(next.id);
    // A decision made here moves focus through its own owner; this only recovers focus lost with a removed row.
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (lost && !decisionFocus.focusPending() && !document.querySelector('[role="dialog"]'))
      listHandles.current.get(groupOf(next))?.focusRecord(next.id, "[data-inbox-detail]");
  }, [orderedItems, selectedId, inbox.isFetching, projection, groupOf, decisionFocus]);
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

  // The inspector body is a snapshot; it reaches the current decision owner through this ref.
  const decisionRef = useRef(decisionFocus.onDecision);
  decisionRef.current = decisionFocus.onDecision;
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
            onDecision={(message, settled) => decisionRef.current(item, message, settled)}
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

  useInboxShortcuts({
    enabled: shortcutsEnabled,
    orderedItems,
    selectedId,
    select: setSelectedId,
    inspect,
    inspectorShowsInboxItem: Boolean(inspector.content?.source?.startsWith("inbox:")),
    groupOf,
    listHandles,
    announce,
  });

  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Inbox"
        description="Decisions and work that need your attention in this workspace."
        actions={
          <>
            <InboxShortcutsToggle open={shortcutHelpOpen} onOpenChange={setShortcutHelpOpen} />
            <Button size="sm" onClick={() => void inbox.refetch()} disabled={inbox.isFetching}>
              <RefreshCw aria-hidden="true" className="size-4" /> Refresh
            </Button>
          </>
        }
      >
        {shortcutHelpOpen ? (
          <InboxShortcutsPanel enabled={shortcutsEnabled} onEnabledChange={setShortcutsEnabled} />
        ) : null}
      </AreaHeader>
      {announcer}

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
          title="Some items couldn't be checked"
          description="The Inbox returned items from outside the selected workspace, so no items or counts are shown."
          action={<Button onClick={() => void inbox.refetch()}>Try again</Button>}
        />
      ) : null}

      {projection ? (
        <>
          {shownGroups.length ? (
            <InboxCoverageSummary projection={projection} />
          ) : (
            <InboxEmptyState projection={projection} />
          )}
          {shownGroups.length ? (
            <InboxFilterBar
              items={visibleItems}
              shownCount={orderedItems.length}
              filters={filters}
              onChange={(next) => setFilterState({ scope: scopeKey, filters: next })}
            />
          ) : null}
          {shownGroups.map(({ group, allItems, known, complete }) => {
            const viewedCount = allItems.filter(isViewed).length;
            const exact = inboxCountIsExact(projection, complete);
            return (
              <InboxGroupSection
                key={group.id}
                group={group}
                items={orderedItems.filter((item) => groupOf(item) === group.id)}
                known={known}
                exact={exact}
                filtered={filtered}
                selectedId={selectedId}
                emptyMessage={
                  filtered
                    ? "Nothing here matches the filters."
                    : group.id === "updates" && viewedCount > 0
                      ? "No unread updates."
                      : exact
                        ? "Nothing waiting here."
                        : "Nothing found here, but not every source could be checked."
                }
                controls={
                  group.id === "updates" ? (
                    <InboxUpdatesControls
                      shownCount={allItems.length}
                      viewedCount={viewedCount}
                      readScope={readScope}
                      localReadsAvailable={localReads.available}
                      readNotice={readNotice}
                      reading={reading}
                      showViewed={showViewed}
                      onMarkAllRead={() => void acknowledge(allItems)}
                      onToggleShowViewed={() => setShowViewedScope(showViewed ? null : scopeKey)}
                    />
                  ) : null
                }
                listRef={(handle) => {
                  if (handle) listHandles.current.set(group.id, handle);
                  else listHandles.current.delete(group.id);
                }}
                renderItem={(item) => (
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
              />
            );
          })}
          {/* History follows the decisions it records; the installation-wide rejection comes last, and only while this
              page has open decisions, so an empty Inbox stays one state (IN-02, IN-10, IN-R01, IN-N08). */}
          <InboxApprovalHistory key={workspaceId} workspaceId={workspaceId} />
          {showBulkReject ? <InboxBulkRejectZone /> : null}
        </>
      ) : null}
    </section>
  );
}
