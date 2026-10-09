import { useLibraryOperation } from "./use-library-operation";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { completeReminder, createReminder, listReminders } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Field } from "../../ui/Field";
import type { NoteRecord } from "@goatcitadel/contracts";

export function LibraryReminders(props: Parameters<typeof LibraryRemindersContent>[0]) {
 const access = useLibraryOperation(JSON.stringify(["reminders", props.workspaceId, props.note?.noteId]));
 return <LibraryRemindersContent key={access.identity} {...props} />;
}
function LibraryRemindersContent({ workspaceId, note }: { workspaceId: string; note?: NoteRecord }) {
  const operation = useLibraryOperation(JSON.stringify(["reminders", workspaceId, note?.noteId]));
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["library", "reminders", workspaceId, operation.identity], queryFn: () => listReminders(workspaceId, { status: "all" }), staleTime: 0 });
  const empty = { title: "", dueAt: "", recurrenceRule: "" };
  const draft = useSessionDraft(operation.presentationScope, empty, undefined, { label: "New reminder" });
  const [status, setStatus] = useState("scheduled"), [busy, setBusy] = useState(false), [notice, setNotice] = useSessionViewState<{ error: boolean; text: string } | undefined>(operation.presentationScope + ":outcome", undefined);
  async function mutate(id?: string) {
    if (operation.locked || query.isError) return;
    const submitted = draft.value;
    const date = new Date(submitted.dueAt);
    if (!id && (!submitted.title.trim() || !submitted.dueAt || !Number.isFinite(date.getTime()))) { setNotice({ error: true, text: "Enter a reminder title and valid local date and time." }); return; }
    setBusy(true); setNotice(undefined);
    try {
      const result = await operation.run(id ?? "create", async () => {
      if (id) {
        const fresh = (await listReminders(workspaceId, { status: "all" })).items.find(item => item.reminderId === id && item.workspaceId === workspaceId);
        if (!fresh || fresh.status !== "scheduled") throw new Error("This reminder is no longer scheduled. Refresh reminders.");
      }
      }, () => id ? completeReminder(id) : createReminder({ workspaceId, title: submitted.title, dueAt: date.toISOString(), ...(submitted.recurrenceRule.trim() ? { recurrenceRule: submitted.recurrenceRule.trim() } : {}), ...(note?.workspaceId === workspaceId ? { sourceRef: `/library/notes?noteId=${encodeURIComponent(note.noteId)}&shell=cockpit` } : {}) }), result => {
      if (result.workspaceId !== workspaceId || (id && (result.reminderId !== id || result.status !== "completed"))) throw new Error("The returned reminder does not confirm the request.");
      });
      if (!result) return;
      if (!id) draft.acceptSaved(empty, undefined, submitted);
      setNotice({ error: false, text: `${result.title}: ${result.status}.` });
      await client.invalidateQueries({ queryKey: ["library", "reminders", workspaceId, operation.identity] });
    } catch (cause) { if (operation.current()) setNotice({ error: true, text: `${describeApiError(cause).summary} Completion is not confirmed; refresh before retrying.` }); }
    finally { setBusy(false); }
  }
  const items = query.data?.items.filter(item => item.workspaceId === workspaceId && (status === "all" || item.status === status)) ?? [];
  return <section className="grid gap-3 rounded-lg border border-line p-3" aria-label="Reminders"><h2 className="font-display text-lg text-fg">Reminders</h2>
    {query.isPending ? <p role="status">Loading reminders…</p> : null}{query.error ? <Callout tone="error">{describeApiError(query.error).summary}</Callout> : null}{notice ? <Callout tone={notice.error ? "error" : "info"}>{notice.text}</Callout> : null}
    {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
    <details><summary>New reminder</summary><div className="mt-2 grid gap-3">{note ? <p className="text-sm">Linked note: {note.title}</p> : <p className="text-sm">Open a note to link this reminder to it.</p>}<Field label="Reminder title">{props => <input {...props} className="rounded-md border border-line bg-raised p-2" value={draft.value.title} onChange={event => draft.setValue({ ...draft.value, title: event.target.value })} />}</Field><Field label="Reminder due time" help="Your local date and time; stored as UTC.">{props => <input {...props} className="rounded-md border border-line bg-raised p-2" type="datetime-local" value={draft.value.dueAt} onChange={event => draft.setValue({ ...draft.value, dueAt: event.target.value })} />}</Field><Field label="Reminder recurrence" help="Optional recurrence rule supported by the Gateway. Leave empty for one time.">{props => <input {...props} className="rounded-md border border-line bg-raised p-2" value={draft.value.recurrenceRule} onChange={event => draft.setValue({ ...draft.value, recurrenceRule: event.target.value })} />}</Field><Button disabled={busy || operation.locked || query.isError} onClick={() => void mutate()}>Schedule reminder</Button><Button variant="ghost" disabled={busy} onClick={draft.discard}>Discard reminder draft</Button></div></details>
    <Field label="Reminder status">{props => <select {...props} className="rounded-md border border-line bg-raised p-2" value={status} onChange={event => setStatus(event.target.value)}><option value="scheduled">Scheduled</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="all">All reminders</option></select>}</Field>
    <Button disabled={busy || operation.locked || query.isFetching} onClick={() => void query.refetch()}>Refresh reminders</Button>
    <ul className="grid gap-2">{items.slice(0, 100).map(item => <li key={item.reminderId} className="rounded-md border border-line p-3"><h3>{item.title}</h3><p className="text-sm text-fg-secondary">{item.status} · {new Date(item.dueAt).toLocaleString()} · {item.recurrenceRule ?? "One time"}</p>{item.sourceRef ? <p className="break-words text-sm">Source: {item.sourceRef}</p> : null}{item.status === "scheduled" ? <Button disabled={busy || operation.locked || query.isError || query.isFetching} onClick={() => void mutate(item.reminderId)}>Complete {item.title}</Button> : null}</li>)}</ul>
    {!query.isPending && !query.isError && !items.length ? <p className="text-sm text-fg-muted">No matching reminders.</p> : null}
  </section>;
}
