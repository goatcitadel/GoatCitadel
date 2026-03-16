import type { DatabaseSync } from "node:sqlite";
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
  private readonly listBySessionIdsStmt;

  public constructor(private readonly db: DatabaseSync) {
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
    this.listBySessionIdsStmt = db.prepare(`
      SELECT * FROM chat_session_bindings
      WHERE session_id IN (SELECT value FROM json_each(@sessionIdsJson))
      AND (@workspaceId IS NULL OR workspace_id = @workspaceId)
    `);
  }

  public get(sessionId: string): ChatSessionBindingRecord | undefined {
    const row = this.getStmt.get(sessionId) as ChatSessionBindingRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public upsert(input: ChatSessionBindingUpsertInput, now = new Date().toISOString()): ChatSessionBindingRecord {
    const existingRow = this.getStmt.get(input.sessionId) as ChatSessionBindingRow | undefined;
    const existing = existingRow ? mapRow(existingRow) : undefined;
    this.upsertStmt.run({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId ? sanitizeWorkspaceId(input.workspaceId) : (existingRow?.workspace_id ?? "default"),
      transport: input.transport,
      connectionId: input.connectionId ?? null,
      targetJson: input.target ? JSON.stringify({ target: input.target }) : null,
      writable: input.writable === undefined ? (existing?.writable === false ? 0 : 1) : (input.writable ? 1 : 0),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return mapRow(this.getStmt.get(input.sessionId) as unknown as ChatSessionBindingRow);
  }

  public listBySessionIds(sessionIds: string[], workspaceId?: string): Map<string, ChatSessionBindingRecord> {
    if (sessionIds.length === 0) {
      return new Map();
    }
    const rows = this.listBySessionIdsStmt.all({
      sessionIdsJson: JSON.stringify(sessionIds),
      workspaceId: workspaceId ? sanitizeWorkspaceId(workspaceId) : null,
    }) as unknown as ChatSessionBindingRow[];
    return new Map(rows.map((row) => [row.session_id, mapRow(row)]));
  }
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
