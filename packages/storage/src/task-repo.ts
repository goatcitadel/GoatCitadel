import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseClient } from "./db.js";
import type {
  AgenticTaskContext,
  TaskArtifactVerification,
  TaskCreateInput,
  TaskDistressSignal,
  TaskProactiveContext,
  TaskRecord,
  TaskRetryBudget,
  TaskStatus,
  TaskUpdateInput,
} from "@goatcitadel/contracts";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { loadAndSanitize, type QuarantineEntry } from "./load-and-sanitize.js";
import { safeJsonParse } from "./safe-json.js";
import { parseJsonObject } from "./state-validators.js";

interface TaskRow {
  task_id: string;
  revision: number | null | undefined;
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
  distress_signals_json: string | null;
  retry_budget_json: string | null;
  artifact_verification_json: string | null;
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

export interface TaskRepositoryOptions {
  quarantine?: { record: (entry: QuarantineEntry) => unknown };
  logger?: { warn: (data: unknown, msg: string) => void };
}

interface TaskMutableState {
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskRecord["priority"];
  assignedAgentId: string | null;
  dueAt: string | null;
  proactiveContext?: TaskProactiveContext;
  agenticContext?: AgenticTaskContext;
  distressSignals?: TaskDistressSignal[];
  retryBudget?: TaskRetryBudget;
  artifactVerification?: TaskArtifactVerification[];
}

export class TaskRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly getForUpdateStmt;
  private readonly updateStmt;
  private readonly hardDeleteStmt;
  private readonly softDeleteStmt;
  private readonly restoreStmt;

  public constructor(
    private readonly db: DatabaseClient,
    private readonly options: TaskRepositoryOptions = {},
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO tasks (
        task_id, workspace_id, title, description, status, priority,
        assigned_agent_id, created_by, due_at, metadata_json,
        distress_signals_json, retry_budget_json, artifact_verification_json,
        created_at, updated_at
      ) VALUES (
        @taskId, @workspaceId, @title, @description, @status, @priority,
        @assignedAgentId, @createdBy, @dueAt, @metadataJson,
        @distressSignalsJson, @retryBudgetJson, @artifactVerificationJson,
        @createdAt, @updatedAt
      )
    `);

    this.getStmt = db.prepare("SELECT * FROM tasks WHERE task_id = ?");
    this.getForUpdateStmt = db.prepare(`
      SELECT * FROM tasks
      WHERE task_id = ?
      ${db.dialect === "postgres" ? "FOR UPDATE" : ""}
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
        metadata_json = @metadataJson,
        distress_signals_json = @distressSignalsJson,
        retry_budget_json = @retryBudgetJson,
        artifact_verification_json = @artifactVerificationJson,
        deleted_at = @deletedAt,
        deleted_by = @deletedBy,
        delete_reason = @deleteReason,
        revision = revision + 1,
        updated_at = @updatedAt
      WHERE task_id = @taskId
        AND revision = @expectedRevision
    `);

    this.hardDeleteStmt = db.prepare(`
      DELETE FROM tasks
      WHERE task_id = @taskId
        AND revision = @expectedRevision
    `);
    this.softDeleteStmt = db.prepare(`
      UPDATE tasks
      SET
        deleted_at = @deletedAt,
        deleted_by = @deletedBy,
        delete_reason = @deleteReason,
        revision = revision + 1,
        updated_at = @updatedAt
      WHERE task_id = @taskId
        AND revision = @expectedRevision
    `);
    this.restoreStmt = db.prepare(`
      UPDATE tasks
      SET
        deleted_at = NULL,
        deleted_by = NULL,
        delete_reason = NULL,
        revision = revision + 1,
        updated_at = @updatedAt
      WHERE task_id = @taskId
        AND revision = @expectedRevision
    `);
  }

  public create(input: TaskCreateInput, now = new Date().toISOString(), options: { taskId?: string } = {}): TaskRecord {
    const normalizedTaskId = (options.taskId ?? randomUUID()).trim();
    if (!normalizedTaskId) {
      throw new ValidationError({ message: "taskId is required" });
    }
    this.insertStmt.run({
      taskId: normalizedTaskId,
      workspaceId: sanitizeWorkspaceId(input.workspaceId ?? "default"),
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? "inbox",
      priority: input.priority ?? "normal",
      assignedAgentId: input.assignedAgentId ?? null,
      createdBy: input.createdBy ?? null,
      dueAt: input.dueAt ?? null,
      metadataJson: serializeTaskMetadata(input.proactiveContext, input.agenticContext),
      distressSignalsJson: input.distressSignals ? JSON.stringify(input.distressSignals) : null,
      retryBudgetJson: input.retryBudget ? JSON.stringify(input.retryBudget) : null,
      artifactVerificationJson: input.artifactVerification ? JSON.stringify(input.artifactVerification) : null,
      createdAt: now,
      updatedAt: now,
    });

    return this.get(normalizedTaskId);
  }

  public get(taskId: string): TaskRecord {
    const row = toTaskRow(this.getStmt.get(taskId));
    if (!row) {
      throw new NotFoundError({ entity: "Task", id: taskId });
    }
    return this.mapTaskRow(row);
  }

  /** Locks a task for a cross-repository state transition. */
  public getForUpdate(taskId: string): TaskRecord {
    const row = toTaskRow(this.getForUpdateStmt.get(taskId));
    if (!row) {
      throw new NotFoundError({ entity: "Task", id: taskId });
    }
    return this.mapTaskRow(row);
  }

  public find(taskId: string): TaskRecord | undefined {
    const row = toTaskRow(this.getStmt.get(taskId));
    if (!row) {
      return undefined;
    }
    return this.mapTaskRow(row);
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
    return rows.map((row) => this.mapTaskRow(row));
  }

  public update(taskId: string, input: TaskUpdateInput, now = new Date().toISOString()): TaskRecord {
    return this.db.transaction("immediate", () => {
      const current = this.getForUpdate(taskId);
      return this.updateWithRevision(taskId, input, current.revision, now);
    });
  }

  public updateWithRevision(
    taskId: string,
    input: TaskUpdateInput,
    expectedRevision: number,
    now = new Date().toISOString(),
  ): TaskRecord {
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      const current = this.getForUpdate(taskId);
      assertExpectedRevision(taskId, expectedRevision, current.revision);
      const nextAssignedAgentId =
        input.assignedAgentId === undefined ? (current.assignedAgentId ?? null) : input.assignedAgentId;
      const nextProactiveContext =
        input.proactiveContext === undefined ? current.proactiveContext : (input.proactiveContext ?? undefined);
      const nextAgenticContext =
        input.agenticContext === undefined ? current.agenticContext : (input.agenticContext ?? undefined);
      const nextDistressSignals =
        input.distressSignals === undefined ? current.distressSignals : (input.distressSignals ?? undefined);
      const nextRetryBudget = input.retryBudget === undefined ? current.retryBudget : (input.retryBudget ?? undefined);
      const nextArtifactVerification =
        input.artifactVerification === undefined
          ? current.artifactVerification
          : (input.artifactVerification ?? undefined);
      const next = {
        title: input.title ?? current.title,
        description: input.description ?? current.description ?? null,
        status: input.status ?? current.status,
        priority: input.priority ?? current.priority,
        assignedAgentId: nextAssignedAgentId,
        dueAt: input.dueAt ?? current.dueAt ?? null,
        proactiveContext: nextProactiveContext,
        agenticContext: nextAgenticContext,
        distressSignals: nextDistressSignals,
        retryBudget: nextRetryBudget,
        artifactVerification: nextArtifactVerification,
      };

      if (taskMutableStateMatches(current, next)) {
        return current;
      }

      const result = this.updateStmt.run({
        taskId,
        expectedRevision,
        title: next.title,
        description: next.description,
        status: next.status,
        priority: next.priority,
        assignedAgentId: nextAssignedAgentId,
        dueAt: next.dueAt,
        metadataJson: serializeTaskMetadata(nextProactiveContext, nextAgenticContext),
        distressSignalsJson: nextDistressSignals ? JSON.stringify(nextDistressSignals) : null,
        retryBudgetJson: nextRetryBudget ? JSON.stringify(nextRetryBudget) : null,
        artifactVerificationJson: nextArtifactVerification ? JSON.stringify(nextArtifactVerification) : null,
        deletedAt: current.deletedAt ?? null,
        deletedBy: current.deletedBy ?? null,
        deleteReason: current.deleteReason ?? null,
        updatedAt: now,
      });
      if (result.changes === 0) {
        throwTaskWriteConflict(taskId, expectedRevision, this.find(taskId)?.revision);
      }
      return this.get(taskId);
    });
  }

  public softDelete(
    taskId: string,
    deletedBy?: string,
    deleteReason?: string,
    now = new Date().toISOString(),
  ): boolean {
    const current = this.find(taskId);
    if (!current || current.deletedAt) {
      return false;
    }
    return this.softDeleteWithRevision(taskId, current.revision, deletedBy, deleteReason, now);
  }

  public softDeleteWithRevision(
    taskId: string,
    expectedRevision: number,
    deletedBy?: string,
    deleteReason?: string,
    now = new Date().toISOString(),
  ): boolean {
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      const current = this.getForUpdate(taskId);
      assertExpectedRevision(taskId, expectedRevision, current.revision);
      if (current.deletedAt) {
        return false;
      }
      const result = this.softDeleteStmt.run({
        taskId,
        expectedRevision,
        deletedAt: now,
        deletedBy: deletedBy ?? null,
        deleteReason: deleteReason ?? null,
        updatedAt: now,
      });
      if (result.changes === 0) {
        throwTaskWriteConflict(taskId, expectedRevision, this.find(taskId)?.revision);
      }
      return true;
    });
  }

  public restore(taskId: string, now = new Date().toISOString()): boolean {
    const current = this.find(taskId);
    if (!current || !current.deletedAt) {
      return false;
    }
    return this.restoreWithRevision(taskId, current.revision, now);
  }

  public restoreWithRevision(taskId: string, expectedRevision: number, now = new Date().toISOString()): boolean {
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      const current = this.getForUpdate(taskId);
      assertExpectedRevision(taskId, expectedRevision, current.revision);
      if (!current.deletedAt) {
        return false;
      }
      const result = this.restoreStmt.run({ taskId, expectedRevision, updatedAt: now });
      if (result.changes === 0) {
        throwTaskWriteConflict(taskId, expectedRevision, this.find(taskId)?.revision);
      }
      return true;
    });
  }

  public hardDelete(taskId: string): boolean {
    const current = this.find(taskId);
    if (!current) {
      return false;
    }
    return this.hardDeleteWithRevision(taskId, current.revision);
  }

  public hardDeleteWithRevision(taskId: string, expectedRevision: number): boolean {
    validateExpectedRevision(expectedRevision);
    return this.db.transaction("immediate", () => {
      const current = this.getForUpdate(taskId);
      assertExpectedRevision(taskId, expectedRevision, current.revision);
      const result = this.hardDeleteStmt.run({ taskId, expectedRevision });
      if (result.changes === 0) {
        throwTaskWriteConflict(taskId, expectedRevision, this.find(taskId)?.revision);
      }
      return true;
    });
  }

  public statusCounts(): TaskStatusCount[] {
    const rows = toTaskStatusCountRows(
      this.db
        .prepare(
          `
      SELECT status, COUNT(*) AS count
      FROM tasks
      WHERE deleted_at IS NULL
      GROUP BY status
      ORDER BY status ASC
    `,
        )
        .all(),
    );
    return rows.map((row) => ({
      status: row.status,
      count: Number(row.count ?? 0),
    }));
  }

  public statusCountsByWorkspace(workspaceId: string): TaskStatusCount[] {
    const rows = toTaskStatusCountRows(
      this.db
        .prepare(
          `
      SELECT status, COUNT(*) AS count
      FROM tasks
      WHERE deleted_at IS NULL
        AND workspace_id = @workspaceId
      GROUP BY status
      ORDER BY status ASC
    `,
        )
        .all({
          workspaceId: sanitizeWorkspaceId(workspaceId),
        }),
    );
    return rows.map((row) => ({
      status: row.status,
      count: Number(row.count ?? 0),
    }));
  }

  private mapTaskRow(row: TaskRow): TaskRecord {
    const metadata = loadAndSanitize(
      row.metadata_json,
      {
        store: "task.metadata",
        rowId: row.task_id,
        parse: parseJsonObject,
        onQuarantine: this.options.quarantine ? (e) => this.options.quarantine!.record(e) : undefined,
        log: this.options.logger,
      },
      {},
    ) as {
      proactiveContext?: TaskProactiveContext | null;
      agenticContext?: AgenticTaskContext | null;
    };
    return {
      taskId: row.task_id,
      revision: normalizeRevision(row.revision),
      workspaceId: row.workspace_id,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status,
      priority: row.priority,
      assignedAgentId: row.assigned_agent_id ?? undefined,
      createdBy: row.created_by ?? undefined,
      dueAt: row.due_at ?? undefined,
      proactiveContext: metadata.proactiveContext ?? undefined,
      agenticContext: metadata.agenticContext ?? undefined,
      distressSignals: row.distress_signals_json
        ? (safeJsonParse<TaskDistressSignal[]>(row.distress_signals_json, []) as TaskDistressSignal[])
        : undefined,
      retryBudget: row.retry_budget_json
        ? safeJsonParse<TaskRetryBudget | undefined>(row.retry_budget_json, undefined)
        : undefined,
      artifactVerification: row.artifact_verification_json
        ? (safeJsonParse<TaskArtifactVerification[]>(row.artifact_verification_json, []) as TaskArtifactVerification[])
        : undefined,
      deletedAt: row.deleted_at ?? undefined,
      deletedBy: row.deleted_by ?? undefined,
      deleteReason: row.delete_reason ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
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

function serializeTaskMetadata(
  proactiveContext?: TaskProactiveContext,
  agenticContext?: AgenticTaskContext,
): string | null {
  if (!proactiveContext && !agenticContext) {
    return null;
  }
  return JSON.stringify({
    ...(proactiveContext ? { proactiveContext } : {}),
    ...(agenticContext ? { agenticContext } : {}),
  });
}

function taskMutableStateMatches(current: TaskRecord, next: TaskMutableState): boolean {
  return (
    next.title === current.title &&
    next.description === (current.description ?? null) &&
    next.status === current.status &&
    next.priority === current.priority &&
    next.assignedAgentId === (current.assignedAgentId ?? null) &&
    next.dueAt === (current.dueAt ?? null) &&
    isDeepStrictEqual(next.proactiveContext, current.proactiveContext) &&
    isDeepStrictEqual(next.agenticContext, current.agenticContext) &&
    isDeepStrictEqual(next.distressSignals, current.distressSignals) &&
    isDeepStrictEqual(next.retryBudget, current.retryBudget) &&
    isDeepStrictEqual(next.artifactVerification, current.artifactVerification)
  );
}

function validateExpectedRevision(expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new ValidationError({
      code: "FIELD_INVALID",
      field: "expectedRevision",
      message: "expectedRevision must be a positive integer",
    });
  }
}

function assertExpectedRevision(taskId: string, expectedRevision: number, actualRevision: number): void {
  if (expectedRevision !== actualRevision) {
    throwTaskWriteConflict(taskId, expectedRevision, actualRevision);
  }
}

function throwTaskWriteConflict(taskId: string, expectedRevision: number, actualRevision?: number): never {
  const currentRevision = actualRevision ?? expectedRevision;
  throw new ConflictError({
    code: "WRITE_CONFLICT",
    message: `task ${taskId} changed since revision ${expectedRevision}`,
    details: { resourceKind: "task", resourceId: taskId, expectedRevision, currentRevision },
  });
}

function normalizeRevision(value: number | null | undefined): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 1;
}

function toTaskRow(value: unknown): TaskRow | undefined {
  return isTaskRow(value) ? value : undefined;
}

function toTaskRows(value: unknown): TaskRow[] {
  return Array.isArray(value) ? value.filter(isTaskRow) : [];
}

function toTaskStatusCountRows(value: unknown): Array<{ status: string; count: number }> {
  return Array.isArray(value)
    ? value.filter(
        (row): row is { status: string; count: number } =>
          isRecord(row) && typeof row.status === "string" && typeof row.count === "number",
      )
    : [];
}

function toTaskStatusCountRowsForTest(value: unknown): Array<{ status: string; count: number }> {
  return toTaskStatusCountRows(value);
}

export const __taskRepoInternals = {
  toTaskStatusCountRowsForTest,
};

function isTaskRow(value: unknown): value is TaskRow {
  return (
    isRecord(value) &&
    typeof value.task_id === "string" &&
    (typeof value.revision === "number" || value.revision === null || value.revision === undefined) &&
    typeof value.workspace_id === "string" &&
    typeof value.title === "string" &&
    (typeof value.description === "string" || value.description === null) &&
    isTaskStatus(value.status) &&
    isTaskPriority(value.priority) &&
    (typeof value.assigned_agent_id === "string" || value.assigned_agent_id === null) &&
    (typeof value.created_by === "string" || value.created_by === null) &&
    (typeof value.due_at === "string" || value.due_at === null) &&
    (typeof value.metadata_json === "string" || value.metadata_json === null) &&
    (typeof value.deleted_at === "string" || value.deleted_at === null) &&
    (typeof value.deleted_by === "string" || value.deleted_by === null) &&
    (typeof value.delete_reason === "string" || value.delete_reason === null) &&
    (typeof value.distress_signals_json === "string" || value.distress_signals_json === null) &&
    (typeof value.retry_budget_json === "string" || value.retry_budget_json === null) &&
    (typeof value.artifact_verification_json === "string" || value.artifact_verification_json === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === "planning" ||
    value === "inbox" ||
    value === "assigned" ||
    value === "in_progress" ||
    value === "testing" ||
    value === "review" ||
    value === "done" ||
    value === "blocked"
  );
}

function isTaskPriority(value: unknown): value is TaskRecord["priority"] {
  return value === "low" || value === "normal" || value === "high" || value === "urgent";
}
