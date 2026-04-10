import type { DatabaseClient } from "./db.js";
import { ValidationError } from "@goatcitadel/contracts";
import type { ChatSessionOrigin } from "@goatcitadel/contracts";

export interface ChatSessionMetaRecord {
  sessionId: string;
  workspaceId?: string;
  title?: string;
  origin?: ChatSessionOrigin;
  includeInHistory: boolean;
  pinned: boolean;
  lifecycleStatus: "active" | "archived";
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatSessionMetaRow {
  session_id: string;
  workspace_id: string;
  title: string | null;
  origin: string | null;
  include_in_history: number;
  pinned: number;
  lifecycle_status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatSessionMetaPatchInput {
  workspaceId?: string;
  title?: string;
  origin?: ChatSessionOrigin;
  includeInHistory?: boolean;
  pinned?: boolean;
  lifecycleStatus?: "active" | "archived";
  archivedAt?: string;
}

export class ChatSessionMetaRepository {
  private readonly getStmt;
  private readonly upsertStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_session_meta WHERE session_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_session_meta (
        session_id, workspace_id, title, origin, include_in_history, pinned, lifecycle_status, archived_at, created_at, updated_at
      ) VALUES (
        @sessionId, @workspaceId, @title, @origin, @includeInHistory, @pinned, @lifecycleStatus, @archivedAt, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        title = excluded.title,
        origin = excluded.origin,
        include_in_history = excluded.include_in_history,
        pinned = excluded.pinned,
        lifecycle_status = excluded.lifecycle_status,
        archived_at = excluded.archived_at,
        updated_at = excluded.updated_at
    `);
  }

  public get(sessionId: string): ChatSessionMetaRecord | undefined {
    const row = toChatSessionMetaRow(this.getStmt.get(sessionId));
    return row ? mapRow(row) : undefined;
  }

  public ensure(sessionId: string, now = new Date().toISOString(), workspaceId = "default"): ChatSessionMetaRecord {
    const existing = this.get(sessionId);
    if (existing) {
      return existing;
    }
    this.upsertStmt.run({
      sessionId,
      workspaceId: sanitizeWorkspaceId(workspaceId),
      title: null,
      origin: null,
      includeInHistory: 1,
      pinned: 0,
      lifecycleStatus: "active",
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const row = toChatSessionMetaRow(this.getStmt.get(sessionId));
    if (!row) {
      throw new TypeError("chat_session_meta ensure did not return a row");
    }
    return mapRow(row);
  }

  public patch(sessionId: string, input: ChatSessionMetaPatchInput, now = new Date().toISOString()): ChatSessionMetaRecord {
    const current = this.ensure(sessionId, now);
    this.upsertStmt.run({
      sessionId,
      workspaceId: input.workspaceId !== undefined ? sanitizeWorkspaceId(input.workspaceId) : sanitizeWorkspaceId(current.workspaceId ?? "default"),
      title: input.title !== undefined ? sanitizeOptional(input.title) : current.title ?? null,
      origin: input.origin !== undefined ? sanitizeOrigin(input.origin) : sanitizeOrigin(current.origin),
      includeInHistory: input.includeInHistory !== undefined ? (input.includeInHistory ? 1 : 0) : (current.includeInHistory ? 1 : 0),
      pinned: input.pinned !== undefined ? (input.pinned ? 1 : 0) : (current.pinned ? 1 : 0),
      lifecycleStatus: input.lifecycleStatus ?? current.lifecycleStatus,
      archivedAt: input.archivedAt !== undefined ? input.archivedAt : current.archivedAt ?? null,
      createdAt: current.createdAt,
      updatedAt: now,
    });
    const row = toChatSessionMetaRow(this.getStmt.get(sessionId));
    if (!row) {
      throw new TypeError("chat_session_meta patch did not return a row");
    }
    return mapRow(row);
  }

  public listBySessionIds(sessionIds: string[], workspaceId?: string): Map<string, ChatSessionMetaRecord> {
    if (sessionIds.length === 0) {
      return new Map();
    }
    const placeholders = sessionIds.map(() => "?").join(", ");
    const workspace = workspaceId ? sanitizeWorkspaceId(workspaceId) : undefined;
    const sql = workspace
      ? `
        SELECT * FROM chat_session_meta
        WHERE session_id IN (${placeholders})
          AND workspace_id = ?
      `
      : `
        SELECT * FROM chat_session_meta
        WHERE session_id IN (${placeholders})
      `;
    const rows = toChatSessionMetaRows(this.db.prepare(sql).all(...sessionIds, ...(workspace ? [workspace] : [])));
    return new Map(rows.map((row) => [row.session_id, mapRow(row)]));
  }
}

function toChatSessionMetaRow(row: unknown): ChatSessionMetaRow | undefined {
  if (row !== undefined && !isChatSessionMetaRow(row)) {
    throw new TypeError("Unexpected chat_session_meta row shape");
  }
  return row;
}

function toChatSessionMetaRows(rows: unknown): ChatSessionMetaRow[] {
  if (!Array.isArray(rows) || rows.some((row) => !isChatSessionMetaRow(row))) {
    throw new TypeError("Unexpected chat_session_meta row shape");
  }
  return rows;
}

function isChatSessionMetaRow(value: unknown): value is ChatSessionMetaRow {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.session_id === "string"
    && typeof value.workspace_id === "string"
    && (typeof value.title === "string" || value.title === null)
    && (typeof value.origin === "string" || value.origin === null)
    && typeof value.include_in_history === "number"
    && typeof value.pinned === "number"
    && (value.lifecycle_status === "active" || value.lifecycle_status === "archived")
    && (typeof value.archived_at === "string" || value.archived_at === null)
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mapRow(row: ChatSessionMetaRow): ChatSessionMetaRecord {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    title: row.title ?? undefined,
    origin: row.origin === "operator" || row.origin === "prompt_pack" || row.origin === "system"
      ? row.origin
      : undefined,
    includeInHistory: row.include_in_history !== 0,
    pinned: row.pinned === 1,
    lifecycleStatus: row.lifecycle_status,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeOptional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function sanitizeOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  if (!/^[a-z0-9._-]{1,64}$/.test(trimmed)) {
    throw new ValidationError({ message: "origin contains unsupported characters" });
  }
  return trimmed;
}

function sanitizeWorkspaceId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "workspaceId" });
  }
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(trimmed)) {
    throw new ValidationError({ message: "workspaceId contains unsupported characters" });
  }
  return trimmed;
}


