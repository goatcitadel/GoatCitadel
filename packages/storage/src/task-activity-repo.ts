import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  TaskActivityCreateInput,
  TaskActivityRecord,
} from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface TaskActivityRow {
  activity_id: string;
  task_id: string;
  agent_id: string | null;
  activity_type: TaskActivityRecord["activityType"];
  message: string;
  metadata_json: string | null;
  created_at: string;
}

export class TaskActivityRepository {
  private readonly insertStmt;
  private readonly listByTaskStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO task_activities (
        activity_id, task_id, agent_id, activity_type, message, metadata_json, created_at
      ) VALUES (
        @activityId, @taskId, @agentId, @activityType, @message, @metadataJson, @createdAt
      )
    `);

    this.listByTaskStmt = db.prepare(`
      SELECT * FROM task_activities
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
  }

  public append(taskId: string, input: TaskActivityCreateInput, createdAt = new Date().toISOString()): TaskActivityRecord {
    const activityId = randomUUID();
    this.insertStmt.run({
      activityId,
      taskId,
      agentId: input.agentId ?? null,
      activityType: input.activityType,
      message: input.message,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt,
    });

    return {
      activityId,
      taskId,
      agentId: input.agentId,
      activityType: input.activityType,
      message: input.message,
      metadata: input.metadata,
      createdAt,
    };
  }

  public listByTask(taskId: string, limit = 200): TaskActivityRecord[] {
    const rows = toTaskActivityRows(this.listByTaskStmt.all(taskId, limit));
    return rows.map((row) => ({
      activityId: row.activity_id,
      taskId: row.task_id,
      agentId: row.agent_id ?? undefined,
      activityType: row.activity_type,
      message: row.message,
      metadata: row.metadata_json ? safeJsonParse<Record<string, unknown>>(row.metadata_json, {}) : undefined,
      createdAt: row.created_at,
    }));
  }
}

function toTaskActivityRows(value: unknown): TaskActivityRow[] {
  return Array.isArray(value) ? value.filter(isTaskActivityRow) : [];
}

function isTaskActivityRow(value: unknown): value is TaskActivityRow {
  return isRecord(value)
    && typeof value.activity_id === "string"
    && typeof value.task_id === "string"
    && (typeof value.agent_id === "string" || value.agent_id === null)
    && typeof value.activity_type === "string"
    && typeof value.message === "string"
    && (typeof value.metadata_json === "string" || value.metadata_json === null)
    && typeof value.created_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


