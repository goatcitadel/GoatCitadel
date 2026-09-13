import { useEffect, useRef, useState } from "react";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { createTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { useSessionDraft } from "../library/session-drafts";
import { NativeButton, NoticeBanner } from "../primitives";
export function KanbanNewTask({
  workspaceId,
  citadelId,
  onCreated,
}: {
  workspaceId: string;
  citadelId?: string;
  onCreated: (task: TaskRecord) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const lock = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const draft = useSessionDraft(
    "kanban:" + (citadelId ?? "") + ":" + workspaceId + ":create",
    { title: "", description: "", priority: "normal" as TaskRecord["priority"] },
    undefined,
    { label: "New task", onSave: () => save() },
  );
  const save = async (): Promise<boolean> => {
    if (lock.current) return false;
    const submitted = draft.value;
    if (!submitted.title.trim()) {
      setError("Enter a task title.");
      return false;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const created = await createTask({
        workspaceId,
        citadelId,
        title: submitted.title.trim(),
        description: submitted.description,
        priority: submitted.priority,
      });
      if (!created.taskId || !created.revision || created.workspaceId !== workspaceId)
        throw new Error("The saved task could not be confirmed. Your input is preserved.");
      const cleared = draft.acceptSaved({ title: "", description: "", priority: "normal" }, undefined, submitted);
      if (cleared && mounted.current) onCreated(created);
      return cleared;
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not save the task.");
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {error ? <NoticeBanner tone="error" message={error} /> : null}
      <fieldset disabled={busy}>
        <label className="mc-next-settings-field">
          Task title
          <input
            required
            value={draft.value.title}
            onChange={(event) => draft.setValue((value) => ({ ...value, title: event.target.value }))}
          />
        </label>
        <label className="mc-next-settings-field">
          Description
          <textarea
            rows={5}
            value={draft.value.description}
            onChange={(event) => draft.setValue((value) => ({ ...value, description: event.target.value }))}
          />
        </label>
        <label className="mc-next-settings-field">
          Priority
          <select
            value={draft.value.priority}
            onChange={(event) =>
              draft.setValue((value) => ({ ...value, priority: event.target.value as TaskRecord["priority"] }))
            }
          >
            {["low", "normal", "high", "urgent"].map((priority) => (
              <option key={priority}>{priority}</option>
            ))}
          </select>
        </label>
        <NativeButton type="submit">{busy ? "Saving…" : "Create task"}</NativeButton>
      </fieldset>
    </form>
  );
}
