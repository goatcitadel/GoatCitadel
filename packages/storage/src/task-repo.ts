import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  TaskCreateInput,
  TaskProactiveContext,
  TaskRecord,
  TaskStatus,
  TaskUpdateInput,
} from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface TaskRow {
  task_id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskRecord["priority"];
  assigned_agent_id: string | null;
  created_by: string | null;
  due_at: string | null;
  metadata_json: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskListQuery {
  workspaceId?: string;
  status?: TaskStatus;
  limit: number;
  cursor?: string;
  view?: "active" | "trash" | "all";
}

export interface TaskStatusCount {
  status: string;
  count: number;
}

export class TaskRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly updateStmt;
  private readonly hardDeleteStmt;
  private readonly softDeleteStmt;
  private readonly restoreStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO tasks (
        task_id, workspace_id, title, description, status, priority,
        assigned_agent_id, created_by, due_at, metadata_json, created_at, updated_at
      ) VALUES (
        @taskId, @workspaceId, @title, @description, @status, @priority,
        @assignedAgentId, @createdBy, @dueAt, @metadataJson, @createdAt, @updatedAt
      )
    `);

    this.getStmt = db.prepare("SELECT * FROM tasks WHERE task_id = ?");
    this.updateStmt = db.prepare(`
      UPDATE tasks
      SET
        title = @title,
        description = @description,
        status = @status,
        priority = @priority,
        assigned_agent_id = @assignedAgentId,
        due_at = @dueAt,
        metadata_json = @metadataJson,
        deleted_at = @deletedAt,
        deleted_by = @deletedBy,
        delete_reason = @deleteReason,
        updated_at = @updatedAt
      WHERE task_id = @taskId
    `);

    this.hardDeleteStmt = db.prepare("DELETE FROM tasks WHERE task_id = ?");
    this.softDeleteStmt = db.prepare(`
      UPDATE tasks
      SET
        deleted_at = @deletedAt,
        deleted_by = @deletedBy,
        delete_reason = @deleteReason,
        updated_at = @updatedAt
      WHERE task_id = @taskId
    `);
    this.restoreStmt = db.prepare(`
      UPDATE tasks
      SET
        deleted_at = NULL,
        deleted_by = NULL,
        delete_reason = NULL,
        updated_at = @updatedAt
      WHERE task_id = @taskId
    `);
  }

  public create(input: TaskCreateInput, now = new Date().toISOString()): TaskRecord {
    const taskId = randomUUID();
    this.insertStmt.run({
      taskId,
      workspaceId: sanitizeWorkspaceId(input.workspaceId ?? "default"),
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? "inbox",
      priority: input.priority ?? "normal",
      assignedAgentId: input.assignedAgentId ?? null,
      createdBy: input.createdBy ?? null,
      dueAt: input.dueAt ?? null,
      metadataJson: serializeTaskMetadata(input.proactiveContext),
      createdAt: now,
      updatedAt: now,
    });

    return this.get(taskId);
  }

  public get(taskId: string): TaskRecord {
    const row = toTaskRow(this.getStmt.get(taskId));
    if (!row) {
      throw new NotFoundError({ entity: "Task", id: taskId });
    }
    return mapTaskRow(row);
  }

  public find(taskId: string): TaskRecord | undefined {
    const row = toTaskRow(this.getStmt.get(taskId));
    if (!row) {
      return undefined;
    }
    return mapTaskRow(row);
  }

  public list(query: TaskListQuery): TaskRecord[] {
    const parsedCursor = parseCompositeCursor(query.cursor);
    const params: Record<string, unknown> = {
      view: query.view ?? "active",
      limit: query.limit,
    };
    const clauses = [
      `(
        @view = 'all'
        OR (@view = 'active' AND deleted_at IS NULL)
        OR (@view = 'trash' AND deleted_at IS NOT NULL)
      )`,
    ];
    if (query.status) {
      params.status = query.status;
      clauses.push("status = @status");
    }
    if (query.workspaceId) {
      params.workspaceId = sanitizeWorkspaceId(query.workspaceId);
      clauses.push("workspace_id = @workspaceId");
    }
    if (parsedCursor) {
      params.cursorUpdatedAt = parsedCursor.timestamp;
      params.cursorTaskId = parsedCursor.key;
      clauses.push("(updated_at < @cursorUpdatedAt OR (updated_at = @cursorUpdatedAt AND task_id < @cursorTaskId))");
    }
    const sql = `
      SELECT * FROM tasks
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY updated_at DESC, task_id DESC
      LIMIT @limit
    `;
    const rows = toTaskRows(this.db.prepare(sql).all(params));
    return rows.map(mapTaskRow);
  }

  public update(taskId: string, input: TaskUpdateInput, now = new Date().toISOString()): TaskRecord {
    const current = this.get(taskId);
    const nextAssignedAgentId = input.assignedAgentId === undefined
      ? current.assignedAgentId ?? null
      : input.assignedAgentId;

    this.updateStmt.run({
      taskId,
      title: input.title ?? current.title,
      description: input.description ?? current.description ?? null,
      status: input.status ?? current.status,
      priority: input.priority ?? current.priority,
      assignedAgentId: nextAssignedAgentId,
      dueAt: input.dueAt ?? current.dueAt ?? null,
      metadataJson: input.proactiveContext === undefined
        ? serializeTaskMetadata(current.proactiveContext)
        : serializeTaskMetadata(input.proactiveContext ?? undefined),
      deletedAt: current.deletedAt ?? null,
      deletedBy: current.deletedBy ?? null,
      deleteReason: current.deleteReason ?? null,
      updatedAt: now,
    });
    return this.get(taskId);
  }

  public softDelete(taskId: string, deletedBy?: string, deleteReason?: string, now = new Date().toISOString()): boolean {
    const before = this.find(taskId);
    if (!before || before.deletedAt) {
      return false;
    }
    this.softDeleteStmt.run({
      taskId,
      deletedAt: now,
      deletedBy: deletedBy ?? null,
      deleteReason: deleteReason ?? null,
      updatedAt: now,
    });
    return true;
  }

  public restore(taskId: string, now = new Date().toISOString()): boolean {
    const before = this.find(taskId);
    if (!before || !before.deletedAt) {
      return false;
    }
    this.restoreStmt.run({
      taskId,
      updatedAt: now,
    });
    return true;
  }

  public hardDelete(taskId: string): boolean {
    const before = this.find(taskId);
    if (!before) {
      return false;
    }
    this.hardDeleteStmt.run(taskId);
    return true;
  }

  public statusCounts(): TaskStatusCount[] {
    const rows = toTaskStatusCountRows(this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM tasks
      WHERE deleted_at IS NULL
      GROUP BY status
      ORDER BY status ASC
    `).all());
    return rows.map((row) => ({
      status: row.status,
      count: Number(row.count ?? 0),
    }));
  }

  public statusCountsByWorkspace(workspaceId: string): TaskStatusCount[] {
    const rows = toTaskStatusCountRows(this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM tasks
      WHERE deleted_at IS NULL
        AND workspace_id = @workspaceId
      GROUP BY status
      ORDER BY status ASC
    `).all({
      workspaceId: sanitizeWorkspaceId(workspaceId),
    }));
    return rows.map((row) => ({
      status: row.status,
      count: Number(row.count ?? 0),
    }));
  }
}

function mapTaskRow(row: TaskRow): TaskRecord {
  const metadata = safeJsonParse<{ proactiveContext?: TaskProactiveContext | null }>(row.metadata_json, {});
  return {
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    priority: row.priority,
    assignedAgentId: row.assigned_agent_id ?? undefined,
    createdBy: row.created_by ?? undefined,
    dueAt: row.due_at ?? undefined,
    proactiveContext: metadata.proactiveContext ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
    deletedBy: row.deleted_by ?? undefined,
    deleteReason: row.delete_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
    return {
      timestamp: cursor,
      key: "",
    };
  }

  const timestamp = cursor.slice(0, separator);
  const key = cursor.slice(separator + 1);
  if (!timestamp || !key) {
    return undefined;
  }

  return { timestamp, key };
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

function serializeTaskMetadata(proactiveContext?: TaskProactiveContext): string | null {
  if (!proactiveContext) {
    return null;
  }
  return JSON.stringify({ proactiveContext });
}

function toTaskRow(value: unknown): TaskRow | undefined {
  return isTaskRow(value) ? value : undefined;
}

function toTaskRows(value: unknown): TaskRow[] {
  return Array.isArray(value) ? value.filter(isTaskRow) : [];
}

function toTaskStatusCountRows(value: unknown): Array<{ status: string; count: number }> {
  return Array.isArray(value)
    ? value.filter((row): row is { status: string; count: number } => (
      isRecord(row) && typeof row.status === "string" && typeof row.count === "number"
    ))
    : [];
}

function isTaskRow(value: unknown): value is TaskRow {
  return isRecord(value)
    && typeof value.task_id === "string"
    && typeof value.workspace_id === "string"
    && typeof value.title === "string"
    && (typeof value.description === "string" || value.description === null)
    && typeof value.status === "string"
    && typeof value.priority === "string"
    && (typeof value.assigned_agent_id === "string" || value.assigned_agent_id === null)
    && (typeof value.created_by === "string" || value.created_by === null)
    && (typeof value.due_at === "string" || value.due_at === null)
    && (typeof value.metadata_json === "string" || value.metadata_json === null)
    && (typeof value.deleted_at === "string" || value.deleted_at === null)
    && (typeof value.deleted_by === "string" || value.deleted_by === null)
    && (typeof value.delete_reason === "string" || value.delete_reason === null)
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


