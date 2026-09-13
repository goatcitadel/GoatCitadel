import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { DetailInspector } from "../../../components/DetailInspector";
import { useDraftLeave } from "../library/DraftLeaveDialog";
import { hasSessionDraft, useSessionDraftVersion } from "../library/session-drafts";
import { fetchTasksByView } from "@goatcitadel/mission-control-shared/api/tasks";
import { KanbanNewTask } from "./KanbanNewTask";
import { KanbanTaskInspector } from "./KanbanTaskInspector";
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
import { Activity, AlertTriangle, LayoutDashboard, RefreshCw } from "lucide-react";
import { Virtuoso, type Components } from "react-virtuoso";
import {
  ApiRequestError,
  bulkTaskAction,
  fetchAgenticRuns,
  type BulkTaskActionInput,
} from "@goatcitadel/mission-control-shared/api/client";
import type { AgenticRunListItem } from "@goatcitadel/contracts";
import { getRouteReleaseScope, routeKicker } from "@next/app/route-model";
import { NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner, StatusChip } from "../primitives";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import type { NativeRoutePagesProps } from "../types";
import { toKanbanCard, toTaskKanbanCard, type KanbanCardModel, type KanbanColumnId } from "./kanban-card-model";
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

interface PendingBulkConflict {
  action: BulkAction;
  taskIds: string[];
}

const KANBAN_STATUS_CHIP_TONE = {
  neutral: "neutral",
  active: "live",
  warning: "warning",
  danger: "critical",
  success: "success",
} as const;

export function KanbanRoutePage(props: NativeRoutePagesProps) {
  return <KanbanWorkspacePage key={(props.activeCitadelId ?? "") + ":" + props.activeWorkspaceId} {...props} />;
}
function KanbanWorkspacePage(props: NativeRoutePagesProps) {
  const leave = useDraftLeave();
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useSessionDraftVersion();
  const [creating, setCreating] = useState(false);
  const [inspected, setInspected] = useState<{ taskId: string; runId: string } | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [runCursor, setRunCursor] = useState<string | undefined>();
  const [taskCursor, setTaskCursor] = useState<string | undefined>();
  const [moreBusy, setMoreBusy] = useState(false);
  const moreLock = useRef(false),
    bulkLock = useRef(false);
  const pageCounts = useRef({ runs: 1, tasks: 1 });
  const [runs, setRuns] = useState<AgenticRunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingConflict, setPendingConflict] = useState<PendingBulkConflict | null>(null);
  const isMounted = useIsMounted();
  // Monotonic request id drops superseded/late run-list responses so
  // a slow earlier load cannot overwrite a newer workspace's board, and so a
  // resolution after unmount is ignored (MCNEXT-006 + MCNEXT-012).
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    setLoading(true);
    const [runResult, taskResult] = await Promise.allSettled([
      readKanbanPages(
        (cursor) =>
          fetchAgenticRuns({ workspaceId: props.activeWorkspaceId, limit: 200, ...(cursor ? { cursor } : {}) }),
        pageCounts.current.runs,
        (item) => item.runId + ":" + item.taskId,
      ),
      readKanbanPages(
        (cursor) =>
          fetchTasksByView("active", undefined, props.activeWorkspaceId, {
            citadelId: props.activeCitadelId,
            limit: 200,
            ...(cursor ? { cursor } : {}),
          }),
        pageCounts.current.tasks,
        (item) => item.taskId,
      ),
    ]);
    if (loadId !== loadIdRef.current) return;
    const issues: string[] = [];
    if (runResult.status === "fulfilled") {
      setRuns(runResult.value.items);
      setRunCursor(runResult.value.nextCursor);
    } else
      issues.push(
        "Run records unavailable: " +
          String(runResult.reason instanceof Error ? runResult.reason.message : runResult.reason),
      );
    if (taskResult.status === "fulfilled") {
      setTasks(taskResult.value.items);
      setTaskCursor(taskResult.value.nextCursor);
    } else
      issues.push(
        "Task records unavailable: " +
          String(taskResult.reason instanceof Error ? taskResult.reason.message : taskResult.reason),
      );
    setError(issues.length ? issues.join(" · ") : null);
    setLoading(false);
    setMoreBusy(false);
  }, [props.activeWorkspaceId, props.activeCitadelId]);
  const loadMore = async () => {
    if (moreLock.current || loading) return;
    const generation = loadIdRef.current;
    moreLock.current = true;
    setMoreBusy(true);
    const [moreRuns, moreTasks] = await Promise.allSettled([
      runCursor
        ? fetchAgenticRuns({ workspaceId: props.activeWorkspaceId, limit: 200, cursor: runCursor })
        : Promise.resolve(null),
      taskCursor
        ? fetchTasksByView("active", undefined, props.activeWorkspaceId, {
            citadelId: props.activeCitadelId,
            limit: 200,
            cursor: taskCursor,
          })
        : Promise.resolve(null),
    ]);
    if (generation === loadIdRef.current) {
      if (moreRuns.status === "fulfilled" && moreRuns.value) {
        if (moreRuns.value.nextCursor === runCursor)
          setError("Run pagination did not advance. Refresh before continuing.");
        else {
          const page = moreRuns.value;
          setRuns((current) => mergeKanbanRows(current ?? [], page.items, (item) => item.runId + ":" + item.taskId));
          setRunCursor(page.nextCursor);
          pageCounts.current.runs++;
        }
      }
      if (moreTasks.status === "fulfilled" && moreTasks.value) {
        if (moreTasks.value.nextCursor === taskCursor)
          setError("Task pagination did not advance. Refresh before continuing.");
        else {
          const page = moreTasks.value;
          setTasks((current) => mergeKanbanRows(current, page.items, (item) => item.taskId));
          setTaskCursor(page.nextCursor);
          pageCounts.current.tasks++;
        }
      }
      if (moreRuns.status === "rejected" || moreTasks.status === "rejected")
        setError("Additional records are unavailable. Loaded records remain available; retry to continue.");
      setMoreBusy(false);
    }
    moreLock.current = false;
  };

  useEffect(() => {
    void load();
    return () => {
      // Supersede any in-flight load on unmount/workspace switch.
      loadIdRef.current += 1;
    };
  }, [load]);

  const cards = useMemo<KanbanCardModel[]>(
    () => [
      ...(runs ?? []).map((run) => toKanbanCard(run)),
      ...tasks.filter((task) => !(runs ?? []).some((run) => run.taskId === task.taskId)).map(toTaskKanbanCard),
    ],
    [runs, tasks],
  );
  const inspectCard = useCallback(
    (card: KanbanCardModel) =>
      leaveRef.current.request(() => {
        setCreating(false);
        setInspected({ taskId: card.taskId, runId: card.runId });
      }),
    [],
  );

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
      if (ids.length === 0 || bulkLock.current) {
        return;
      }
      const cardsByTaskId = new Map(cards.map((card) => [card.taskId, card]));
      const missingRevisionTaskId = ids.find((taskId) => {
        const revision = cardsByTaskId.get(taskId)?.revision;
        return !Number.isInteger(revision) || Number(revision) < 1;
      });
      if (missingRevisionTaskId) {
        setActionError(
          `Task ${missingRevisionTaskId} does not have canonical revision data. Refresh before retrying this action.`,
        );
        return;
      }
      const expectedRevisionsByTaskId = Object.fromEntries(
        ids.map((taskId) => [taskId, cardsByTaskId.get(taskId)!.revision!]),
      );
      const body: BulkTaskActionInput & { workspaceId?: string } =
        action === "retry"
          ? {
              action,
              taskIds: ids,
              expectedRevisionsByTaskId,
              reason: "operator-bulk-retry",
              workspaceId: props.activeWorkspaceId,
            }
          : { action, taskIds: ids, expectedRevisionsByTaskId, workspaceId: props.activeWorkspaceId };
      bulkLock.current = true;
      setBulkBusy(true);
      setActionError(null);
      setNotice(null);
      try {
        const result = await bulkTaskAction(body);
        if (
          !Array.isArray(result.tasks) ||
          ids.some(
            (taskId) =>
              !result.tasks.some(
                (task) =>
                  task.taskId === taskId &&
                  task.workspaceId === props.activeWorkspaceId &&
                  task.revision > expectedRevisionsByTaskId[taskId]!,
              ),
          )
        ) {
          throw new Error(
            "The Gateway did not confirm every selected task update. Refresh to review their recorded state before retrying.",
          );
        }
        if (!isMounted()) {
          return;
        }
        setSelected(new Set());
        setPendingConflict(null);
        setNotice(`${ids.length} selected task${ids.length === 1 ? "" : "s"} updated.`);
        await load();
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 409) {
          await load();
          if (isMounted()) {
            setPendingConflict({ action, taskIds: ids });
            setActionError(
              "One or more selected tasks changed. Canonical task data was refreshed; review the preserved selection, then retry explicitly.",
            );
          }
        } else if (isMounted()) {
          setActionError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        bulkLock.current = false;
        if (isMounted()) {
          setBulkBusy(false);
        }
      }
    },
    [cards, isMounted, load, props.activeWorkspaceId, selected],
  );

  const hasSelection = selected.size > 0;

  return (
    <NativePageFrame
      icon={LayoutDashboard}
      kicker={routeKicker(props.route)}
      title="Kanban"
      description="Tasks and runs, grouped by their latest recorded state."
      loading={loading && runs === null && tasks.length === 0}
      // Only a failed run-list fetch (error) is fatal — it leaves the board null/stale,
      // so the frame replaces it (Finding 10). A failed bulk action (actionError) must
      // stay non-fatal: the board data is still valid and the operator's selection must
      // remain visible, so it renders as an inline banner below instead of nuking the board.
      error={error && runs === null && tasks.length === 0 ? error : null}
      onRetry={() => void load()}
      releaseStatus={getRouteReleaseScope(props.route).status}
      actions={
        <>
          <NativeButton
            onClick={() =>
              leave.request(() => {
                setInspected(null);
                setCreating(true);
              })
            }
          >
            New task
            {hasSessionDraft("kanban:" + (props.activeCitadelId ?? "") + ":" + props.activeWorkspaceId + ":create")
              ? " · Unsaved"
              : ""}
          </NativeButton>
          <NativeButton variant="ghost" disabled={bulkBusy || loading} onClick={() => void load()}>
            <RefreshCw size={14} />
            {error ? "Retry" : "Refresh"}
          </NativeButton>
        </>
      }
    >
      {hasSelection ? (
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
            <RefreshCw size={12} /> Refresh
          </NativeButton>
        </div>
      ) : null}
      {error && (runs !== null || tasks.length > 0) ? (
        <NoticeBanner tone="warning" message={error + " Previously loaded records may be stale."} />
      ) : null}
      {actionError ? (
        <div data-testid="kanban-action-error">
          <NoticeBanner tone="error" message={actionError} />
          {pendingConflict ? (
            <NativeButton
              variant="outline"
              className="mc-next-kanban-action"
              data-testid="kanban-conflict-retry"
              aria-label={`Retry ${pendingConflict.action} for ${pendingConflict.taskIds.length} previously selected tasks`}
              disabled={bulkBusy || selected.size === 0}
              onClick={() => void runBulk(pendingConflict.action)}
            >
              Retry {formatBulkAction(pendingConflict.action)}
            </NativeButton>
          ) : null}
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
            onInspect={inspectCard}
          />
        ))}
      </div>
      {runCursor || taskCursor ? (
        <NativeButton variant="outline" disabled={moreBusy || loading} onClick={() => void loadMore()}>
          {moreBusy ? "Loading records…" : "Load more tasks and runs"}
        </NativeButton>
      ) : null}
      <DetailInspector
        open={creating || inspected !== null}
        title={
          creating
            ? "New task"
            : (cards.find((card) => card.taskId === inspected?.taskId && card.runId === inspected?.runId)?.title ??
              "Task details")
        }
        onClose={() =>
          leave.request(() => {
            setCreating(false);
            setInspected(null);
          })
        }
      >
        {creating ? (
          <KanbanNewTask
            workspaceId={props.activeWorkspaceId}
            citadelId={props.activeCitadelId}
            onCreated={(task) => {
              setTasks((current) => mergeKanbanRows(current, [task], (item) => item.taskId));
              setCreating(false);
              setInspected({ taskId: task.taskId, runId: "" });
              void load();
            }}
          />
        ) : inspected ? (
          <KanbanTaskInspector
            key={inspected.taskId + ":" + inspected.runId}
            {...props}
            task={tasks.find((task) => task.taskId === inspected.taskId)}
            run={runs?.find((run) => run.taskId === inspected.taskId && run.runId === inspected.runId)}
          />
        ) : null}
      </DetailInspector>
      {leave.dialog}
    </NativePageFrame>
  );
}

interface KanbanColumnProps {
  column: { id: KanbanColumnId; label: string };
  cards: KanbanCardModel[];
  selected: Set<string>;
  onToggleSelect: (taskId: string) => void;
  onInspect?: (card: KanbanCardModel) => void;
}

function KanbanColumn({ column, cards, selected, onToggleSelect, onInspect }: KanbanColumnProps) {
  // Window long columns. Each KanbanCard is memoized and receives a primitive
  // `checked` plus the stable `onToggleSelect`, so toggling one selection only
  // re-renders the cards whose membership actually changed.
  const renderCard = useCallback(
    (_index: number, card: KanbanCardModel) => (
      <KanbanCard
        card={card}
        checked={selected.has(card.taskId)}
        onToggleSelect={onToggleSelect}
        onInspect={onInspect}
        containerElement="div"
      />
    ),
    [selected, onToggleSelect, onInspect],
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
            <EmptyState size="compact" title="No tasks or runs in this lane." />
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
              onInspect={onInspect}
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
  onInspect?: (card: KanbanCardModel) => void;
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
  onInspect,
}: KanbanCardProps) {
  const handleToggle = useCallback(() => onToggleSelect(card.taskId), [onToggleSelect, card.taskId]);
  const content = (
    <>
      <label>
        <input
          type="checkbox"
          data-testid={`kanban-select-${card.taskId}`}
          checked={checked}
          disabled={!card.revision}
          onChange={handleToggle}
          aria-label={`Select ${card.title}`}
          title={card.revision ? undefined : "Canonical task revision unavailable"}
        />
      </label>
      <NativeButton variant="ghost" className="mc-next-kanban-card-title" onClick={() => onInspect?.(card)}>
        {card.title}
      </NativeButton>
      <div className="mc-next-kanban-card-meta">
        <span>{card.surfaceLabel}</span>
        <span>{card.updatedDisplay}</span>
      </div>
      <span className="mc-next-kanban-status-chip">
        <StatusChip tone={KANBAN_STATUS_CHIP_TONE[card.statusTone]} icon={<Activity size={12} />}>
          {card.statusLabel}
        </StatusChip>
      </span>
      {card.attentionReason ? <small>{card.attentionReason}</small> : null}
      {card.diagnosticSummary.critical > 0 ? (
        <span data-testid={`diagnostic-chip-${card.taskId}`} className="distress critical">
          <AlertTriangle size={12} /> {card.diagnosticSummary.critical} critical
        </span>
      ) : card.diagnosticSummary.warning > 0 ? (
        <span data-testid={`diagnostic-chip-${card.taskId}`} className="distress warn">
          <Activity size={12} /> {card.diagnosticSummary.warning} warning
        </span>
      ) : null}
    </>
  );
  return containerElement === "div" ? (
    <div className={`mc-next-kanban-card tone-${card.statusTone}`}>{content}</div>
  ) : (
    <li className={`mc-next-kanban-card tone-${card.statusTone}`}>{content}</li>
  );
});

function formatBulkAction(action: BulkAction): string {
  return action.slice(0, 1).toUpperCase() + action.slice(1);
}

function mergeKanbanRows<T>(current: T[], next: T[], key: (value: T) => string): T[] {
  const rows = new Map(current.map((value) => [key(value), value]));
  next.forEach((value) => rows.set(key(value), value));
  return [...rows.values()];
}
async function readKanbanPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
  count: number,
  key: (value: T) => string,
) {
  let page = await fetchPage();
  const seen = new Set<string>();
  let rows = page.items;
  for (let index = 1; index < count && page.nextCursor; index++) {
    if (seen.has(page.nextCursor)) throw new Error("Pagination cursor repeated");
    seen.add(page.nextCursor);
    page = await fetchPage(page.nextCursor);
    rows = mergeKanbanRows(rows, page.items, key);
  }
  return { ...page, items: rows };
}
