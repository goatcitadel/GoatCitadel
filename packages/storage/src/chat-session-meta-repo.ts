import type { DatabaseClient } from "./db.js";
import { ValidationError } from "@goatcitadel/contracts";
import type { ChatFolderRecord, ChatSessionOrigin } from "@goatcitadel/contracts";

export interface ChatSessionMetaRecord {
  sessionId: string;
  workspaceId?: string;
  title?: string;
  origin?: ChatSessionOrigin;
  includeInHistory: boolean;
  pinned: boolean;
  lifecycleStatus: "active" | "archived";
  archivedAt?: string;
  folderId?: string;
  folderName?: string;
  tags: string[];
  pinnedGoal?: string;
  goalTurnBudget?: number;
  goalTurnsUsed: number;
  goalSetAt?: string;
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
  folder_id: string | null;
  folder_name: string | null;
  tags_json: string | null;
  pinned_goal: string | null;
  goal_turn_budget: number | null;
  goal_turns_used: number;
  goal_set_at: string | null;
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
  folderId?: string;
  folderName?: string;
  tags?: string[];
  pinnedGoal?: string | null;
  goalTurnBudget?: number | null;
  goalSetAt?: string | null;
}

export class ChatSessionMetaRepository {
  private readonly getStmt;
  private readonly upsertStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_session_meta WHERE session_id = ?");
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_session_meta (
        session_id, workspace_id, title, origin, include_in_history, pinned, lifecycle_status, archived_at, folder_id, folder_name, tags_json, pinned_goal, goal_turn_budget, goal_turns_used, goal_set_at, created_at, updated_at
      ) VALUES (
        @sessionId, @workspaceId, @title, @origin, @includeInHistory, @pinned, @lifecycleStatus, @archivedAt, @folderId, @folderName, @tagsJson, @pinnedGoal, @goalTurnBudget, @goalTurnsUsed, @goalSetAt, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        title = excluded.title,
        origin = excluded.origin,
        include_in_history = excluded.include_in_history,
        pinned = excluded.pinned,
        lifecycle_status = excluded.lifecycle_status,
        archived_at = excluded.archived_at,
        folder_id = excluded.folder_id,
        folder_name = excluded.folder_name,
        tags_json = excluded.tags_json,
        pinned_goal = excluded.pinned_goal,
        goal_turn_budget = excluded.goal_turn_budget,
        goal_turns_used = excluded.goal_turns_used,
        goal_set_at = excluded.goal_set_at,
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
      folderId: null,
      folderName: null,
      tagsJson: "[]",
      pinnedGoal: null,
      goalTurnBudget: null,
      goalTurnsUsed: 0,
      goalSetAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const row = toChatSessionMetaRow(this.getStmt.get(sessionId));
    if (!row) {
      throw new TypeError("chat_session_meta ensure did not return a row");
    }
    return mapRow(row);
  }

  public patch(
    sessionId: string,
    input: ChatSessionMetaPatchInput,
    now = new Date().toISOString(),
  ): ChatSessionMetaRecord {
    const current = this.ensure(sessionId, now);
    const normalizedFolderName = input.folderName !== undefined ? sanitizeOptional(input.folderName) : undefined;
    const normalizedFolderId =
      input.folderId !== undefined
        ? sanitizeOptional(input.folderId)
        : normalizedFolderName !== undefined
          ? normalizedFolderName
            ? sanitizeFolderId(normalizedFolderName)
            : null
          : undefined;
    const pinnedGoalWrite = resolveOptionalGoalString(input.pinnedGoal, current.pinnedGoal);
    const goalBudgetWrite = resolveOptionalGoalNumber(input.goalTurnBudget, current.goalTurnBudget);
    const goalSetAtWrite = resolveOptionalGoalString(input.goalSetAt, current.goalSetAt);
    // Writing pinnedGoal (set or clear) resets the per-goal turn counter.
    const goalTurnsUsedWrite = input.pinnedGoal !== undefined ? 0 : current.goalTurnsUsed;
    this.upsertStmt.run({
      sessionId,
      workspaceId:
        input.workspaceId !== undefined
          ? sanitizeWorkspaceId(input.workspaceId)
          : sanitizeWorkspaceId(current.workspaceId ?? "default"),
      title: input.title !== undefined ? sanitizeOptional(input.title) : (current.title ?? null),
      origin: input.origin !== undefined ? sanitizeOrigin(input.origin) : sanitizeOrigin(current.origin),
      includeInHistory:
        input.includeInHistory !== undefined ? (input.includeInHistory ? 1 : 0) : current.includeInHistory ? 1 : 0,
      pinned: input.pinned !== undefined ? (input.pinned ? 1 : 0) : current.pinned ? 1 : 0,
      lifecycleStatus: input.lifecycleStatus ?? current.lifecycleStatus,
      archivedAt: input.archivedAt !== undefined ? input.archivedAt : (current.archivedAt ?? null),
      folderId: normalizedFolderId !== undefined ? normalizedFolderId : (current.folderId ?? null),
      folderName: normalizedFolderName !== undefined ? normalizedFolderName : (current.folderName ?? null),
      tagsJson: input.tags !== undefined ? JSON.stringify(sanitizeTags(input.tags)) : JSON.stringify(current.tags),
      pinnedGoal: pinnedGoalWrite,
      goalTurnBudget: goalBudgetWrite,
      goalTurnsUsed: goalTurnsUsedWrite,
      goalSetAt: goalSetAtWrite,
      createdAt: current.createdAt,
      updatedAt: now,
    });
    const row = toChatSessionMetaRow(this.getStmt.get(sessionId));
    if (!row) {
      throw new TypeError("chat_session_meta patch did not return a row");
    }
    return mapRow(row);
  }

  public incrementGoalTurnsUsed(sessionId: string, now = new Date().toISOString()): number {
    const current = this.ensure(sessionId, now);
    const next = (current.goalTurnsUsed ?? 0) + 1;
    this.db
      .prepare(`UPDATE chat_session_meta SET goal_turns_used = ?, updated_at = ? WHERE session_id = ?`)
      .run(next, now, sessionId);
    return next;
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

  public listFolders(workspaceId = "default"): ChatFolderRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            folder_id,
            folder_name,
            workspace_id,
            MIN(created_at) AS created_at,
            MAX(updated_at) AS updated_at,
            COUNT(1) AS session_count
          FROM chat_session_meta
          WHERE workspace_id = ?
            AND folder_id IS NOT NULL
            AND folder_name IS NOT NULL
          GROUP BY folder_id, folder_name, workspace_id
          ORDER BY LOWER(folder_name) ASC
        `,
      )
      .all(sanitizeWorkspaceId(workspaceId)) as Array<{
      folder_id: string;
      folder_name: string;
      workspace_id: string;
      created_at: string;
      updated_at: string;
      session_count: number;
    }>;
    return rows.map((row) => ({
      folderId: row.folder_id,
      workspaceId: row.workspace_id,
      name: row.folder_name,
      sessionCount: row.session_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
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

  return (
    typeof value.session_id === "string" &&
    typeof value.workspace_id === "string" &&
    (typeof value.title === "string" || value.title === null) &&
    (typeof value.origin === "string" || value.origin === null) &&
    typeof value.include_in_history === "number" &&
    typeof value.pinned === "number" &&
    (value.lifecycle_status === "active" || value.lifecycle_status === "archived") &&
    (typeof value.archived_at === "string" || value.archived_at === null) &&
    (typeof value.folder_id === "string" || value.folder_id === null) &&
    (typeof value.folder_name === "string" || value.folder_name === null) &&
    (typeof value.tags_json === "string" || value.tags_json === null) &&
    (typeof value.pinned_goal === "string" || value.pinned_goal === null) &&
    (typeof value.goal_turn_budget === "number" || value.goal_turn_budget === null) &&
    typeof value.goal_turns_used === "number" &&
    (typeof value.goal_set_at === "string" || value.goal_set_at === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mapRow(row: ChatSessionMetaRow): ChatSessionMetaRecord {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    title: row.title ?? undefined,
    origin:
      row.origin === "operator" || row.origin === "prompt_pack" || row.origin === "system" ? row.origin : undefined,
    includeInHistory: row.include_in_history !== 0,
    pinned: row.pinned === 1,
    lifecycleStatus: row.lifecycle_status,
    archivedAt: row.archived_at ?? undefined,
    folderId: row.folder_id ?? undefined,
    folderName: row.folder_name ?? undefined,
    tags: parseTags(row.tags_json),
    pinnedGoal: row.pinned_goal ?? undefined,
    goalTurnBudget: row.goal_turn_budget ?? undefined,
    goalTurnsUsed: row.goal_turns_used,
    goalSetAt: row.goal_set_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resolveOptionalGoalString(input: string | null | undefined, current: string | undefined): string | null {
  if (input === undefined) {
    return current ?? null;
  }
  return input;
}

function resolveOptionalGoalNumber(input: number | null | undefined, current: number | undefined): number | null {
  if (input === undefined) {
    return current ?? null;
  }
  return input;
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

function sanitizeFolderId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  let normalized = "";
  let pendingDash = false;
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    const isAsciiLetter = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isAsciiLetter || isDigit) {
      normalized += char;
      pendingDash = false;
      continue;
    }
    if (normalized.length > 0 && !pendingDash) {
      normalized += "-";
      pendingDash = true;
    }
  }
  if (normalized.endsWith("-")) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized) {
    throw new ValidationError({ message: "folderName must include at least one letter or number" });
  }
  return normalized.slice(0, 64);
}

function sanitizeTags(value: string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = trimmed.slice(0, 32);
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(normalized);
  }
  return tags;
}

function parseTags(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return sanitizeTags(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return [];
  }
}
