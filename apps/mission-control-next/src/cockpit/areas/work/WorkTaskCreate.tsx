import type { FormEvent } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { taskCreateDraftKey } from "../../../features/native-routes/ops/work-form-drafts";
import { useQueryClient } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { useTaskCreate } from "../../../features/native-routes/ops/use-task-create";
import { TASK_CREATE_BOUNDARY } from "../../../features/native-routes/ops/task-create-mutation";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";

const PRIORITIES: readonly TaskRecord["priority"][] = ["normal", "low", "high", "urgent"];

export function WorkTaskCreate({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (task: TaskRecord) => void;
}) {
  const client = useQueryClient();
  const { activeCitadelId } = useUiPreferences();
  const empty = { title: "", description: "", priority: "normal" as TaskRecord["priority"] };
  const editor = useSessionDraft(
    taskCreateDraftKey(getGatewayApiBaseUrl(), workspaceId, activeCitadelId), empty, undefined,
    { label: "New task" },
  );
  const { title, description, priority } = editor.value;
  const control = useTaskCreate({ workspaceId, viewIdentity: activeCitadelId, draft: editor.value,
    onRecorded: (_task, submitted) => editor.acceptSaved(empty, undefined, submitted) ? empty : undefined,
  });
  const { busy, locked, uncertain, message } = control;
  const reviewing = Boolean(control.review);
  const edit: typeof editor.setValue = (update) => {
    control.invalidate();
    editor.setValue(update);
  };

  function review(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    control.begin();
  }
  async function create(): Promise<void> {
    await control.confirm(async (created, isCurrent) => {
      await client.invalidateQueries({ queryKey: queryKeys.workTasks(workspaceId) });
      if (isCurrent()) onCreated(created);
    });
  }

  return (
    <section aria-label="New task" className="grid gap-3 rounded-lg border border-line-strong bg-raised p-4">
      <div>
        <h2 className="font-display text-lg font-semibold text-fg">New task</h2>
        <p className="text-sm text-fg-secondary">{TASK_CREATE_BOUNDARY}</p>
      </div>
      {message ? (
        <p
          role={uncertain ? "alert" : "status"}
          className="rounded-md border border-line bg-sunken p-3 text-sm text-fg"
        >
          {message}
        </p>
      ) : null}
      {uncertain ? (
        <ClassicOwnerLink href="/ops/kanban?shell=classic" scope={workspaceId} label="Review current tasks in Ops" />
      ) : null}
      <form onSubmit={review} className="grid gap-3">
        <label className="grid gap-1 text-sm text-fg-secondary">
          Title
          <input
            required
            maxLength={160}
            value={title}
            disabled={locked}
            onChange={(event) => {
              edit((value) => ({ ...value, title: event.target.value }));
            }}
            className="rounded-md border border-line bg-canvas p-2 text-fg"
          />
        </label>
        <label className="grid gap-1 text-sm text-fg-secondary">
          Description
          <textarea
            rows={3}
            maxLength={4000}
            value={description}
            disabled={locked}
            onChange={(event) => {
              edit((value) => ({ ...value, description: event.target.value }));
            }}
            className="rounded-md border border-line bg-canvas p-2 text-fg"
          />
        </label>
        <label className="grid gap-1 text-sm text-fg-secondary">
          Priority
          <select
            value={priority}
            disabled={locked}
            onChange={(event) => {
              edit((value) => ({ ...value, priority: event.target.value as TaskRecord["priority"] }));
            }}
            className="rounded-md border border-line bg-canvas p-2 text-fg"
          >
            {PRIORITIES.map((item) => (
              <option key={item} value={item}>
                {humanizeToken(item)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={locked}>
            Review task
          </Button>
          <Button
            disabled={locked}
            onClick={() => {
              control.invalidate();
              onClose();
            }}
          >
            Close
          </Button>
        </div>
      </form>
      {reviewing ? (
        <div className="grid gap-2 rounded-md border border-line-strong bg-sunken p-3">
          <p className="text-sm text-fg">
            Create {title.trim()} in this workspace with {humanizeToken(priority).toLowerCase()} priority?
          </p>
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void create()}>
              Confirm create
            </Button>
            <Button disabled={busy} onClick={control.invalidate}>
              Keep editing
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
