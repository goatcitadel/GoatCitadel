import type { NoteMutationInput, NoteRecord } from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function listNotes(
  workspaceId = "default",
  options: { lifecycleStatus?: "active" | "archived" | "all" } = {},
): Promise<{ items: NoteRecord[] }> {
  const query = new URLSearchParams({ workspaceId });
  if (options.lifecycleStatus) query.set("lifecycleStatus", options.lifecycleStatus);
  return request<{ items: NoteRecord[] }>(`/api/v1/notes?${query}`);
}

export async function updateNote(
  noteId: string,
  input: Partial<NoteMutationInput> & { expectedRevision?: number },
): Promise<NoteRecord> {
  return request<NoteRecord>(`/api/v1/notes/${encodeURIComponent(noteId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  createNote,
  listNoteRevisions,
  archiveNote,
  listReminders,
  createReminder,
  completeReminder,
  fetchCommunicationsDashboard,
  createMailDraft,
  getMailDraft,
  sendMailDraft,
  createCalendarEvent,
} from "./personal-ops-operations.js";
