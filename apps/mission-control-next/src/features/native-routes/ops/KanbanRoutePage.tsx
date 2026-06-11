import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, LayoutDashboard, RefreshCw } from "lucide-react";
import { bulkTaskAction, fetchAgenticRuns } from "@goatcitadel/mission-control-shared/api/client";
import type { AgenticRunListItem } from "@goatcitadel/contracts";
import { NativePageFrame } from "../NativeRoutePageLayout";
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

type BulkAction = "unblock" | "retry" | "close";

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
      kicker="Ops"
      title="Kanban"
      description="Agentic run board with stale-run detection, diagnostics, and bulk operator controls."
      loading={loading}
      error={actionError ?? error}
    >
      <div className="mc-next-kanban-toolbar">
        <button type="button" disabled={!hasSelection || bulkBusy} onClick={() => void runBulk("unblock")}>
          Unblock
        </button>
        <button type="button" disabled={!hasSelection || bulkBusy} onClick={() => void runBulk("retry")}>
          Retry
        </button>
        <button type="button" disabled={!hasSelection || bulkBusy} onClick={() => void runBulk("close")}>
          Close
        </button>
        <button type="button" disabled={bulkBusy} onClick={() => void load()}>
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>
      {notice ? (
        <div className="mc-next-runtime-notice tone-success" data-testid="kanban-notice">
          <span>{notice}</span>
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
  return (
    <section className="mc-next-kanban-column" data-testid={`kanban-column-${column.id}`}>
      <header>
        <h3>{column.label}</h3>
        <span className="count">{cards.length}</span>
      </header>
      <ul>
        {cards.length > 0 ? (
          cards.map((card) => (
            <KanbanCard
              key={`${card.runId}:${card.taskId}`}
              card={card}
              checked={selected.has(card.taskId)}
              onToggleSelect={() => onToggleSelect(card.taskId)}
            />
          ))
        ) : (
          <li className="mc-next-kanban-empty">No runs in this lane.</li>
        )}
      </ul>
    </section>
  );
}

interface KanbanCardProps {
  card: KanbanCardModel;
  checked: boolean;
  onToggleSelect: () => void;
}

function KanbanCard({ card, checked, onToggleSelect }: KanbanCardProps) {
  return (
    <li className={`mc-next-kanban-card tone-${card.statusTone}`}>
      <label>
        <input
          type="checkbox"
          data-testid={`kanban-select-${card.taskId}`}
          checked={checked}
          onChange={onToggleSelect}
          aria-label={`Select ${card.title}`}
        />
        <span className="title">{card.title}</span>
      </label>
      <div className="mc-next-kanban-card-meta">
        <span>{card.surfaceLabel}</span>
        <span>{card.updatedDisplay}</span>
      </div>
      <span className={`mc-next-kanban-status tone-${card.statusTone}`}>
        <Activity className="h-3 w-3" /> {card.statusLabel}
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
    </li>
  );
}
