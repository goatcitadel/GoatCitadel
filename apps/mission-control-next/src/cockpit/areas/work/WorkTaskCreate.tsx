import { useEffect, useRef, type FormEvent } from "react";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { taskCreateDraftKey } from "../../../features/native-routes/ops/work-form-drafts";
import { useQueryClient } from "@tanstack/react-query";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { useTaskCreate } from "../../../features/native-routes/ops/use-task-create";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { readCockpitLocation } from "../../app/cockpit-back-guard";
import { TASK_PRIORITY_LABELS } from "./work-vocabulary";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";

const PRIORITIES: readonly TaskRecord["priority"][] = ["low", "normal", "high", "urgent"];

export function WorkTaskCreate({
  workspaceId,
  onClose,
  onCreated,
  accessAvailable = true,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (task: TaskRecord) => void;
  accessAvailable?: boolean;
}) {
  const { search, hash } = typeof window === "undefined" ? { search: "", hash: "" } : readCockpitLocation();
  const recoveryParams = new URLSearchParams(search);
  recoveryParams.set("workspaceId", workspaceId);
  recoveryParams.delete("taskId");
  recoveryParams.delete("shell");
  recoveryParams.delete("shellScope");
  const recoveryHref = "/work" + "?" + recoveryParams + hash;
  const client = useQueryClient();
  const { activeCitadelId } = useUiPreferences();
  const empty = { title: "", description: "", priority: "normal" as TaskRecord["priority"] };
  const editor = useSessionDraft(
    taskCreateDraftKey(getGatewayApiBaseUrl(), workspaceId, activeCitadelId),
    empty,
    undefined,
    { label: "New task" },
  );
  const { title, description, priority } = editor.value;
  const control = useTaskCreate({
    workspaceId,
    viewIdentity: activeCitadelId,
    draft: editor.value,
    onRecorded: (_task, submitted) => (editor.acceptSaved(empty, undefined, submitted) ? empty : undefined),
  });
  const { locked, uncertain, message } = control;
  const titleField = useRef<HTMLInputElement>(null);
  // WK-12: "New task" disables itself when the form opens, so focus moves to the form's first field, not <body>.
  useEffect(() => {
    titleField.current?.focus();
  }, []);
  const edit: typeof editor.setValue = (update) => {
    control.invalidate();
    editor.setValue(update);
  };

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!accessAvailable) return;
    void create();
  }
  async function create(): Promise<void> {
    await control.create(async (created, isCurrent) => {
      await client.invalidateQueries({ queryKey: queryKeys.workTasks(workspaceId) });
      if (isCurrent()) onCreated(created);
    });
  }

  return (
    <section aria-label="New task" className="grid gap-3 border-t border-line-subtle pt-4">
      <div>
        <h2 className="text-base font-semibold text-fg">New task</h2>
        <p className="text-sm text-fg-secondary">
          Add an operator task to this workspace. Creating a task does not start a run.
        </p>
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
        <NativeOwnerLink
          href={recoveryHref}
          scope={workspaceId}
          className="inline-block text-sm text-accent hover:underline"
        >
          Inspect workspace tasks
        </NativeOwnerLink>
      ) : null}
      <form onSubmit={submit} className="grid gap-3">
        <label className="grid gap-1 text-sm text-fg-secondary">
          Title
          <input
            ref={titleField}
            required
            maxLength={160}
            value={title}
            disabled={locked}
            onChange={(event) => {
              edit((value) => ({ ...value, title: event.target.value }));
            }}
            className="rounded-md border border-line-control bg-canvas p-2 text-fg"
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
            className="rounded-md border border-line-control bg-canvas p-2 text-fg"
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
            className="rounded-md border border-line-control bg-canvas p-2 text-fg"
          >
            {PRIORITIES.map((item) => (
              <option key={item} value={item}>
                {TASK_PRIORITY_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={locked || !accessAvailable}>
            Create task
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
    </section>
  );
}
