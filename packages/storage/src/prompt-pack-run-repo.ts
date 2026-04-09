import type { DatabaseSync } from "node:sqlite";
import type {
  ChatCitationRecord,
  ChatTurnTraceRecord,
  PromptPackRunIntegrityRecord,
  PromptPackRunRecord,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";

interface PromptPackRunRow {
  run_id: string;
  pack_id: string;
  test_id: string;
  session_id: string | null;
  status: PromptPackRunRecord["status"];
  provider_id: string | null;
  model: string | null;
  mode: PromptPackRunRecord["mode"] | null;
  tool_tier: PromptPackRunRecord["toolTier"] | null;
  tool_autonomy: PromptPackRunRecord["toolAutonomy"] | null;
  web_mode: PromptPackRunRecord["webMode"] | null;
  memory_mode: PromptPackRunRecord["memoryMode"] | null;
  thinking_level: PromptPackRunRecord["thinkingLevel"] | null;
  response_text: string | null;
  trace_json: string | null;
  citations_json: string | null;
  integrity_json: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export class PromptPackRunRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly patchStmt;
  private readonly listByPackStmt;
  private readonly listByTestStmt;
  private readonly deleteByPackStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.getStmt = db.prepare("SELECT * FROM prompt_pack_runs WHERE run_id = ?");
    this.insertStmt = db.prepare(`
      INSERT INTO prompt_pack_runs (
        run_id, pack_id, test_id, session_id, status, provider_id, model,
        mode, tool_tier, tool_autonomy, web_mode, memory_mode, thinking_level,
        response_text, trace_json, citations_json, integrity_json, error, started_at, finished_at
      ) VALUES (
        @runId, @packId, @testId, @sessionId, @status, @providerId, @model,
        @mode, @toolTier, @toolAutonomy, @webMode, @memoryMode, @thinkingLevel,
        @responseText, @traceJson, @citationsJson, @integrityJson, @error, @startedAt, @finishedAt
      )
    `);
    this.patchStmt = db.prepare(`
      UPDATE prompt_pack_runs
      SET
        status = COALESCE(@status, status),
        mode = CASE WHEN @hasMode = 1 THEN @mode ELSE mode END,
        tool_tier = CASE WHEN @hasToolTier = 1 THEN @toolTier ELSE tool_tier END,
        tool_autonomy = CASE WHEN @hasToolAutonomy = 1 THEN @toolAutonomy ELSE tool_autonomy END,
        web_mode = CASE WHEN @hasWebMode = 1 THEN @webMode ELSE web_mode END,
        memory_mode = CASE WHEN @hasMemoryMode = 1 THEN @memoryMode ELSE memory_mode END,
        thinking_level = CASE WHEN @hasThinkingLevel = 1 THEN @thinkingLevel ELSE thinking_level END,
        response_text = CASE WHEN @hasResponseText = 1 THEN @responseText ELSE response_text END,
        trace_json = CASE WHEN @hasTrace = 1 THEN @traceJson ELSE trace_json END,
        citations_json = CASE WHEN @hasCitations = 1 THEN @citationsJson ELSE citations_json END,
        integrity_json = CASE WHEN @hasIntegrity = 1 THEN @integrityJson ELSE integrity_json END,
        error = CASE WHEN @hasError = 1 THEN @error ELSE error END,
        finished_at = CASE WHEN @hasFinishedAt = 1 THEN @finishedAt ELSE finished_at END
      WHERE run_id = @runId
    `);
    this.listByPackStmt = db.prepare(`
      SELECT * FROM prompt_pack_runs
      WHERE pack_id = @packId
      ORDER BY started_at DESC
      LIMIT @limit
    `);
    this.listByTestStmt = db.prepare(`
      SELECT * FROM prompt_pack_runs
      WHERE test_id = @testId
      ORDER BY started_at DESC
      LIMIT @limit
    `);
    this.deleteByPackStmt = db.prepare("DELETE FROM prompt_pack_runs WHERE pack_id = ?");
  }

  public get(runId: string): PromptPackRunRecord {
    const row = toPromptPackRunRow(this.getStmt.get(runId));
    if (!row) {
      throw new NotFoundError({ entity: "Prompt pack run", id: runId });
    }
    return mapRow(row);
  }

  public create(input: {
    runId: string;
    packId: string;
    testId: string;
    sessionId?: string;
    status?: PromptPackRunRecord["status"];
    providerId?: string;
    model?: string;
    mode?: PromptPackRunRecord["mode"];
    toolTier?: PromptPackRunRecord["toolTier"];
    toolAutonomy?: PromptPackRunRecord["toolAutonomy"];
    webMode?: PromptPackRunRecord["webMode"];
    memoryMode?: PromptPackRunRecord["memoryMode"];
    thinkingLevel?: PromptPackRunRecord["thinkingLevel"];
    responseText?: string;
    trace?: ChatTurnTraceRecord;
    citations?: ChatCitationRecord[];
    integrity?: PromptPackRunIntegrityRecord;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
  }): PromptPackRunRecord {
    this.insertStmt.run({
      runId: input.runId,
      packId: input.packId,
      testId: input.testId,
      sessionId: input.sessionId ?? null,
      status: input.status ?? "queued",
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      mode: input.mode ?? null,
      toolTier: input.toolTier ?? null,
      toolAutonomy: input.toolAutonomy ?? null,
      webMode: input.webMode ?? null,
      memoryMode: input.memoryMode ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      responseText: input.responseText ?? null,
      traceJson: input.trace ? JSON.stringify(input.trace) : null,
      citationsJson: input.citations ? JSON.stringify(input.citations) : null,
      integrityJson: input.integrity ? JSON.stringify(input.integrity) : null,
      error: input.error ?? null,
      startedAt: input.startedAt ?? new Date().toISOString(),
      finishedAt: input.finishedAt ?? null,
    });
    return this.get(input.runId);
  }

  public patch(
    runId: string,
    input: {
      status?: PromptPackRunRecord["status"];
      mode?: PromptPackRunRecord["mode"];
      toolTier?: PromptPackRunRecord["toolTier"];
      toolAutonomy?: PromptPackRunRecord["toolAutonomy"];
      webMode?: PromptPackRunRecord["webMode"];
      memoryMode?: PromptPackRunRecord["memoryMode"];
      thinkingLevel?: PromptPackRunRecord["thinkingLevel"];
      responseText?: string;
      trace?: ChatTurnTraceRecord;
      citations?: ChatCitationRecord[];
      integrity?: PromptPackRunIntegrityRecord;
      error?: string;
      finishedAt?: string;
    },
  ): PromptPackRunRecord {
    const result = this.patchStmt.run({
      runId,
      status: input.status ?? null,
      hasMode: input.mode !== undefined ? 1 : 0,
      mode: input.mode ?? null,
      hasToolTier: input.toolTier !== undefined ? 1 : 0,
      toolTier: input.toolTier ?? null,
      hasToolAutonomy: input.toolAutonomy !== undefined ? 1 : 0,
      toolAutonomy: input.toolAutonomy ?? null,
      hasWebMode: input.webMode !== undefined ? 1 : 0,
      webMode: input.webMode ?? null,
      hasMemoryMode: input.memoryMode !== undefined ? 1 : 0,
      memoryMode: input.memoryMode ?? null,
      hasThinkingLevel: input.thinkingLevel !== undefined ? 1 : 0,
      thinkingLevel: input.thinkingLevel ?? null,
      hasResponseText: input.responseText !== undefined ? 1 : 0,
      responseText: input.responseText ?? null,
      hasTrace: input.trace !== undefined ? 1 : 0,
      traceJson: input.trace !== undefined ? JSON.stringify(input.trace) : null,
      hasCitations: input.citations !== undefined ? 1 : 0,
      citationsJson: input.citations !== undefined ? JSON.stringify(input.citations) : null,
      hasIntegrity: input.integrity !== undefined ? 1 : 0,
      integrityJson: input.integrity !== undefined ? JSON.stringify(input.integrity) : null,
      hasError: input.error !== undefined ? 1 : 0,
      error: input.error ?? null,
      hasFinishedAt: input.finishedAt !== undefined ? 1 : 0,
      finishedAt: input.finishedAt ?? null,
    });
    if (Number(result.changes ?? 0) < 1) {
      throw new NotFoundError({ entity: "Prompt pack run", id: runId });
    }
    return this.get(runId);
  }

  public listByPack(packId: string, limit = 500): PromptPackRunRecord[] {
    const rows = toPromptPackRunRows(
      this.listByPackStmt.all({
        packId,
        limit: Math.max(1, Math.min(limit, 5000)),
      }),
    );
    return rows.map(mapRow);
  }

  public listByTest(testId: string, limit = 100): PromptPackRunRecord[] {
    const rows = toPromptPackRunRows(
      this.listByTestStmt.all({
        testId,
        limit: Math.max(1, Math.min(limit, 5000)),
      }),
    );
    return rows.map(mapRow);
  }

  public deleteByPack(packId: string): number {
    const result = this.deleteByPackStmt.run(packId);
    return Number(result.changes ?? 0);
  }
}

function mapRow(row: PromptPackRunRow): PromptPackRunRecord {
  return {
    runId: row.run_id,
    packId: row.pack_id,
    testId: row.test_id,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    providerId: row.provider_id ?? undefined,
    model: row.model ?? undefined,
    mode: row.mode ?? undefined,
    toolTier: row.tool_tier ?? undefined,
    toolAutonomy: row.tool_autonomy ?? undefined,
    webMode: row.web_mode ?? undefined,
    memoryMode: row.memory_mode ?? undefined,
    thinkingLevel: row.thinking_level ?? undefined,
    responseText: row.response_text ?? undefined,
    trace: row.trace_json ? safeJsonParse<ChatTurnTraceRecord | undefined>(row.trace_json, undefined) : undefined,
    citations: row.citations_json
      ? safeJsonParse<ChatCitationRecord[] | undefined>(row.citations_json, undefined)
      : undefined,
    integrity: row.integrity_json
      ? safeJsonParse<PromptPackRunIntegrityRecord | undefined>(row.integrity_json, undefined)
      : undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toPromptPackRunRow(value: unknown): PromptPackRunRow | undefined {
  return isPromptPackRunRow(value) ? value : undefined;
}

function toPromptPackRunRows(value: unknown): PromptPackRunRow[] {
  return Array.isArray(value) ? value.filter(isPromptPackRunRow) : [];
}

function isPromptPackRunRow(value: unknown): value is PromptPackRunRow {
  return (
    isRecord(value) &&
    typeof value.run_id === "string" &&
    typeof value.pack_id === "string" &&
    typeof value.test_id === "string" &&
    (typeof value.session_id === "string" || value.session_id === null) &&
    typeof value.status === "string" &&
    (typeof value.provider_id === "string" || value.provider_id === null) &&
    (typeof value.model === "string" || value.model === null) &&
    (typeof value.mode === "string" || value.mode === null) &&
    (typeof value.tool_tier === "string" || value.tool_tier === null) &&
    (typeof value.tool_autonomy === "string" || value.tool_autonomy === null) &&
    (typeof value.web_mode === "string" || value.web_mode === null) &&
    (typeof value.memory_mode === "string" || value.memory_mode === null) &&
    (typeof value.thinking_level === "string" || value.thinking_level === null) &&
    (typeof value.response_text === "string" || value.response_text === null) &&
    (typeof value.trace_json === "string" || value.trace_json === null) &&
    (typeof value.citations_json === "string" || value.citations_json === null) &&
    (typeof value.integrity_json === "string" || value.integrity_json === null) &&
    (typeof value.error === "string" || value.error === null) &&
    typeof value.started_at === "string" &&
    (typeof value.finished_at === "string" || value.finished_at === null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
