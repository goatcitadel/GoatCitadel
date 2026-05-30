import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, LayoutDashboard, RefreshCw } from "lucide-react";
import { bulkTaskAction, fetchTasksByView } from "@goatcitadel/mission-control-shared/api/client";
import type { TaskRecord } from "@goatcitadel/contracts";
import { NativePageFrame } from "../NativeRoutePageLayout";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import type { NativeRoutePagesProps } from "../types";
import { toKanbanCard, type KanbanCardModel, type KanbanColumnId } from "./kanban-card-model";
import "../native-routes.css";

const COLUMNS: Array<{ id: KanbanColumnId; label: string }> = [
  { id: "backlog", label: "Backlog" },
  { id: "in_progress", label: "In Progress" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];

type BulkAction = "unblock" | "retry" | "close";

export function KanbanRoutePage(props: NativeRoutePagesProps) {
  const [tasks, setTasks] = useState<TaskRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const isMounted = useIsMounted();
  // Monotonic request id drops superseded/late `fetchTasksByView` responses so
  // a slow earlier load cannot overwrite a newer workspace's board, and so a
  // resolution after unmount is ignored (MCNEXT-006 + MCNEXT-012).
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    const loadId = loadIdRef.current + 1;
    loadIdRef.current = loadId;
    const isCurrentLoad = () => loadIdRef.current === loadId;
    setLoading(true);
    try {
      const result = await fetchTasksByView("active", undefined, props.activeWorkspaceId);
      if (!isCurrentLoad()) {
        return;
      }
      setTasks(result.items as TaskRecord[]);
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

  const cards = useMemo<KanbanCardModel[]>(() => (tasks ?? []).map((task) => toKanbanCard(task)), [tasks]);

  const cardsByColumn = useMemo(() => {
    const groups: Record<KanbanColumnId, KanbanCardModel[]> = {
      backlog: [],
      in_progress: [],
      blocked: [],
      done: [],
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
        action === "retry" ? { action, taskIds: ids, reason: "operator-bulk-retry" } : { action, taskIds: ids };
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
    [isMounted, load, selected],
  );

  const hasSelection = selected.size > 0;

  return (
    <NativePageFrame
      icon={LayoutDashboard}
      kicker="Ops"
      title="Kanban"
      description="Multi-agent board with distress signals, retry budgets, and bulk operator controls."
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
        {cards.map((card) => (
          <KanbanCard
            key={card.taskId}
            card={card}
            checked={selected.has(card.taskId)}
            onToggleSelect={() => onToggleSelect(card.taskId)}
          />
        ))}
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
    <li className="mc-next-kanban-card">
      <label>
        <input
          type="checkbox"
          data-testid={`kanban-select-${card.taskId}`}
          checked={checked}
          onChange={onToggleSelect}
        />
        <span className="title">{card.title}</span>
      </label>
      {card.assignedAgentId ? <small>{card.assignedAgentId}</small> : null}
      {card.retryDisplay ? (
        <span className="retry">
          <RefreshCw className="h-3 w-3" /> {card.retryDisplay}
        </span>
      ) : null}
      {card.distressSummary.critical > 0 ? (
        <span data-testid={`distress-chip-${card.taskId}`} className="distress critical">
          <AlertTriangle className="h-3 w-3" /> {card.distressSummary.critical} critical
        </span>
      ) : card.distressSummary.warn > 0 ? (
        <span data-testid={`distress-chip-${card.taskId}`} className="distress warn">
          <Activity className="h-3 w-3" /> {card.distressSummary.warn} warn
        </span>
      ) : null}
      {typeof card.lastHeartbeatAgeSeconds === "number" ? (
        <small className="heartbeat">{card.lastHeartbeatAgeSeconds}s ago</small>
      ) : null}
    </li>
  );
}
