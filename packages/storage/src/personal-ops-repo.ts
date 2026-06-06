import { randomUUID } from "node:crypto";
import type {
  NoteMutationInput,
  NoteRecord,
  PersonalOpsLifecycleStatus,
  ReminderMutationInput,
  ReminderRecord,
} from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export interface PersonalOpsWorkspaceAccess {
  workspaceId?: string;
}

export interface PersonalOpsNoteListQuery {
  workspaceId?: string;
  lifecycleStatus?: PersonalOpsLifecycleStatus | "all";
}

export interface PersonalOpsReminderListQuery {
  workspaceId?: string;
  status?: ReminderRecord["status"] | "all";
}

export interface PersonalOpsRepository {
  listNotes(query?: PersonalOpsNoteListQuery): NoteRecord[];
  createNote(input: NoteMutationInput, now?: string): NoteRecord;
  findNote(noteId: string): NoteRecord | undefined;
  getNote(noteId: string): NoteRecord;
  updateNote(
    noteId: string,
    input: Partial<NoteMutationInput>,
    access?: PersonalOpsWorkspaceAccess,
    now?: string,
  ): NoteRecord;
  archiveNote(noteId: string, access?: PersonalOpsWorkspaceAccess, now?: string): NoteRecord;
  listReminders(query?: PersonalOpsReminderListQuery): ReminderRecord[];
  createReminder(input: ReminderMutationInput, now?: string): ReminderRecord;
  findReminder(reminderId: string): ReminderRecord | undefined;
  getReminder(reminderId: string): ReminderRecord;
  completeReminder(reminderId: string, access?: PersonalOpsWorkspaceAccess, now?: string): ReminderRecord;
}

export class PersonalOpsInMemoryRepository implements PersonalOpsRepository {
  private readonly notes = new Map<string, NoteRecord>();
  private readonly reminders = new Map<string, ReminderRecord>();

  public listNotes(query: PersonalOpsNoteListQuery = {}): NoteRecord[] {
    const workspaceId = normalizeWorkspaceId(query.workspaceId);
    const lifecycleStatus = query.lifecycleStatus ?? "active";
    return Array.from(this.notes.values())
      .filter((note) => note.workspaceId === workspaceId)
      .filter((note) => lifecycleStatus === "all" || note.lifecycleStatus === lifecycleStatus)
      .sort(comparePersonalOpsRecords)
      .map(cloneNote);
  }

  public createNote(input: NoteMutationInput, now = new Date().toISOString()): NoteRecord {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const note: NoteRecord = {
      noteId: randomUUID(),
      workspaceId,
      title: requireText(input.title, "title", NOTE_TITLE_MAX),
      body: normalizeOptionalText(input.body, "body", NOTE_BODY_MAX) ?? "",
      tags: normalizeStringList(input.tags, "tags", TAG_MAX_ITEMS, TAG_MAX_CHARS),
      sourceRefs: normalizeStringList(input.sourceRefs, "sourceRefs", SOURCE_REF_MAX_ITEMS, SOURCE_REF_MAX_CHARS),
      lifecycleStatus: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.notes.set(note.noteId, note);
    return cloneNote(note);
  }

  public findNote(noteId: string): NoteRecord | undefined {
    const note = this.notes.get(requireId(noteId, "noteId"));
    return note ? cloneNote(note) : undefined;
  }

  public getNote(noteId: string): NoteRecord {
    const normalizedNoteId = requireId(noteId, "noteId");
    const note = this.notes.get(normalizedNoteId);
    if (!note) {
      throw new NotFoundError({ entity: "Note", id: normalizedNoteId });
    }
    return cloneNote(note);
  }

  public updateNote(
    noteId: string,
    input: Partial<NoteMutationInput>,
    access: PersonalOpsWorkspaceAccess = {},
    now = new Date().toISOString(),
  ): NoteRecord {
    const normalizedNoteId = requireId(noteId, "noteId");
    const current = this.notes.get(normalizedNoteId);
    if (!current) {
      throw new NotFoundError({ entity: "Note", id: normalizedNoteId });
    }
    assertWorkspaceAccess("Note", normalizedNoteId, current.workspaceId, input.workspaceId ?? access.workspaceId);

    const next: NoteRecord = {
      ...current,
      title: input.title === undefined ? current.title : requireText(input.title, "title", NOTE_TITLE_MAX),
      body:
        input.body === undefined ? current.body : (normalizeOptionalText(input.body, "body", NOTE_BODY_MAX) ?? ""),
      tags:
        input.tags === undefined
          ? [...current.tags]
          : normalizeStringList(input.tags, "tags", TAG_MAX_ITEMS, TAG_MAX_CHARS),
      sourceRefs:
        input.sourceRefs === undefined
          ? [...current.sourceRefs]
          : normalizeStringList(input.sourceRefs, "sourceRefs", SOURCE_REF_MAX_ITEMS, SOURCE_REF_MAX_CHARS),
      updatedAt: now,
    };
    this.notes.set(normalizedNoteId, next);
    return cloneNote(next);
  }

  public archiveNote(
    noteId: string,
    access: PersonalOpsWorkspaceAccess = {},
    now = new Date().toISOString(),
  ): NoteRecord {
    const normalizedNoteId = requireId(noteId, "noteId");
    const current = this.notes.get(normalizedNoteId);
    if (!current) {
      throw new NotFoundError({ entity: "Note", id: normalizedNoteId });
    }
    assertWorkspaceAccess("Note", normalizedNoteId, current.workspaceId, access.workspaceId);
    if (current.lifecycleStatus === "archived") {
      return cloneNote(current);
    }

    const next: NoteRecord = {
      ...current,
      lifecycleStatus: "archived",
      archivedAt: now,
      updatedAt: now,
    };
    this.notes.set(normalizedNoteId, next);
    return cloneNote(next);
  }

  public listReminders(query: PersonalOpsReminderListQuery = {}): ReminderRecord[] {
    const workspaceId = normalizeWorkspaceId(query.workspaceId);
    const status = query.status ?? "scheduled";
    return Array.from(this.reminders.values())
      .filter((reminder) => reminder.workspaceId === workspaceId)
      .filter((reminder) => status === "all" || reminder.status === status)
      .sort(comparePersonalOpsRecords)
      .map(cloneReminder);
  }

  public createReminder(input: ReminderMutationInput, now = new Date().toISOString()): ReminderRecord {
    const reminder: ReminderRecord = {
      reminderId: randomUUID(),
      workspaceId: normalizeWorkspaceId(input.workspaceId),
      title: requireText(input.title, "title", REMINDER_TITLE_MAX),
      dueAt: normalizeIsoDate(input.dueAt, "dueAt"),
      recurrenceRule: normalizeOptionalText(input.recurrenceRule, "recurrenceRule", RECURRENCE_RULE_MAX),
      status: "scheduled",
      sourceRef: normalizeOptionalText(input.sourceRef, "sourceRef", SOURCE_REF_MAX_CHARS),
      createdAt: now,
      updatedAt: now,
    };
    this.reminders.set(reminder.reminderId, reminder);
    return cloneReminder(reminder);
  }

  public findReminder(reminderId: string): ReminderRecord | undefined {
    const reminder = this.reminders.get(requireId(reminderId, "reminderId"));
    return reminder ? cloneReminder(reminder) : undefined;
  }

  public getReminder(reminderId: string): ReminderRecord {
    const normalizedReminderId = requireId(reminderId, "reminderId");
    const reminder = this.reminders.get(normalizedReminderId);
    if (!reminder) {
      throw new NotFoundError({ entity: "Reminder", id: normalizedReminderId });
    }
    return cloneReminder(reminder);
  }

  public completeReminder(
    reminderId: string,
    access: PersonalOpsWorkspaceAccess = {},
    now = new Date().toISOString(),
  ): ReminderRecord {
    const normalizedReminderId = requireId(reminderId, "reminderId");
    const current = this.reminders.get(normalizedReminderId);
    if (!current) {
      throw new NotFoundError({ entity: "Reminder", id: normalizedReminderId });
    }
    assertWorkspaceAccess("Reminder", normalizedReminderId, current.workspaceId, access.workspaceId);
    if (current.status === "completed") {
      return cloneReminder(current);
    }

    const next: ReminderRecord = {
      ...current,
      status: "completed",
      updatedAt: now,
    };
    this.reminders.set(normalizedReminderId, next);
    return cloneReminder(next);
  }
}

interface PersonalOpsNoteRow {
  note_id: string;
  workspace_id: string;
  title: string;
  body: string;
  tags_json: string;
  source_refs_json: string;
  lifecycle_status: PersonalOpsLifecycleStatus;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface PersonalOpsReminderRow {
  reminder_id: string;
  workspace_id: string;
  title: string;
  due_at: string;
  recurrence_rule: string | null;
  status: ReminderRecord["status"];
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}

export class PersonalOpsStorageRepository implements PersonalOpsRepository {
  private readonly listNotesStmt;
  private readonly insertNoteStmt;
  private readonly getNoteStmt;
  private readonly updateNoteStmt;
  private readonly listRemindersStmt;
  private readonly insertReminderStmt;
  private readonly getReminderStmt;
  private readonly updateReminderStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.ensureSchema();
    this.listNotesStmt = db.prepare(`
      SELECT *
      FROM personal_ops_notes
      WHERE workspace_id = @workspaceId
        AND (@lifecycleStatus = 'all' OR lifecycle_status = @lifecycleStatus)
      ORDER BY updated_at DESC, note_id DESC
    `);
    this.insertNoteStmt = db.prepare(`
      INSERT INTO personal_ops_notes (
        note_id, workspace_id, title, body, tags_json, source_refs_json,
        lifecycle_status, created_at, updated_at, archived_at
      ) VALUES (
        @noteId, @workspaceId, @title, @body, @tagsJson, @sourceRefsJson,
        @lifecycleStatus, @createdAt, @updatedAt, @archivedAt
      )
    `);
    this.getNoteStmt = db.prepare(`
      SELECT *
      FROM personal_ops_notes
      WHERE note_id = ?
      LIMIT 1
    `);
    this.updateNoteStmt = db.prepare(`
      UPDATE personal_ops_notes
      SET title = @title,
          body = @body,
          tags_json = @tagsJson,
          source_refs_json = @sourceRefsJson,
          lifecycle_status = @lifecycleStatus,
          updated_at = @updatedAt,
          archived_at = @archivedAt
      WHERE note_id = @noteId
    `);
    this.listRemindersStmt = db.prepare(`
      SELECT *
      FROM personal_ops_reminders
      WHERE workspace_id = @workspaceId
        AND (@status = 'all' OR status = @status)
      ORDER BY updated_at DESC, reminder_id DESC
    `);
    this.insertReminderStmt = db.prepare(`
      INSERT INTO personal_ops_reminders (
        reminder_id, workspace_id, title, due_at, recurrence_rule,
        status, source_ref, created_at, updated_at
      ) VALUES (
        @reminderId, @workspaceId, @title, @dueAt, @recurrenceRule,
        @status, @sourceRef, @createdAt, @updatedAt
      )
    `);
    this.getReminderStmt = db.prepare(`
      SELECT *
      FROM personal_ops_reminders
      WHERE reminder_id = ?
      LIMIT 1
    `);
    this.updateReminderStmt = db.prepare(`
      UPDATE personal_ops_reminders
      SET status = @status,
          updated_at = @updatedAt
      WHERE reminder_id = @reminderId
    `);
  }

  public listNotes(query: PersonalOpsNoteListQuery = {}): NoteRecord[] {
    const rows = toNoteRows(
      this.listNotesStmt.all({
        workspaceId: normalizeWorkspaceId(query.workspaceId),
        lifecycleStatus: query.lifecycleStatus ?? "active",
      }),
    );
    return rows.map(mapNoteRow);
  }

  public createNote(input: NoteMutationInput, now = new Date().toISOString()): NoteRecord {
    const workspaceId = normalizeWorkspaceId(input.workspaceId);
    const note: NoteRecord = {
      noteId: randomUUID(),
      workspaceId,
      title: requireText(input.title, "title", NOTE_TITLE_MAX),
      body: normalizeOptionalText(input.body, "body", NOTE_BODY_MAX) ?? "",
      tags: normalizeStringList(input.tags, "tags", TAG_MAX_ITEMS, TAG_MAX_CHARS),
      sourceRefs: normalizeStringList(input.sourceRefs, "sourceRefs", SOURCE_REF_MAX_ITEMS, SOURCE_REF_MAX_CHARS),
      lifecycleStatus: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.insertNoteStmt.run(toNoteParams(note));
    return this.getNote(note.noteId);
  }

  public findNote(noteId: string): NoteRecord | undefined {
    const row = toNoteRow(this.getNoteStmt.get(requireId(noteId, "noteId")));
    return row ? mapNoteRow(row) : undefined;
  }

  public getNote(noteId: string): NoteRecord {
    const normalizedNoteId = requireId(noteId, "noteId");
    const note = this.findNote(normalizedNoteId);
    if (!note) {
      throw new NotFoundError({ entity: "Note", id: normalizedNoteId });
    }
    return note;
  }

  public updateNote(
    noteId: string,
    input: Partial<NoteMutationInput>,
    access: PersonalOpsWorkspaceAccess = {},
    now = new Date().toISOString(),
  ): NoteRecord {
    const current = this.getNote(noteId);
    assertWorkspaceAccess("Note", current.noteId, current.workspaceId, input.workspaceId ?? access.workspaceId);
    const next: NoteRecord = {
      ...current,
      title: input.title === undefined ? current.title : requireText(input.title, "title", NOTE_TITLE_MAX),
      body:
        input.body === undefined ? current.body : (normalizeOptionalText(input.body, "body", NOTE_BODY_MAX) ?? ""),
      tags:
        input.tags === undefined
          ? [...current.tags]
          : normalizeStringList(input.tags, "tags", TAG_MAX_ITEMS, TAG_MAX_CHARS),
      sourceRefs:
        input.sourceRefs === undefined
          ? [...current.sourceRefs]
          : normalizeStringList(input.sourceRefs, "sourceRefs", SOURCE_REF_MAX_ITEMS, SOURCE_REF_MAX_CHARS),
      updatedAt: now,
    };
    this.updateNoteStmt.run(toNoteParams(next));
    return this.getNote(next.noteId);
  }

  public archiveNote(
    noteId: string,
    access: PersonalOpsWorkspaceAccess = {},
    now = new Date().toISOString(),
  ): NoteRecord {
    const current = this.getNote(noteId);
    assertWorkspaceAccess("Note", current.noteId, current.workspaceId, access.workspaceId);
    if (current.lifecycleStatus === "archived") {
      return current;
    }
    const next: NoteRecord = {
      ...current,
      lifecycleStatus: "archived",
      archivedAt: now,
      updatedAt: now,
    };
    this.updateNoteStmt.run(toNoteParams(next));
    return this.getNote(next.noteId);
  }

  public listReminders(query: PersonalOpsReminderListQuery = {}): ReminderRecord[] {
    const rows = toReminderRows(
      this.listRemindersStmt.all({
        workspaceId: normalizeWorkspaceId(query.workspaceId),
        status: query.status ?? "scheduled",
      }),
    );
    return rows.map(mapReminderRow);
  }

  public createReminder(input: ReminderMutationInput, now = new Date().toISOString()): ReminderRecord {
    const reminder: ReminderRecord = {
      reminderId: randomUUID(),
      workspaceId: normalizeWorkspaceId(input.workspaceId),
      title: requireText(input.title, "title", REMINDER_TITLE_MAX),
      dueAt: normalizeIsoDate(input.dueAt, "dueAt"),
      recurrenceRule: normalizeOptionalText(input.recurrenceRule, "recurrenceRule", RECURRENCE_RULE_MAX),
      status: "scheduled",
      sourceRef: normalizeOptionalText(input.sourceRef, "sourceRef", SOURCE_REF_MAX_CHARS),
      createdAt: now,
      updatedAt: now,
    };
    this.insertReminderStmt.run(toReminderParams(reminder));
    return this.getReminder(reminder.reminderId);
  }

  public findReminder(reminderId: string): ReminderRecord | undefined {
    const row = toReminderRow(this.getReminderStmt.get(requireId(reminderId, "reminderId")));
    return row ? mapReminderRow(row) : undefined;
  }

  public getReminder(reminderId: string): ReminderRecord {
    const normalizedReminderId = requireId(reminderId, "reminderId");
    const reminder = this.findReminder(normalizedReminderId);
    if (!reminder) {
      throw new NotFoundError({ entity: "Reminder", id: normalizedReminderId });
    }
    return reminder;
  }

  public completeReminder(
    reminderId: string,
    access: PersonalOpsWorkspaceAccess = {},
    now = new Date().toISOString(),
  ): ReminderRecord {
    const current = this.getReminder(reminderId);
    assertWorkspaceAccess("Reminder", current.reminderId, current.workspaceId, access.workspaceId);
    if (current.status === "completed") {
      return current;
    }
    this.updateReminderStmt.run({
      reminderId: current.reminderId,
      status: "completed",
      updatedAt: now,
    });
    return this.getReminder(current.reminderId);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personal_ops_notes (
        note_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_personal_ops_notes_workspace_updated
        ON personal_ops_notes(workspace_id, updated_at);

      CREATE TABLE IF NOT EXISTS personal_ops_reminders (
        reminder_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        due_at TEXT NOT NULL,
        recurrence_rule TEXT,
        status TEXT NOT NULL,
        source_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_personal_ops_reminders_workspace_updated
        ON personal_ops_reminders(workspace_id, updated_at);
    `);
  }
}

const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;
const NOTE_TITLE_MAX = 300;
const NOTE_BODY_MAX = 20_000;
const REMINDER_TITLE_MAX = 300;
const RECURRENCE_RULE_MAX = 500;
const TAG_MAX_ITEMS = 32;
const TAG_MAX_CHARS = 60;
const SOURCE_REF_MAX_ITEMS = 50;
const SOURCE_REF_MAX_CHARS = 1_000;

function normalizeWorkspaceId(value: string | undefined): string {
  return sanitizeWorkspaceId(value ?? "default");
}

function normalizeOptionalWorkspaceId(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizeWorkspaceId(value);
}

function sanitizeWorkspaceId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "workspaceId" });
  }
  if (!WORKSPACE_ID_PATTERN.test(trimmed)) {
    throw new ValidationError({ field: "workspaceId", message: "workspaceId contains unsupported characters" });
  }
  return trimmed;
}

function assertWorkspaceAccess(entity: string, id: string, actualWorkspaceId: string, requestedWorkspaceId?: string): void {
  const normalized = normalizeOptionalWorkspaceId(requestedWorkspaceId);
  if (normalized && normalized !== actualWorkspaceId) {
    throw new NotFoundError({ entity, id });
  }
}

function requireId(value: string, field: string): string {
  return requireText(value, field, 240);
}

function requireText(value: string | undefined, field: string, maxLength: number): string {
  const normalized = normalizeText(value, field, maxLength);
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return normalized;
}

function normalizeOptionalText(value: string | undefined, field: string, maxLength: number): string | undefined {
  const normalized = normalizeText(value, field, maxLength);
  return normalized || undefined;
}

function normalizeText(value: string | undefined, field: string, maxLength: number): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ValidationError({ field });
  }
  const normalized = value.replaceAll("\u0000", "").trim();
  if (normalized.length > maxLength) {
    throw new ValidationError({ field, message: `${field} exceeds ${maxLength} characters` });
  }
  return normalized;
}

function normalizeStringList(
  value: string[] | undefined,
  field: string,
  maxItems: number,
  maxChars: number,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ValidationError({ field });
  }
  if (value.length > maxItems) {
    throw new ValidationError({ field, message: `${field} supports at most ${maxItems} items` });
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ValidationError({ field });
    }
    const text = normalizeText(item, field, maxChars);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}

function normalizeIsoDate(value: string, field: string): string {
  const normalized = requireText(value, field, 120);
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) {
    throw new ValidationError({ field, message: `${field} must be a valid ISO timestamp` });
  }
  return new Date(timestamp).toISOString();
}

function cloneNote(note: NoteRecord): NoteRecord {
  return {
    ...note,
    tags: [...note.tags],
    sourceRefs: [...note.sourceRefs],
  };
}

function cloneReminder(reminder: ReminderRecord): ReminderRecord {
  return { ...reminder };
}

function comparePersonalOpsRecords(
  a: Pick<NoteRecord, "updatedAt"> | Pick<ReminderRecord, "updatedAt">,
  b: Pick<NoteRecord, "updatedAt"> | Pick<ReminderRecord, "updatedAt">,
): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function toNoteParams(note: NoteRecord): Record<string, unknown> {
  return {
    noteId: note.noteId,
    workspaceId: note.workspaceId,
    title: note.title,
    body: note.body,
    tagsJson: JSON.stringify(note.tags),
    sourceRefsJson: JSON.stringify(note.sourceRefs),
    lifecycleStatus: note.lifecycleStatus,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    archivedAt: note.archivedAt ?? null,
  };
}

function toReminderParams(reminder: ReminderRecord): Record<string, unknown> {
  return {
    reminderId: reminder.reminderId,
    workspaceId: reminder.workspaceId,
    title: reminder.title,
    dueAt: reminder.dueAt,
    recurrenceRule: reminder.recurrenceRule ?? null,
    status: reminder.status,
    sourceRef: reminder.sourceRef ?? null,
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
  };
}

function mapNoteRow(row: PersonalOpsNoteRow): NoteRecord {
  return {
    noteId: row.note_id,
    workspaceId: row.workspace_id,
    title: row.title,
    body: row.body,
    tags: safeJsonParse<string[]>(row.tags_json, []),
    sourceRefs: safeJsonParse<string[]>(row.source_refs_json, []),
    lifecycleStatus: row.lifecycle_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
  };
}

function mapReminderRow(row: PersonalOpsReminderRow): ReminderRecord {
  return {
    reminderId: row.reminder_id,
    workspaceId: row.workspace_id,
    title: row.title,
    dueAt: row.due_at,
    recurrenceRule: row.recurrence_rule ?? undefined,
    status: row.status,
    sourceRef: row.source_ref ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toNoteRow(value: unknown): PersonalOpsNoteRow | undefined {
  return isNoteRow(value) ? value : undefined;
}

function toNoteRows(value: unknown): PersonalOpsNoteRow[] {
  return Array.isArray(value) ? value.filter(isNoteRow) : [];
}

function isNoteRow(value: unknown): value is PersonalOpsNoteRow {
  const row = value as Partial<PersonalOpsNoteRow> | undefined;
  return (
    Boolean(row) &&
    typeof row?.note_id === "string" &&
    typeof row.workspace_id === "string" &&
    typeof row.title === "string" &&
    typeof row.body === "string" &&
    typeof row.tags_json === "string" &&
    typeof row.source_refs_json === "string" &&
    typeof row.lifecycle_status === "string" &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string"
  );
}

function toReminderRow(value: unknown): PersonalOpsReminderRow | undefined {
  return isReminderRow(value) ? value : undefined;
}

function toReminderRows(value: unknown): PersonalOpsReminderRow[] {
  return Array.isArray(value) ? value.filter(isReminderRow) : [];
}

function isReminderRow(value: unknown): value is PersonalOpsReminderRow {
  const row = value as Partial<PersonalOpsReminderRow> | undefined;
  return (
    Boolean(row) &&
    typeof row?.reminder_id === "string" &&
    typeof row.workspace_id === "string" &&
    typeof row.title === "string" &&
    typeof row.due_at === "string" &&
    typeof row.status === "string" &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string"
  );
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
