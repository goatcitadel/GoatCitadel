import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteRevisionRecord } from "@goatcitadel/contracts";
import { archiveNote, completeReminder, createNote, createReminder, listNoteRevisions, listNotes, listReminders, updateNote } from "@goatcitadel/mission-control-shared/api/personal-ops";
import { NativeCard, NativeDisclosureCard } from "../NativeRoutePageLayout";
import { DetailInspector } from "../../../components/DetailInspector";
import type { NativeRoutePagesProps } from "../types";
import { formatDateTime, getErrorMessage, nativeLoad, nativeLoadIssues, useAsyncLoad, type LoadState, type Notice } from "../shared/native-helpers";
import { LibraryActionCardGrid, LibraryButtonRow, LibraryField, LibraryFieldGrid, LibraryLoadWarnings, LibraryNotice, LibrarySectionShell, LibrarySelectableList } from "../shared/library-primitives";
import { NativeButton } from "../primitives";
import { hasSessionDraft, useSessionDraft } from "./session-drafts";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useDraftLeave } from "./DraftLeaveDialog";

const EMPTY_NOTE = { title: "", body: "" };
const EMPTY_REMINDER = { title: "", dueAt: "" };

export function LibraryNotesSection(props: NativeRoutePagesProps) {
  return <NotesWorkspace key={props.activeWorkspaceId} {...props} />;
}

function NotesWorkspace({ activeWorkspaceId, activeWorkspaceName }: NativeRoutePagesProps) {
  const [selectedNoteId, setSelectedNoteId] = useState("");
  const [creating, setCreating] = useState(false);
  const [reminderCreating, setReminderCreating] = useState(false);
  const [query, setQuery] = useSessionViewState(`notes:${activeWorkspaceId}:query`, "");
  const [lifecycleStatus, setLifecycleStatus] = useSessionViewState<"active" | "archived" | "all">(`notes:${activeWorkspaceId}:status`, "active");
  const [reminderStatus, setReminderStatus] = useSessionViewState<"scheduled" | "completed" | "cancelled" | "all">(`reminders:${activeWorkspaceId}:status`, "scheduled");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reminderQuery, setReminderQuery] = useSessionViewState(`reminders:${activeWorkspaceId}:query`, "");
  const [selectedReminderId, setSelectedReminderId] = useState<string | null>(null);
  const [completingReminder, setCompletingReminder] = useState(false);
  const reminderCompletionPending = useRef(false);
  const [history, setHistory] = useState<LoadState<NoteRevisionRecord[]>>({ loading: false, error: null, data: null });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const [reminderSaving, setReminderSaving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const leave = useDraftLeave();
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [notes, reminders] = await Promise.all([
      nativeLoad("Notes", listNotes(activeWorkspaceId, { lifecycleStatus }), { items: [] }),
      nativeLoad("Reminders", listReminders(activeWorkspaceId, { status: reminderStatus }), { items: [] }),
    ]);
    return { issues: nativeLoadIssues([notes, reminders]), notes: notes.data.items, reminders: reminders.data.items };
  }, [activeWorkspaceId, lifecycleStatus, reminderStatus]);
  const selectedReminder = data?.reminders.find((item) => item.reminderId === selectedReminderId);
  const visibleReminders = (data?.reminders ?? []).filter((item) => !reminderQuery.trim() || [item.title, item.sourceRef, item.recurrenceRule].join(" ").toLocaleLowerCase().includes(reminderQuery.trim().toLocaleLowerCase()));
  const selectedNote = data?.notes.find((note) => note.noteId === selectedNoteId) ?? null;
  const keyForNote = (id: string) => JSON.stringify(["notes", activeWorkspaceId, id, "edit"]);
  const draft = useSessionDraft(keyForNote(selectedNoteId), selectedNote ? { title: selectedNote.title, body: selectedNote.body } : EMPTY_NOTE, selectedNote?.revision, {
    label: selectedNote?.title ?? "Note", available: Boolean(selectedNote), active: Boolean(selectedNoteId), onSave: handleUpdateNote,
  });
  const createDraft = useSessionDraft(JSON.stringify(["notes", activeWorkspaceId, "create"]), EMPTY_NOTE, undefined, { label: "New note", active: creating, onSave: handleCreateNote });
  const reminderDraft = useSessionDraft(JSON.stringify(["reminders", activeWorkspaceId, "create"]), EMPTY_REMINDER, undefined, { label: "New reminder", active: reminderCreating, onSave: handleCreateReminder });
  const visibleNotes = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    return (data?.notes ?? []).filter((note) => !text || [note.title, note.body, ...note.tags].join(" ").toLocaleLowerCase().includes(text));
  }, [data?.notes, query]);

  useEffect(() => {
    setHistory({ loading: false, error: null, data: null });
    if (!historyOpen || !selectedNoteId) return;
    let cancelled = false;
    setHistory({ loading: true, error: null, data: null });
    void listNoteRevisions(selectedNoteId, activeWorkspaceId)
      .then((result) => { if (!cancelled) setHistory({ loading: false, error: null, data: result.items }); })
      .catch((cause: unknown) => { if (!cancelled) setHistory({ loading: false, error: getErrorMessage(cause), data: null }); });
    return () => { cancelled = true; };
  }, [activeWorkspaceId, selectedNoteId, selectedNote?.revision, historyOpen]);

  async function handleCreateNote(): Promise<boolean> {
    if (!createDraft.value.title.trim() || noteSaving) return false;
    setNoteSaving(true);
    try {
      const created = await createNote({ workspaceId: activeWorkspaceId, ...createDraft.value });
      const clean = createDraft.acceptSaved(EMPTY_NOTE, undefined, createDraft.value);
      setNotice({ tone: "success", message: `${created.title} saved.` });
      if (clean) setCreating(false);
      await reload();
      return clean;
    } catch (cause) { setNotice({ tone: "error", message: getErrorMessage(cause) }); return false; }
    finally { setNoteSaving(false); }
  }
  async function handleCreateReminder(): Promise<boolean> {
    const dueAt = toReminderDueAtIso(reminderDraft.value.dueAt);
    if (!reminderDraft.value.title.trim() || !dueAt || reminderSaving) return false;
    setReminderSaving(true);
    try {
      const created = await createReminder({ workspaceId: activeWorkspaceId, title: reminderDraft.value.title, dueAt });
      const clean = reminderDraft.acceptSaved(EMPTY_REMINDER, undefined, reminderDraft.value);
      if (clean) setReminderCreating(false);
      setNotice({ tone: "success", message: `${created.title} scheduled.` });
      await reload();
      return clean;
    } catch (cause) { setNotice({ tone: "error", message: getErrorMessage(cause) }); return false; }
    finally { setReminderSaving(false); }
  }
  async function handleUpdateNote(expectedRevision?: number): Promise<boolean> {
    if (!selectedNote || !draft.value.title.trim() || noteSaving) return false;
    setNoteSaving(true);
    try {
      const updated = await updateNote(selectedNote.noteId, { workspaceId: activeWorkspaceId, ...draft.value, expectedRevision: expectedRevision ?? draft.baseRevision as number });
      const clean = draft.acceptSaved({ title: updated.title, body: updated.body }, updated.revision, draft.value);
      setNotice({ tone: "success", message: `${updated.title} updated at revision ${updated.revision}.` });
      await reload();
      return clean;
    } catch (cause) {
      setNotice({ tone: "error", message: `${getErrorMessage(cause)} Your draft is preserved. Reload canonical to inspect the current version.` });
      return false;
    } finally { setNoteSaving(false); }
  }
  async function handleArchiveNote() {
    if (!selectedNote) return;
    setNoteSaving(true);
    try {
      await archiveNote(selectedNote.noteId, activeWorkspaceId);
      setNotice({ tone: "success", message: `${selectedNote.title} archived.` });
      setSelectedNoteId(""); setConfirmArchive(false);
      await reload();
    } catch (cause) { setNotice({ tone: "error", message: getErrorMessage(cause) }); }
    finally { setNoteSaving(false); }
  }
  async function handleCompleteReminder() {
    if (!selectedReminder || selectedReminder.status !== "scheduled" || reminderCompletionPending.current) return;
    reminderCompletionPending.current = true;
    setCompletingReminder(true);
    try {
      const updated = await completeReminder(selectedReminder.reminderId);
      if (updated.reminderId !== selectedReminder.reminderId || updated.workspaceId !== activeWorkspaceId || updated.status !== "completed") throw new Error("Completion is not confirmed. Refresh the reminder before trying again.");
      setNotice({ tone: "success", message: `${updated.title} completed.` });
      setSelectedReminderId((current) => current === selectedReminder.reminderId ? null : current); await reload();
    } catch (cause) { setNotice({ tone: "error", message: getErrorMessage(cause) }); }
    finally { reminderCompletionPending.current = false; setCompletingReminder(false); }
  }
  const openNote = (id: string) => leave.request(() => { setSelectedNoteId(id); setCreating(false); setHistoryOpen(false); setConfirmArchive(false); });
  const closeEditor = () => leave.request(() => { setSelectedNoteId(""); setCreating(false); setHistoryOpen(false); setConfirmArchive(false); });
  const editor = selectedNoteId || creating;
  const currentDraft = creating ? createDraft : draft;

  return <LibrarySectionShell loading={loading && !data} error={error} onRetry={reload}>
    {notice ? <LibraryNotice notice={notice} /> : null}
    <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
    {loading && data ? <p role="status">Refreshing notes…</p> : null}
    <div className="mc-next-settings-stack">
      {editor ? <NativeCard title={creating ? "New note" : selectedNote?.title ?? "Note unavailable"} subtitle={currentDraft.isDirty ? "Unsaved changes · kept for this app session" : activeWorkspaceName}
        actions={<NativeButton variant="ghost" onClick={closeEditor}>Back to notes</NativeButton>}>
        {!creating && !selectedNote ? <p role="alert">This note is no longer available in the current list. Your unsaved draft is retained.</p> : null}
        <LibraryFieldGrid>
          <LibraryField label={creating ? "Title" : "Edit title"}><input className="mc-next-settings-input" value={currentDraft.value.title} onChange={(event) => currentDraft.setValue((value) => ({ ...value, title: event.target.value }))} /></LibraryField>
          <LibraryField label={creating ? "Body" : "Edit body"} span={2}><textarea className="mc-next-settings-input" value={currentDraft.value.body} rows={14} onChange={(event) => currentDraft.setValue((value) => ({ ...value, body: event.target.value }))} /></LibraryField>
        </LibraryFieldGrid>
        {draft.hasRemoteChanges && !creating ? <LibraryNotice notice={{ tone: "warning", message: `A newer revision is available. Your draft is based on revision ${draft.baseRevision}; review the canonical version before resolving the conflict.` }} /> : null}
        <LibraryButtonRow>
          <NativeButton disabled={noteSaving || !currentDraft.value.title.trim() || (!creating && !selectedNote)} onClick={() => void (creating ? handleCreateNote() : handleUpdateNote())}>{noteSaving ? "Saving..." : creating ? "Save note" : "Save changes"}</NativeButton>
          {currentDraft.isDirty ? <NativeButton variant="secondary" onClick={closeEditor}>Keep draft and close</NativeButton> : null}
          {!creating ? <NativeButton variant="outline" onClick={() => void reload()}>Reload canonical</NativeButton> : null}
          {!creating ? <NativeButton variant="ghost" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>History and details</NativeButton> : null}
          {selectedNote?.lifecycleStatus === "active" && !creating ? <NativeButton variant="destructive" disabled={noteSaving} onClick={() => leave.request(() => setConfirmArchive(true), [draft.key])}>Archive note</NativeButton> : null}
        </LibraryButtonRow>
        {confirmArchive ? <div role="group" aria-label="Confirm note archive"><p>Archive {selectedNote?.title}? It remains accessible under Archived notes.</p><LibraryButtonRow><NativeButton variant="destructive" disabled={noteSaving} onClick={() => void handleArchiveNote()}>Confirm archive</NativeButton><NativeButton variant="ghost" onClick={() => setConfirmArchive(false)}>Cancel</NativeButton></LibraryButtonRow></div> : null}
        {historyOpen && !creating ? <section aria-label="Note history and details">
          <p>{selectedNote?.tags.join(", ") || "No tags"} · Revision {selectedNote?.revision ?? "unavailable"}</p>
          {(selectedNote?.sourceRefs ?? []).map((source) => <p key={source}>{source}</p>)}
          {draft.hasRemoteChanges ? <section aria-label="Current canonical note"><h3>{selectedNote?.title}</h3><pre className="mc-next-settings-pre">{selectedNote?.body}</pre><NativeButton variant="outline" disabled={noteSaving} onClick={() => void handleUpdateNote(selectedNote?.revision)}>Apply draft to revision {selectedNote?.revision}</NativeButton></section> : null}
          {history.loading ? <p role="status">Loading note history…</p> : null}
          {history.error ? <LibraryNotice notice={{ tone: "error", message: history.error }} /> : null}
          <LibraryActionCardGrid items={(history.data ?? []).map((revision) => ({ id: `${revision.noteId}:${revision.revision}`, label: `Revision ${revision.revision}`, value: revision.source, description: revision.title, meta: `${formatDateTime(revision.createdAt)} · ${revision.actorId}`, tone: revision.revision === selectedNote?.revision ? "success" : "neutral" }))} emptyLabel={history.loading ? "Loading history…" : "No note history is available."} />
        </section> : null}
      </NativeCard> : <NativeCard title="Notes" subtitle={`${visibleNotes.length} matching · ${data?.notes.length ?? 0} loaded in ${activeWorkspaceName}`} actions={<LibraryButtonRow><NativeButton onClick={() => setCreating(true)}>{createDraft.isDirty ? "Resume new note" : "New note"}</NativeButton><NativeButton variant="ghost" onClick={() => void reload()}>Refresh</NativeButton></LibraryButtonRow>}>
        <LibraryFieldGrid><LibraryField label="Search notes"><input className="mc-next-settings-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></LibraryField><LibraryField label="Note status"><select className="mc-next-settings-input" value={lifecycleStatus} onChange={(event) => setLifecycleStatus(event.target.value as typeof lifecycleStatus)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All notes</option></select></LibraryField></LibraryFieldGrid>
        <LibrarySelectableList virtualized items={visibleNotes.map((note) => ({ id: note.noteId, title: note.title, meta: `${hasSessionDraft(keyForNote(note.noteId)) ? "Unsaved · " : ""}${note.tags.join(", ") || formatDateTime(note.updatedAt)}`, body: note.body ? note.body.slice(0, 180) : "No body text yet." }))} selectedId={selectedNoteId} onSelect={openNote} emptyLabel={query ? "No matching notes." : "No notes in this workspace yet."} />
      </NativeCard>}
      {!editor ? <NativeDisclosureCard id="notes-reminders" title="Reminders" subtitle={`${data?.reminders.length ?? 0} loaded`}>
        <LibraryButtonRow><NativeButton onClick={() => setReminderCreating(true)}>{reminderDraft.isDirty ? "Resume reminder" : "New reminder"}</NativeButton></LibraryButtonRow>
        <LibraryField label="Reminder status"><select className="mc-next-settings-input" value={reminderStatus} onChange={(event) => setReminderStatus(event.target.value as typeof reminderStatus)}><option value="scheduled">Scheduled</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="all">All reminders</option></select></LibraryField>
        <LibraryField label="Search reminders"><input className="mc-next-settings-input" type="search" value={reminderQuery} onChange={(event) => setReminderQuery(event.target.value)} /></LibraryField>
        <p>{visibleReminders.length} matching · {data?.reminders.length ?? 0} loaded</p>
        <LibrarySelectableList virtualized items={visibleReminders.map((reminder) => ({ id: reminder.reminderId, title: reminder.title, body: reminder.sourceRef ?? "Workspace reminder", meta: `${reminder.status} · ${formatDateTime(reminder.dueAt)}` }))} selectedId={selectedReminderId ?? ""} onSelect={setSelectedReminderId} emptyLabel={reminderQuery ? "No matching reminders." : "No reminders in this view."} />
        {reminderCreating ? <><LibraryFieldGrid><LibraryField label="Reminder"><input className="mc-next-settings-input" value={reminderDraft.value.title} onChange={(event) => reminderDraft.setValue((value) => ({ ...value, title: event.target.value }))} /></LibraryField><LibraryField label="Due at"><input type="datetime-local" className="mc-next-settings-input" value={reminderDraft.value.dueAt} onChange={(event) => reminderDraft.setValue((value) => ({ ...value, dueAt: event.target.value }))} /></LibraryField></LibraryFieldGrid><LibraryButtonRow><NativeButton disabled={reminderSaving || !reminderDraft.value.title.trim() || !toReminderDueAtIso(reminderDraft.value.dueAt)} onClick={() => void handleCreateReminder()}>Schedule</NativeButton><NativeButton variant="ghost" onClick={() => leave.request(() => setReminderCreating(false), [reminderDraft.key])}>Close</NativeButton></LibraryButtonRow></> : null}
      </NativeDisclosureCard> : null}
    </div>
    <DetailInspector open={selectedReminderId !== null} title={selectedReminder?.title ?? "Reminder"} onClose={() => setSelectedReminderId(null)}>
      {selectedReminder ? <>
        <p>{selectedReminder.status} · {formatDateTime(selectedReminder.dueAt)}</p>
        {selectedReminder.status === "scheduled" ? <NativeButton disabled={completingReminder} onClick={() => void handleCompleteReminder()}>{completingReminder ? "Completing…" : "Mark completed"}</NativeButton> : null}
        <dl><dt>Recurrence</dt><dd>{selectedReminder.recurrenceRule || "Does not repeat"}</dd><dt>Source</dt><dd>{selectedReminder.sourceRef || "None recorded"}</dd><dt>Approval</dt><dd>{selectedReminder.approvalId || "None recorded"}</dd><dt>Created</dt><dd>{formatDateTime(selectedReminder.createdAt)}</dd><dt>Updated</dt><dd>{formatDateTime(selectedReminder.updatedAt)}</dd><dt>Reminder ID</dt><dd>{selectedReminder.reminderId}</dd></dl>
      </> : <p role="alert">This reminder is unavailable in the current view. Close details and refresh or change the status filter.</p>}
    </DetailInspector>
    {leave.dialog}
  </LibrarySectionShell>;
}

export function toReminderDueAtIso(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
