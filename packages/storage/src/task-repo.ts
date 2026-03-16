import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  TaskCreateInput,
  TaskRecord,
  TaskStatus,
  TaskUpdateInput,
} from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";

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
  private readonly listStmt;
  private readonly updateStmt;
  private readonly hardDeleteStmt;
  private readonly softDeleteStmt;
  private readonly restoreStmt;
  private readonly statusCountsStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.insertStmt = db.prepare(`
      INSERT INTO tasks (
        task_id, workspace_id, title, description, status, priority,
        assigned_agent_id, created_by, due_at, created_at, updated_at
      ) VALUES (
        @taskId, @workspaceId, @title, @description, @status, @priority,
        @assignedAgentId, @createdBy, @dueAt, @createdAt, @updatedAt
      )
    `);

    this.getStmt = db.prepare("SELECT * FROM tasks WHERE task_id = ?");

    this.listStmt = db.prepare(`
      SELECT * FROM tasks
      WHERE (@status IS NULL OR status = @status)
        AND (@workspaceId IS NULL OR workspace_id = @workspaceId)
        AND (
          @view = 'all'
          OR (@view = 'active' AND deleted_at IS NULL)
          OR (@view = 'trash' AND deleted_at IS NOT NULL)
        )
        AND (
          @cursorUpdatedAt IS NULL
          OR updated_at < @cursorUpdatedAt
          OR (updated_at = @cursorUpdatedAt AND task_id < @cursorTaskId)
        )
      ORDER BY updated_at DESC, task_id DESC
      LIMIT @limit
    `);

    this.updateStmt = db.prepare(`
      UPDATE tasks
      SET
        title = @title,
        description = @description,
        status = @status,
        priority = @priority,
        assigned_agent_id = @assignedAgentId,
        due_at = @dueAt,
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
    this.statusCountsStmt = db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM tasks
      WHERE deleted_at IS NULL
        AND (@workspaceId IS NULL OR workspace_id = @workspaceId)
      GROUP BY status
      ORDER BY status ASC
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
      createdAt: now,
      updatedAt: now,
    });

    return this.get(taskId);
  }

  public get(taskId: string): TaskRecord {
    const row = this.getStmt.get(taskId) as TaskRow | undefined;
    if (!row) {
      throw new NotFoundError({ entity: "Task", id: taskId });
    }
    return mapTaskRow(row);
  }

  public find(taskId: string): TaskRecord | undefined {
    const row = this.getStmt.get(taskId) as TaskRow | undefined;
    if (!row) {
      return undefined;
    }
    return mapTaskRow(row);
  }

  public list(query: TaskListQuery): TaskRecord[] {
    const parsedCursor = parseCompositeCursor(query.cursor);
    const rows = this.listStmt.all({
      status: query.status ?? null,
      workspaceId: query.workspaceId ? sanitizeWorkspaceId(query.workspaceId) : null,
      view: query.view ?? "active",
      cursorUpdatedAt: parsedCursor?.timestamp ?? null,
      cursorTaskId: parsedCursor?.key ?? null,
      limit: query.limit,
    }) as unknown as TaskRow[];
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
    const rows = this.statusCountsStmt.all({
      workspaceId: null,
    }) as unknown as Array<{ status: string; count: number }>;
    return rows.map((row) => ({
      status: row.status,
      count: Number(row.count ?? 0),
    }));
  }

  public statusCountsByWorkspace(workspaceId: string): TaskStatusCount[] {
    const rows = this.statusCountsStmt.all({
      workspaceId: sanitizeWorkspaceId(workspaceId),
    }) as unknown as Array<{ status: string; count: number }>;
    return rows.map((row) => ({
      status: row.status,
      count: Number(row.count ?? 0),
    }));
  }
}

function mapTaskRow(row: TaskRow): TaskRecord {
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
