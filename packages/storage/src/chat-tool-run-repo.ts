import type { DatabaseClient } from "./db.js";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  buildLegacyToolEffectEvidence,
  isToolEffectEvidenceRecord,
  NotFoundError,
  type ToolEffectDisposition,
  type ToolEffectEvidenceRecord,
  type ToolEffectOutcomeKind,
  type ToolEffectPotential,
} from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface ChatToolRunRow {
  tool_run_id: string;
  turn_id: string;
  session_id: string;
  tool_name: string;
  status: ChatToolRunRecord["status"];
  approval_id: string | null;
  args_json: string | null;
  result_json: string | null;
  reused: number | null;
  reused_from_tool_run_id: string | null;
  reuse_reason: string | null;
  error: string | null;
  failure_guidance: string | null;
  effect_potential: string | null;
  effect_disposition: string | null;
  effect_outcome_kind: string | null;
  effect_evidence_json: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ChatToolRunCreateInput {
  toolRunId: string;
  turnId: string;
  sessionId: string;
  toolName: string;
  status?: ChatToolRunRecord["status"];
  approvalId?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  reused?: boolean;
  reusedFromToolRunId?: string;
  reuseReason?: string;
  error?: string;
  failureGuidance?: string;
  effectPotential?: ToolEffectPotential;
  effectDisposition?: ToolEffectDisposition | null;
  effectOutcomeKind?: ToolEffectOutcomeKind;
  effectEvidence?: ToolEffectEvidenceRecord;
  startedAt?: string;
  finishedAt?: string;
}

export interface ChatToolRunPatchInput {
  status?: ChatToolRunRecord["status"];
  approvalId?: string;
  result?: Record<string, unknown>;
  reused?: boolean;
  reusedFromToolRunId?: string;
  reuseReason?: string;
  error?: string;
  failureGuidance?: string;
  effectPotential?: ToolEffectPotential;
  effectDisposition?: ToolEffectDisposition | null;
  effectOutcomeKind?: ToolEffectOutcomeKind;
  effectEvidence?: ToolEffectEvidenceRecord;
  finishedAt?: string;
}

export class ChatToolRunRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly listByTurnStmt;
  private readonly listBySessionStmt;
  private readonly listByTurnIdsStmtCache = new Map<number, ReturnType<DatabaseClient["prepare"]>>();
  private readonly patchStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_tool_runs WHERE tool_run_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO chat_tool_runs (
        tool_run_id, turn_id, session_id, tool_name, status, approval_id, args_json,
        result_json, reused, reused_from_tool_run_id, reuse_reason, error, failure_guidance,
        effect_potential, effect_disposition, effect_outcome_kind, effect_evidence_json,
        started_at, finished_at
      ) VALUES (
        @toolRunId, @turnId, @sessionId, @toolName, @status, @approvalId, @argsJson,
        @resultJson, @reused, @reusedFromToolRunId, @reuseReason, @error, @failureGuidance,
        @effectPotential, @effectDisposition, @effectOutcomeKind, @effectEvidenceJson,
        @startedAt, @finishedAt
      )
    `);
    this.patchStmt = db.prepare(`
      UPDATE chat_tool_runs
      SET
        status = @status,
        approval_id = @approvalId,
        result_json = @resultJson,
        reused = @reused,
        reused_from_tool_run_id = @reusedFromToolRunId,
        reuse_reason = @reuseReason,
        error = @error,
        failure_guidance = @failureGuidance,
        effect_potential = @effectPotential,
        effect_disposition = @effectDisposition,
        effect_outcome_kind = @effectOutcomeKind,
        effect_evidence_json = @effectEvidenceJson,
        finished_at = @finishedAt
      WHERE tool_run_id = @toolRunId
    `);
    this.listByTurnStmt = db.prepare(`
      SELECT * FROM chat_tool_runs
      WHERE turn_id = @turnId
      ORDER BY started_at ASC
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT * FROM chat_tool_runs
      WHERE session_id = @sessionId
      ORDER BY started_at DESC
      LIMIT @limit
    `);
  }

  public get(toolRunId: string): ChatToolRunRecord {
    const row = toChatToolRunRow(this.getStmt.get(toolRunId));
    if (!row) {
      throw new NotFoundError({ entity: "Chat tool run", id: toolRunId });
    }
    return mapRow(row);
  }

  public create(input: ChatToolRunCreateInput): ChatToolRunRecord {
    this.insertStmt.run({
      toolRunId: input.toolRunId,
      turnId: input.turnId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      status: input.status ?? "started",
      approvalId: input.approvalId ?? null,
      argsJson: input.args ? JSON.stringify(input.args) : null,
      resultJson: input.result ? JSON.stringify(input.result) : null,
      reused: input.reused === undefined ? null : input.reused ? 1 : 0,
      reusedFromToolRunId: input.reusedFromToolRunId ?? null,
      reuseReason: input.reuseReason ?? null,
      error: input.error ?? null,
      failureGuidance: input.failureGuidance ?? null,
      effectPotential: input.effectPotential ?? null,
      effectDisposition: input.effectDisposition ?? null,
      effectOutcomeKind: input.effectOutcomeKind ?? null,
      effectEvidenceJson: input.effectEvidence ? JSON.stringify(input.effectEvidence) : null,
      startedAt: input.startedAt ?? new Date().toISOString(),
      finishedAt: input.finishedAt ?? null,
    });
    return this.get(input.toolRunId);
  }

  public patch(toolRunId: string, input: ChatToolRunPatchInput): ChatToolRunRecord {
    const current = this.get(toolRunId);
    this.patchStmt.run({
      toolRunId,
      status: input.status ?? current.status,
      approvalId: input.approvalId !== undefined ? input.approvalId : (current.approvalId ?? null),
      resultJson:
        input.result !== undefined
          ? JSON.stringify(input.result)
          : current.result
            ? JSON.stringify(current.result)
            : null,
      reused:
        input.reused !== undefined
          ? input.reused
            ? 1
            : 0
          : current.reused === undefined
            ? null
            : current.reused
              ? 1
              : 0,
      reusedFromToolRunId:
        input.reusedFromToolRunId !== undefined ? input.reusedFromToolRunId : (current.reusedFromToolRunId ?? null),
      reuseReason: input.reuseReason !== undefined ? input.reuseReason : (current.reuseReason ?? null),
      error: input.error !== undefined ? input.error : (current.error ?? null),
      failureGuidance: input.failureGuidance !== undefined ? input.failureGuidance : (current.failureGuidance ?? null),
      effectPotential: input.effectPotential !== undefined ? input.effectPotential : (current.effectPotential ?? null),
      effectDisposition:
        input.effectDisposition !== undefined ? input.effectDisposition : (current.effectDisposition ?? null),
      effectOutcomeKind:
        input.effectOutcomeKind !== undefined ? input.effectOutcomeKind : (current.effectOutcomeKind ?? null),
      effectEvidenceJson:
        input.effectEvidence !== undefined
          ? JSON.stringify(input.effectEvidence)
          : current.effectEvidence
            ? JSON.stringify(current.effectEvidence)
            : null,
      finishedAt: input.finishedAt !== undefined ? input.finishedAt : (current.finishedAt ?? null),
    });
    return this.get(toolRunId);
  }

  public listByTurn(turnId: string): ChatToolRunRecord[] {
    const rows = toChatToolRunRows(this.listByTurnStmt.all({ turnId }));
    return rows.map(mapRow);
  }

  public listBySession(sessionId: string, limit = 200): ChatToolRunRecord[] {
    const rows = toChatToolRunRows(
      this.listBySessionStmt.all({
        sessionId,
        limit: Math.max(1, Math.min(limit, 2000)),
      }),
    );
    return rows.map(mapRow);
  }

  public listByTurnIds(turnIds: string[]): Map<string, ChatToolRunRecord[]> {
    const uniqueTurnIds = [...new Set(turnIds.map((item) => item.trim()).filter(Boolean))];
    const grouped = new Map<string, ChatToolRunRecord[]>();
    if (uniqueTurnIds.length === 0) {
      return grouped;
    }

    for (let index = 0; index < uniqueTurnIds.length; index += 400) {
      const batch = uniqueTurnIds.slice(index, index + 400);
      const stmt = this.getListByTurnIdsStmt(batch.length);
      const rows = toChatToolRunRows(stmt.all(...batch));
      for (const row of rows) {
        const record = mapRow(row);
        const current = grouped.get(record.turnId) ?? [];
        current.push(record);
        grouped.set(record.turnId, current);
      }
    }

    for (const records of grouped.values()) {
      records.sort((left, right) => {
        const leftStarted = Date.parse(left.startedAt) || 0;
        const rightStarted = Date.parse(right.startedAt) || 0;
        if (leftStarted !== rightStarted) {
          return leftStarted - rightStarted;
        }
        return left.toolRunId.localeCompare(right.toolRunId);
      });
    }

    return grouped;
  }

  private getListByTurnIdsStmt(size: number) {
    const cached = this.listByTurnIdsStmtCache.get(size);
    if (cached) {
      return cached;
    }
    const placeholders = new Array(size).fill("?").join(", ");
    const stmt = this.db.prepare(`
      SELECT *
      FROM chat_tool_runs
      WHERE turn_id IN (${placeholders})
      ORDER BY started_at ASC, tool_run_id ASC
    `);
    this.listByTurnIdsStmtCache.set(size, stmt);
    return stmt;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatToolRunRow(value: unknown): value is ChatToolRunRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.tool_run_id === "string" &&
    typeof value.turn_id === "string" &&
    typeof value.session_id === "string" &&
    typeof value.tool_name === "string" &&
    typeof value.status === "string" &&
    (typeof value.approval_id === "string" || value.approval_id === null) &&
    (typeof value.args_json === "string" || value.args_json === null) &&
    (typeof value.result_json === "string" || value.result_json === null) &&
    (typeof value.reused === "number" || value.reused === null) &&
    (typeof value.reused_from_tool_run_id === "string" || value.reused_from_tool_run_id === null) &&
    (typeof value.reuse_reason === "string" || value.reuse_reason === null) &&
    (typeof value.error === "string" || value.error === null) &&
    (typeof value.failure_guidance === "string" || value.failure_guidance === null) &&
    (typeof value.effect_potential === "string" || value.effect_potential === null) &&
    (typeof value.effect_disposition === "string" || value.effect_disposition === null) &&
    (typeof value.effect_outcome_kind === "string" || value.effect_outcome_kind === null) &&
    (typeof value.effect_evidence_json === "string" || value.effect_evidence_json === null) &&
    typeof value.started_at === "string" &&
    (typeof value.finished_at === "string" || value.finished_at === null)
  );
}

function toChatToolRunRow(value: unknown): ChatToolRunRow | undefined {
  return isChatToolRunRow(value) ? value : undefined;
}

function toChatToolRunRows(value: unknown): ChatToolRunRow[] {
  return Array.isArray(value) ? value.filter(isChatToolRunRow) : [];
}

function parseOptionalRecord(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = safeJsonParse<unknown>(raw, undefined);
  return isRecord(parsed) ? parsed : undefined;
}

function mapRow(row: ChatToolRunRow): ChatToolRunRecord {
  const legacy = buildLegacyToolEffectEvidence(row.status);
  const rawPotential: ToolEffectPotential | undefined =
    row.effect_potential === "none" || row.effect_potential === "unknown" ? row.effect_potential : undefined;
  const parsedEvidence = row.effect_evidence_json
    ? safeJsonParse<unknown>(row.effect_evidence_json, undefined)
    : undefined;
  const rawEvidence = isToolEffectEvidenceRecord(parsedEvidence) ? parsedEvidence : undefined;
  const rawOutcomeKind: ToolEffectOutcomeKind | undefined =
    row.effect_outcome_kind === "none" ||
    row.effect_outcome_kind === "uncertain" ||
    row.effect_outcome_kind === "concrete"
      ? row.effect_outcome_kind
      : undefined;
  const rawDisposition: ToolEffectDisposition | undefined =
    row.effect_disposition === "none" || row.effect_disposition === "unknown" ? row.effect_disposition : undefined;
  const coherent = isCoherentToolEffectProjection({
    row,
    potential: rawPotential,
    disposition: rawDisposition,
    outcomeKind: rawOutcomeKind,
    evidence: rawEvidence,
  });
  const effectPotential: ToolEffectPotential = coherent ? (rawPotential as ToolEffectPotential) : legacy.potential;
  const effectEvidence = coherent ? (rawEvidence as ToolEffectEvidenceRecord) : legacy.evidence;
  const effectOutcomeKind: ToolEffectOutcomeKind = coherent
    ? (rawOutcomeKind as ToolEffectOutcomeKind)
    : legacy.outcomeKind;
  const effectDisposition: ToolEffectDisposition | undefined = coherent
    ? rawOutcomeKind === "concrete"
      ? undefined
      : rawDisposition
    : legacy.disposition;
  return {
    toolRunId: row.tool_run_id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    status: row.status,
    approvalId: row.approval_id ?? undefined,
    args: parseOptionalRecord(row.args_json),
    result: parseOptionalRecord(row.result_json),
    reused: row.reused === null ? undefined : row.reused !== 0,
    reusedFromToolRunId: row.reused_from_tool_run_id ?? undefined,
    reuseReason: row.reuse_reason ?? undefined,
    error: row.error ?? undefined,
    failureGuidance: row.failure_guidance ?? undefined,
    effectPotential,
    effectDisposition,
    effectOutcomeKind,
    effectEvidence,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function isCoherentToolEffectProjection(input: {
  row: ChatToolRunRow;
  potential?: ToolEffectPotential;
  disposition?: ToolEffectDisposition;
  outcomeKind?: ToolEffectOutcomeKind;
  evidence?: ToolEffectEvidenceRecord;
}): boolean {
  const { row, potential, disposition, outcomeKind, evidence } = input;
  if (!potential || !outcomeKind || !evidence || outcomeKind !== evidence.outcomeKind) return false;
  const startedOpen = row.status === "started" && row.finished_at === null;
  const settled = row.status !== "started" && row.finished_at !== null;
  const notReused = row.reused !== 1;
  const noApproval = row.approval_id === null;
  const terminalApprovalLinked = !noApproval && settled && (row.status === "executed" || row.status === "failed");

  if (outcomeKind === "concrete") {
    return (
      potential === "unknown" &&
      row.effect_disposition === null &&
      notReused &&
      (noApproval || terminalApprovalLinked) &&
      ((row.status === "executed" && settled) || (row.status === "failed" && settled) || startedOpen)
    );
  }
  if (outcomeKind === "uncertain") {
    if (evidence.reason === "approval_wait_after_auxiliary_dispatch") {
      return (
        potential === "unknown" &&
        disposition === "unknown" &&
        notReused &&
        row.status === "approval_required" &&
        settled &&
        Boolean(row.approval_id)
      );
    }
    if (potential !== "unknown" || disposition !== "unknown" || !notReused || (!noApproval && !terminalApprovalLinked))
      return false;
    if (evidence.reason === "dispatch_may_have_occurred") {
      return startedOpen || (row.status === "failed" && settled);
    }
    if (evidence.reason === "interrupted_after_possible_dispatch") {
      return row.status === "failed" && settled;
    }
    return evidence.reason === "completed_without_canonical_effect_receipt" && row.status === "executed" && settled;
  }
  if (disposition !== "none") return false;
  switch (evidence.reason) {
    case "planned_before_dispatch":
      return startedOpen && notReused && noApproval;
    case "pre_dispatch_blocked":
      return (row.status === "blocked" || row.status === "failed") && settled && notReused && noApproval;
    case "approval_wait_before_dispatch":
      return row.status === "approval_required" && settled && notReused && Boolean(row.approval_id);
    case "skipped_before_dispatch":
      return (row.status === "blocked" || row.status === "failed") && settled && notReused && noApproval;
    case "reused_without_dispatch":
      return row.status === "executed" && settled && row.reused === 1 && noApproval;
    case "trusted_safe_read":
      return (
        potential === "none" &&
        notReused &&
        noApproval &&
        (startedOpen || ((row.status === "executed" || row.status === "failed") && settled))
      );
    default:
      return false;
  }
}
