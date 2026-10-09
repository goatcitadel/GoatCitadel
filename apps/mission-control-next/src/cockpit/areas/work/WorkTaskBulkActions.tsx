import { useEffect, useRef, useState } from "react";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { commitTaskBulkAction, type TaskBulkAction } from "../../../features/native-routes/ops/task-bulk-operation";
import {
  readTaskMutation,
  taskMutationKey,
  useTaskMutations,
} from "../../../features/native-routes/ops/task-mutation-state";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";

const ACTIONS: ReadonlyArray<{ action: TaskBulkAction; verb: string; consequence: string }> = [
  {
    action: "unblock",
    verb: "Unblock",
    consequence: "Returns each task to assigned and resets its retry count. It does not start any work.",
  },
  {
    action: "retry",
    verb: "Retry",
    consequence:
      "Records one retry attempt per task. A task past its retry budget becomes blocked with a distress signal. It does not start a run.",
  },
  {
    action: "close",
    verb: "Close",
    consequence: "Marks each task done. The Gateway refuses the whole batch if any task has no deliverable.",
  },
];
const count = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;

/** Reviewed bulk task actions for the selected operator tasks. Runtime runs are never part of a task action. */
export function WorkTaskBulkActions({
  workspaceId,
  selected,
  onSettled,
  onClear,
  onRefresh,
}: {
  workspaceId: string;
  selected: TaskRecord[];
  onSettled: (notice: string) => void;
  onClear: () => void;
  onRefresh: () => void;
}) {
  useTaskMutations();
  const base = getGatewayApiBaseUrl();
  const [review, setReview] = useState<{ action: (typeof ACTIONS)[number]; tasks: TaskRecord[] }>();
  const [outcome, setOutcome] = useState<string>();
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const locked = selected.some(
    (task) => readTaskMutation(taskMutationKey(base, workspaceId, task.taskId)).phase !== "idle",
  );
  const close = () => {
    if (!busy) setReview(undefined);
  };
  const confirm = async () => {
    if (!review || busy) return;
    setBusy(true);
    setOutcome(undefined);
    const result = await commitTaskBulkAction({
      action: review.action.action,
      reviewed: review.tasks,
      workspaceId,
      isCurrent: () => live.current,
    });
    if (!live.current) return;
    setBusy(false);
    if (result.kind === "confirmed") {
      setReview(undefined);
      onSettled(
        `${count(result.changed)} updated.${result.matched ? ` ${count(result.matched)} already matched.` : ""}`,
      );
      return;
    }
    if (result.kind === "cancelled") return;
    if (result.kind === "changed" || result.kind === "conflict") onRefresh();
    setOutcome(result.message);
  };
  return (
    <div
      className="grid min-w-0 gap-2 rounded-lg border border-line bg-raised p-3"
      aria-label="Task actions"
      role="group"
    >
      <p className="text-sm text-fg">
        <strong>{count(selected.length)} selected.</strong> Runtime runs are not affected by task actions.
      </p>
      {locked ? (
        <Callout tone="warning">
          A selected task has a pending or unconfirmed action in this app session. Inspect its owner record before
          continuing.
        </Callout>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((entry) => (
          <Button
            key={entry.action}
            size="sm"
            variant={entry.action === "close" ? "danger" : "secondary"}
            disabled={!selected.length || locked || busy}
            onClick={() => {
              setOutcome(undefined);
              setReview({ action: entry, tasks: structuredClone(selected) });
            }}
          >
            {entry.verb}…
          </Button>
        ))}
        <Button size="sm" variant="ghost" disabled={!selected.length || busy} onClick={onClear}>
          Clear selection
        </Button>
      </div>
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={review ? `Review: ${review.action.verb} ${count(review.tasks.length)}` : "Review task action"}
        description={`Operator tasks in workspace ${workspaceId}.`}
      >
        {review ? (
          <div className="grid min-w-0 gap-3 text-sm wrap-anywhere">
            <ul className="grid max-h-64 min-w-0 gap-1 overflow-y-auto">
              {review.tasks.map((task) => (
                <li key={task.taskId}>
                  <strong>{task.title}</strong> · {humanizeToken(task.status)} · revision {task.revision}
                </li>
              ))}
            </ul>
            <p>{review.action.consequence}</p>
            <p className="text-fg-secondary">
              Each task is re-read first, then the Gateway checks every revision: if any task changed, nothing is
              applied.
            </p>
            {outcome ? <Callout tone="error">{outcome}</Callout> : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" disabled={busy} onClick={close}>
                {outcome ? "Close" : "Cancel"}
              </Button>
              {outcome ? null : (
                <Button
                  variant={review.action.action === "close" ? "danger" : "primary"}
                  disabled={busy || locked}
                  onClick={() => void confirm()}
                >
                  {busy ? "Applying…" : `${review.action.verb} ${count(review.tasks.length)}`}
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
