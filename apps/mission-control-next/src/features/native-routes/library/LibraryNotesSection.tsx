import { useMemo, useState } from "react";
import {
  createNote,
  createReminder,
  listNotes,
  listReminders,
} from "@goatcitadel/mission-control-shared/api/personal-ops";
import { NativeCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import {
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  useAsyncLoad,
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

export function LibraryNotesSection({ activeWorkspaceId, activeWorkspaceName }: NativeRoutePagesProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reminderTitle, setReminderTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
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

  const handleCreateNote = async () => {
    try {
      const created = await createNote({ workspaceId: activeWorkspaceId, title, body });
      setTitle("");
      setBody("");
      setNotice({ tone: "success", message: `${created.title} saved.` });
      await reload();
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
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

  return (
    <LibrarySectionShell loading={loading} error={error}>
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
            selectedId=""
            onSelect={() => undefined}
            emptyLabel="No notes in this workspace yet."
          />
        </NativeCard>
        <div className="mc-next-settings-stack">
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
              <button type="button" className="mc-next-settings-filter" onClick={() => void handleCreateNote()}>
                Save note
              </button>
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
