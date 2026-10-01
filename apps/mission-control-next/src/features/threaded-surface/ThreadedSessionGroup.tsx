import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ChatMode, ChatSessionRecord, ChatSessionSearchHitRecord } from "@goatcitadel/contracts";

type SessionGroupItem = {
  sessionId: string;
  title?: string | null;
  updatedAt?: string;
  projectName?: string | null;
  folderName?: string | null;
  tags?: string[];
  channel?: string | null;
  account?: string | null;
  mode?: ChatMode | null;
  pinned?: boolean;
  lifecycleStatus?: ChatSessionRecord["lifecycleStatus"];
  tokenTotal?: number;
  costUsdTotal?: number;
  pinnedGoal?: string;
  generatedArtifacts?: ChatSessionRecord["generatedArtifacts"];
  delegationParent?: ChatSessionRecord["delegationParent"];
  searchHits?: ChatSessionSearchHitRecord[];
};

export function SessionGroup({
  title,
  items,
  count,
  selectedSessionId,
  onSelectSession,
  renderSessionLabel,
  nestedChildrenByParentId,
  orphanDelegatedItems = [],
  emptyCopy = "No sessions in this lane yet.",
}: {
  title: string;
  items: SessionGroupItem[];
  count?: number;
  selectedSessionId: string | null;
  onSelectSession: (
    sessionId: string,
    options?: { turnId?: string | null; searchHit?: ChatSessionSearchHitRecord },
  ) => void;
  renderSessionLabel: (sessionId: string) => string;
  nestedChildrenByParentId?: Record<string, SessionGroupItem[]>;
  orphanDelegatedItems?: SessionGroupItem[];
  emptyCopy?: string;
}) {
  const [collapsedParents, setCollapsedParents] = useState<Record<string, boolean>>({});
  const selectedParentId = useMemo(() => {
    if (!selectedSessionId || !nestedChildrenByParentId) {
      return null;
    }
    return (
      Object.entries(nestedChildrenByParentId).find(([, children]) =>
        children.some((child) => child.sessionId === selectedSessionId),
      )?.[0] ?? null
    );
  }, [nestedChildrenByParentId, selectedSessionId]);
  useEffect(() => {
    if (!nestedChildrenByParentId) {
      return;
    }
    setCollapsedParents((current) => {
      let changed = false;
      const next = { ...current };
      for (const parentId of Object.keys(nestedChildrenByParentId)) {
        if (next[parentId] === undefined) {
          next[parentId] = true;
          changed = true;
        }
        if (parentId === selectedParentId && next[parentId]) {
          next[parentId] = false;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [nestedChildrenByParentId, selectedParentId]);
  const hasVisibleItems = items.length > 0 || orphanDelegatedItems.length > 0;

  return (
    <section className="mc-next-threaded-session-group" aria-label={title}>
      <div className="mc-next-threaded-group-head">
        <h3>{title}</h3>
        <span aria-hidden="true">{count ?? items.length}</span>
      </div>
      {hasVisibleItems ? (
        <div className="mc-next-threaded-session-list">
          {items.map((item) => {
            const children = nestedChildrenByParentId?.[item.sessionId] ?? [];
            const collapsed = collapsedParents[item.sessionId] ?? children.length > 0;
            const childrenControlsId = `mc-next-threaded-session-children-${encodeURIComponent(item.sessionId)}`;
            return (
              <div key={item.sessionId} className="mc-next-threaded-session-tree-node">
                <SessionRow
                  item={item}
                  selectedSessionId={selectedSessionId}
                  onSelectSession={onSelectSession}
                  renderSessionLabel={renderSessionLabel}
                  childCount={children.length}
                  collapsed={collapsed}
                  childrenControlsId={children.length > 0 ? childrenControlsId : undefined}
                  onToggleChildren={
                    children.length > 0
                      ? () =>
                          setCollapsedParents((current) => ({
                            ...current,
                            [item.sessionId]: !collapsed,
                          }))
                      : undefined
                  }
                />
                {children.length > 0 ? (
                  <div
                    id={childrenControlsId}
                    className="mc-next-threaded-session-children"
                    hidden={collapsed}
                    aria-hidden={collapsed}
                  >
                    {collapsed
                      ? null
                      : children.map((child) => (
                          <SessionRow
                            key={child.sessionId}
                            item={child}
                            selectedSessionId={selectedSessionId}
                            onSelectSession={onSelectSession}
                            renderSessionLabel={renderSessionLabel}
                            nested
                          />
                        ))}
                  </div>
                ) : null}
              </div>
            );
          })}
          {orphanDelegatedItems.length > 0 ? (
            <div className="mc-next-threaded-orphan-delegates">
              <div className="mc-next-threaded-orphan-delegates-head">
                <span>Delegated tasks</span>
                <span>{orphanDelegatedItems.length}</span>
              </div>
              {orphanDelegatedItems.map((child) => (
                <SessionRow
                  key={child.sessionId}
                  item={child}
                  selectedSessionId={selectedSessionId}
                  onSelectSession={onSelectSession}
                  renderSessionLabel={renderSessionLabel}
                  nested
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mc-next-threaded-empty-copy">{emptyCopy}</p>
      )}
    </section>
  );
}

function SessionRow({
  item,
  selectedSessionId,
  onSelectSession,
  renderSessionLabel,
  childCount = 0,
  collapsed = false,
  childrenControlsId,
  onToggleChildren,
  nested = false,
}: {
  item: SessionGroupItem;
  selectedSessionId: string | null;
  onSelectSession: (
    sessionId: string,
    options?: { turnId?: string | null; searchHit?: ChatSessionSearchHitRecord },
  ) => void;
  renderSessionLabel: (sessionId: string) => string;
  childCount?: number;
  collapsed?: boolean;
  childrenControlsId?: string;
  onToggleChildren?: () => void;
  nested?: boolean;
}) {
  const label = item.title?.trim() || renderSessionLabel(item.sessionId);
  const mode: ChatMode = "chat";
  const delegatedLabel = item.delegationParent?.label?.trim() || item.delegationParent?.role?.trim();
  const meta = delegatedLabel
    ? `Delegated task · ${delegatedLabel}`
    : item.projectName?.trim() ||
      item.folderName?.trim() ||
      item.channel?.trim() ||
      item.account?.trim() ||
      "Workspace session";
  const updatedAtLabel = formatRelativeTime(item.updatedAt);
  const metadataChips = getSessionMetadataChips(item);

  return (
    <div className={`mc-next-threaded-session-row-shell${nested ? " nested" : ""}`}>
      <button
        type="button"
        className={`mc-next-threaded-session-row mode-${mode}${selectedSessionId === item.sessionId ? " active" : ""}`}
        onClick={() => onSelectSession(item.sessionId)}
        title={label}
      >
        <div className="mc-next-threaded-session-row-main">
          <div className="mc-next-threaded-session-row-copy">
            <span className="mc-next-threaded-mode-label mode-chat">Chat</span>
            <div className="mc-next-threaded-session-titleline">
              <strong>{label}</strong>
              <time className="mc-next-threaded-session-time" dateTime={item.updatedAt}>
                {updatedAtLabel}
              </time>
            </div>
            <span title={meta}>{meta}</span>
            {metadataChips.length > 0 ? (
              <div className="mc-next-threaded-session-meta-chips" aria-label="Session metadata">
                {metadataChips.map((chip) => (
                  <span key={chip}>{chip}</span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </button>
      {item.searchHits && item.searchHits.length > 0 ? (
        <div className="mc-next-threaded-search-hits" aria-label={`Search results in ${label}`}>
          {item.searchHits.map((hit) => (
            <button
              key={`${hit.messageId}:${hit.sequence}`}
              type="button"
              className="mc-next-threaded-search-hit"
              onClick={() => onSelectSession(item.sessionId, { searchHit: hit })}
              aria-label="Open exact search result"
            >
              <span>Message match</span>
              <mark>{hit.excerpt}</mark>
            </button>
          ))}
        </div>
      ) : null}
      {onToggleChildren ? (
        <button
          type="button"
          className="mc-next-threaded-session-toggle"
          onClick={onToggleChildren}
          aria-label={collapsed ? "Expand delegated chats" : "Collapse delegated chats"}
          aria-expanded={!collapsed}
          aria-controls={childrenControlsId}
          title={collapsed ? "Expand delegated chats" : "Collapse delegated chats"}
        >
          <span>{childCount}</span>
          <ChevronRight size={14} className={collapsed ? "" : "open"} />
        </button>
      ) : null}
    </div>
  );
}

function getSessionMetadataChips(item: SessionGroupItem): string[] {
  const chips: string[] = [];
  if (item.pinned) {
    chips.push("Pinned");
  }
  if (item.lifecycleStatus === "archived") {
    chips.push("Archived");
  }
  if (item.pinnedGoal?.trim()) {
    chips.push("Goal");
  }
  if (item.tags?.length) {
    chips.push(...item.tags.slice(0, 2));
  }
  if ((item.generatedArtifacts?.length ?? 0) > 0) {
    chips.push(`${item.generatedArtifacts!.length} artifact${item.generatedArtifacts!.length === 1 ? "" : "s"}`);
  }
  if ((item.tokenTotal ?? 0) > 0) {
    chips.push(formatCompactSessionNumber(item.tokenTotal!, "token"));
  }
  if ((item.costUsdTotal ?? 0) > 0) {
    chips.push(formatCompactUsd(item.costUsdTotal!));
  }
  return chips.slice(0, 4);
}

function formatCompactSessionNumber(value: number, unit: string): string {
  return `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)} ${unit}${
    value === 1 ? "" : "s"
  }`;
}

function formatCompactUsd(value: number): string {
  if (value < 0.01) {
    return "<$0.01";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

export function formatRelativeTime(value?: string): string {
  if (!value) {
    return "Recent";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "Recent";
  }
  const deltaMinutes = Math.max(1, Math.round((Date.now() - timestamp) / 60000));
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}
