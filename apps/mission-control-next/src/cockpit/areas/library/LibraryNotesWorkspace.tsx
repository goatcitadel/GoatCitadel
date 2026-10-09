import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listNotes } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Field } from "../../ui/Field";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { LibraryNoteEditor } from "./LibraryNoteEditor";
import { LibraryReminders } from "./LibraryReminders";


export function LibraryNotesWorkspace({ workspaceId }: { workspaceId: string }) {
  const route = useCockpitRoute();
  const noteId = new URLSearchParams(route.search).get("noteId");
  const creating = !noteId && new URLSearchParams(route.search).get("view") === "create";
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<"active" | "archived" | "all">("active");
  const notes = useQuery({ queryKey: ["library", "notes", workspaceId], queryFn: () => listNotes(workspaceId, { lifecycleStatus: "all" }), staleTime: 0 });
  const scoped = notes.data?.items.filter(item => item.workspaceId === workspaceId) ?? [];
  const selected = scoped.find(item => item.noteId === noteId);
  const visible = scoped.filter(item => (status === "all" || item.lifecycleStatus === status) && `${item.title} ${item.body} ${item.tags.join(" ")}`.toLowerCase().includes(filter.toLowerCase()));
  function select(id?: string) { const params = new URLSearchParams(route.search); if (id) params.set("noteId", id); else params.delete("noteId"); params.delete("view"); params.set("shell", "cockpit"); route.requestTransition(review => { if (review.isCurrent()) { review.navigate(`/library/notes?${params}`); } }); }
  return <section className="mx-auto grid w-full max-w-5xl gap-4 p-4" aria-label="Library Notes">
    <header><h1 className="font-display text-xl font-semibold text-fg">Notes</h1><p className="text-sm text-fg-secondary">Workspace notes, revision history, sources and reminders.</p></header>
    <div className="flex flex-wrap gap-2"><Button onClick={() => route.requestTransition(review => { if (review.isCurrent()) { const params = new URLSearchParams(route.search); params.delete("noteId"); params.set("view", "create"); params.set("shell", "cockpit"); review.navigate(`/library/notes?${params}`); } })}>New note</Button><Button disabled={notes.isFetching} onClick={() => void notes.refetch()}>Refresh notes</Button></div>
    {notes.isPending ? <p role="status">Loading notes…</p> : null}
    {notes.error ? <Callout tone="error">{describeApiError(notes.error).summary} Editing is locked until a fresh read succeeds.</Callout> : null}
    {creating ? <LibraryNoteEditor key={`create:${workspaceId}`} workspaceId={workspaceId} available={!notes.isError && !notes.isFetching} onClose={() => select()} /> : noteId && selected ? <LibraryNoteEditor key={`${workspaceId}:${noteId}`} note={selected} historyRequested={new URLSearchParams(route.search).get("view") === "history"} workspaceId={workspaceId} available={!notes.isError && !notes.isFetching} onClose={() => select()} /> : noteId && !notes.isPending && !notes.isError ? <Callout tone="warning">The selected note was not found in this workspace. Check its link or access.</Callout> : null}
    <div className="grid gap-3 sm:grid-cols-2"><Field label="Search notes">{props => <input {...props} className="rounded-md border border-line bg-raised p-2 text-fg" value={filter} onChange={event => setFilter(event.target.value)} />}</Field><Field label="Note status">{props => <select {...props} className="rounded-md border border-line bg-raised p-2 text-fg" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All notes</option></select>}</Field></div>
    <p className="text-sm text-fg-muted">Showing {Math.min(visible.length, 100)} of {visible.length} matching notes. Narrow search to find additional notes.</p>
    <ul className="grid gap-2">{visible.slice(0, 100).map(note => <li key={note.noteId} className="rounded-lg border border-line bg-raised p-3"><h2 className="font-semibold text-fg">{note.title}</h2><p className="text-sm text-fg-secondary">{note.lifecycleStatus} · Version {note.revision} · {note.updatedAt}</p><Button size="sm" onClick={() => select(note.noteId)}>Open {note.title}</Button></li>)}</ul>
    <LibraryReminders key={creating ? "unlinked" : selected?.noteId ?? "unlinked"} workspaceId={workspaceId} note={creating ? undefined : selected} />
    <ClassicOwnerLink href="/library/notes?shell=classic" scope={workspaceId} label="Open notes in classic view" />
    
  </section>;
}
