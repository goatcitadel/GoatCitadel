import { useState } from "react";
import { UnattributedDraftRecovery } from "./UnattributedDraftRecovery";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { taskDetailsDraftKey } from "../../../features/native-routes/ops/work-form-drafts";
import { useQueryClient } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { useTaskDetailReview } from "../../../features/native-routes/ops/use-task-detail-review";
import { TASK_PRIORITY_LABELS } from "./work-vocabulary";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { taskRecordsEqual } from "../../../features/native-routes/ops/task-detail-mutation";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { readCockpitLocation } from "../../app/cockpit-back-guard";

const PRIORITIES: readonly TaskRecord["priority"][] = ["low", "normal", "high", "urgent"];

interface Draft {
  base: TaskRecord;
  title: string;
  description: string;
  priority: TaskRecord["priority"];
}

function draftFrom(task: TaskRecord): Draft {
  return { base: task, title: task.title, description: task.description ?? "", priority: task.priority };
}

export function TaskDetailsEditor({ task, workspaceId }: { task: TaskRecord; workspaceId: string }) {
  const { search, hash } = typeof window === "undefined" ? { search: "", hash: "" } : readCockpitLocation();
  const recoveryParams = new URLSearchParams(search);
  recoveryParams.set("workspaceId", workspaceId);
  recoveryParams.delete("taskId");
  recoveryParams.delete("shell");
  recoveryParams.delete("shellScope");
  const recoveryHref = `/work/tasks/${encodeURIComponent(task.taskId)}` + "?" + recoveryParams + hash;
  const client = useQueryClient();
  const editor = useSessionDraft(
    taskDetailsDraftKey(getGatewayApiBaseUrl(), workspaceId, task.taskId),
    draftFrom(task),
    task.revision,
    { label: "Task details" },
  );
  const draft = editor.value,
    base = draft.base;
  const owner = useTaskDetailReview(task, workspaceId);
  const { busy, uncertain } = owner;
  const [notice, setNotice] = useState<string | null>(null);
  const error = owner.message;

  const stale = !taskRecordsEqual(base, task);
  const executionOwned = Boolean(task.agenticContext || task.proactiveContext);
  const changed =
    draft.title.trim() !== base.title ||
    draft.description.trim() !== (base.description ?? "") ||
    draft.priority !== base.priority;
  const canReview =
    !stale && !executionOwned && task.status !== "done" && !owner.locked && changed && Boolean(draft.title.trim());

  function reset(): void {
    editor.discard();
    owner.invalidate();
    setNotice(null);
  }

  async function save(): Promise<void> {
    const submitted = draft;
    await owner.confirm(
      (updated) => {
        editor.acceptSaved(draftFrom(updated), updated.revision, submitted);
        setNotice("Task details saved. This board edit does not change a running execution.");
        void Promise.allSettled([
          client.invalidateQueries({ queryKey: ["tasks", "work-task", workspaceId, updated.taskId] }),
          client.invalidateQueries({ queryKey: queryKeys.workTasks(workspaceId) }),
        ]);
      },
      { kind: "details", title: draft.title.trim(), description: draft.description.trim(), priority: draft.priority },
    );
  }

  return (
    <section aria-label="Task details editor" className="border-t border-line-subtle pt-4">
      <h2 className="text-base font-semibold text-fg">Task details</h2>
      <UnattributedDraftRecovery editor={editor} />
      <p className="mt-1 text-sm text-fg-secondary">
        Edit this board record's title, description, and priority. This does not control a run.
      </p>
      {executionOwned ? (
        <p className="mt-2 text-sm text-fg-muted">
          A runtime execution owns this task. Review its run before editing board details.
        </p>
      ) : null}
      {task.status === "done" ? (
        <p className="mt-2 text-sm text-fg-muted">Completed task details are read-only here.</p>
      ) : null}
      {stale && !uncertain ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="status" className="text-sm text-fg-secondary">
            The task changed while this editor was open.
          </p>
          <Button size="sm" onClick={reset}>
            Load current details
          </Button>
        </div>
      ) : null}
      {!executionOwned && task.status !== "done" && !uncertain ? (
        <div className="mt-3 grid gap-3">
          <label className="grid gap-1 text-sm text-fg-secondary">
            Title
            <input
              maxLength={160}
              value={draft.title}
              disabled={busy || stale}
              onChange={(event) => {
                editor.setValue((value) => ({ ...value, title: event.target.value }));
                owner.invalidate();
              }}
              className="rounded-md border border-line-control bg-sunken p-2 text-fg"
            />
          </label>
          <label className="grid gap-1 text-sm text-fg-secondary">
            Description
            <textarea
              aria-label="Description"
              rows={3}
              maxLength={4000}
              value={draft.description}
              disabled={busy || stale}
              onChange={(event) => {
                editor.setValue((value) => ({ ...value, description: event.target.value }));
                owner.invalidate();
              }}
              className="rounded-md border border-line-control bg-sunken p-2 text-fg"
            />
          </label>
          <label className="grid max-w-xs gap-1 text-sm text-fg-secondary">
            Priority
            <select
              aria-label="Priority"
              value={draft.priority}
              disabled={busy || stale}
              onChange={(event) => {
                editor.setValue((value) => ({ ...value, priority: event.target.value as TaskRecord["priority"] }));
                owner.invalidate();
              }}
              className="min-h-10 rounded-md border border-line-control bg-sunken px-3 text-fg"
            >
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {TASK_PRIORITY_LABELS[priority]}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            className="justify-self-start"
            disabled={!canReview}
            onClick={() => {
              setNotice(null);
              void save();
            }}
          >
            Save task details
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mt-2 text-sm text-status-done">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-status-failed">
          {error}
        </p>
      ) : null}
      {uncertain ? (
        <NativeOwnerLink
          href={recoveryHref}
          scope={`${workspaceId}:${task.taskId}`}
          className="mt-2 inline-block text-sm font-medium text-accent underline"
        >
          Inspect task
        </NativeOwnerLink>
      ) : null}
    </section>
  );
}
