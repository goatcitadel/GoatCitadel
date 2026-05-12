import type { DatabaseClient } from "./db.js";
import type { ChatSessionBindingRecord } from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ChatSessionBindingRow {
  session_id: string;
  workspace_id: string;
  transport: "llm" | "integration";
  connection_id: string | null;
  target_json: string | null;
  writable: number;
  created_at: string;
  updated_at: string;
}

export interface ChatSessionBindingUpsertInput {
  sessionId: string;
  workspaceId?: string;
  transport: "llm" | "integration";
  connectionId?: string;
  target?: string;
  writable?: boolean;
}

export class ChatSessionBindingRepository {
  private readonly getStmt;
  private readonly upsertStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_session_bindings WHERE session_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_session_bindings (
        session_id, workspace_id, transport, connection_id, target_json, writable, created_at, updated_at
      ) VALUES (
        @sessionId, @workspaceId, @transport, @connectionId, @targetJson, @writable, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        transport = excluded.transport,
        connection_id = excluded.connection_id,
        target_json = excluded.target_json,
        writable = excluded.writable,
        updated_at = excluded.updated_at
    `);
  }

  public get(sessionId: string): ChatSessionBindingRecord | undefined {
    const row = toChatSessionBindingRow(this.getStmt.get(sessionId));
    return row ? mapRow(row) : undefined;
  }

  public upsert(input: ChatSessionBindingUpsertInput, now = new Date().toISOString()): ChatSessionBindingRecord {
    const existingRow = toChatSessionBindingRow(this.getStmt.get(input.sessionId));
    const existing = existingRow ? mapRow(existingRow) : undefined;
    this.upsertStmt.run({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId
        ? sanitizeWorkspaceId(input.workspaceId)
        : (existingRow?.workspace_id ?? "default"),
      transport: input.transport,
      connectionId: input.connectionId ?? null,
      targetJson: input.target ? JSON.stringify({ target: input.target }) : null,
      writable: input.writable === undefined ? (existing?.writable === false ? 0 : 1) : input.writable ? 1 : 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    const row = toChatSessionBindingRow(this.getStmt.get(input.sessionId));
    if (!row) {
      throw new TypeError("chat_session_bindings upsert did not return a row");
    }
    return mapRow(row);
  }

  public listBySessionIds(sessionIds: string[], workspaceId?: string): Map<string, ChatSessionBindingRecord> {
    if (sessionIds.length === 0) {
      return new Map();
    }
    const placeholders = sessionIds.map(() => "?").join(", ");
    const workspace = workspaceId ? sanitizeWorkspaceId(workspaceId) : undefined;
    const sql = workspace
      ? `
        SELECT * FROM chat_session_bindings
        WHERE session_id IN (${placeholders})
          AND workspace_id = ?
      `
      : `
        SELECT * FROM chat_session_bindings
        WHERE session_id IN (${placeholders})
      `;
    const rows = toChatSessionBindingRows(this.db.prepare(sql).all(...sessionIds, ...(workspace ? [workspace] : [])));
    return new Map(rows.map((row) => [row.session_id, mapRow(row)]));
  }
}

function toChatSessionBindingRow(row: unknown): ChatSessionBindingRow | undefined {
  if (row !== undefined && !isChatSessionBindingRow(row)) {
    throw new TypeError("Unexpected chat_session_bindings row shape");
  }
  return row;
}

function toChatSessionBindingRows(rows: unknown): ChatSessionBindingRow[] {
  if (!Array.isArray(rows) || rows.some((row) => !isChatSessionBindingRow(row))) {
    throw new TypeError("Unexpected chat_session_bindings row shape");
  }
  return rows;
}

function isChatSessionBindingRow(value: unknown): value is ChatSessionBindingRow {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.session_id === "string" &&
    typeof value.workspace_id === "string" &&
    (value.transport === "llm" || value.transport === "integration") &&
    (typeof value.connection_id === "string" || value.connection_id === null) &&
    (typeof value.target_json === "string" || value.target_json === null) &&
    typeof value.writable === "number" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapRow(row: ChatSessionBindingRow): ChatSessionBindingRecord {
  return {
    sessionId: row.session_id,
    transport: row.transport,
    connectionId: row.connection_id ?? undefined,
    target: parseTarget(row.target_json),
    writable: row.writable === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTarget(targetJson: string | null): string | undefined {
  if (!targetJson) {
    return undefined;
  }
  const parsed = safeJsonParse<{ target?: unknown }>(targetJson, {});
  return typeof parsed.target === "string" ? parsed.target : undefined;
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
