import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import type {
  AgenticSubagentMetadata,
  TaskSubagentCreateInput,
  TaskSubagentSession,
  TaskSubagentUpdateInput,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface TaskSubagentRow {
  subagent_session_id: string;
  task_id: string;
  agent_session_id: string;
  agent_name: string | null;
  status: TaskSubagentSession["status"];
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export class TaskSubagentRepository {
  private readonly insertStmt;
  private readonly listByTaskStmt;
  private readonly listAllStmt;
  private readonly getByAgentSessionStmt;
  private readonly getByAgentSessionForUpdateStmt;
  private readonly updateByAgentSessionStmt;
  private readonly countActiveStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO task_subagent_sessions (
        subagent_session_id, task_id, agent_session_id, agent_name,
        status, metadata_json, created_at, updated_at, ended_at
      ) VALUES (
        @subagentSessionId, @taskId, @agentSessionId, @agentName,
        @status, @metadataJson, @createdAt, @updatedAt, @endedAt
      )
    `);

    this.listByTaskStmt = db.prepare(`
      SELECT * FROM task_subagent_sessions
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    this.listAllStmt = db.prepare(`
      SELECT * FROM task_subagent_sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    this.getByAgentSessionStmt = db.prepare("SELECT * FROM task_subagent_sessions WHERE agent_session_id = ?");
    this.getByAgentSessionForUpdateStmt = db.prepare(`
      SELECT * FROM task_subagent_sessions
      WHERE agent_session_id = ?
      ${db.dialect === "postgres" ? "FOR UPDATE" : ""}
    `);

    this.updateByAgentSessionStmt = db.prepare(`
      UPDATE task_subagent_sessions
      SET
        status = @status,
        metadata_json = @metadataJson,
        ended_at = @endedAt,
        updated_at = @updatedAt
      WHERE agent_session_id = @agentSessionId
    `);

    this.countActiveStmt = db.prepare("SELECT COUNT(*) AS count FROM task_subagent_sessions WHERE status = 'active'");
  }

  public create(taskId: string, input: TaskSubagentCreateInput, now = new Date().toISOString()): TaskSubagentSession {
    const subagentSessionId = randomUUID();
    this.insertStmt.run({
      subagentSessionId,
      taskId,
      agentSessionId: input.agentSessionId,
      agentName: input.agentName ?? null,
      status: "active",
      metadataJson: serializeSubagentMetadata(input.metadata),
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    });

    return this.getByAgentSessionId(input.agentSessionId);
  }

  public getByAgentSessionId(agentSessionId: string): TaskSubagentSession {
    const row = toTaskSubagentRow(this.getByAgentSessionStmt.get(agentSessionId));
    if (!row) {
      throw new NotFoundError({ entity: "Sub-agent session", id: agentSessionId });
    }
    return mapSubagentRow(row);
  }

  public findByAgentSessionId(agentSessionId: string): TaskSubagentSession | undefined {
    const row = toTaskSubagentRow(this.getByAgentSessionStmt.get(agentSessionId));
    if (!row) {
      return undefined;
    }
    return mapSubagentRow(row);
  }

  public getByAgentSessionIdForUpdate(agentSessionId: string): TaskSubagentSession {
    const row = toTaskSubagentRow(this.getByAgentSessionForUpdateStmt.get(agentSessionId));
    if (!row) {
      throw new NotFoundError({ entity: "Sub-agent session", id: agentSessionId });
    }
    return mapSubagentRow(row);
  }

  public listByTask(taskId: string, limit = 200): TaskSubagentSession[] {
    const rows = toTaskSubagentRows(this.listByTaskStmt.all(taskId, limit));
    return rows.map(mapSubagentRow);
  }

  public listAll(limit = 500): TaskSubagentSession[] {
    const rows = toTaskSubagentRows(this.listAllStmt.all(limit));
    return rows.map(mapSubagentRow);
  }

  public updateByAgentSessionId(
    agentSessionId: string,
    input: TaskSubagentUpdateInput,
    now = new Date().toISOString(),
  ): TaskSubagentSession {
    return this.db.transaction("immediate", () => {
      const current = this.getByAgentSessionIdForUpdate(agentSessionId);
      return this.writeLockedUpdate(agentSessionId, current, input, now);
    });
  }

  public updateByAgentSessionIdWithMetadataPatch(
    agentSessionId: string,
    input: Omit<TaskSubagentUpdateInput, "metadata"> & { metadataPatch: Partial<AgenticSubagentMetadata> },
    now = new Date().toISOString(),
  ): TaskSubagentSession {
    return this.db.transaction("immediate", () => {
      const current = this.getByAgentSessionIdForUpdate(agentSessionId);
      return this.writeLockedUpdate(
        agentSessionId,
        current,
        {
          status: input.status,
          endedAt: input.endedAt,
          metadata: { ...(current.metadata ?? {}), ...input.metadataPatch },
        },
        now,
      );
    });
  }

  public activeCount(): number {
    const row = this.countActiveStmt.get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private writeLockedUpdate(
    agentSessionId: string,
    current: TaskSubagentSession,
    input: TaskSubagentUpdateInput,
    now: string,
  ): TaskSubagentSession {
    this.updateByAgentSessionStmt.run({
      agentSessionId,
      status: input.status ?? current.status,
      metadataJson:
        input.metadata === undefined
          ? serializeSubagentMetadata(current.metadata)
          : serializeSubagentMetadata(input.metadata ?? undefined),
      endedAt: input.endedAt ?? current.endedAt ?? null,
      updatedAt: now,
    });
    return this.getByAgentSessionId(agentSessionId);
  }
}

function mapSubagentRow(row: TaskSubagentRow): TaskSubagentSession {
  const metadata = safeJsonParse<AgenticSubagentMetadata | null>(row.metadata_json, null) ?? undefined;
  return {
    subagentSessionId: row.subagent_session_id,
    taskId: row.task_id,
    agentSessionId: row.agent_session_id,
    agentName: row.agent_name ?? undefined,
    status: row.status,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at ?? undefined,
  };
}

function serializeSubagentMetadata(metadata?: AgenticSubagentMetadata): string | null {
  return metadata ? JSON.stringify(metadata) : null;
}

function toTaskSubagentRow(value: unknown): TaskSubagentRow | undefined {
  return isTaskSubagentRow(value) ? value : undefined;
}

function toTaskSubagentRows(value: unknown): TaskSubagentRow[] {
  return Array.isArray(value) ? value.filter(isTaskSubagentRow) : [];
}

function isTaskSubagentRow(value: unknown): value is TaskSubagentRow {
  return (
    isRecord(value) &&
    typeof value.subagent_session_id === "string" &&
    typeof value.task_id === "string" &&
    typeof value.agent_session_id === "string" &&
    (typeof value.agent_name === "string" || value.agent_name === null) &&
    typeof value.status === "string" &&
    (typeof value.metadata_json === "string" || value.metadata_json === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    (typeof value.ended_at === "string" || value.ended_at === null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
