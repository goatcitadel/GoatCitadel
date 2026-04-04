import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ChatExecutionPlanRecord,
  ChatExecutionPlanSource,
  ChatExecutionPlanStatus,
  ChatExecutionPlanStepRecord,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ChatExecutionPlanRow {
  plan_id: string;
  session_id: string;
  turn_id: string;
  mode: ChatExecutionPlanRecord["mode"];
  planning_mode: ChatExecutionPlanRecord["planningMode"];
  status: ChatExecutionPlanStatus;
  source: ChatExecutionPlanSource;
  advisory_only: number;
  objective: string;
  summary: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ChatExecutionPlanStepRow {
  plan_id: string;
  step_id: string;
  step_index: number;
  objective: string;
  success_criteria: string | null;
  suggested_tools_json: string | null;
  expected_output: string | null;
  parallelizable: number;
  depends_on_step_ids_json: string | null;
  delegated_role: string | null;
  status: ChatExecutionPlanStepRecord["status"];
  summary: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  child_run_id: string | null;
  child_session_id: string | null;
  child_turn_id: string | null;
}

export interface ChatExecutionPlanCreateInput {
  planId?: string;
  sessionId: string;
  turnId: string;
  mode: ChatExecutionPlanRecord["mode"];
  planningMode: ChatExecutionPlanRecord["planningMode"];
  status?: ChatExecutionPlanStatus;
  source: ChatExecutionPlanSource;
  advisoryOnly?: boolean;
  objective: string;
  summary: string;
  steps: ChatExecutionPlanStepRecord[];
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ChatExecutionPlanPatchInput {
  status?: ChatExecutionPlanStatus;
  summary?: string;
  steps?: ChatExecutionPlanStepRecord[];
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export class ChatExecutionPlanRepository {
  private readonly getPlanStmt;
  private readonly listPlansBySessionStmt;
  private readonly listPlansByTurnStmt;
  private readonly listStepsByPlanStmt;
  private readonly insertPlanStmt;
  private readonly patchPlanStmt;
  private readonly deleteStepsByPlanStmt;
  private readonly insertStepStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getPlanStmt = db.prepare("SELECT * FROM chat_execution_plans WHERE plan_id = ?");
    this.listPlansBySessionStmt = db.prepare(`
      SELECT * FROM chat_execution_plans
      WHERE session_id = @sessionId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listPlansByTurnStmt = db.prepare(`
      SELECT * FROM chat_execution_plans
      WHERE turn_id = @turnId
      ORDER BY created_at DESC
      LIMIT @limit
    `);
    this.listStepsByPlanStmt = db.prepare(`
      SELECT * FROM chat_execution_plan_steps
      WHERE plan_id = @planId
      ORDER BY step_index ASC
    `);
    this.insertPlanStmt = db.prepare(`
      INSERT INTO chat_execution_plans (
        plan_id, session_id, turn_id, mode, planning_mode, status, source, advisory_only,
        objective, summary, created_at, updated_at, started_at, finished_at
      ) VALUES (
        @planId, @sessionId, @turnId, @mode, @planningMode, @status, @source, @advisoryOnly,
        @objective, @summary, @createdAt, @updatedAt, @startedAt, @finishedAt
      )
    `);
    this.patchPlanStmt = db.prepare(`
      UPDATE chat_execution_plans
      SET
        status = @status,
        summary = @summary,
        updated_at = @updatedAt,
        started_at = @startedAt,
        finished_at = @finishedAt
      WHERE plan_id = @planId
    `);
    this.deleteStepsByPlanStmt = db.prepare("DELETE FROM chat_execution_plan_steps WHERE plan_id = ?");
    this.insertStepStmt = db.prepare(`
      INSERT INTO chat_execution_plan_steps (
        plan_id, step_id, step_index, objective, success_criteria, suggested_tools_json, expected_output,
        parallelizable, depends_on_step_ids_json, delegated_role, status, summary, error, started_at, finished_at,
        child_run_id, child_session_id, child_turn_id
      ) VALUES (
        @planId, @stepId, @index, @objective, @successCriteria, @suggestedToolsJson, @expectedOutput,
        @parallelizable, @dependsOnStepIdsJson, @delegatedRole, @status, @summary, @error, @startedAt, @finishedAt,
        @childRunId, @childSessionId, @childTurnId
      )
    `);
  }

  public get(planId: string): ChatExecutionPlanRecord {
    const row = toChatExecutionPlanRow(this.getPlanStmt.get(planId));
    if (!row) {
      throw new NotFoundError({ entity: "Chat execution plan", id: planId });
    }
    return this.mapPlan(row);
  }

  public create(input: ChatExecutionPlanCreateInput): ChatExecutionPlanRecord {
    const planId = input.planId ?? randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const updatedAt = input.updatedAt ?? createdAt;

    this.withSavepoint(() => {
      this.insertPlanStmt.run({
        planId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        mode: input.mode,
        planningMode: input.planningMode,
        status: input.status ?? "drafted",
        source: input.source,
        advisoryOnly: input.advisoryOnly ? 1 : 0,
        objective: input.objective,
        summary: input.summary,
        createdAt,
        updatedAt,
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null,
      });
      this.replaceSteps(planId, input.steps);
    });

    return this.get(planId);
  }

  public patch(planId: string, input: ChatExecutionPlanPatchInput): ChatExecutionPlanRecord {
    const current = this.get(planId);
    this.withSavepoint(() => {
      this.patchPlanStmt.run({
        planId,
        status: input.status ?? current.status,
        summary: input.summary ?? current.summary,
        updatedAt: input.updatedAt ?? new Date().toISOString(),
        startedAt: input.startedAt !== undefined ? input.startedAt : (current.startedAt ?? null),
        finishedAt: input.finishedAt !== undefined ? input.finishedAt : (current.finishedAt ?? null),
      });
      if (input.steps) {
        this.replaceSteps(planId, input.steps);
      }
    });
    return this.get(planId);
  }

  public listBySession(sessionId: string, limit = 50): ChatExecutionPlanRecord[] {
    const rows = toChatExecutionPlanRows(this.listPlansBySessionStmt.all({
      sessionId,
      limit: Math.max(1, Math.min(limit, 500)),
    }));
    return rows.map((row) => this.mapPlan(row));
  }

  public listByTurn(turnId: string, limit = 10): ChatExecutionPlanRecord[] {
    const rows = toChatExecutionPlanRows(this.listPlansByTurnStmt.all({
      turnId,
      limit: Math.max(1, Math.min(limit, 100)),
    }));
    return rows.map((row) => this.mapPlan(row));
  }

  private replaceSteps(planId: string, steps: ChatExecutionPlanStepRecord[]): void {
    this.deleteStepsByPlanStmt.run(planId);
    for (const step of steps) {
      const logicalStepId = step.stepId || randomUUID();
      this.insertStepStmt.run({
        planId,
        stepId: toPersistedExecutionPlanStepId(planId, logicalStepId),
        index: step.index,
        objective: step.objective,
        successCriteria: step.successCriteria ?? null,
        suggestedToolsJson: step.suggestedTools ? JSON.stringify(step.suggestedTools) : null,
        expectedOutput: step.expectedOutput ?? null,
        parallelizable: step.parallelizable ? 1 : 0,
        dependsOnStepIdsJson: step.dependsOnStepIds ? JSON.stringify(step.dependsOnStepIds) : null,
        delegatedRole: step.delegatedRole ?? null,
        status: step.status,
        summary: step.summary ?? null,
        error: step.error ?? null,
        startedAt: step.startedAt ?? null,
        finishedAt: step.finishedAt ?? null,
        childRunId: step.childRunId ?? null,
        childSessionId: step.childSessionId ?? null,
        childTurnId: step.childTurnId ?? null,
      });
    }
  }

  private withSavepoint<T>(work: () => T): T {
    const savepointName = `chat_execution_plan_${randomUUID().replaceAll("-", "_")}`;
    this.db.exec(`SAVEPOINT ${savepointName}`);
    try {
      const result = work();
      this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      throw error;
    }
  }

  private mapPlan(row: ChatExecutionPlanRow): ChatExecutionPlanRecord {
    const steps = toChatExecutionPlanStepRows(this.listStepsByPlanStmt.all({ planId: row.plan_id }));
    return {
      planId: row.plan_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      mode: row.mode,
      planningMode: row.planning_mode,
      status: row.status,
      source: row.source,
      advisoryOnly: row.advisory_only === 1,
      objective: row.objective,
      summary: row.summary,
      steps: steps.map(mapStep),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChatExecutionPlanRow(value: unknown): value is ChatExecutionPlanRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.plan_id === "string"
    && typeof value.session_id === "string"
    && typeof value.turn_id === "string"
    && typeof value.mode === "string"
    && typeof value.planning_mode === "string"
    && typeof value.status === "string"
    && typeof value.source === "string"
    && typeof value.advisory_only === "number"
    && typeof value.objective === "string"
    && typeof value.summary === "string"
    && typeof value.created_at === "string"
    && typeof value.updated_at === "string"
    && (typeof value.started_at === "string" || value.started_at === null)
    && (typeof value.finished_at === "string" || value.finished_at === null);
}

function isChatExecutionPlanStepRow(value: unknown): value is ChatExecutionPlanStepRow {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.plan_id === "string"
    && typeof value.step_id === "string"
    && typeof value.step_index === "number"
    && typeof value.objective === "string"
    && (typeof value.success_criteria === "string" || value.success_criteria === null)
    && (typeof value.suggested_tools_json === "string" || value.suggested_tools_json === null)
    && (typeof value.expected_output === "string" || value.expected_output === null)
    && typeof value.parallelizable === "number"
    && (typeof value.depends_on_step_ids_json === "string" || value.depends_on_step_ids_json === null)
    && (typeof value.delegated_role === "string" || value.delegated_role === null)
    && typeof value.status === "string"
    && (typeof value.summary === "string" || value.summary === null)
    && (typeof value.error === "string" || value.error === null)
    && (typeof value.started_at === "string" || value.started_at === null)
    && (typeof value.finished_at === "string" || value.finished_at === null)
    && (typeof value.child_run_id === "string" || value.child_run_id === null)
    && (typeof value.child_session_id === "string" || value.child_session_id === null)
    && (typeof value.child_turn_id === "string" || value.child_turn_id === null);
}

function toChatExecutionPlanRow(value: unknown): ChatExecutionPlanRow | undefined {
  return isChatExecutionPlanRow(value) ? value : undefined;
}

function toChatExecutionPlanRows(value: unknown): ChatExecutionPlanRow[] {
  return Array.isArray(value) ? value.filter(isChatExecutionPlanRow) : [];
}

function toChatExecutionPlanStepRows(value: unknown): ChatExecutionPlanStepRow[] {
  return Array.isArray(value) ? value.filter(isChatExecutionPlanStepRow) : [];
}

function mapStep(row: ChatExecutionPlanStepRow): ChatExecutionPlanStepRecord {
  return {
    stepId: toLogicalExecutionPlanStepId(row.plan_id, row.step_id),
    index: row.step_index,
    objective: row.objective,
    successCriteria: row.success_criteria ?? undefined,
    suggestedTools: row.suggested_tools_json
      ? safeJsonParse<string[]>(row.suggested_tools_json, [])
      : undefined,
    expectedOutput: row.expected_output ?? undefined,
    parallelizable: row.parallelizable === 1,
    dependsOnStepIds: row.depends_on_step_ids_json
      ? safeJsonParse<string[]>(row.depends_on_step_ids_json, [])
      : undefined,
    delegatedRole: row.delegated_role ?? undefined,
    status: row.status,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    childRunId: row.child_run_id ?? undefined,
    childSessionId: row.child_session_id ?? undefined,
    childTurnId: row.child_turn_id ?? undefined,
  };
}

function toPersistedExecutionPlanStepId(planId: string, logicalStepId: string): string {
  return `${planId}:${logicalStepId}`;
}

function toLogicalExecutionPlanStepId(planId: string, persistedStepId: string): string {
  const prefix = `${planId}:`;
  return persistedStepId.startsWith(prefix)
    ? persistedStepId.slice(prefix.length)
    : persistedStepId;
}
