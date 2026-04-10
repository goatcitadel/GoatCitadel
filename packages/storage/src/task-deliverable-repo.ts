import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  TaskDeliverableCreateInput,
  TaskDeliverableRecord,
} from "@goatcitadel/contracts";

interface TaskDeliverableRow {
  deliverable_id: string;
  task_id: string;
  deliverable_type: TaskDeliverableRecord["deliverableType"];
  title: string;
  path: string | null;
  description: string | null;
  created_at: string;
}

export class TaskDeliverableRepository {
  private readonly insertStmt;
  private readonly listByTaskStmt;
  private readonly countByTaskStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO task_deliverables (
        deliverable_id, task_id, deliverable_type, title, path, description, created_at
      ) VALUES (
        @deliverableId, @taskId, @deliverableType, @title, @path, @description, @createdAt
      )
    `);

    this.listByTaskStmt = db.prepare(`
      SELECT * FROM task_deliverables
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    this.countByTaskStmt = db.prepare("SELECT COUNT(*) AS count FROM task_deliverables WHERE task_id = ?");
  }

  public append(
    taskId: string,
    input: TaskDeliverableCreateInput,
    createdAt = new Date().toISOString(),
  ): TaskDeliverableRecord {
    const deliverableId = randomUUID();
    this.insertStmt.run({
      deliverableId,
      taskId,
      deliverableType: input.deliverableType,
      title: input.title,
      path: input.path ?? null,
      description: input.description ?? null,
      createdAt,
    });

    return {
      deliverableId,
      taskId,
      deliverableType: input.deliverableType,
      title: input.title,
      path: input.path,
      description: input.description,
      createdAt,
    };
  }

  public listByTask(taskId: string, limit = 200): TaskDeliverableRecord[] {
    const rows = toTaskDeliverableRows(this.listByTaskStmt.all(taskId, limit));
    return rows.map((row) => ({
      deliverableId: row.deliverable_id,
      taskId: row.task_id,
      deliverableType: row.deliverable_type,
      title: row.title,
      path: row.path ?? undefined,
      description: row.description ?? undefined,
      createdAt: row.created_at,
    }));
  }

  public countByTask(taskId: string): number {
    const row = this.countByTaskStmt.get(taskId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }
}

function toTaskDeliverableRows(value: unknown): TaskDeliverableRow[] {
  return Array.isArray(value) ? value.filter(isTaskDeliverableRow) : [];
}

function isTaskDeliverableRow(value: unknown): value is TaskDeliverableRow {
  return isRecord(value)
    && typeof value.deliverable_id === "string"
    && typeof value.task_id === "string"
    && typeof value.deliverable_type === "string"
    && typeof value.title === "string"
    && (typeof value.path === "string" || value.path === null)
    && (typeof value.description === "string" || value.description === null)
    && typeof value.created_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


