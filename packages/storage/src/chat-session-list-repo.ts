import type { ChatMode, ChatSessionLifecycleStatus, ChatSessionScope } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export interface ChatSessionListCandidate {
  sessionId: string;
  updatedAt: string;
  pinned: boolean;
}

export interface ChatSessionListCandidateQuery {
  workspaceId: string;
  scope?: ChatSessionScope | "all";
  view?: ChatSessionLifecycleStatus | "all";
  includeHidden?: boolean;
  projectId?: string;
  folderId?: string;
  tag?: string;
  mode?: ChatMode;
  q?: string;
  limit?: number;
  cursor?: string;
}

interface ChatSessionListCandidateRow {
  session_id: string;
  updated_at: string;
  pinned: number;
}

interface CursorPinnedRow {
  pinned: number;
}

export class ChatSessionListRepository {
  private static readonly maxListCandidatesStatementCacheSize = 64;

  private readonly cursorPinnedStmt;
  private readonly listCandidatesStmtCache = new Map<string, ReturnType<DatabaseClient["prepare"]>>();

  public constructor(private readonly db: DatabaseClient) {
    this.cursorPinnedStmt = db.prepare(`
      SELECT COALESCE(pinned, 0) AS pinned
      FROM chat_session_meta
      WHERE session_id = ?
      LIMIT 1
    `);
  }

  public listCandidates(input: ChatSessionListCandidateQuery): ChatSessionListCandidate[] {
    const workspaceId = input.workspaceId.trim();
    if (!workspaceId) {
      return [];
    }

    const clauses: string[] = ["m.workspace_id = ?"];
    const params: unknown[] = [workspaceId];
    const scope = input.scope ?? "all";
    const view = input.view ?? "active";
    const includeHidden = input.includeHidden ?? false;

    if (scope === "mission") {
      clauses.push("s.channel = ?");
      params.push("mission");
    } else if (scope === "external") {
      clauses.push("s.channel <> ?");
      params.push("mission");
    }

    if (view !== "all") {
      clauses.push("m.lifecycle_status = ?");
      params.push(view);
    }

    if (!includeHidden) {
      clauses.push("m.include_in_history <> 0");
    }

    const projectId = input.projectId?.trim();
    if (projectId) {
      clauses.push("sp.project_id = ?");
      params.push(projectId);
    }

    const folderId = input.folderId?.trim();
    if (folderId) {
      clauses.push("m.folder_id = ?");
      params.push(folderId);
    }

    void input.mode;

    const tag = input.tag?.trim().toLowerCase();
    if (tag) {
      clauses.push("LOWER(COALESCE(m.tags_json, '[]')) LIKE ? ESCAPE '\\'");
      params.push(`%"${escapeLike(tag)}"%`);
    }

    const search = input.q?.trim().toLowerCase();
    if (search) {
      const like = `%${escapeLike(search)}%`;
      clauses.push(`
        (
          LOWER(COALESCE(m.title, '')) LIKE ? ESCAPE '\\'
          OR LOWER(s.session_key) LIKE ? ESCAPE '\\'
          OR LOWER(s.channel) LIKE ? ESCAPE '\\'
          OR LOWER(s.account) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(m.folder_name, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(m.tags_json, '[]')) LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1
            FROM chat_messages AS cm
            WHERE cm.session_id = s.session_id
              AND LOWER(cm.content) LIKE ? ESCAPE '\\'
            LIMIT 1
          )
        )
      `);
      params.push(like, like, like, like, like, like, like);
    }

    const parsedCursor = parseCompositeCursor(input.cursor);
    if (parsedCursor) {
      const cursorPinned = this.resolveCursorPinned(parsedCursor.key);
      if (cursorPinned === undefined) {
        clauses.push(`
          (
            s.updated_at < ?
            OR (s.updated_at = ? AND s.session_id < ?)
          )
        `);
        params.push(parsedCursor.timestamp, parsedCursor.timestamp, parsedCursor.key);
      } else {
        clauses.push(`
          (
            COALESCE(m.pinned, 0) < ?
            OR (
              COALESCE(m.pinned, 0) = ?
              AND (
                s.updated_at < ?
                OR (s.updated_at = ? AND s.session_id < ?)
              )
            )
          )
        `);
        params.push(cursorPinned, cursorPinned, parsedCursor.timestamp, parsedCursor.timestamp, parsedCursor.key);
      }
    }

    const limit = Math.max(1, Math.min(5000, Math.floor(input.limit ?? 200)));
    const sql = `
      SELECT
        s.session_id,
        s.updated_at,
        COALESCE(m.pinned, 0) AS pinned
      FROM sessions AS s
      INNER JOIN chat_session_meta AS m
        ON m.session_id = s.session_id
      LEFT JOIN chat_session_prefs AS p
        ON p.session_id = s.session_id
      LEFT JOIN chat_session_projects AS sp
        ON sp.session_id = s.session_id
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY COALESCE(m.pinned, 0) DESC, s.updated_at DESC, s.session_id DESC
      LIMIT ?
    `;
    const rows = toCandidateRows(this.getListCandidatesStmt(sql).all(...params, limit));
    return rows.map((row) => ({
      sessionId: row.session_id,
      updatedAt: row.updated_at,
      pinned: row.pinned !== 0,
    }));
  }

  private resolveCursorPinned(sessionId: string): number | undefined {
    const row = toCursorPinnedRow(this.cursorPinnedStmt.get(sessionId));
    return row?.pinned;
  }

  private getListCandidatesStmt(sql: string): ReturnType<DatabaseClient["prepare"]> {
    const cached = this.listCandidatesStmtCache.get(sql);
    if (cached) {
      return cached;
    }
    if (this.listCandidatesStmtCache.size >= ChatSessionListRepository.maxListCandidatesStatementCacheSize) {
      const oldestKey = this.listCandidatesStmtCache.keys().next().value;
      if (typeof oldestKey === "string") {
        this.listCandidatesStmtCache.delete(oldestKey);
      }
    }
    const stmt = this.db.prepare(sql);
    this.listCandidatesStmtCache.set(sql, stmt);
    return stmt;
  }
}

interface CompositeCursor {
  timestamp: string;
  key: string;
}

function parseCompositeCursor(cursor?: string): CompositeCursor | undefined {
  if (!cursor) {
    return undefined;
  }
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0) {
    return undefined;
  }
  const timestamp = cursor.slice(0, separator);
  const key = cursor.slice(separator + 1);
  return timestamp && key ? { timestamp, key } : undefined;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toCandidateRows(rows: unknown): ChatSessionListCandidateRow[] {
  if (!Array.isArray(rows) || rows.some((row) => !isCandidateRow(row))) {
    throw new TypeError("Unexpected chat session candidate row shape");
  }
  return rows;
}

function toCursorPinnedRow(value: unknown): CursorPinnedRow | undefined {
  return isCursorPinnedRow(value) ? value : undefined;
}

function isCandidateRow(value: unknown): value is ChatSessionListCandidateRow {
  return (
    isRecord(value) &&
    typeof value.session_id === "string" &&
    typeof value.updated_at === "string" &&
    typeof value.pinned === "number"
  );
}

function isCursorPinnedRow(value: unknown): value is CursorPinnedRow {
  return isRecord(value) && typeof value.pinned === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
