import type { DatabaseClient } from "./db.js";
import type {
  ChatCitationRecord,
  ChatDelegationStepRecord,
  ChatDelegationStepStatus,
  ChatSessionDelegationParentRecord,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ChatDelegationStepRow {
  step_id: string;
  run_id: string;
  role: string;
  label: string | null;
  step_index: number;
  status: ChatDelegationStepStatus;
  provider_id: string | null;
  model: string | null;
  summary: string | null;
  output: string | null;
  error: string | null;
  failure_guidance: string | null;
  durable_run_id: string | null;
  child_session_id: string | null;
  child_turn_id: string | null;
  citations_json: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

interface ChatDelegationParentRow extends ChatDelegationStepRow {
  parent_session_id: string;
}

export class ChatDelegationStepRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly patchStmt;
  private readonly listByRunStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_delegation_steps WHERE step_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO chat_delegation_steps (
        step_id, run_id, role, label, step_index, status, provider_id, model, summary, output, error, started_at, finished_at, duration_ms
        , failure_guidance, durable_run_id, child_session_id, child_turn_id, citations_json
      ) VALUES (
        @stepId, @runId, @role, @label, @index, @status, @providerId, @model, @summary, @output, @error, @startedAt, @finishedAt, @durationMs,
        @failureGuidance, @durableRunId, @childSessionId, @childTurnId, @citationsJson
      )
    `);
    this.patchStmt = db.prepare(`
      UPDATE chat_delegation_steps
      SET
        status = @status,
        provider_id = @providerId,
        model = @model,
        label = @label,
        summary = @summary,
        output = @output,
        error = @error,
        failure_guidance = @failureGuidance,
        durable_run_id = @durableRunId,
        child_session_id = @childSessionId,
        child_turn_id = @childTurnId,
        citations_json = @citationsJson,
        finished_at = @finishedAt,
        duration_ms = @durationMs
      WHERE step_id = @stepId
    `);
    this.listByRunStmt = db.prepare(`
      SELECT * FROM chat_delegation_steps
      WHERE run_id = @runId
      ORDER BY step_index ASC, started_at ASC
    `);
  }

  public get(stepId: string): ChatDelegationStepRecord {
    const row = toChatDelegationStepRow(this.getStmt.get(stepId));
    if (!row) {
      throw new NotFoundError({ entity: "Delegation step", id: stepId });
    }
    return mapRow(row);
  }

  public create(input: {
    stepId: string;
    runId: string;
    role: string;
    label?: string;
    index: number;
    status?: ChatDelegationStepStatus;
    providerId?: string;
    model?: string;
    summary?: string;
    output?: string;
    error?: string;
    failureGuidance?: string;
    durableRunId?: string;
    childSessionId?: string;
    childTurnId?: string;
    citations?: ChatCitationRecord[];
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
  }): ChatDelegationStepRecord {
    this.insertStmt.run({
      stepId: input.stepId,
      runId: input.runId,
      role: input.role,
      label: input.label ?? null,
      index: input.index,
      status: input.status ?? "pending",
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      summary: input.summary ?? null,
      output: input.output ?? null,
      error: input.error ?? null,
      failureGuidance: input.failureGuidance ?? null,
      durableRunId: input.durableRunId ?? null,
      childSessionId: input.childSessionId ?? null,
      childTurnId: input.childTurnId ?? null,
      citationsJson: input.citations ? JSON.stringify(input.citations) : null,
      startedAt: input.startedAt ?? new Date().toISOString(),
      finishedAt: input.finishedAt ?? null,
      durationMs: input.durationMs ?? null,
    });
    return this.get(input.stepId);
  }

  public patch(
    stepId: string,
    input: {
      status?: ChatDelegationStepStatus;
      providerId?: string;
      model?: string;
      label?: string;
      summary?: string;
      output?: string;
      error?: string;
      failureGuidance?: string;
      durableRunId?: string;
      childSessionId?: string;
      childTurnId?: string;
      citations?: ChatCitationRecord[];
      finishedAt?: string;
      durationMs?: number;
    },
  ): ChatDelegationStepRecord {
    const current = this.get(stepId);
    this.patchStmt.run({
      stepId,
      status: input.status ?? current.status,
      providerId: input.providerId !== undefined ? input.providerId : (current.providerId ?? null),
      model: input.model !== undefined ? input.model : (current.model ?? null),
      label: input.label !== undefined ? input.label : (current.label ?? null),
      summary: input.summary !== undefined ? input.summary : (current.summary ?? null),
      output: input.output !== undefined ? input.output : (current.output ?? null),
      error: input.error !== undefined ? input.error : (current.error ?? null),
      failureGuidance: input.failureGuidance !== undefined ? input.failureGuidance : (current.failureGuidance ?? null),
      durableRunId: input.durableRunId !== undefined ? input.durableRunId : (current.durableRunId ?? null),
      childSessionId: input.childSessionId !== undefined ? input.childSessionId : (current.childSessionId ?? null),
      childTurnId: input.childTurnId !== undefined ? input.childTurnId : (current.childTurnId ?? null),
      citationsJson:
        input.citations !== undefined
          ? JSON.stringify(input.citations)
          : current.citations
            ? JSON.stringify(current.citations)
            : null,
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : (current.finishedAt ?? null),
      durationMs: input.durationMs !== undefined ? input.durationMs : (current.durationMs ?? null),
    });
    return this.get(stepId);
  }

  public listByRun(runId: string): ChatDelegationStepRecord[] {
    const rows = toChatDelegationStepRows(this.listByRunStmt.all({ runId }));
    return rows.map(mapRow);
  }

  public listParentsByChildSessionIds(
    sessionIds: string[],
    workspaceId?: string,
  ): Map<string, ChatSessionDelegationParentRecord> {
    const childSessionIds = [...new Set(sessionIds.map((item) => item.trim()).filter(Boolean))];
    if (childSessionIds.length === 0) {
      return new Map();
    }
    const placeholders = childSessionIds.map(() => "?").join(", ");
    const workspace = workspaceId?.trim();
    const rows = toChatDelegationParentRows(
      this.db
        .prepare(
          workspace
            ? `
            SELECT steps.*, runs.session_id AS parent_session_id
            FROM chat_delegation_steps steps
            INNER JOIN chat_delegation_runs runs ON runs.run_id = steps.run_id
            INNER JOIN chat_session_meta child_meta
              ON child_meta.session_id = steps.child_session_id
             AND child_meta.workspace_id = ?
            INNER JOIN chat_session_meta parent_meta
              ON parent_meta.session_id = runs.session_id
             AND parent_meta.workspace_id = child_meta.workspace_id
            WHERE steps.child_session_id IN (${placeholders})
            ORDER BY steps.started_at DESC, steps.step_index DESC, steps.step_id DESC
          `
            : `
            SELECT steps.*, runs.session_id AS parent_session_id
            FROM chat_delegation_steps steps
            INNER JOIN chat_delegation_runs runs ON runs.run_id = steps.run_id
            WHERE steps.child_session_id IN (${placeholders})
            ORDER BY steps.started_at DESC, steps.step_index DESC, steps.step_id DESC
          `,
        )
        .all(...(workspace ? [workspace, ...childSessionIds] : childSessionIds)),
    );
    const byChildSessionId = new Map<string, ChatSessionDelegationParentRecord>();
    for (const row of rows) {
      const childSessionId = row.child_session_id;
      if (!childSessionId || byChildSessionId.has(childSessionId)) {
        continue;
      }
      byChildSessionId.set(childSessionId, {
        parentSessionId: row.parent_session_id,
        runId: row.run_id,
        stepId: row.step_id,
        role: row.role,
        label: row.label ?? undefined,
        index: row.step_index,
      });
    }
    return byChildSessionId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChatDelegationStepRow(value: unknown): value is ChatDelegationStepRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.step_id === "string" &&
    typeof value.run_id === "string" &&
    typeof value.role === "string" &&
    (typeof value.label === "string" || value.label === null) &&
    typeof value.step_index === "number" &&
    typeof value.status === "string" &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.model === "string" || value.model === null) &&
    (typeof value.summary === "string" || value.summary === null) &&
    (typeof value.output === "string" || value.output === null) &&
    (typeof value.error === "string" || value.error === null) &&
    (typeof value.failure_guidance === "string" || value.failure_guidance === null) &&
    (typeof value.durable_run_id === "string" || value.durable_run_id === null) &&
    (typeof value.child_session_id === "string" || value.child_session_id === null) &&
    (typeof value.child_turn_id === "string" || value.child_turn_id === null) &&
    (typeof value.citations_json === "string" || value.citations_json === null) &&
    typeof value.started_at === "string" &&
    (typeof value.finished_at === "string" || value.finished_at === null) &&
    (typeof value.duration_ms === "number" || value.duration_ms === null)
  );
}

function toChatDelegationStepRow(value: unknown): ChatDelegationStepRow | undefined {
  return isChatDelegationStepRow(value) ? value : undefined;
}

function toChatDelegationStepRows(value: unknown): ChatDelegationStepRow[] {
  return Array.isArray(value) ? value.filter(isChatDelegationStepRow) : [];
}

function isChatDelegationParentRow(value: unknown): value is ChatDelegationParentRow {
  if (!isChatDelegationStepRow(value) || !isRecord(value)) {
    return false;
  }
  return typeof value.parent_session_id === "string";
}

function toChatDelegationParentRows(value: unknown): ChatDelegationParentRow[] {
  return Array.isArray(value) ? value.filter(isChatDelegationParentRow) : [];
}

function mapRow(row: ChatDelegationStepRow): ChatDelegationStepRecord {
  return {
    stepId: row.step_id,
    runId: row.run_id,
    role: row.role,
    label: row.label ?? undefined,
    status: row.status,
    index: row.step_index,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    summary: row.summary ?? undefined,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    failureGuidance: row.failure_guidance ?? undefined,
    durableRunId: row.durable_run_id ?? undefined,
    childSessionId: row.child_session_id ?? undefined,
    childTurnId: row.child_turn_id ?? undefined,
    citations: row.citations_json ? safeJsonParse<ChatCitationRecord[]>(row.citations_json, []) : undefined,
  };
}
