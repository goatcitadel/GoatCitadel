import type { MouseEvent } from "react";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { presentRunStatus, presentTaskStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { WindowedRecordList } from "../../ui/WindowedRecordList";
import { StatusBadge } from "../../ui/StatusBadge";
import { TimeText } from "../../ui/TimeText";
import { workRunTitle } from "./work-board";

// The scanned item keeps its own hairline card; the column around it is flat.
const CARD = "block rounded-md border border-line bg-raised p-3 hover:border-line-strong";

type BoardItem = { kind: "task"; key: string; task: TaskRecord } | { kind: "run"; key: string; run: DurableRunRecord };

/**
 * One flat board column: the heading and its count on one row, then the loaded task and run cards, or one empty
 * line. Selection turns operator task cards into checkboxes; runtime runs stay links.
 */
export function WorkBoardColumn({
  title,
  description,
  count,
  tasks,
  runs,
  empty,
  filtered = false,
  selecting,
  selectedIds,
  onToggle,
  onOpen,
}: {
  title: string;
  description: string;
  count: string;
  tasks: readonly TaskRecord[];
  runs: readonly DurableRunRecord[];
  empty: boolean;
  /** A search or record-type filter is on, so an empty column may only be hiding records. */
  filtered?: boolean;
  selecting: boolean;
  selectedIds: ReadonlySet<string>;
  onToggle: (taskId: string) => void;
  onOpen: (path: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const items: BoardItem[] = [
    ...tasks.map((task) => ({ kind: "task" as const, key: "task:" + task.taskId, task })),
    ...runs.map((run) => ({ kind: "run" as const, key: "run:" + run.runId, run })),
  ];
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 border-b border-line-subtle pb-2">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <span className="whitespace-nowrap text-xs tabular-nums text-fg-muted">{count}</span>
      </div>
      <p className="text-xs text-fg-muted">{description}</p>
      {items.length ? (
        <WindowedRecordList label={title + " records"} items={items} itemKey={(item) => item.key}>
          {(item) => {
            if (item.kind === "run") return <RunCard run={item.run} onOpen={onOpen} />;
            const task = item.task;
            if (selecting)
              return (
                <label className={`${CARD} flex min-h-11 cursor-pointer items-start gap-2`}>
                  <input
                    type="checkbox"
                    className="mt-0.5 size-5 shrink-0"
                    checked={selectedIds.has(task.taskId)}
                    onChange={() => onToggle(task.taskId)}
                  />
                  <span className="min-w-0">
                    <TaskKind task={task} />
                    <span className="mt-1 line-clamp-3 block text-sm font-medium text-fg">{task.title}</span>
                  </span>
                </label>
              );
            const path = `/work/tasks/${encodeURIComponent(task.taskId)}`;
            return (
              <a href={path} onClick={onOpen(path)} className={CARD}>
                <TaskKind task={task} />
                <span className="mt-1 line-clamp-3 block text-sm font-medium text-fg">{task.title}</span>
                <TimeText value={task.updatedAt} prefix="Updated" className="mt-2 block text-xs text-fg-muted" />
              </a>
            );
          }}
        </WindowedRecordList>
      ) : null}
      {empty ? (
        <p className="text-xs text-fg-muted">
          {filtered ? "Nothing here matches the filter." : "No recent work in this state."}
        </p>
      ) : null}
    </section>
  );
}

function TaskKind({ task }: { task: TaskRecord }) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs font-medium text-fg-muted">
      Operator task <StatusBadge status={presentTaskStatus(task.status)} />
    </span>
  );
}

function RunCard({
  run,
  onOpen,
}: {
  run: DurableRunRecord;
  onOpen: (path: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const path = `/work/runs/${encodeURIComponent(run.runId)}`;
  return (
    <a href={path} onClick={onOpen(path)} className={CARD}>
      <span className="text-xs font-medium text-fg-muted">Run</span>
      <span className="line-clamp-3 block text-sm font-medium text-fg">{workRunTitle(run)}</span>
      <span className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <StatusBadge status={presentRunStatus(run.status)} />
        <TimeText value={run.updatedAt} className="text-xs text-fg-muted" />
      </span>
      {run.lastError || run.recoverySummary ? (
        <span className="mt-2 block text-xs text-status-failed">{run.lastError ?? run.recoverySummary}</span>
      ) : null}
    </a>
  );
}
