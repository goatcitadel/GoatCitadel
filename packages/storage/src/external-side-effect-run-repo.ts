import { randomUUID } from "node:crypto";
import type {
  ExternalSideEffectRunRecord,
  ExternalSideEffectRunStatus,
  IntegrationExternalWritebackReplayOutcome,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { safeJsonParse } from "./safe-json.js";

interface ExternalSideEffectRunRow {
  run_id: string;
  workspace_id: string;
  boundary: string;
  route_path: string;
  catalog_id: string | null;
  connection_id: string | null;
  action_id: string | null;
  actor_scope: string;
  idempotency_key: string;
  payload_hash: string;
  status: ExternalSideEffectRunStatus;
  replay_policy: "audit_only" | "idempotent_external";
  replay_outcome: IntegrationExternalWritebackReplayOutcome | null;
  replay_attempt: "new" | "retry_after_failure" | "blocked" | "unavailable" | null;
  resume_state: ExternalSideEffectRunRecord["resumeState"];
  request_payload_json: string | null;
  response_payload_json: string | null;
  external_reference_id: string | null;
  envelope_id: string | null;
  error_text: string | null;
  attempt_count: number;
  external_call_started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export class ExternalSideEffectRunRepository {
  private readonly insertStmt;
  private readonly getStmt;
  private readonly findByIdempotencyStmt;
  private readonly listByWorkspaceStmt;
  private readonly listByConnectionStmt;
  private readonly markExternalCallStartedStmt;
  private readonly markCompletedStmt;
  private readonly markFailureStmt;
  private readonly attachEnvelopeStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.insertStmt = db.prepare(`
      INSERT INTO external_side_effect_runs (
        run_id, workspace_id, boundary, route_path, catalog_id, connection_id, action_id, actor_scope,
        idempotency_key, payload_hash, status, replay_policy, replay_outcome, replay_attempt, resume_state,
        request_payload_json, response_payload_json, external_reference_id, envelope_id, error_text,
        attempt_count, external_call_started_at, completed_at, created_at, updated_at
      ) VALUES (
        @runId, @workspaceId, @boundary, @routePath, @catalogId, @connectionId, @actionId, @actorScope,
        @idempotencyKey, @payloadHash, @status, @replayPolicy, @replayOutcome, @replayAttempt, @resumeState,
        @requestPayloadJson, @responsePayloadJson, @externalReferenceId, @envelopeId, @errorText,
        @attemptCount, @externalCallStartedAt, @completedAt, @createdAt, @updatedAt
      )
    `);
    this.getStmt = db.prepare("SELECT * FROM external_side_effect_runs WHERE run_id = ?");
    this.findByIdempotencyStmt = db.prepare(`
      SELECT *
      FROM external_side_effect_runs
      WHERE route_path = @routePath
        AND idempotency_key = @idempotencyKey
        AND actor_scope = @actorScope
      LIMIT 1
    `);
    this.listByWorkspaceStmt = db.prepare(`
      SELECT *
      FROM external_side_effect_runs
      WHERE workspace_id = @workspaceId
      ORDER BY created_at DESC, run_id DESC
      LIMIT @limit
    `);
    this.listByConnectionStmt = db.prepare(`
      SELECT *
      FROM external_side_effect_runs
      WHERE workspace_id = @workspaceId
        AND connection_id = @connectionId
      ORDER BY created_at DESC, run_id DESC
      LIMIT @limit
    `);
    this.markExternalCallStartedStmt = db.prepare(`
      UPDATE external_side_effect_runs
      SET status = 'external_call_started',
          attempt_count = @attemptCount,
          external_call_started_at = @externalCallStartedAt,
          updated_at = @updatedAt
      WHERE run_id = @runId
    `);
    this.markCompletedStmt = db.prepare(`
      UPDATE external_side_effect_runs
      SET status = 'completed',
          replay_outcome = @replayOutcome,
          resume_state = 'completed',
          response_payload_json = @responsePayloadJson,
          external_reference_id = @externalReferenceId,
          envelope_id = @envelopeId,
          error_text = NULL,
          completed_at = @completedAt,
          updated_at = @updatedAt
      WHERE run_id = @runId
    `);
    this.markFailureStmt = db.prepare(`
      UPDATE external_side_effect_runs
      SET status = @status,
          resume_state = @resumeState,
          response_payload_json = @responsePayloadJson,
          error_text = @errorText,
          completed_at = @completedAt,
          updated_at = @updatedAt
      WHERE run_id = @runId
    `);
    this.attachEnvelopeStmt = db.prepare(`
      UPDATE external_side_effect_runs
      SET envelope_id = @envelopeId,
          updated_at = @updatedAt
      WHERE run_id = @runId
    `);
  }

  public createOrGet(
    input: {
      workspaceId?: string;
      boundary: string;
      routePath: string;
      catalogId?: string;
      connectionId?: string;
      actionId?: string;
      actorScope?: string;
      idempotencyKey: string;
      payloadHash: string;
      status?: ExternalSideEffectRunStatus;
      replayOutcome?: IntegrationExternalWritebackReplayOutcome;
      replayAttempt?: ExternalSideEffectRunRecord["replayAttempt"];
      requestPayload?: Record<string, unknown>;
    },
    now = new Date().toISOString(),
  ): ExternalSideEffectRunRecord {
    const actorScope = input.actorScope?.trim() ?? "";
    const existing = this.findByIdempotency(input.routePath, input.idempotencyKey, actorScope);
    if (existing) {
      return existing;
    }
    const runId = `extfx_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    this.insertStmt.run({
      runId,
      workspaceId: input.workspaceId ?? "default",
      boundary: input.boundary,
      routePath: input.routePath,
      catalogId: input.catalogId ?? null,
      connectionId: input.connectionId ?? null,
      actionId: input.actionId ?? null,
      actorScope,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      status: input.status ?? "claimed_not_sent",
      replayPolicy: "idempotent_external",
      replayOutcome: input.replayOutcome ?? null,
      replayAttempt: input.replayAttempt ?? "new",
      resumeState: resumeStateForStatus(input.status ?? "claimed_not_sent"),
      requestPayloadJson: serializeJson(input.requestPayload),
      responsePayloadJson: null,
      externalReferenceId: null,
      envelopeId: null,
      errorText: null,
      attemptCount: 0,
      externalCallStartedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    return this.get(runId);
  }

  public get(runId: string): ExternalSideEffectRunRecord {
    const row = toExternalSideEffectRunRow(this.getStmt.get(runId));
    if (!row) {
      throw new Error(`Unknown external side-effect run ${runId}`);
    }
    return mapExternalSideEffectRunRow(row);
  }

  public findByIdempotency(
    routePath: string,
    idempotencyKey: string,
    actorScope = "",
  ): ExternalSideEffectRunRecord | undefined {
    const row = toExternalSideEffectRunRow(
      this.findByIdempotencyStmt.get({
        routePath,
        idempotencyKey,
        actorScope: actorScope.trim(),
      }),
    );
    return row ? mapExternalSideEffectRunRow(row) : undefined;
  }

  public listByWorkspace(workspaceId = "default", limit = 200): ExternalSideEffectRunRecord[] {
    const rows = toExternalSideEffectRunRows(
      this.listByWorkspaceStmt.all({
        workspaceId,
        limit: clampLimit(limit),
      }),
    );
    return rows.map(mapExternalSideEffectRunRow);
  }

  public listByConnection(
    connectionId: string,
    input: { workspaceId?: string; limit?: number } = {},
  ): ExternalSideEffectRunRecord[] {
    const rows = toExternalSideEffectRunRows(
      this.listByConnectionStmt.all({
        workspaceId: input.workspaceId ?? "default",
        connectionId,
        limit: clampLimit(input.limit ?? 200),
      }),
    );
    return rows.map(mapExternalSideEffectRunRow);
  }

  public markExternalCallStarted(
    runId: string,
    input: { attemptCount?: number } = {},
    now = new Date().toISOString(),
  ): ExternalSideEffectRunRecord {
    const current = this.get(runId);
    this.markExternalCallStartedStmt.run({
      runId,
      attemptCount: input.attemptCount ?? current.attemptCount + 1,
      externalCallStartedAt: now,
      updatedAt: now,
    });
    return this.get(runId);
  }

  public markCompleted(
    runId: string,
    input: {
      replayOutcome?: IntegrationExternalWritebackReplayOutcome;
      responsePayload?: Record<string, unknown>;
      externalReferenceId?: string;
      envelopeId?: string;
    } = {},
    now = new Date().toISOString(),
  ): ExternalSideEffectRunRecord {
    this.markCompletedStmt.run({
      runId,
      replayOutcome: input.replayOutcome ?? "claimed",
      responsePayloadJson: serializeJson(input.responsePayload),
      externalReferenceId: input.externalReferenceId ?? null,
      envelopeId: input.envelopeId ?? null,
      completedAt: now,
      updatedAt: now,
    });
    return this.get(runId);
  }

  public markFailure(
    runId: string,
    input: {
      status: "failed_before_boundary" | "unknown_external_outcome";
      errorText: string;
      responsePayload?: Record<string, unknown>;
    },
    now = new Date().toISOString(),
  ): ExternalSideEffectRunRecord {
    this.markFailureStmt.run({
      runId,
      status: input.status,
      resumeState: resumeStateForStatus(input.status),
      responsePayloadJson: serializeJson(input.responsePayload),
      errorText: input.errorText,
      completedAt: now,
      updatedAt: now,
    });
    return this.get(runId);
  }

  public attachEnvelope(
    runId: string,
    envelopeId: string,
    now = new Date().toISOString(),
  ): ExternalSideEffectRunRecord {
    this.attachEnvelopeStmt.run({
      runId,
      envelopeId,
      updatedAt: now,
    });
    return this.get(runId);
  }
}

function mapExternalSideEffectRunRow(row: ExternalSideEffectRunRow): ExternalSideEffectRunRecord {
  return {
    runId: row.run_id,
    workspaceId: row.workspace_id,
    boundary: row.boundary,
    routePath: row.route_path,
    catalogId: row.catalog_id ?? undefined,
    connectionId: row.connection_id ?? undefined,
    actionId: row.action_id ?? undefined,
    actorScope: row.actor_scope,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    status: row.status,
    replayPolicy: row.replay_policy,
    replayOutcome: row.replay_outcome ?? undefined,
    replayAttempt: row.replay_attempt ?? undefined,
    resumeState: row.resume_state,
    requestPayload: safeJsonParse<Record<string, unknown> | undefined>(row.request_payload_json ?? "", undefined),
    responsePayload: safeJsonParse<Record<string, unknown> | undefined>(row.response_payload_json ?? "", undefined),
    externalReferenceId: row.external_reference_id ?? undefined,
    envelopeId: row.envelope_id ?? undefined,
    errorText: row.error_text ?? undefined,
    attemptCount: row.attempt_count,
    externalCallStartedAt: row.external_call_started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resumeStateForStatus(status: ExternalSideEffectRunStatus): ExternalSideEffectRunRecord["resumeState"] {
  if (status === "completed" || status === "blocked_duplicate") {
    return "completed";
  }
  if (status === "external_call_started") {
    return "in_progress";
  }
  if (status === "payload_mismatch") {
    return "payload_mismatch";
  }
  if (status === "idempotency_unavailable") {
    return "idempotency_unavailable";
  }
  if (status === "failed_before_boundary") {
    return "manual_retry_after_recorded_failure";
  }
  return "not_resumable";
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 200;
  }
  return Math.max(1, Math.min(1_000, Math.floor(value)));
}

function toExternalSideEffectRunRow(value: unknown): ExternalSideEffectRunRow | undefined {
  return isExternalSideEffectRunRow(value) ? value : undefined;
}

function toExternalSideEffectRunRows(value: unknown): ExternalSideEffectRunRow[] {
  return Array.isArray(value) ? value.filter(isExternalSideEffectRunRow) : [];
}

function isExternalSideEffectRunRow(value: unknown): value is ExternalSideEffectRunRow {
  return (
    isRecord(value) &&
    typeof value.run_id === "string" &&
    typeof value.workspace_id === "string" &&
    typeof value.boundary === "string" &&
    typeof value.route_path === "string" &&
    (typeof value.catalog_id === "string" || value.catalog_id === null) &&
    (typeof value.connection_id === "string" || value.connection_id === null) &&
    (typeof value.action_id === "string" || value.action_id === null) &&
    typeof value.actor_scope === "string" &&
    typeof value.idempotency_key === "string" &&
    typeof value.payload_hash === "string" &&
    isExternalSideEffectRunStatus(value.status) &&
    (value.replay_policy === "audit_only" || value.replay_policy === "idempotent_external") &&
    (isExternalReplayOutcome(value.replay_outcome) || value.replay_outcome === null) &&
    (value.replay_attempt === "new" ||
      value.replay_attempt === "retry_after_failure" ||
      value.replay_attempt === "blocked" ||
      value.replay_attempt === "unavailable" ||
      value.replay_attempt === null) &&
    (value.resume_state === "not_resumable" ||
      value.resume_state === "completed" ||
      value.resume_state === "manual_retry_after_recorded_failure" ||
      value.resume_state === "in_progress" ||
      value.resume_state === "payload_mismatch" ||
      value.resume_state === "idempotency_unavailable") &&
    (typeof value.request_payload_json === "string" || value.request_payload_json === null) &&
    (typeof value.response_payload_json === "string" || value.response_payload_json === null) &&
    (typeof value.external_reference_id === "string" || value.external_reference_id === null) &&
    (typeof value.envelope_id === "string" || value.envelope_id === null) &&
    (typeof value.error_text === "string" || value.error_text === null) &&
    typeof value.attempt_count === "number" &&
    (typeof value.external_call_started_at === "string" || value.external_call_started_at === null) &&
    (typeof value.completed_at === "string" || value.completed_at === null) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isExternalSideEffectRunStatus(value: unknown): value is ExternalSideEffectRunStatus {
  return (
    value === "claimed_not_sent" ||
    value === "external_call_started" ||
    value === "completed" ||
    value === "failed_before_boundary" ||
    value === "unknown_external_outcome" ||
    value === "blocked_duplicate" ||
    value === "payload_mismatch" ||
    value === "idempotency_unavailable"
  );
}

function isExternalReplayOutcome(value: unknown): value is IntegrationExternalWritebackReplayOutcome {
  return (
    value === "claimed" ||
    value === "duplicate" ||
    value === "in_progress" ||
    value === "payload_mismatch" ||
    value === "idempotency_unavailable"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
