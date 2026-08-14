import { createHash, randomUUID } from "node:crypto";
import {
  CHANGE_PLAN_SCHEMA_VERSION,
  ConflictError,
  NotFoundError,
  changePlanPhaseForStatus,
  chatChangePlanScopeForKind,
  isChatChangePlanKind,
  isChatChangePlanRequest,
  isChatChangePlanResult,
  isChatChangePlanStatus,
  type ChatChangePlanCreateInput,
  type ChatChangePlanRecord,
  type ChatChangePlanResult,
  type ChatChangePlanStatus,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface ChatChangePlanRow {
  plan_id: string;
  session_id: string;
  requester_actor_id: string | null;
  kind: string;
  scope: string;
  status: string;
  revision: number | string;
  expected_target_revision: number | string | null;
  request_json: string;
  title: string;
  summary: string;
  result_json: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
}

export interface ChatChangePlanRepositoryCreateInput extends ChatChangePlanCreateInput {
  readonly title: string;
  readonly summary: string;
  readonly expectedTargetRevision?: number;
  readonly expiresAt: string;
  readonly createdAt?: string;
}

export interface ChatChangePlanRepositoryTransitionInput {
  readonly expectedRevision: number;
  readonly status: ChatChangePlanStatus;
  readonly result?: ChatChangePlanResult;
  readonly appliedAt?: string;
}

const TRANSITIONS: Readonly<Record<ChatChangePlanStatus, readonly ChatChangePlanStatus[]>> = {
  draft: [],
  awaiting_input: [],
  awaiting_confirmation: ["applying", "cancelled", "failed", "manual_required"],
  staging: [],
  awaiting_approval: [],
  applying: ["applied", "failed"],
  verifying: [],
  monitoring: [],
  completed: [],
  applied: [],
  cancelled: [],
  failed: [],
  manual_required: [],
  rolling_back: [],
  rolled_back: [],
  rollback_failed: [],
};

/**
 * Durable, secret-free ledger for explicit Chat configuration decisions.
 * Effect-specific state stays with its existing owner; this record only binds
 * intent, current owner revision, outcome, and the operator-visible receipt.
 */
export class ChatChangePlanRepository {
  private readonly getStmt;
  private readonly listBySessionStmt;
  private readonly insertStmt;
  private readonly transitionStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM chat_change_plans WHERE plan_id = ?");
    this.listBySessionStmt = db.prepare(`
      SELECT * FROM chat_change_plans
      WHERE session_id = @sessionId
      ORDER BY created_at DESC, plan_id DESC
      LIMIT @limit
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO chat_change_plans (
        plan_id, session_id, requester_actor_id, kind, scope, status, revision,
        expected_target_revision, request_json, title, summary, result_json, expires_at,
        created_at, updated_at, applied_at
      ) VALUES (
        @planId, @sessionId, @requesterActorId, @kind, @scope, @status, @revision,
        @expectedTargetRevision, @requestJson, @title, @summary, NULL, @expiresAt,
        @createdAt, @updatedAt, NULL
      )
    `);
    this.transitionStmt = db.prepare(`
      UPDATE chat_change_plans
      SET status = @status,
          revision = @nextRevision,
          result_json = @resultJson,
          updated_at = @updatedAt,
          applied_at = @appliedAt
      WHERE plan_id = @planId AND revision = @expectedRevision
    `);
  }

  public create(input: ChatChangePlanRepositoryCreateInput): ChatChangePlanRecord {
    const planId = randomUUID();
    const now = input.createdAt ?? new Date().toISOString();
    validateCreateInput(input);
    this.insertStmt.run({
      planId,
      sessionId: input.sessionId.trim(),
      requesterActorId: optionalIdentifier(input.requesterActorId),
      kind: input.request.kind,
      scope: chatChangePlanScopeForKind(input.request.kind),
      status: "awaiting_confirmation",
      revision: 1,
      expectedTargetRevision: input.expectedTargetRevision ?? null,
      requestJson: JSON.stringify(input.request),
      title: input.title.trim(),
      summary: input.summary.trim(),
      expiresAt: timestamp(input.expiresAt, "expiry timestamp"),
      createdAt: now,
      updatedAt: now,
    });
    return this.get(planId);
  }

  public get(planId: string): ChatChangePlanRecord {
    const row = toRow(this.getStmt.get(planId));
    if (!row) {
      throw new NotFoundError({ entity: "Chat Change Plan", id: planId });
    }
    return mapRow(row);
  }

  public listBySession(sessionId: string, limit = 50): ChatChangePlanRecord[] {
    const normalizedSessionId = identifier(sessionId, "session ID");
    const rows = this.listBySessionStmt.all({
      sessionId: normalizedSessionId,
      limit: Math.max(1, Math.min(Math.trunc(limit), 200)),
    });
    if (!Array.isArray(rows)) return [];
    return rows
      .map(toRow)
      .filter((row): row is ChatChangePlanRow => row !== undefined)
      .map(mapRow);
  }

  public transition(planId: string, input: ChatChangePlanRepositoryTransitionInput): ChatChangePlanRecord {
    const current = this.get(planId);
    if (current.revision !== input.expectedRevision) {
      throw stalePlanConflict(current, input.expectedRevision);
    }
    if (!TRANSITIONS[current.status].includes(input.status)) {
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: `Chat Change Plan ${planId} cannot transition from ${current.status} to ${input.status}.`,
      });
    }
    if (input.result !== undefined && !isChatChangePlanResult(input.result)) {
      throw new TypeError("Chat Change Plan result is not a bounded secret-free shape.");
    }
    const now = new Date().toISOString();
    const appliedAt = input.appliedAt
      ? timestamp(input.appliedAt, "applied timestamp")
      : input.status === "applied"
        ? now
        : null;
    const resultJson = input.result ? JSON.stringify(input.result) : null;
    const result = this.transitionStmt.run({
      planId,
      expectedRevision: input.expectedRevision,
      nextRevision: current.revision + 1,
      status: input.status,
      resultJson,
      updatedAt: now,
      appliedAt,
    });
    if (result.changes !== 1) {
      throw stalePlanConflict(this.get(planId), input.expectedRevision);
    }
    return this.get(planId);
  }
}

function validateCreateInput(input: ChatChangePlanRepositoryCreateInput): void {
  identifier(input.sessionId, "session ID");
  boundedText(input.title, "title", 180);
  boundedText(input.summary, "summary", 1_000);
  if (!isChatChangePlanRequest(input.request)) {
    throw new TypeError("Chat Change Plan request is not an allowlisted bounded shape.");
  }
  timestamp(input.expiresAt, "expiry timestamp");
  if (
    input.expectedTargetRevision !== undefined &&
    (!Number.isSafeInteger(input.expectedTargetRevision) || input.expectedTargetRevision < 1)
  ) {
    throw new TypeError("Chat Change Plan target revision must be a positive integer.");
  }
}

function mapRow(row: ChatChangePlanRow): ChatChangePlanRecord {
  if (!isChatChangePlanKind(row.kind) || !isChatChangePlanStatus(row.status)) {
    throw new TypeError("Stored Chat Change Plan has an unsupported kind or status.");
  }
  const request = parseObject(row.request_json, "request");
  if (!isChatChangePlanRequest(request)) {
    throw new TypeError("Stored Chat Change Plan request is invalid.");
  }
  if (request.kind !== row.kind) {
    throw new TypeError("Stored Chat Change Plan request kind does not match its row.");
  }
  const expectedScope = chatChangePlanScopeForKind(row.kind);
  if (row.scope !== expectedScope) {
    throw new TypeError("Stored Chat Change Plan scope does not match its kind.");
  }
  const revision = integer(row.revision, "revision");
  const expectedTargetRevision =
    row.expected_target_revision === null ? undefined : integer(row.expected_target_revision, "target revision");
  const result = row.result_json === null ? undefined : parseObject(row.result_json, "result");
  if (result !== undefined && !isChatChangePlanResult(result)) {
    throw new TypeError("Stored Chat Change Plan result is invalid.");
  }
  return {
    schemaVersion: CHANGE_PLAN_SCHEMA_VERSION,
    planId: identifier(row.plan_id, "plan ID"),
    origin: {
      surface: "chat",
      workspaceId: "legacy",
      sessionId: identifier(row.session_id, "session ID"),
      ...(row.requester_actor_id ? { actorId: identifier(row.requester_actor_id, "requester actor ID") } : {}),
    },
    adapter: { adapterId: "legacy-chat-change-plan", version: 1 },
    sessionId: identifier(row.session_id, "session ID"),
    requesterActorId: row.requester_actor_id ? identifier(row.requester_actor_id, "requester actor ID") : undefined,
    kind: row.kind,
    scope: expectedScope,
    status: row.status,
    phase: changePlanPhaseForStatus(row.status),
    revision,
    expectedTargetRevision,
    request,
    intentHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    target: {
      ownerId: row.kind === "session_model" ? "chat_session_prefs" : "legacy_change_owner",
      resourceId: row.kind === "session_model" ? row.session_id : row.kind,
      ...(expectedTargetRevision ? { expectedRevision: expectedTargetRevision } : {}),
    },
    title: boundedText(row.title, "title", 180),
    summary: boundedText(row.summary, "summary", 1_000),
    impact: boundedText(row.summary, "summary", 1_000),
    risk: row.kind === "product_source_update" ? "danger" : row.kind === "capability_candidate" ? "caution" : "safe",
    approvalRefs: [],
    evidenceRefs: result?.evidenceRefs ?? [],
    rollbackRefs: result?.rollbackRef ? [result.rollbackRef] : [],
    result,
    expiresAt: timestamp(row.expires_at, "expiry timestamp"),
    createdAt: boundedText(row.created_at, "created timestamp", 80),
    updatedAt: boundedText(row.updated_at, "updated timestamp", 80),
    appliedAt: row.applied_at ? boundedText(row.applied_at, "applied timestamp", 80) : undefined,
  };
}

function toRow(value: unknown): ChatChangePlanRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<ChatChangePlanRow>;
  if (
    typeof row.plan_id !== "string" ||
    typeof row.session_id !== "string" ||
    typeof row.kind !== "string" ||
    typeof row.scope !== "string" ||
    typeof row.status !== "string" ||
    (typeof row.revision !== "number" && typeof row.revision !== "string") ||
    (row.expected_target_revision !== null &&
      row.expected_target_revision !== undefined &&
      typeof row.expected_target_revision !== "number" &&
      typeof row.expected_target_revision !== "string") ||
    typeof row.request_json !== "string" ||
    typeof row.title !== "string" ||
    typeof row.summary !== "string" ||
    (row.result_json !== null && row.result_json !== undefined && typeof row.result_json !== "string") ||
    typeof row.expires_at !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    (row.applied_at !== null && row.applied_at !== undefined && typeof row.applied_at !== "string") ||
    (row.requester_actor_id !== null &&
      row.requester_actor_id !== undefined &&
      typeof row.requester_actor_id !== "string")
  ) {
    return undefined;
  }
  return {
    plan_id: row.plan_id,
    session_id: row.session_id,
    requester_actor_id: row.requester_actor_id ?? null,
    kind: row.kind,
    scope: row.scope,
    status: row.status,
    revision: row.revision,
    expected_target_revision: row.expected_target_revision ?? null,
    request_json: row.request_json,
    title: row.title,
    summary: row.summary,
    result_json: row.result_json ?? null,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    applied_at: row.applied_at ?? null,
  };
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through to the owner error below
  }
  throw new TypeError(`Stored Chat Change Plan ${label} is invalid.`);
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new TypeError(`Chat Change Plan ${label} is invalid.`);
  return normalized;
}

function optionalIdentifier(value: string | undefined): string | null {
  return value?.trim() ? identifier(value, "requester actor ID") : null;
}

function boundedText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new TypeError(`Chat Change Plan ${label} is invalid.`);
  return normalized;
}

function integer(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`Stored Chat Change Plan ${label} is invalid.`);
  return parsed;
}

function timestamp(value: string, label: string): string {
  const normalized = boundedText(value, label, 80);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new TypeError(`Chat Change Plan ${label} is invalid.`);
  }
  return normalized;
}

function stalePlanConflict(current: ChatChangePlanRecord, expectedRevision: number): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: `Chat Change Plan ${current.planId} changed since revision ${expectedRevision}.`,
    details: {
      resourceKind: "chat_change_plan",
      resourceId: current.planId,
      expectedRevision,
      currentRevision: current.revision,
    },
  });
}
