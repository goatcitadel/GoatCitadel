import type { DatabaseClient } from "./db.js";
import type {
  ChatCitationRecord,
  ChatDelegationMode,
  ChatDelegationRunRecord,
  ChatDelegationRunStatus,
  ChatOrchestrationRouteDecision,
  ChatOrchestrationVisibility,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ChatDelegationRunRow {
  run_id: string;
  session_id: string;
  task_id: string;
  objective: string;
  roles_json: string;
  mode: ChatDelegationMode;
  provider_id: string | null;
  model: string | null;
  status: ChatDelegationRunStatus;
  visibility: ChatOrchestrationVisibility | null;
  workflow_template: string | null;
  execution_plan_id: string | null;
  route_decision_json: string | null;
  final_summary: string | null;
  stitched_output: string | null;
  citations_json: string;
  trace_json: string | null;
  started_at: string;
  finished_at: string | null;
}

export class ChatDelegationRunRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly patchStmt;
  private readonly listBySessionStmt;
  private readonly listRecentStmt;
  private readonly activeStepCountStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_delegation_runs WHERE run_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO chat_delegation_runs (
        run_id, session_id, task_id, objective, roles_json, mode, provider_id, model, status, visibility,
        workflow_template, execution_plan_id, route_decision_json, final_summary,
        stitched_output, citations_json, trace_json, started_at, finished_at
      ) VALUES (
        @runId, @sessionId, @taskId, @objective, @rolesJson, @mode, @providerId, @model, @status, @visibility,
        @workflowTemplate, @executionPlanId, @routeDecisionJson, @finalSummary,
        @stitchedOutput, @citationsJson, @traceJson, @startedAt, @finishedAt
      )
    `);
    this.patchStmt = db.prepare(`
      UPDATE chat_delegation_runs
      SET
        status = @status,
        visibility = @visibility,
        workflow_template = @workflowTemplate,
        execution_plan_id = @executionPlanId,
        route_decision_json = @routeDecisionJson,
        final_summary = @finalSummary,
        stitched_output = @stitchedOutput,
        citations_json = @citationsJson,
        trace_json = @traceJson,
        finished_at = @finishedAt
      WHERE run_id = @runId
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT * FROM chat_delegation_runs
      WHERE session_id = @sessionId
      ORDER BY started_at DESC
      LIMIT @limit
    `);
    this.listRecentStmt = db.prepare(`
      SELECT runs.*
      FROM chat_delegation_runs runs
      LEFT JOIN chat_session_meta meta ON meta.session_id = runs.session_id
      WHERE (@workspaceId IS NULL OR meta.workspace_id = @workspaceId)
        AND (@sessionId IS NULL OR runs.session_id = @sessionId)
        AND (@parentRunId IS NULL OR runs.run_id = @parentRunId)
      ORDER BY runs.started_at DESC, runs.run_id DESC
      LIMIT @limit
    `);
    this.activeStepCountStmt = db.prepare(`
      SELECT COUNT(*) AS active_count
      FROM chat_delegation_steps
      WHERE run_id = ? AND status IN ('running', 'pending')
    `);
  }

  public get(runId: string): ChatDelegationRunRecord {
    const raw = this.getStmt.get(runId);
    if (!raw) {
      throw new NotFoundError({ entity: "Delegation run", id: runId });
    }
    const row = toChatDelegationRunRow(raw);
    if (!row) {
      throw new Error(`Delegation run ${runId} is corrupt or uses unsupported persisted values`);
    }
    return mapRow(row);
  }

  public create(input: {
    runId: string;
    sessionId: string;
    taskId: string;
    objective: string;
    roles: string[];
    mode: ChatDelegationMode;
    providerId?: string;
    model?: string;
    status?: ChatDelegationRunStatus;
    visibility?: ChatOrchestrationVisibility;
    workflowTemplate?: string;
    executionPlanId?: string;
    routeDecision?: ChatOrchestrationRouteDecision;
    finalSummary?: string;
    stitchedOutput?: string;
    citations?: ChatCitationRecord[];
    trace?: ChatTurnTraceRecord["routing"];
    startedAt?: string;
    finishedAt?: string;
  }): ChatDelegationRunRecord {
    this.insertStmt.run({
      runId: input.runId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      objective: input.objective,
      rolesJson: JSON.stringify(input.roles),
      mode: input.mode,
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      status: input.status ?? "running",
      visibility: input.visibility ?? null,
      workflowTemplate: input.workflowTemplate ?? null,
      executionPlanId: input.executionPlanId ?? null,
      routeDecisionJson: input.routeDecision ? JSON.stringify(input.routeDecision) : null,
      finalSummary: input.finalSummary ?? null,
      stitchedOutput: input.stitchedOutput ?? null,
      citationsJson: JSON.stringify(input.citations ?? []),
      traceJson: input.trace ? JSON.stringify(input.trace) : null,
      startedAt: input.startedAt ?? new Date().toISOString(),
      finishedAt: input.finishedAt ?? null,
    });
    return this.get(input.runId);
  }

  public patch(
    runId: string,
    input: {
      status?: ChatDelegationRunStatus;
      visibility?: ChatOrchestrationVisibility;
      workflowTemplate?: string;
      executionPlanId?: string;
      routeDecision?: ChatOrchestrationRouteDecision;
      finalSummary?: string;
      stitchedOutput?: string;
      citations?: ChatCitationRecord[];
      trace?: ChatTurnTraceRecord["routing"];
      finishedAt?: string;
    },
  ): ChatDelegationRunRecord {
    const current = this.get(runId);
    this.patchStmt.run({
      runId,
      status: input.status ?? current.status,
      visibility: input.visibility !== undefined ? input.visibility : (current.visibility ?? null),
      workflowTemplate:
        input.workflowTemplate !== undefined ? input.workflowTemplate : (current.workflowTemplate ?? null),
      executionPlanId: input.executionPlanId !== undefined ? input.executionPlanId : (current.executionPlanId ?? null),
      routeDecisionJson: JSON.stringify(input.routeDecision ?? current.routeDecision ?? null),
      finalSummary: input.finalSummary !== undefined ? input.finalSummary : (current.finalSummary ?? null),
      stitchedOutput: input.stitchedOutput !== undefined ? input.stitchedOutput : (current.stitchedOutput ?? null),
      citationsJson: JSON.stringify(input.citations ?? current.citations),
      traceJson: JSON.stringify(input.trace ?? current.trace ?? {}),
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : (current.finishedAt ?? null),
    });
    return this.get(runId);
  }

  public listBySession(sessionId: string, limit = 100): ChatDelegationRunRecord[] {
    const rawRows = this.listBySessionStmt.all({
      sessionId,
      limit: Math.max(1, Math.min(limit, 1000)),
    });
    if (!Array.isArray(rawRows)) {
      throw new Error(`Delegation run list for session ${sessionId} is corrupt`);
    }
    const rows = rawRows.map((row, index) => {
      const mapped = toChatDelegationRunRow(row);
      if (!mapped) {
        throw new Error(`Delegation run list row ${index} for session ${sessionId} is corrupt`);
      }
      return mapped;
    });
    return rows.map(mapRow);
  }

  public listRecent(
    input: {
      workspaceId?: string;
      sessionId?: string;
      parentRunId?: string;
      limit?: number;
    } = {},
  ): ChatDelegationRunRecord[] {
    const rawRows = this.listRecentStmt.all({
      workspaceId: input.workspaceId?.trim() || null,
      sessionId: input.sessionId?.trim() || null,
      parentRunId: input.parentRunId?.trim() || null,
      limit: Math.max(1, Math.min(input.limit ?? 100, 1000)),
    });
    if (!Array.isArray(rawRows)) {
      throw new Error("Recent delegation run list is corrupt");
    }
    const rows = rawRows.map((row, index) => {
      const mapped = toChatDelegationRunRow(row);
      if (!mapped) {
        throw new Error(`Recent delegation run list row ${index} is corrupt`);
      }
      return mapped;
    });
    return rows.map(mapRow);
  }

  public reconcileSupersededRunningRunsForSession(
    sessionId: string,
    input: { now?: string; maxAgeMs?: number; limit?: number } = {},
  ): ChatDelegationRunRecord[] {
    const nowMs = Date.parse(input.now ?? new Date().toISOString());
    const maxAgeMs = input.maxAgeMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isFinite(nowMs) || maxAgeMs <= 0) {
      return [];
    }
    const runs = this.listBySession(sessionId, input.limit ?? 1000);
    const newestTerminalByObjective = new Map<string, ChatDelegationRunRecord>();
    const patched: ChatDelegationRunRecord[] = [];
    for (const run of runs) {
      const objectiveKey = normalizeObjectiveKey(run.objective);
      if (!objectiveKey) {
        continue;
      }
      if (run.status !== "running") {
        if (!newestTerminalByObjective.has(objectiveKey) && isTerminalRunStatus(run.status)) {
          newestTerminalByObjective.set(objectiveKey, run);
        }
        continue;
      }
      const newerTerminal = newestTerminalByObjective.get(objectiveKey);
      const startedMs = Date.parse(run.startedAt);
      if (!newerTerminal || !Number.isFinite(startedMs) || nowMs - startedMs < maxAgeMs) {
        continue;
      }
      if (this.countActiveSteps(run.runId) > 0) {
        continue;
      }
      patched.push(
        this.patch(run.runId, {
          status: "partial",
          finalSummary: "Superseded by a later terminal delegation run; stale running state reconciled.",
          stitchedOutput:
            run.stitchedOutput ??
            `STALE: Superseded by later delegation run ${newerTerminal.runId}; no active child step remained.`,
          finishedAt: input.now ?? new Date(nowMs).toISOString(),
        }),
      );
    }
    return patched;
  }

  private countActiveSteps(runId: string): number {
    const raw = this.activeStepCountStmt.get(runId);
    if (!isRecord(raw)) {
      return 0;
    }
    const count = raw.active_count ?? raw.count;
    if (typeof count === "number" && Number.isFinite(count)) {
      return count;
    }
    return typeof count === "bigint" ? Number(count) : 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatDelegationRunRow(value: unknown): value is ChatDelegationRunRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.run_id === "string" &&
    typeof value.session_id === "string" &&
    typeof value.task_id === "string" &&
    typeof value.objective === "string" &&
    typeof value.roles_json === "string" &&
    isDelegationMode(value.mode) &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.model === "string" || value.model === null) &&
    isDelegationStatus(value.status) &&
    (isVisibility(value.visibility) || value.visibility === null) &&
    (typeof value.workflow_template === "string" || value.workflow_template === null) &&
    (typeof value.execution_plan_id === "string" || value.execution_plan_id === null) &&
    (typeof value.route_decision_json === "string" || value.route_decision_json === null) &&
    (typeof value.final_summary === "string" || value.final_summary === null) &&
    (typeof value.stitched_output === "string" || value.stitched_output === null) &&
    typeof value.citations_json === "string" &&
    (typeof value.trace_json === "string" || value.trace_json === null) &&
    typeof value.started_at === "string" &&
    (typeof value.finished_at === "string" || value.finished_at === null)
  );
}

function isDelegationMode(value: unknown): value is ChatDelegationMode {
  return value === "sequential" || value === "parallel";
}

function isDelegationStatus(value: unknown): value is ChatDelegationRunStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "partial";
}

function isTerminalRunStatus(value: ChatDelegationRunStatus): boolean {
  return value === "completed" || value === "failed" || value === "partial";
}

function normalizeObjectiveKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function isVisibility(value: unknown): value is ChatOrchestrationVisibility {
  return value === "hidden" || value === "summarized" || value === "expandable" || value === "explicit";
}

function toChatDelegationRunRow(value: unknown): ChatDelegationRunRow | undefined {
  return isChatDelegationRunRow(value) ? value : undefined;
}

function mapRow(row: ChatDelegationRunRow): ChatDelegationRunRecord {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    objective: row.objective,
    roles: parseArray<string>(row.roles_json),
    mode: row.mode,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    status: row.status,
    visibility: row.visibility ?? undefined,
    workflowTemplate: row.workflow_template ?? undefined,
    executionPlanId: row.execution_plan_id ?? undefined,
    routeDecision: parseOptionalRecord<ChatOrchestrationRouteDecision>(row.route_decision_json),
    finalSummary: row.final_summary ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    stitchedOutput: row.stitched_output ?? undefined,
    citations: parseArray<ChatCitationRecord>(row.citations_json),
    trace: parseOptionalRecord<ChatTurnTraceRecord["routing"]>(row.trace_json),
  };
}

function parseArray<T>(raw: string): T[] {
  const parsed = safeJsonParse<unknown>(raw, []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function parseOptionalRecord<T>(raw: string | null): T | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = safeJsonParse<unknown>(raw, undefined);
  return isRecord(parsed) ? (parsed as T) : undefined;
}
