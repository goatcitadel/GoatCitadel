import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { useTaskCreate } from "./use-task-create";
import { taskCreateDraftKey } from "./work-form-drafts";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { TASK_CREATE_BOUNDARY } from "./task-create-mutation";
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
  const draft = useSessionDraft(
    taskCreateDraftKey(getGatewayApiBaseUrl(), workspaceId, citadelId),
    { title: "", description: "", priority: "normal" as TaskRecord["priority"] },
    undefined,
    { label: "New task" },
  );
  const control = useTaskCreate({
    workspaceId,
    citadelId,
    draft: draft.value,
    onRecorded: (_task, submitted) => {
      const empty = { title: "", description: "", priority: "normal" as TaskRecord["priority"] };
      return draft.acceptSaved(empty, undefined, submitted) ? empty : undefined;
    },
  });
  const edit: typeof draft.setValue = (value) => {
    control.invalidate();
    draft.setValue(value);
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        control.begin();
      }}
    >
      {control.message ? (
        <NoticeBanner tone={control.uncertain ? "warning" : "error"} message={control.message} />
      ) : null}
      <p>{TASK_CREATE_BOUNDARY}</p>
      <fieldset disabled={control.locked}>
        <label className="mc-next-settings-field">
          Task title
          <input
            required
            value={draft.value.title}
            onChange={(event) => edit((value) => ({ ...value, title: event.target.value }))}
          />
        </label>
        <label className="mc-next-settings-field">
          Description
          <textarea
            rows={5}
            value={draft.value.description}
            onChange={(event) => edit((value) => ({ ...value, description: event.target.value }))}
          />
        </label>
        <label className="mc-next-settings-field">
          Priority
          <select
            value={draft.value.priority}
            onChange={(event) =>
              edit((value) => ({ ...value, priority: event.target.value as TaskRecord["priority"] }))
            }
          >
            {["low", "normal", "high", "urgent"].map((priority) => (
              <option key={priority}>{priority}</option>
            ))}
          </select>
        </label>
        <NativeButton type="submit">{control.busy ? "Saving…" : "Create task"}</NativeButton>
      </fieldset>
      {control.review ? (
        <section aria-label="Review new task">
          <p>
            Create {control.review.title} in workspace {workspaceId} with {control.review.priority} priority?
          </p>
          <p>{control.review.description || "No description."}</p>
          <NativeButton disabled={control.locked} onClick={() => void control.confirm((task) => onCreated(task))}>
            Confirm create task
          </NativeButton>
          <NativeButton disabled={control.busy} onClick={control.invalidate}>
            Keep editing task
          </NativeButton>
        </section>
      ) : null}
    </form>
  );
}
