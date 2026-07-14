import type { DatabaseClient } from "./db.js";
import { ChatSessionRevisionRepository } from "./chat-session-revision-repo.js";

export interface ChatSessionProjectRecord {
  sessionId: string;
  revision: number;
  projectId: string;
  assignedAt: string;
}

export interface ChatSessionProjectUnassignResult {
  unassigned: boolean;
  revision: number;
}

interface ChatSessionProjectRow {
  session_id: string;
  project_id: string;
  assigned_at: string;
  aggregate_revision: number | null | undefined;
}

export class ChatSessionProjectRepository {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly deleteStmt;
  private readonly revisions;

  public constructor(private readonly db: DatabaseClient) {
    this.revisions = new ChatSessionRevisionRepository(db);
    this.getStmt = db.prepare(`
      SELECT assignment.*, meta.revision AS aggregate_revision
      FROM chat_session_projects AS assignment
      LEFT JOIN chat_session_meta AS meta ON meta.session_id = assignment.session_id
      WHERE assignment.session_id = ?
    `);
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
    return row ? mapRow(row, normalizeAggregateRevision(row.aggregate_revision)) : undefined;
  }

  public assign(sessionId: string, projectId: string, now = new Date().toISOString()): ChatSessionProjectRecord {
    const revision = this.revisions.ensure(sessionId, now);
    return this.assignWithRevision(sessionId, projectId, revision.revision, now);
  }

  public assignWithRevision(
    sessionId: string,
    projectId: string,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): ChatSessionProjectRecord {
    const result = this.revisions.runWithRevision(
      sessionId,
      expectedRevision,
      () => {
        const current = this.get(sessionId);
        if (current?.projectId === projectId) {
          return { value: current, changed: false };
        }
        this.upsertStmt.run({ sessionId, projectId, assignedAt: now });
        const row = toChatSessionProjectRow(this.getStmt.get(sessionId));
        if (!row) {
          throw new Error(`Chat session project assignment for ${sessionId} was not persisted`);
        }
        return { value: mapRow(row, expectedRevision), changed: true };
      },
      now,
    );
    return { ...result.value, revision: result.revision };
  }

  public unassign(sessionId: string): boolean {
    const revision = this.revisions.ensure(sessionId);
    return this.unassignWithRevision(sessionId, revision.revision).unassigned;
  }

  public unassignWithRevision(sessionId: string, expectedRevision: number): ChatSessionProjectUnassignResult {
    const result = this.revisions.runWithRevision(sessionId, expectedRevision, () => {
      const existing = this.get(sessionId);
      if (!existing) {
        return { value: false, changed: false };
      }
      this.deleteStmt.run(sessionId);
      return { value: true, changed: true };
    });
    return { unassigned: result.value, revision: result.revision };
  }

  public listBySessionIds(sessionIds: string[]): Map<string, ChatSessionProjectRecord> {
    if (sessionIds.length === 0) {
      return new Map();
    }
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
      SELECT assignment.*, meta.revision AS aggregate_revision
      FROM chat_session_projects AS assignment
      LEFT JOIN chat_session_meta AS meta ON meta.session_id = assignment.session_id
      WHERE assignment.session_id IN (${placeholders})
    `,
      )
      .all(...sessionIds);
    const mappedRows = toChatSessionProjectRows(rows);
    return new Map(
      mappedRows.map((row) => [row.session_id, mapRow(row, normalizeAggregateRevision(row.aggregate_revision))]),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatSessionProjectRow(value: unknown): value is ChatSessionProjectRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.session_id === "string" &&
    typeof value.project_id === "string" &&
    typeof value.assigned_at === "string" &&
    (typeof value.aggregate_revision === "number" ||
      value.aggregate_revision === null ||
      value.aggregate_revision === undefined)
  );
}

function toChatSessionProjectRow(value: unknown): ChatSessionProjectRow | undefined {
  return isChatSessionProjectRow(value) ? value : undefined;
}

function toChatSessionProjectRows(value: unknown): ChatSessionProjectRow[] {
  return Array.isArray(value) ? value.filter(isChatSessionProjectRow) : [];
}

function mapRow(row: ChatSessionProjectRow, revision: number): ChatSessionProjectRecord {
  return {
    sessionId: row.session_id,
    revision,
    projectId: row.project_id,
    assignedAt: row.assigned_at,
  };
}

function normalizeAggregateRevision(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 1;
}
