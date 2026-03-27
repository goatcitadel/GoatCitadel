import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  HookDecision,
  HookDeliveryStatus,
  HookMode,
  HookPatchSummary,
  HookRunRecord,
  HookTrigger,
} from "@goatcitadel/contracts";
import { safeJsonParse } from "./safe-json.js";

interface HookRunRow {
  run_id: string;
  hook_id: string;
  workspace_id: string;
  trigger: HookTrigger;
  entity_type: string;
  entity_id: string;
  mode: HookMode;
  status: HookDeliveryStatus;
  idempotency_key: string;
  attempt_count: number;
  durable_run_id: string | null;
  decision_json: string | null;
  patch_summary_json: string | null;
  error_text: string | null;
  latency_ms: number | null;
  request_payload_json: string | null;
  response_payload_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export class HookRunRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly findByIdempotencyStmt;
  private readonly listByWorkspaceStmt;
  private readonly updateAttemptStmt;
  private readonly updateOutcomeStmt;
  private readonly attachDurableStmt;

  public constructor(private readonly db: DatabaseSync) {
    this.insertStmt = db.prepare(`
      INSERT INTO hook_runs (
        run_id,
        hook_id,
        workspace_id,
        trigger,
        entity_type,
        entity_id,
        mode,
        status,
        idempotency_key,
        attempt_count,
        durable_run_id,
        decision_json,
        patch_summary_json,
        error_text,
        latency_ms,
        request_payload_json,
        response_payload_json,
        created_at,
        updated_at,
        completed_at
      ) VALUES (
        @runId,
        @hookId,
        @workspaceId,
        @trigger,
        @entityType,
        @entityId,
        @mode,
        @status,
        @idempotencyKey,
        @attemptCount,
        @durableRunId,
        @decisionJson,
        @patchSummaryJson,
        @errorText,
        @latencyMs,
        @requestPayloadJson,
        @responsePayloadJson,
        @createdAt,
        @updatedAt,
        @completedAt
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM hook_runs WHERE run_id = ?");
    this.findByIdempotencyStmt = db.prepare(`
      SELECT *
      FROM hook_runs
      WHERE hook_id = @hookId
        AND idempotency_key = @idempotencyKey
      LIMIT 1
    `);
    this.listByWorkspaceStmt = db.prepare(`
      SELECT *
      FROM hook_runs
      WHERE workspace_id = @workspaceId
      ORDER BY created_at DESC, run_id DESC
      LIMIT @limit
    `);
    this.updateAttemptStmt = db.prepare(`
      UPDATE hook_runs
      SET
        status = @status,
        attempt_count = @attemptCount,
        error_text = @errorText,
        request_payload_json = @requestPayloadJson,
        updated_at = @updatedAt
      WHERE run_id = @runId
    `);
    this.updateOutcomeStmt = db.prepare(`
      UPDATE hook_runs
      SET
        status = @status,
        decision_json = @decisionJson,
        patch_summary_json = @patchSummaryJson,
        error_text = @errorText,
        latency_ms = @latencyMs,
        response_payload_json = @responsePayloadJson,
        updated_at = @updatedAt,
        completed_at = @completedAt
      WHERE run_id = @runId
    `);
    this.attachDurableStmt = db.prepare(`
      UPDATE hook_runs
      SET
        durable_run_id = @durableRunId,
        updated_at = @updatedAt
      WHERE run_id = @runId
    `);
  }

  public create(input: Omit<HookRunRecord, "runId" | "createdAt" | "updatedAt">, now = new Date().toISOString()): HookRunRecord {
    const runId = `hookrun_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    this.insertStmt.run({
      runId,
      hookId: input.hookId,
      workspaceId: input.workspaceId,
      trigger: input.trigger,
      entityType: input.entityType,
      entityId: input.entityId,
      mode: input.mode,
      status: input.status,
      idempotencyKey: input.idempotencyKey,
      attemptCount: input.attemptCount,
      durableRunId: input.durableRunId ?? null,
      decisionJson: serializeJson(input.decision),
      patchSummaryJson: serializeJson(input.patchSummary),
      errorText: input.errorText ?? null,
      latencyMs: input.latencyMs ?? null,
      requestPayloadJson: serializeJson(input.requestPayload),
      responsePayloadJson: serializeJson(input.responsePayload),
      createdAt: now,
      updatedAt: now,
      completedAt: input.completedAt ?? null,
    });
    return this.get(runId);
  }

  public get(runId: string): HookRunRecord {
    const row = this.getStmt.get(runId) as HookRunRow | undefined;
    if (!row) {
      throw new Error(`Unknown hook run ${runId}`);
    }
    return mapHookRunRow(row);
  }

  public findByIdempotency(hookId: string, idempotencyKey: string): HookRunRecord | undefined {
    const row = this.findByIdempotencyStmt.get({ hookId, idempotencyKey }) as HookRunRow | undefined;
    return row ? mapHookRunRow(row) : undefined;
  }

  public listByWorkspace(workspaceId: string, limit = 200): HookRunRecord[] {
    const rows = this.listByWorkspaceStmt.all({
      workspaceId,
      limit: Math.max(1, Math.min(1_000, Math.floor(limit))),
    }) as unknown as HookRunRow[];
    return rows.map(mapHookRunRow);
  }

  public markAttempt(runId: string, input: {
    status: HookDeliveryStatus;
    attemptCount: number;
    errorText?: string;
    requestPayload?: Record<string, unknown>;
  }, now = new Date().toISOString()): HookRunRecord {
    this.updateAttemptStmt.run({
      runId,
      status: input.status,
      attemptCount: input.attemptCount,
      errorText: input.errorText ?? null,
      requestPayloadJson: serializeJson(input.requestPayload),
      updatedAt: now,
    });
    return this.get(runId);
  }

  public markOutcome(runId: string, input: {
    status: HookDeliveryStatus;
    decision?: HookDecision;
    patchSummary?: HookPatchSummary;
    errorText?: string;
    latencyMs?: number;
    responsePayload?: Record<string, unknown>;
    completedAt?: string;
  }, now = new Date().toISOString()): HookRunRecord {
    this.updateOutcomeStmt.run({
      runId,
      status: input.status,
      decisionJson: serializeJson(input.decision),
      patchSummaryJson: serializeJson(input.patchSummary),
      errorText: input.errorText ?? null,
      latencyMs: input.latencyMs ?? null,
      responsePayloadJson: serializeJson(input.responsePayload),
      updatedAt: now,
      completedAt: input.completedAt ?? now,
    });
    return this.get(runId);
  }

  public attachDurableRun(runId: string, durableRunId: string, now = new Date().toISOString()): HookRunRecord {
    this.attachDurableStmt.run({
      runId,
      durableRunId,
      updatedAt: now,
    });
    return this.get(runId);
  }
}

function mapHookRunRow(row: HookRunRow): HookRunRecord {
  return {
    runId: row.run_id,
    hookId: row.hook_id,
    workspaceId: row.workspace_id,
    trigger: row.trigger,
    entityType: row.entity_type,
    entityId: row.entity_id,
    mode: row.mode,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    attemptCount: row.attempt_count,
    durableRunId: row.durable_run_id ?? undefined,
    decision: safeJsonParse<HookDecision | undefined>(row.decision_json ?? "", undefined),
    patchSummary: safeJsonParse<HookPatchSummary | undefined>(row.patch_summary_json ?? "", undefined),
    errorText: row.error_text ?? undefined,
    latencyMs: row.latency_ms ?? undefined,
    requestPayload: safeJsonParse<Record<string, unknown> | undefined>(row.request_payload_json ?? "", undefined),
    responsePayload: safeJsonParse<Record<string, unknown> | undefined>(row.response_payload_json ?? "", undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function serializeJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}
