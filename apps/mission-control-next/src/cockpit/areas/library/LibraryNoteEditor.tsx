import { useLibraryOperation } from "./use-library-operation";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NoteRecord } from "@goatcitadel/contracts";
import { archiveNote, createNote, listNotes, listNoteRevisions, updateNote } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { Field } from "../../ui/Field";

const INPUT = "w-full rounded-md border border-line bg-raised p-2 text-fg";
type Review = { action: "save" | "archive"; note?: NoteRecord; title: string; body: string; revision?: number };
export function LibraryNoteEditor(props: Parameters<typeof LibraryNoteEditorContent>[0]) {
 const access = useLibraryOperation(JSON.stringify(["note", props.workspaceId, props.note?.noteId ?? "create"]));
 return <LibraryNoteEditorContent key={access.identity} {...props} />;
}
function LibraryNoteEditorContent({ note, workspaceId, available, historyRequested = false, onClose }: { note?: NoteRecord; workspaceId: string; available: boolean; historyRequested?: boolean; onClose: () => void }) {
  const operation = useLibraryOperation(JSON.stringify(["note", workspaceId, note?.noteId ?? "create"]));
  const client = useQueryClient(), leave = useDraftLeave();
  const draft = useSessionDraft(operation.presentationScope, { title: note?.title ?? "", body: note?.body ?? "" }, note?.revision, { label: note?.title ?? "New note" });
  const [historyOpen, setHistoryOpen] = useState(historyRequested), [review, setReview] = useSessionViewState<Review | undefined>(operation.presentationScope + ":review", undefined);
  const [busy, setBusy] = useState(false), [outcome, setOutcome] = useSessionViewState<{ error: boolean; text: string } | undefined>(operation.presentationScope + ":outcome", undefined);
  useEffect(() => { setHistoryOpen(historyRequested); }, [historyRequested]);
  const history = useQuery({ queryKey: ["library", "note-history", workspaceId, note?.noteId, note?.revision, operation.identity], queryFn: () => listNoteRevisions(note!.noteId, workspaceId), enabled: historyOpen && Boolean(note), staleTime: 0 });
  const stale = Boolean(note && draft.baseRevision !== note.revision);
  const reviewStale = Boolean(review?.note && (review.note.revision !== note?.revision || review.note.lifecycleStatus !== note?.lifecycleStatus));
  async function confirm() {
    if (!review || operation.locked || outcome || reviewStale || !available) return;
    setBusy(true);
    try {
      const saved = await operation.run(String(review.revision ?? "create"), async () => {
      if (review.note) {
        const fresh = (await listNotes(workspaceId, { lifecycleStatus: "all" })).items.find(item => item.noteId === review.note!.noteId && item.workspaceId === workspaceId);
        if (!fresh || fresh.revision !== review.revision || fresh.lifecycleStatus !== "active") throw new Error("The note changed during review. Close this review and reload the canonical note. Your draft is preserved.");
      }
      }, () => review.action === "archive" ? archiveNote(review.note!.noteId, workspaceId) : review.note ? updateNote(review.note.noteId, { workspaceId, title: review.title, body: review.body, expectedRevision: review.revision }) : createNote({ workspaceId, title: review.title, body: review.body }), saved => {
      if (saved.workspaceId !== workspaceId || (review.note && saved.noteId !== review.note.noteId) || (review.action === "archive" && saved.lifecycleStatus !== "archived")) throw new Error("The returned note does not confirm this request. Refresh notes before retrying.");
      });
      if (!saved) return;
      if (review.action === "save") draft.acceptSaved(review.note ? { title: saved.title, body: saved.body } : { title: "", body: "" }, review.note ? saved.revision : undefined, { title: review.title, body: review.body });
      setOutcome({ error: false, text: `${saved.title} ${review.action === "archive" ? "archived" : "saved"}. Canonical version ${saved.revision}.` });
      await client.invalidateQueries({ queryKey: ["library", "notes", workspaceId] });
      await client.invalidateQueries({ queryKey: ["library", "note-history", workspaceId] });
    } catch (cause) { if (operation.current()) setOutcome({ error: true, text: `${describeApiError(cause).summary} Save is not confirmed. Check the canonical note before retrying.` }); }
    finally { setBusy(false); }
  }
  function start(action: Review["action"]) { if (operation.locked || !operation.current()) return; setOutcome(undefined); setReview({ action, note, ...draft.value, revision: draft.baseRevision as number | undefined }); }
  return <section className="grid gap-3 rounded-lg border border-line p-3" aria-label="Note editor">
    <h2 className="font-display text-lg text-fg">{note?.title ?? "New note"}</h2>
    <p className="text-sm text-fg-secondary">Workspace {workspaceId}{note ? ` · ${note.lifecycleStatus} · Version ${note.revision}` : ""}</p>
    {stale ? <Callout tone="warning">The canonical note changed. Your draft is retained. Discard it to load the latest version before reviewing another save.</Callout> : null}
    {operation.locked ? <Callout tone="warning">{operation.attempt?.message}</Callout> : null}
    <Field label="Note title">{props => <input {...props} className={INPUT} value={draft.value.title} onChange={event => draft.setValue({ ...draft.value, title: event.target.value })} />}</Field>
    <Field label="Note body">{props => <textarea {...props} className={INPUT} rows={6} value={draft.value.body} onChange={event => draft.setValue({ ...draft.value, body: event.target.value })} />}</Field>
    <div className="flex flex-wrap gap-2"><Button disabled={operation.locked || !available || stale || busy || !draft.value.title.trim() || note?.lifecycleStatus === "archived"} onClick={() => start("save")}>Review note save</Button><Button variant="ghost" disabled={busy} onClick={draft.discard}>Discard note changes</Button><Button variant="ghost" disabled={busy} onClick={() => leave.request(onClose)}>Close note</Button>{note ? <><Button disabled={operation.locked || !available || busy || stale || note.lifecycleStatus !== "active"} onClick={() => start("archive")}>Review archive</Button><Button onClick={() => setHistoryOpen(value => !value)}>Note history</Button></> : null}</div>
    {note ? <details className="break-words text-sm text-fg-secondary"><summary>Note provenance</summary><p>Created {new Date(note.createdAt).toLocaleString()} · Updated {new Date(note.updatedAt).toLocaleString()}</p><TechnicalDetails label="Note timestamps"><p>{note.createdAt} · {note.updatedAt}</p></TechnicalDetails><p>Sources: {note.sourceRefs.join(", ") || "No sources recorded"}</p><p>Tags: {note.tags.join(", ") || "None"}</p></details> : null}
    {historyOpen ? <section aria-label="Note history">{history.isFetching ? <p role="status">Reading history…</p> : null}{history.error ? <Callout tone="error">{describeApiError(history.error).summary}</Callout> : null}<ul className="grid gap-2">{history.data?.items.filter(item => item.workspaceId === workspaceId && item.noteId === note?.noteId).map(item => <li key={item.revision} className="rounded-md border border-line p-3"><h3>Version {item.revision}: {item.title}</h3><p className="text-sm text-fg-secondary">{item.source} · {item.actorId} · {new Date(item.createdAt).toLocaleString()}</p><details className="text-sm"><summary>Version content and provenance</summary><p className="whitespace-pre-wrap break-words">{item.body}</p><TechnicalDetails label="Version technical provenance"><p>{item.createdAt}</p><p className="break-all">SHA-256: {item.contentHash}</p><p>Sources: {item.sourceRefs.join(", ") || "None"}</p></TechnicalDetails></details></li>)}</ul></section> : null}
    <Dialog open={Boolean(review)} onOpenChange={open => { if (!open && !busy) setReview(undefined); }} title={review?.action === "archive" ? "Archive note" : "Save note"} description="Review the exact note and workspace before confirming.">
      <div className="grid gap-3"><p className="break-words">{review?.title} · Workspace {workspaceId}</p><p>{review?.action === "archive" ? "Archive removes this note from active lists and retains its history." : "Save persists this note and creates its next canonical version."}</p>
        {outcome ? <Callout tone={outcome.error ? "error" : "info"}>{outcome.text}</Callout> : reviewStale ? <Callout tone="warning">The note changed during review. Close this review and inspect the current version.</Callout> : null}
        <Button disabled={busy || operation.locked || Boolean(outcome) || reviewStale || !available} onClick={() => void confirm()}>{busy ? "Checking and saving…" : review?.action === "archive" ? "Confirm archive" : "Confirm note save"}</Button>
      </div>
    </Dialog>{leave.dialog}
  </section>;
}
