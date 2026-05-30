import type { ChatMode, ChatSideChatRecord } from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface ChatSideChatRow {
  side_chat_id: string;
  parent_session_id: string;
  child_session_id: string;
  workspace_id: string;
  created_from_surface: ChatMode;
  source_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatSideChatCreateInput {
  sideChatId: string;
  parentSessionId: string;
  childSessionId: string;
  workspaceId?: string;
  createdFromSurface: ChatMode;
  sourceTurnId?: string;
}

export class ChatSideChatRepository {
  private readonly getByParentStmt;
  private readonly getByChildStmt;
  private readonly upsertStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getByParentStmt = db.prepare("SELECT * FROM chat_side_chats WHERE parent_session_id = ?");
    this.getByChildStmt = db.prepare("SELECT * FROM chat_side_chats WHERE child_session_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_side_chats (
        side_chat_id, parent_session_id, child_session_id, workspace_id, created_from_surface,
        source_turn_id, created_at, updated_at
      ) VALUES (
        @sideChatId, @parentSessionId, @childSessionId, @workspaceId, @createdFromSurface,
        @sourceTurnId, @createdAt, @updatedAt
      )
      ON CONFLICT(parent_session_id) DO UPDATE SET
        child_session_id = excluded.child_session_id,
        workspace_id = excluded.workspace_id,
        created_from_surface = excluded.created_from_surface,
        source_turn_id = excluded.source_turn_id,
        updated_at = excluded.updated_at
    `);
  }

  public getByParentSession(parentSessionId: string): ChatSideChatRecord | undefined {
    const row = toChatSideChatRow(this.getByParentStmt.get(sanitizeRequiredId(parentSessionId, "parentSessionId")));
    return row ? mapRow(row) : undefined;
  }

  public getByChildSession(childSessionId: string): ChatSideChatRecord | undefined {
    const row = toChatSideChatRow(this.getByChildStmt.get(sanitizeRequiredId(childSessionId, "childSessionId")));
    return row ? mapRow(row) : undefined;
  }

  public upsert(input: ChatSideChatCreateInput, now = new Date().toISOString()): ChatSideChatRecord {
    const parentSessionId = sanitizeRequiredId(input.parentSessionId, "parentSessionId");
    const existing = this.getByParentSession(parentSessionId);
    this.upsertStmt.run({
      sideChatId: existing?.sideChatId ?? sanitizeRequiredId(input.sideChatId, "sideChatId"),
      parentSessionId,
      childSessionId: sanitizeRequiredId(input.childSessionId, "childSessionId"),
      workspaceId: sanitizeWorkspaceId(input.workspaceId),
      createdFromSurface: sanitizeChatMode(input.createdFromSurface),
      sourceTurnId: input.sourceTurnId?.trim() || null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    const row = toChatSideChatRow(this.getByParentStmt.get(parentSessionId));
    if (!row) {
      throw new TypeError("chat_side_chats upsert did not return a row");
    }
    return mapRow(row);
  }
}

function toChatSideChatRow(row: unknown): ChatSideChatRow | undefined {
  if (row !== undefined && !isChatSideChatRow(row)) {
    throw new TypeError("Unexpected chat_side_chats row shape");
  }
  return row;
}

function isChatSideChatRow(value: unknown): value is ChatSideChatRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.side_chat_id === "string" &&
    typeof value.parent_session_id === "string" &&
    typeof value.child_session_id === "string" &&
    typeof value.workspace_id === "string" &&
    (value.created_from_surface === "chat" ||
      value.created_from_surface === "cowork" ||
      value.created_from_surface === "code") &&
    (typeof value.source_turn_id === "string" || value.source_turn_id === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function mapRow(row: ChatSideChatRow): ChatSideChatRecord {
  return {
    sideChatId: row.side_chat_id,
    parentSessionId: row.parent_session_id,
    childSessionId: row.child_session_id,
    workspaceId: row.workspace_id,
    createdFromSurface: row.created_from_surface,
    sourceTurnId: row.source_turn_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeRequiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return trimmed;
}

function sanitizeWorkspaceId(value?: string): string {
  const trimmed = value?.trim() || "default";
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(trimmed)) {
    throw new ValidationError({ message: "workspaceId contains unsupported characters" });
  }
  return trimmed;
}

function sanitizeChatMode(value: ChatMode): ChatMode {
  if (value === "chat" || value === "cowork" || value === "code") {
    return value;
  }
  throw new ValidationError({ message: "createdFromSurface is invalid" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
