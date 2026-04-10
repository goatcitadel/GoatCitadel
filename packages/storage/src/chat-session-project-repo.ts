import type { DatabaseClient } from "./db.js";

export interface ChatSessionProjectRecord {
  sessionId: string;
  projectId: string;
  assignedAt: string;
}

interface ChatSessionProjectRow {
  session_id: string;
  project_id: string;
  assigned_at: string;
}

export class ChatSessionProjectRepository {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly deleteStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_session_projects WHERE session_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_session_projects (session_id, project_id, assigned_at)
      VALUES (@sessionId, @projectId, @assignedAt)
      ON CONFLICT(session_id) DO UPDATE SET
        project_id = excluded.project_id,
        assigned_at = excluded.assigned_at
    `);
    this.deleteStmt = db.prepare("DELETE FROM chat_session_projects WHERE session_id = ?");
  }

  public get(sessionId: string): ChatSessionProjectRecord | undefined {
    const row = toChatSessionProjectRow(this.getStmt.get(sessionId));
    return row ? mapRow(row) : undefined;
  }

  public assign(sessionId: string, projectId: string, now = new Date().toISOString()): ChatSessionProjectRecord {
    this.upsertStmt.run({
      sessionId,
      projectId,
      assignedAt: now,
    });
    const row = toChatSessionProjectRow(this.getStmt.get(sessionId));
    if (!row) {
      throw new Error(`Chat session project assignment for ${sessionId} was not persisted`);
    }
    return mapRow(row);
  }

  public unassign(sessionId: string): boolean {
    const existing = this.get(sessionId);
    if (!existing) {
      return false;
    }
    this.deleteStmt.run(sessionId);
    return true;
  }

  public listBySessionIds(sessionIds: string[]): Map<string, ChatSessionProjectRecord> {
    if (sessionIds.length === 0) {
      return new Map();
    }
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT * FROM chat_session_projects
      WHERE session_id IN (${placeholders})
    `).all(...sessionIds);
    const mappedRows = toChatSessionProjectRows(rows);
    return new Map(mappedRows.map((row) => [row.session_id, mapRow(row)]));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChatSessionProjectRow(value: unknown): value is ChatSessionProjectRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.session_id === "string"
    && typeof value.project_id === "string"
    && typeof value.assigned_at === "string";
}

function toChatSessionProjectRow(value: unknown): ChatSessionProjectRow | undefined {
  return isChatSessionProjectRow(value) ? value : undefined;
}

function toChatSessionProjectRows(value: unknown): ChatSessionProjectRow[] {
  return Array.isArray(value) ? value.filter(isChatSessionProjectRow) : [];
}

function mapRow(row: ChatSessionProjectRow): ChatSessionProjectRecord {
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    assignedAt: row.assigned_at,
  };
}


