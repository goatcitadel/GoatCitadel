import type {
  CalendarEventRecord,
  CommunicationsDashboardResponse,
  MailDraftRecord,
  NoteMutationInput,
  NoteRecord,
  NoteRevisionRecord,
  ReminderMutationInput,
  ReminderRecord,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function listNotes(workspaceId = "default"): Promise<{ items: NoteRecord[] }> {
  return request<{ items: NoteRecord[] }>(`/api/v1/notes?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export async function createNote(input: NoteMutationInput): Promise<NoteRecord> {
  return request<NoteRecord>("/api/v1/notes", {
    method: "POST",
    body: JSON.stringify(input),
  });
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

export async function listNoteRevisions(
  noteId: string,
  workspaceId = "default",
): Promise<{ items: NoteRevisionRecord[] }> {
  return request<{ items: NoteRevisionRecord[] }>(
    `/api/v1/notes/${encodeURIComponent(noteId)}/history?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
}

export async function archiveNote(noteId: string): Promise<NoteRecord> {
  return request<NoteRecord>(`/api/v1/notes/${encodeURIComponent(noteId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function listReminders(workspaceId = "default"): Promise<{ items: ReminderRecord[] }> {
  return request<{ items: ReminderRecord[] }>(`/api/v1/reminders?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export async function createReminder(input: ReminderMutationInput): Promise<ReminderRecord> {
  return request<ReminderRecord>("/api/v1/reminders", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function completeReminder(reminderId: string): Promise<ReminderRecord> {
  return request<ReminderRecord>(`/api/v1/reminders/${encodeURIComponent(reminderId)}/complete`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchCommunicationsDashboard(workspaceId = "default"): Promise<CommunicationsDashboardResponse> {
  return request<CommunicationsDashboardResponse>(
    `/api/v1/communications?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
}

export async function createMailDraft(input: {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
}): Promise<MailDraftRecord> {
  return request<MailDraftRecord>("/api/v1/mail/drafts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function sendMailDraft(draftId: string): Promise<MailDraftRecord> {
  return request<MailDraftRecord>(`/api/v1/mail/drafts/${encodeURIComponent(draftId)}/send`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function createCalendarEvent(input: Omit<CalendarEventRecord, "eventId" | "createdAt" | "updatedAt">) {
  return request<CalendarEventRecord>("/api/v1/calendar/events", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
