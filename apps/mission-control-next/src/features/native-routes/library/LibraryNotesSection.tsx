import { useEffect, useMemo, useState } from "react";
import type { NoteRevisionRecord } from "@goatcitadel/contracts";
import {
  archiveNote,
  createNote,
  createReminder,
  listNoteRevisions,
  listNotes,
  listReminders,
  updateNote,
} from "@goatcitadel/mission-control-shared/api/personal-ops";
import { NativeCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import {
  formatDateTime,
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  useAsyncLoad,
  type LoadState,
  type Notice,
} from "../shared/native-helpers";
import {
  LibraryActionCardGrid,
  LibraryButtonRow,
  LibraryField,
  LibraryFieldGrid,
  LibraryLoadWarnings,
  LibraryNotice,
  LibrarySectionShell,
  LibrarySelectableList,
} from "../shared/library-primitives";
import { NativeButton } from "../primitives";

export function LibraryNotesSection({ activeWorkspaceId, activeWorkspaceName }: NativeRoutePagesProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reminderTitle, setReminderTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [selectedNoteId, setSelectedNoteId] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [history, setHistory] = useState<LoadState<NoteRevisionRecord[]>>({
    loading: false,
    error: null,
    data: null,
  });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [notes, reminders] = await Promise.all([
      nativeLoad("Notes", listNotes(activeWorkspaceId), { items: [] }),
      nativeLoad("Reminders", listReminders(activeWorkspaceId), { items: [] }),
    ]);
    return {
      issues: nativeLoadIssues([notes, reminders]),
      notes: notes.data.items,
      reminders: reminders.data.items,
    };
  }, [activeWorkspaceId]);

  const latestNotes = useMemo(() => data?.notes.slice(0, 40) ?? [], [data?.notes]);
  const upcomingReminders = useMemo(() => data?.reminders.slice(0, 20) ?? [], [data?.reminders]);
  const selectedNote = latestNotes.find((note) => note.noteId === selectedNoteId) ?? null;

  useEffect(() => {
    if (!latestNotes.length) {
      setSelectedNoteId("");
      return;
    }
    setSelectedNoteId((current) =>
      latestNotes.some((note) => note.noteId === current) ? current : (latestNotes[0]?.noteId ?? ""),
    );
  }, [latestNotes]);

  useEffect(() => {
    if (!selectedNote) {
      setEditTitle("");
      setEditBody("");
      setHistory({ loading: false, error: null, data: null });
      return;
    }
    setEditTitle(selectedNote.title);
    setEditBody(selectedNote.body);
    let cancelled = false;
    setHistory({ loading: true, error: null, data: null });
    void listNoteRevisions(selectedNote.noteId, activeWorkspaceId)
      .then((result) => {
        if (!cancelled) setHistory({ loading: false, error: null, data: result.items });
      })
      .catch((historyError: unknown) => {
        if (!cancelled) setHistory({ loading: false, error: getErrorMessage(historyError), data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, selectedNote]);

  const handleCreateNote = async () => {
    setNoteSaving(true);
    try {
      const created = await createNote({ workspaceId: activeWorkspaceId, title, body });
      setTitle("");
      setBody("");
      setNotice({ tone: "success", message: `${created.title} saved.` });
      await reload();
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    } finally {
      setNoteSaving(false);
    }
  };

  const handleCreateReminder = async () => {
    try {
      const created = await createReminder({ workspaceId: activeWorkspaceId, title: reminderTitle, dueAt });
      setReminderTitle("");
      setDueAt("");
      setNotice({ tone: "success", message: `${created.title} scheduled.` });
      await reload();
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleUpdateNote = async () => {
    if (!selectedNote) return;
    setNoteSaving(true);
    try {
      const updated = await updateNote(selectedNote.noteId, {
        workspaceId: activeWorkspaceId,
        title: editTitle,
        body: editBody,
        expectedRevision: selectedNote.revision,
      });
      setNotice({ tone: "success", message: `${updated.title} updated at revision ${updated.revision}.` });
      await reload();
    } catch (updateError) {
      setNotice({
        tone: "error",
        message: `${getErrorMessage(updateError)} Your draft is preserved; reload the canonical note before retrying.`,
      });
    } finally {
      setNoteSaving(false);
    }
  };

  const handleArchiveNote = async () => {
    if (!selectedNote) return;
    setNoteSaving(true);
    try {
      await archiveNote(selectedNote.noteId, activeWorkspaceId);
      setNotice({ tone: "success", message: `${selectedNote.title} archived.` });
      setSelectedNoteId("");
      await reload();
    } catch (archiveError) {
      setNotice({ tone: "error", message: getErrorMessage(archiveError) });
    } finally {
      setNoteSaving(false);
    }
  };

  return (
    <LibrarySectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <LibraryNotice notice={notice} /> : null}
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Notes"
          subtitle={`Working notes and business context for ${activeWorkspaceName}.`}
          stats={[
            { label: "Active notes", value: String(data?.notes.length ?? 0) },
            { label: "Reminders", value: String(data?.reminders.length ?? 0) },
          ]}
        >
          <LibrarySelectableList
            items={latestNotes.map((note) => ({
              id: note.noteId,
              title: note.title,
              meta: note.tags.join(", ") || note.updatedAt,
              body: note.body || "No body text yet.",
            }))}
            selectedId={selectedNoteId}
            onSelect={setSelectedNoteId}
            emptyLabel="No notes in this workspace yet."
          />
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={selectedNote ? `Edit ${selectedNote.title}` : "Note detail"}
            subtitle={
              selectedNote
                ? `Optimistic revision ${selectedNote.revision}; conflicts preserve the local draft.`
                : "Select a note to edit, archive, or inspect its immutable history."
            }
          >
            {selectedNote ? (
              <>
                <LibraryFieldGrid>
                  <LibraryField label="Edit title">
                    <input
                      className="mc-next-settings-input"
                      value={editTitle}
                      onChange={(event) => setEditTitle(event.target.value)}
                    />
                  </LibraryField>
                  <LibraryField label="Edit body" span={2}>
                    <textarea
                      className="mc-next-settings-input"
                      value={editBody}
                      onChange={(event) => setEditBody(event.target.value)}
                      rows={5}
                    />
                  </LibraryField>
                </LibraryFieldGrid>
                <LibraryButtonRow>
                  <NativeButton
                    onClick={() => void handleUpdateNote()}
                    disabled={noteSaving || !editTitle.trim() || !editBody.trim()}
                  >
                    {noteSaving ? "Saving changes..." : "Save changes"}
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => void reload()} disabled={noteSaving}>
                    Reload canonical
                  </NativeButton>
                  <NativeButton variant="destructive" onClick={() => void handleArchiveNote()} disabled={noteSaving}>
                    Archive note
                  </NativeButton>
                </LibraryButtonRow>
                {history.loading ? <p role="status">Loading note history…</p> : null}
                {history.error ? <LibraryNotice notice={{ tone: "error", message: history.error }} /> : null}
                <LibraryActionCardGrid
                  items={(history.data ?? []).map((revision) => ({
                    id: `${revision.noteId}:${revision.revision}`,
                    label: `Revision ${revision.revision}`,
                    value: revision.source,
                    description: revision.title,
                    meta: `${formatDateTime(revision.createdAt)} · ${revision.actorId}`,
                    tone: revision.revision === selectedNote.revision ? "success" : "neutral",
                  }))}
                  emptyLabel={history.loading ? "Loading history…" : "No note history is available."}
                />
              </>
            ) : (
              <p>No note selected.</p>
            )}
          </NativeCard>
          <NativeCard title="Capture note" subtitle="Save reusable context without promoting it to durable memory.">
            <LibraryFieldGrid>
              <LibraryField label="Title">
                <input
                  className="mc-next-settings-input"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Client follow-up"
                />
              </LibraryField>
              <LibraryField label="Body" span={2}>
                <textarea
                  className="mc-next-settings-input"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="Details, decisions, links, or next steps"
                  rows={5}
                />
              </LibraryField>
            </LibraryFieldGrid>
            <LibraryButtonRow>
              <NativeButton
                onClick={() => void handleCreateNote()}
                disabled={noteSaving || !title.trim() || !body.trim()}
              >
                {noteSaving ? "Saving note..." : "Save note"}
              </NativeButton>
            </LibraryButtonRow>
          </NativeCard>
          <NativeCard title="Reminders" subtitle="Operator-visible commitments and follow-ups.">
            <LibraryActionCardGrid
              items={upcomingReminders.map((reminder) => ({
                id: reminder.reminderId,
                label: reminder.title,
                value: reminder.status,
                description: reminder.sourceRef ?? "Workspace reminder",
                meta: reminder.dueAt,
                tone: reminder.status === "scheduled" ? "info" : "neutral",
              }))}
              emptyLabel="No active reminders."
            />
            <LibraryFieldGrid>
              <LibraryField label="Reminder">
                <input
                  className="mc-next-settings-input"
                  value={reminderTitle}
                  onChange={(event) => setReminderTitle(event.target.value)}
                  placeholder="Review proposal"
                />
              </LibraryField>
              <LibraryField label="Due at">
                <input
                  className="mc-next-settings-input"
                  value={dueAt}
                  onChange={(event) => setDueAt(event.target.value)}
                  placeholder="2026-06-06T17:00:00.000Z"
                />
              </LibraryField>
            </LibraryFieldGrid>
            <LibraryButtonRow>
              <button type="button" className="mc-next-settings-filter" onClick={() => void handleCreateReminder()}>
                Schedule
              </button>
            </LibraryButtonRow>
          </NativeCard>
        </div>
      </div>
    </LibrarySectionShell>
  );
}
