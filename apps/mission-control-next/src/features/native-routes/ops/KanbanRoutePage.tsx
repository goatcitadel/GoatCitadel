import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Ref,
} from "react";
import { Activity, AlertTriangle, LayoutDashboard, RefreshCw, Users } from "lucide-react";
import { Virtuoso, type Components } from "react-virtuoso";
import { bulkTaskAction, fetchAgenticRuns } from "@goatcitadel/mission-control-shared/api/client";
import type { AgenticRunListItem } from "@goatcitadel/contracts";
import { getRouteReleaseScope, routeKicker } from "@next/app/route-model";
import { NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner, StatusChip } from "../primitives";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import type { NativeRoutePagesProps } from "../types";
import { toKanbanCard, type KanbanCardModel, type KanbanColumnId } from "./kanban-card-model";
import "../native-routes.css";

const COLUMNS: Array<{ id: KanbanColumnId; label: string }> = [
  { id: "queued", label: "Queued" },
  { id: "running", label: "Running" },
  { id: "needs_attention", label: "Needs Attention" },
  { id: "closed", label: "Closed" },
];

// Window a column's cards only once it gets long enough that offscreen DOM
// actually costs something. Short columns render plainly so tiny lanes avoid
// Virtuoso's measurement pass (and so react-test-renderer, which has no layout,
// still renders every card for assertions).
const KANBAN_VIRTUALIZE_THRESHOLD = 24;

type BulkAction = "unblock" | "retry" | "close";

const KANBAN_STATUS_CHIP_TONE = {
  neutral: "neutral",
  active: "live",
  warning: "warning",
  danger: "critical",
  success: "success",
} as const;

export function KanbanRoutePage(props: NativeRoutePagesProps) {
  const [runs, setRuns] = useState<AgenticRunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const isMounted = useIsMounted();
  // Monotonic request id drops superseded/late run-list responses so
  // a slow earlier load cannot overwrite a newer workspace's board, and so a
  // resolution after unmount is ignored (MCNEXT-006 + MCNEXT-012).
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    const loadId = loadIdRef.current + 1;
    loadIdRef.current = loadId;
    const isCurrentLoad = () => loadIdRef.current === loadId;
    setLoading(true);
    try {
      const result = await fetchAgenticRuns({ workspaceId: props.activeWorkspaceId, limit: 200 });
      if (!isCurrentLoad()) {
        return;
      }
      setRuns(result.items);
      setError(null);
      setActionError(null);
    } catch (e) {
      if (isCurrentLoad()) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (isCurrentLoad()) {
        setLoading(false);
      }
    }
  }, [props.activeWorkspaceId]);

  useEffect(() => {
    void load();
    return () => {
      // Supersede any in-flight load on unmount/workspace switch.
      loadIdRef.current += 1;
    };
  }, [load]);

  const cards = useMemo<KanbanCardModel[]>(() => (runs ?? []).map((run) => toKanbanCard(run)), [runs]);

  const cardsByColumn = useMemo(() => {
    const groups: Record<KanbanColumnId, KanbanCardModel[]> = {
      queued: [],
      running: [],
      needs_attention: [],
      closed: [],
    };
    for (const card of cards) {
      groups[card.column].push(card);
    }
    return groups;
  }, [cards]);

  const toggleSelect = useCallback((taskId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, []);

  const runBulk = useCallback(
    async (action: BulkAction) => {
      const ids = Array.from(selected);
      if (ids.length === 0) {
        return;
      }
      const body =
        action === "retry"
          ? { action, taskIds: ids, reason: "operator-bulk-retry", workspaceId: props.activeWorkspaceId }
          : { action, taskIds: ids, workspaceId: props.activeWorkspaceId };
      setBulkBusy(true);
      setActionError(null);
      setNotice(null);
      try {
        await bulkTaskAction(body);
        if (!isMounted()) {
          return;
        }
        setSelected(new Set());
        setNotice(`${ids.length} selected task${ids.length === 1 ? "" : "s"} updated.`);
        await load();
      } catch (err) {
        if (isMounted()) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (isMounted()) {
          setBulkBusy(false);
        }
      }
    },
    [isMounted, load, props.activeWorkspaceId, selected],
  );

  const hasSelection = selected.size > 0;

  return (
    <NativePageFrame
      icon={LayoutDashboard}
      kicker={routeKicker(props.route)}
      title="Kanban"
      description="Agentic run board with stale-run detection, diagnostics, and bulk operator controls."
      loading={loading}
      // Only a failed run-list fetch (error) is fatal — it leaves the board null/stale,
      // so the frame replaces it (Finding 10). A failed bulk action (actionError) must
      // stay non-fatal: the board data is still valid and the operator's selection must
      // remain visible, so it renders as an inline banner below instead of nuking the board.
      error={error}
      releaseStatus={getRouteReleaseScope(props.route).status}
      actions={
        <NativeButton
          variant="secondary"
          className="mc-next-kanban-action"
          onClick={() => props.navigate({ area: "ops", section: "kanban", theme: props.route.theme })}
        >
          <Users className="h-3 w-3" /> Run Board
        </NativeButton>
      }
    >
      <div className="mc-next-kanban-toolbar" role="toolbar" aria-label="Agentic run bulk actions">
        <NativeButton
          variant="default"
          className="mc-next-kanban-action"
          disabled={!hasSelection || bulkBusy}
          onClick={() => void runBulk("unblock")}
        >
          Unblock
        </NativeButton>
        <NativeButton
          variant="outline"
          className="mc-next-kanban-action"
          disabled={!hasSelection || bulkBusy}
          onClick={() => void runBulk("retry")}
        >
          Retry
        </NativeButton>
        <NativeButton
          variant="outline"
          className="mc-next-kanban-action"
          disabled={!hasSelection || bulkBusy}
          onClick={() => void runBulk("close")}
        >
          Close
        </NativeButton>
        <NativeButton
          variant="secondary"
          className="mc-next-kanban-action"
          disabled={bulkBusy}
          onClick={() => void load()}
        >
          <RefreshCw className="h-3 w-3" /> Refresh
        </NativeButton>
      </div>
      {actionError ? (
        <div data-testid="kanban-action-error">
          <NoticeBanner tone="error" message={actionError} />
        </div>
      ) : null}
      {notice ? (
        <div data-testid="kanban-notice">
          <NoticeBanner tone="success" message={notice} />
        </div>
      ) : null}
      <div className="mc-next-kanban-board" data-testid="kanban-board">
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col.id}
            column={col}
            cards={cardsByColumn[col.id]}
            selected={selected}
            onToggleSelect={toggleSelect}
          />
        ))}
      </div>
    </NativePageFrame>
  );
}

interface KanbanColumnProps {
  column: { id: KanbanColumnId; label: string };
  cards: KanbanCardModel[];
  selected: Set<string>;
  onToggleSelect: (taskId: string) => void;
}

function KanbanColumn({ column, cards, selected, onToggleSelect }: KanbanColumnProps) {
  // Window long columns. Each KanbanCard is memoized and receives a primitive
  // `checked` plus the stable `onToggleSelect`, so toggling one selection only
  // re-renders the cards whose membership actually changed.
  const renderCard = useCallback(
    (_index: number, card: KanbanCardModel) => (
      <KanbanCard
        card={card}
        checked={selected.has(card.taskId)}
        onToggleSelect={onToggleSelect}
        containerElement="div"
      />
    ),
    [selected, onToggleSelect],
  );

  return (
    <section className="mc-next-kanban-column" data-testid={`kanban-column-${column.id}`}>
      <header>
        <h3>{column.label}</h3>
        <span className="count">{cards.length}</span>
      </header>
      {cards.length === 0 ? (
        <ul>
          <li className="mc-next-kanban-empty">
            <EmptyState size="compact" title="No runs in this lane." />
          </li>
        </ul>
      ) : cards.length > KANBAN_VIRTUALIZE_THRESHOLD ? (
        <Virtuoso
          data={cards}
          computeItemKey={(_index, card) => `${card.runId}:${card.taskId}`}
          itemContent={renderCard}
          className="mc-next-kanban-column-scroller"
          data-native-scroll="true"
          components={KANBAN_VIRTUOSO_COMPONENTS}
          increaseViewportBy={{ top: 240, bottom: 360 }}
        />
      ) : (
        <ul>
          {cards.map((card) => (
            <KanbanCard
              key={`${card.runId}:${card.taskId}`}
              card={card}
              checked={selected.has(card.taskId)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// Virtuoso renders its rows inside a plain scroller; reuse the <ul> semantics so
// virtualized and plain columns keep the same list markup/roles. Virtuoso types
// the List ref as a div, so accept that contract and forward it to the <ul>.
const KANBAN_VIRTUOSO_COMPONENTS: Components<KanbanCardModel> = {
  List: forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"ul">>(function KanbanVirtuosoList(props, ref) {
    return <ul {...props} ref={ref as Ref<HTMLUListElement>} />;
  }),
  Item: forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"li">>(function KanbanVirtuosoItem(props, ref) {
    return <li {...props} ref={ref as Ref<HTMLLIElement>} />;
  }),
};

interface KanbanCardProps {
  card: KanbanCardModel;
  checked: boolean;
  onToggleSelect: (taskId: string) => void;
  containerElement?: "li" | "div";
}

export const KanbanCard = memo(function KanbanCard({
  card,
  checked,
  onToggleSelect,
  containerElement = "li",
}: KanbanCardProps) {
  const handleToggle = useCallback(() => onToggleSelect(card.taskId), [onToggleSelect, card.taskId]);
  const content = (
    <>
      <label>
        <input
          type="checkbox"
          data-testid={`kanban-select-${card.taskId}`}
          checked={checked}
          onChange={handleToggle}
          aria-label={`Select ${card.title}`}
        />
        <span className="title">{card.title}</span>
      </label>
      <div className="mc-next-kanban-card-meta">
        <span>{card.surfaceLabel}</span>
        <span>{card.updatedDisplay}</span>
      </div>
      <span className="mc-next-kanban-status-chip">
        <StatusChip tone={KANBAN_STATUS_CHIP_TONE[card.statusTone]} icon={<Activity className="h-3 w-3" />}>
          {card.statusLabel}
        </StatusChip>
      </span>
      {card.attentionReason ? <small>{card.attentionReason}</small> : null}
      {card.contextMode || card.profileId ? (
        <small>
          {[
            card.contextMode ? `Context: ${card.contextMode}` : null,
            card.profileId ? `Profile: ${card.profileId}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      ) : null}
      {card.diagnosticSummary.critical > 0 ? (
        <span data-testid={`diagnostic-chip-${card.taskId}`} className="distress critical">
          <AlertTriangle className="h-3 w-3" /> {card.diagnosticSummary.critical} critical
        </span>
      ) : card.diagnosticSummary.warning > 0 ? (
        <span data-testid={`diagnostic-chip-${card.taskId}`} className="distress warn">
          <Activity className="h-3 w-3" /> {card.diagnosticSummary.warning} warning
        </span>
      ) : null}
      <small className="run-id" title={`Run ${card.runId}`}>
        Run {card.runId.slice(0, 8)}
      </small>
    </>
  );
  return containerElement === "div" ? (
    <div className={`mc-next-kanban-card tone-${card.statusTone}`}>{content}</div>
  ) : (
    <li className={`mc-next-kanban-card tone-${card.statusTone}`}>{content}</li>
  );
});
