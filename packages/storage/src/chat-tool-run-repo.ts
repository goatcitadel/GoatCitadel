import type { DatabaseClient } from "./db.js";
import type { ChatToolRunRecord } from "@goatcitadel/contracts";
import {
  buildLegacyToolEffectEvidence,
  isToolEffectEvidenceRecord,
  NotFoundError,
  TOOL_EFFECT_CLASSIFICATION_VERSION,
  type ToolEffectDisposition,
  type ToolEffectEvidenceRecord,
  type ToolEffectOutcomeKind,
  type ToolEffectPotential,
} from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

const MAX_COMPLETE_TURN_READ = 100;

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

/** How often one tool was called, and when it was last started. */
export interface ChatToolCallCount {
  toolName: string;
  calls: number;
  lastCalledAt: string;
}

export class ChatToolRunRepository {
  private readonly getStmt;
  private readonly getForUpdateStmt;
  private readonly insertStmt;
  private readonly hasByTurnStmt;
  private readonly listByTurnStmt;
  private readonly readCompleteByTurnStmt;
  private readonly listBySessionStmt;
  private readonly findByApprovalStmt;
  private readonly countCallsByToolSinceStmt;
  private readonly listByTurnIdsStmtCache = new Map<number, ReturnType<DatabaseClient["prepare"]>>();
  private readonly patchStmt;
  private readonly compareAndSwapResultStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_tool_runs WHERE tool_run_id = ?");
    this.getForUpdateStmt =
      db.dialect === "postgres"
        ? db.prepare("SELECT * FROM chat_tool_runs WHERE tool_run_id = ? FOR UPDATE")
        : this.getStmt;
    // A call is a run that went out: executed or failed, and not served again from an earlier run. Blocked, waiting
    // and still-running rows never were calls. No index leads with started_at; the Gateway caches this read.
    const effectJson =
      db.dialect === "postgres"
        ? "gc_try_parse_jsonb(effect_evidence_json)"
        : "(CASE WHEN json_valid(effect_evidence_json) THEN effect_evidence_json END)";
    const effectValue = (key: string) =>
      db.dialect === "postgres" ? `(${effectJson} ->> '${key}')` : `json_extract(${effectJson}, '$.${key}')`;
    const emptyEffectRefs =
      db.dialect === "postgres"
        ? `(${effectJson} -> 'refs') = '[]'::jsonb`
        : `json_type(${effectJson}, '$.refs') = 'array' AND json_array_length(${effectJson}, '$.refs') = 0`;
    this.countCallsByToolSinceStmt = db.prepare(`
      SELECT tool_name, COUNT(*) AS calls, MAX(started_at) AS last_called_at
      FROM chat_tool_runs
      WHERE started_at >= @since
        AND status IN ('executed', 'failed')
        AND (reused IS NULL OR reused = 0)
        AND CASE WHEN status = 'failed' AND finished_at IS NOT NULL
          AND effect_potential IN ('none', 'unknown')
          AND effect_disposition = 'none' AND effect_outcome_kind = 'none'
          AND ${effectValue("version")} = @effectVersion AND ${effectValue("outcomeKind")} = 'none'
          AND (${emptyEffectRefs})
          AND (
            ${effectValue("reason")} = 'pre_dispatch_blocked'
            OR (approval_id IS NULL AND ${effectValue("reason")} = 'skipped_before_dispatch')
          )
        THEN 0 ELSE 1 END = 1
      GROUP BY tool_name
      ORDER BY tool_name ASC
    `);
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
    this.compareAndSwapResultStmt = db.prepare(`
      UPDATE chat_tool_runs
      SET result_json = @nextResultJson
      WHERE tool_run_id = @toolRunId
        AND result_json = @expectedResultJson
      RETURNING *
    `);
    this.hasByTurnStmt = db.prepare("SELECT 1 FROM chat_tool_runs WHERE turn_id = @turnId LIMIT 1");
    this.listByTurnStmt = db.prepare(`
      SELECT * FROM chat_tool_runs
      WHERE turn_id = @turnId
      ORDER BY started_at ASC
    `);
    this.readCompleteByTurnStmt = db.prepare(`
      SELECT * FROM chat_tool_runs WHERE turn_id = @turnId
      ORDER BY started_at ASC, tool_run_id ASC LIMIT @limit
    `);
    this.listBySessionStmt = db.prepare(`
      SELECT * FROM chat_tool_runs
      WHERE session_id = @sessionId
      ORDER BY started_at DESC
      LIMIT @limit
    `);
    this.findByApprovalStmt = db.prepare(`
      SELECT * FROM chat_tool_runs
      WHERE session_id = @sessionId AND approval_id = @approvalId
      ORDER BY started_at DESC
      LIMIT 1
    `);
  }

  public get(toolRunId: string): ChatToolRunRecord {
    return mapRow(this.readToolRunRow(toolRunId, this.getStmt.get(toolRunId)));
  }

  /** Locks the existing receipt inside a caller-owned transaction. */
  public getForUpdate(toolRunId: string): ChatToolRunRecord {
    return mapRow(this.readToolRunRow(toolRunId, this.getForUpdateStmt.get(toolRunId)));
  }

  private readToolRunRow(toolRunId: string, raw: unknown): ChatToolRunRow {
    const row = toChatToolRunRow(raw);
    if (!row) {
      throw new NotFoundError({ entity: "Chat tool run", id: toolRunId });
    }
    return row;
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
    return this.db.transaction("immediate", () => {
      const current = this.readToolRunRow(toolRunId, this.getForUpdateStmt.get(toolRunId));
      this.patchStmt.run({
        toolRunId,
        status: input.status ?? current.status,
        approvalId: input.approvalId !== undefined ? input.approvalId : current.approval_id,
        resultJson: input.result !== undefined ? JSON.stringify(input.result) : current.result_json,
        reused: input.reused === undefined ? current.reused : Number(input.reused),
        reusedFromToolRunId:
          input.reusedFromToolRunId !== undefined ? input.reusedFromToolRunId : current.reused_from_tool_run_id,
        reuseReason: input.reuseReason !== undefined ? input.reuseReason : current.reuse_reason,
        error: input.error !== undefined ? input.error : current.error,
        failureGuidance: input.failureGuidance !== undefined ? input.failureGuidance : current.failure_guidance,
        effectPotential: input.effectPotential !== undefined ? input.effectPotential : current.effect_potential,
        effectDisposition: input.effectDisposition !== undefined ? input.effectDisposition : current.effect_disposition,
        effectOutcomeKind:
          input.effectOutcomeKind !== undefined ? input.effectOutcomeKind : current.effect_outcome_kind,
        effectEvidenceJson:
          input.effectEvidence !== undefined ? JSON.stringify(input.effectEvidence) : current.effect_evidence_json,
        finishedAt: input.finishedAt !== undefined ? input.finishedAt : current.finished_at,
      });
      return this.get(toolRunId);
    });
  }

  /** Atomically replaces an exact persisted result; stale writers receive no authority. */
  public compareAndSwapResult(
    toolRunId: string,
    expectedResult: Record<string, unknown>,
    nextResult: Record<string, unknown>,
  ): ChatToolRunRecord | undefined {
    const row = this.compareAndSwapResultStmt.get({
      toolRunId,
      expectedResultJson: JSON.stringify(expectedResult),
      nextResultJson: JSON.stringify(nextResult),
    });
    return row === undefined ? undefined : mapRow(this.readToolRunRow(toolRunId, row));
  }

  /** Any persisted receipt, even if its current schema is unreadable. */
  public hasByTurn(turnId: string): boolean {
    return this.hasByTurnStmt.get({ turnId }) !== undefined;
  }

  public listByTurn(turnId: string): ChatToolRunRecord[] {
    const rows = toChatToolRunRows(this.listByTurnStmt.all({ turnId }));
    return rows.map(mapRow);
  }

  /** Reads one bounded snapshot. An unreadable row or overflow means the history is incomplete. */
  public readCompleteByTurn(turnId: string, limit: number): ChatToolRunRecord[] | undefined {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_COMPLETE_TURN_READ) return undefined;
    const raw = this.readCompleteByTurnStmt.all({ turnId, limit: limit + 1 });
    if (raw.length > limit) return undefined;
    const rows = toChatToolRunRows(raw);
    return rows.length === raw.length ? rows.map(mapRow) : undefined;
  }

  /** Uses the existing turn/started_at index; the ID breaks timestamp ties. */
  public listByTurnPage(
    turnId: string,
    after?: { startedAt: string; toolRunId: string },
    limit = 32,
  ): ChatToolRunRecord[] {
    return this.listByTurnPageWithCursor(turnId, after, limit).items;
  }

  public listByTurnPageWithCursor(
    turnId: string,
    after?: { startedAt: string; toolRunId: string },
    limit = 32,
  ): { items: ChatToolRunRecord[]; nextAfter?: { startedAt: string; toolRunId: string } } {
    const bounded = Number.isSafeInteger(limit) ? Math.max(1, Math.min(32, limit)) : 32;
    const textCursor =
      this.db.dialect === "sqlite" ? "AND typeof(started_at) = 'text' AND typeof(tool_run_id) = 'text'" : "";
    const rows = this.db
      .prepare(
        `
      SELECT * FROM chat_tool_runs WHERE turn_id = ?
        AND (started_at > ? OR (started_at = ? AND tool_run_id > ?))
        ${textCursor}
      ORDER BY started_at ASC, tool_run_id ASC LIMIT ?
    `,
      )
      .all(turnId, after?.startedAt ?? "", after?.startedAt ?? "", after?.toolRunId ?? "", bounded);
    const last = rows.at(-1);
    return {
      items: toChatToolRunRows(rows).map(mapRow),
      nextAfter:
        isRecord(last) && typeof last.started_at === "string" && typeof last.tool_run_id === "string"
          ? { startedAt: last.started_at, toolRunId: last.tool_run_id }
          : undefined,
    };
  }

  public listBySession(sessionId: string, limit = 200): ChatToolRunRecord[] {
    const rows = toChatToolRunRows(
      this.listBySessionStmt.all({
        sessionId,
        limit: Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 2000)) : 200,
      }),
    );
    return rows.map(mapRow);
  }

  /** Newest tool run of a session that owns this approval, regardless of how many runs the session has. */
  public findByApprovalId(sessionId: string, approvalId: string): ChatToolRunRecord | undefined {
    const rows = toChatToolRunRows(this.findByApprovalStmt.all({ sessionId, approvalId }));
    return rows.map(mapRow)[0];
  }

  /**
   * Calls started at or after `sinceIso`, per tool. Counts shrink when a chat is deleted, because its runs go with it.
   * PostgreSQL hands COUNT(*) back as a bigint string, so the count is converted here.
   */
  public countCallsByToolSince(sinceIso: string): ChatToolCallCount[] {
    const rows = this.countCallsByToolSinceStmt.all({
      since: sinceIso,
      effectVersion: TOOL_EFFECT_CLASSIFICATION_VERSION,
    });
    return (Array.isArray(rows) ? rows : []).flatMap((row: unknown) => {
      if (!isRecord(row) || typeof row.tool_name !== "string" || typeof row.last_called_at !== "string") {
        return [];
      }
      const calls = Number(row.calls);
      return Number.isSafeInteger(calls) && calls > 0
        ? [{ toolName: row.tool_name, calls, lastCalledAt: row.last_called_at }]
        : [];
    });
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

const toolRunStatuses = {
  started: true,
  executed: true,
  blocked: true,
  approval_required: true,
  failed: true,
} satisfies Record<ChatToolRunRecord["status"], true>;

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
    Object.hasOwn(toolRunStatuses, value.status) &&
    (typeof value.approval_id === "string" || value.approval_id === null) &&
    (typeof value.args_json === "string" || value.args_json === null) &&
    (typeof value.result_json === "string" || value.result_json === null) &&
    (value.reused === 0 || value.reused === 1 || value.reused === null) &&
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
  const notReused = row.reused === null || row.reused === 0;
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
      // Approval replay can fail current policy before dispatch. The runtime
      // owner emits this evidence only after reading its durable boundary event.
      return (
        (row.status === "blocked" || row.status === "failed") &&
        settled &&
        notReused &&
        (noApproval || terminalApprovalLinked)
      );
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
        (noApproval || terminalApprovalLinked) &&
        (startedOpen || ((row.status === "executed" || row.status === "failed") && settled))
      );
    default:
      return false;
  }
}
