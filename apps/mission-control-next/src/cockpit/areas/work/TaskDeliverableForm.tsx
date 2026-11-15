import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskDeliverableRecord, TaskRecord } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { addTaskDeliverable } from "@goatcitadel/mission-control-shared/api/tasks";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { TASK_DELIVERABLE_LABELS } from "./work-vocabulary";

/** The id of the title box, so "Record a deliverable" beside the Done hint can move focus to it. */
export const TASK_DELIVERABLE_TITLE_ID = "task-deliverable-title";

type DeliverableKind = TaskDeliverableRecord["deliverableType"];

const KIND_ORDER: readonly DeliverableKind[] = ["artifact", "file", "url"];
const CONTROL_CLASS = "min-h-10 w-full rounded-md border border-line-control bg-sunken px-3 text-fg";

/**
 * Records a deliverable on a task nobody's run is handling. Done needs at least one, and this is where an operator
 * adds it. The Gateway owns the record; this form only asks for it and says what came of the request.
 */
export function TaskDeliverableForm({ task, workspaceId }: { task: TaskRecord; workspaceId: string }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<DeliverableKind>("artifact");
  const [path, setPath] = useState("");
  const [note, setNote] = useState("");
  const [recorded, setRecorded] = useState(false);
  const deliverablesKey = ["tasks", "work-task-deliverables", workspaceId, task.taskId];
  // The task page owns this read; the form only watches it, because Done is offered from that list.
  const list = useQuery<{ items?: readonly unknown[] }>({ queryKey: deliverablesKey, enabled: false });
  const listed = list.isSuccess && (list.data?.items?.length ?? 0) > 0;
  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof addTaskDeliverable>[1]) => addTaskDeliverable(task.taskId, input),
    onSuccess: (_record, sent) => {
      // Only what was sent is cleared: anything typed while the request was out stays.
      setTitle((current) => (current.trim() === sent.title ? "" : current));
      setKind((current) => (current === sent.deliverableType ? "artifact" : current));
      setPath((current) => (current.trim() === (sent.path ?? "") ? "" : current));
      setNote((current) => (current.trim() === (sent.description ?? "") ? "" : current));
      setRecorded(true);
      // Not waited for: a read that fails or pauses must not leave the button busy.
      void queryClient.invalidateQueries({ queryKey: deliverablesKey });
      void queryClient.invalidateQueries({ queryKey: ["tasks", "work-task", workspaceId, task.taskId] });
    },
  });
  // Done is promised only once a finished read of the list holds a deliverable; a failed or paused read promises none.
  const recordedLine = listed
    ? "Deliverable recorded. You can now mark the task Done."
    : list.isFetching
      ? "Deliverable recorded."
      : "Deliverable recorded, but the list couldn't be refreshed. Reload the page to see it and mark the task Done.";
  const trimmedTitle = title.trim();
  const trimmedPath = path.trim();
  const trimmedNote = note.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmedTitle || mutation.isPending) return;
    setRecorded(false);
    mutation.mutate({
      workspaceId,
      title: trimmedTitle,
      deliverableType: kind,
      ...(trimmedPath ? { path: trimmedPath } : {}),
      ...(trimmedNote ? { description: trimmedNote } : {}),
    });
  }

  return (
    <form aria-label="Record a deliverable" onSubmit={submit} className="mt-4 grid gap-3">
      <h3 className="text-sm font-semibold text-fg">Record a deliverable</h3>
      {/* The title keeps a fixed id for the jump from the Done hint, which Field's generated id cannot give. */}
      <div className="space-y-1 text-sm text-fg-secondary">
        <label htmlFor={TASK_DELIVERABLE_TITLE_ID} className="block font-medium">
          Title
          <span aria-hidden="true" className="ml-0.5 text-status-failed">
            *
          </span>
        </label>
        <input
          id={TASK_DELIVERABLE_TITLE_ID}
          required
          aria-required="true"
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className={CONTROL_CLASS}
        />
      </div>
      <Field label="Kind">
        {(props) => (
          <select
            {...props}
            value={kind}
            onChange={(event) => setKind(event.target.value as DeliverableKind)}
            className={CONTROL_CLASS}
          >
            {KIND_ORDER.map((item) => (
              <option key={item} value={item}>
                {TASK_DELIVERABLE_LABELS[item]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="File path or link (optional)">
        {(props) => (
          <input {...props} value={path} onChange={(event) => setPath(event.target.value)} className={CONTROL_CLASS} />
        )}
      </Field>
      <Field label="Note (optional)">
        {(props) => (
          <input {...props} value={note} onChange={(event) => setNote(event.target.value)} className={CONTROL_CLASS} />
        )}
      </Field>
      <div>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!trimmedTitle}
          loading={mutation.isPending}
          loadingLabel="Recording…"
        >
          Record deliverable
        </Button>
      </div>
      {mutation.isError || recorded ? (
        <p
          role={mutation.isError ? "alert" : "status"}
          className={mutation.isError ? "text-sm text-status-failed" : "text-sm text-fg"}
        >
          {mutation.isError
            ? `Couldn't record the deliverable. ${describeApiError(mutation.error).summary}`
            : recordedLine}
        </p>
      ) : null}
    </form>
  );
}
