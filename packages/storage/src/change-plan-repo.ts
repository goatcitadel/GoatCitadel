import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CHANGE_PLAN_SCHEMA_VERSION,
  ConflictError,
  NotFoundError,
  canonicalJsonString,
  changePlanPhaseForStatus,
  changePlanScopeForKind,
  isChangePlanKind,
  isChangePlanRequest,
  isChangePlanResult,
  isChangePlanStatus,
  type ChangePlanAdapterRef,
  type ChangePlanOrigin,
  type ChangePlanRecord,
  type ChangePlanRequest,
  type ChangePlanRequiredAction,
  type ChangePlanResult,
  type ChangePlanRisk,
  type ChangePlanStatus,
  type ChangePlanTargetRef,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

interface ChangePlanRow {
  schema_version: number | string;
  plan_id: string;
  origin_surface: string;
  workspace_id: string;
  session_id: string | null;
  turn_id: string | null;
  requester_actor_id: string | null;
  request_id: string | null;
  idempotency_key: string | null;
  adapter_id: string;
  adapter_version: number | string;
  kind: string;
  scope: string;
  status: string;
  phase: string;
  revision: number | string;
  request_json: string;
  intent_hash: string;
  target_owner_id: string;
  target_resource_id: string;
  expected_target_revision: number | string | null;
  expected_target_hash: string | null;
  active_target_key: string | null;
  title: string;
  summary: string;
  impact: string;
  risk: string;
  required_action_json: string | null;
  action_snapshot_hash: string | null;
  action_nonce_hash: string | null;
  approval_refs_json: string;
  evidence_refs_json: string;
  rollback_refs_json: string;
  result_json: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
}

interface LegacyChatChangePlanRow {
  plan_id: string;
  session_id: string;
  workspace_id: string;
  requester_actor_id: string | null;
  kind: string;
  status: string;
  revision: number | string;
  expected_target_revision: number | string | null;
  request_json: string;
  title: string;
  summary: string;
  result_json: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
}

export interface ChangePlanRepositoryCreateInput {
  readonly origin: ChangePlanOrigin;
  readonly request: ChangePlanRequest;
  readonly adapter: ChangePlanAdapterRef;
  readonly target: ChangePlanTargetRef;
  readonly title: string;
  readonly summary: string;
  readonly impact: string;
  readonly risk: ChangePlanRisk;
  readonly status: Extract<ChangePlanStatus, "draft" | "awaiting_input" | "awaiting_confirmation" | "manual_required">;
  readonly requiredAction?: ChangePlanRequiredAction;
  readonly idempotencyKey?: string;
  readonly approvalRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly rollbackRefs?: readonly string[];
  readonly result?: ChangePlanResult;
  readonly expiresAt?: string;
  readonly createdAt?: string;
}

export interface ChangePlanRepositoryTransitionInput {
  readonly expectedRevision: number;
  readonly status: ChangePlanStatus;
  readonly actionNonce?: string;
  /** Reserved for Gateway-owned recovery/error transitions, never an API input. */
  readonly internal?: boolean;
  readonly requiredAction?: ChangePlanRequiredAction | null;
  readonly approvalRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly rollbackRefs?: readonly string[];
  readonly result?: ChangePlanResult;
  /** May advance revision/hash only; the claimed owner/resource identity is immutable. */
  readonly target?: ChangePlanTargetRef;
  readonly appliedAt?: string;
  readonly eventType?: string;
  readonly actorId?: string;
  readonly eventPayload?: Readonly<Record<string, unknown>>;
}

export interface ChangePlanRepositoryListInput {
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly status?: ChangePlanStatus;
  readonly limit?: number;
}

export interface ChangePlanEventRecord {
  readonly eventId: string;
  readonly planId: string;
  readonly sequence: number;
  readonly fromStatus?: ChangePlanStatus;
  readonly toStatus: ChangePlanStatus;
  readonly eventType: string;
  readonly actorId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface ChangePlanLinkRecord {
  readonly planId: string;
  readonly linkKind: "approval" | "evidence" | "rollback" | "owner";
  readonly linkId: string;
  readonly materialHash?: string;
  readonly createdAt: string;
}

const TERMINAL_STATUSES = new Set<ChangePlanStatus>([
  "completed",
  "applied",
  "manual_required",
  "failed",
  "cancelled",
  "rolled_back",
  "rollback_failed",
]);

const TRANSITIONS: Readonly<Record<ChangePlanStatus, readonly ChangePlanStatus[]>> = {
  draft: ["awaiting_input", "awaiting_confirmation", "manual_required", "failed", "cancelled"],
  awaiting_input: ["awaiting_input", "awaiting_confirmation", "staging", "manual_required", "failed", "cancelled"],
  awaiting_confirmation: [
    "staging",
    "awaiting_approval",
    "applying",
    "manual_required",
    "failed",
    "cancelled",
    "rolling_back",
  ],
  staging: [
    "awaiting_input",
    "awaiting_confirmation",
    "awaiting_approval",
    "applying",
    "verifying",
    "manual_required",
    "failed",
    "cancelled",
  ],
  awaiting_approval: ["applying", "manual_required", "failed", "cancelled", "rolling_back"],
  applying: ["verifying", "monitoring", "completed", "applied", "manual_required", "failed", "rolling_back"],
  verifying: ["monitoring", "completed", "applied", "manual_required", "failed", "rolling_back"],
  monitoring: ["completed", "applied", "manual_required", "failed", "rolling_back", "rolled_back", "rollback_failed"],
  completed: ["awaiting_confirmation", "rolling_back"],
  applied: ["awaiting_confirmation", "rolling_back"],
  manual_required: ["awaiting_confirmation", "rolling_back"],
  failed: ["awaiting_confirmation", "rolling_back"],
  cancelled: [],
  rolling_back: ["awaiting_approval", "monitoring", "manual_required", "rolled_back", "rollback_failed"],
  rolled_back: [],
  rollback_failed: [],
};

/** Canonical durable repository for all Evolution Control Plane plans. */
export class ChangePlanRepository {
  private readonly getStmt;
  private readonly findByIdempotencyStmt;
  private readonly findActiveTargetStmt;
  private readonly listWorkspaceStmt;
  private readonly listSessionStmt;
  private readonly listActiveStmt;
  private readonly insertStmt;
  private readonly transitionStmt;
  private readonly insertEventStmt;
  private readonly listEventsStmt;
  private readonly insertLinkStmt;
  private readonly listLinksStmt;
  private readonly listLegacyChatPlansStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.getStmt = db.prepare("SELECT * FROM change_plans WHERE plan_id = ?");
    this.findByIdempotencyStmt = db.prepare(`
      SELECT * FROM change_plans
      WHERE workspace_id = @workspaceId AND idempotency_key = @idempotencyKey
    `);
    this.findActiveTargetStmt = db.prepare(`
      SELECT * FROM change_plans WHERE active_target_key = @activeTargetKey
    `);
    this.listWorkspaceStmt = db.prepare(`
      SELECT * FROM change_plans
      WHERE workspace_id = @workspaceId
        AND (CAST(@status AS TEXT) IS NULL OR status = @status)
      ORDER BY created_at DESC, plan_id DESC
      LIMIT @limit
    `);
    this.listSessionStmt = db.prepare(`
      SELECT * FROM change_plans
      WHERE workspace_id = @workspaceId AND session_id = @sessionId
        AND (CAST(@status AS TEXT) IS NULL OR status = @status)
      ORDER BY created_at DESC, plan_id DESC
      LIMIT @limit
    `);
    this.listActiveStmt = db.prepare(`
      SELECT * FROM change_plans
      WHERE active_target_key IS NOT NULL
      ORDER BY updated_at ASC, plan_id ASC
      LIMIT @limit
    `);
    this.insertStmt = db.prepare(`
      INSERT INTO change_plans (
        schema_version, plan_id, origin_surface, workspace_id, session_id, turn_id,
        requester_actor_id, request_id, idempotency_key, adapter_id, adapter_version,
        kind, scope, status, phase, revision, request_json, intent_hash,
        target_owner_id, target_resource_id, expected_target_revision, expected_target_hash,
        active_target_key, title, summary, impact, risk, required_action_json,
        action_snapshot_hash, action_nonce_hash, approval_refs_json, evidence_refs_json,
        rollback_refs_json, result_json, expires_at, created_at, updated_at, applied_at
      ) VALUES (
        @schemaVersion, @planId, @originSurface, @workspaceId, @sessionId, @turnId,
        @requesterActorId, @requestId, @idempotencyKey, @adapterId, @adapterVersion,
        @kind, @scope, @status, @phase, 1, @requestJson, @intentHash,
        @targetOwnerId, @targetResourceId, @expectedTargetRevision, @expectedTargetHash,
        @activeTargetKey, @title, @summary, @impact, @risk, @requiredActionJson,
        @actionSnapshotHash, @actionNonceHash, @approvalRefsJson, @evidenceRefsJson,
        @rollbackRefsJson, @resultJson, @expiresAt, @createdAt, @createdAt, @appliedAt
      )
      ON CONFLICT DO NOTHING
    `);
    this.transitionStmt = db.prepare(`
      UPDATE change_plans
      SET status = @status,
          phase = @phase,
          revision = @nextRevision,
          expected_target_revision = @expectedTargetRevision,
          expected_target_hash = @expectedTargetHash,
          required_action_json = @requiredActionJson,
          action_snapshot_hash = @actionSnapshotHash,
          action_nonce_hash = @actionNonceHash,
          approval_refs_json = @approvalRefsJson,
          evidence_refs_json = @evidenceRefsJson,
          rollback_refs_json = @rollbackRefsJson,
          result_json = @resultJson,
          active_target_key = @activeTargetKey,
          updated_at = @updatedAt,
          applied_at = @appliedAt
      WHERE plan_id = @planId AND revision = @expectedRevision
    `);
    this.insertEventStmt = db.prepare(`
      INSERT INTO change_plan_events (
        event_id, plan_id, sequence, from_status, to_status, event_type,
        actor_id, payload_json, created_at
      ) VALUES (
        @eventId, @planId, @sequence, @fromStatus, @toStatus, @eventType,
        @actorId, @payloadJson, @createdAt
      )
    `);
    this.listEventsStmt = db.prepare(`
      SELECT * FROM change_plan_events
      WHERE plan_id = @planId
      ORDER BY sequence ASC, event_id ASC
      LIMIT @limit
    `);
    this.insertLinkStmt = db.prepare(`
      INSERT INTO change_plan_links (plan_id, link_kind, link_id, material_hash, created_at)
      VALUES (@planId, @linkKind, @linkId, @materialHash, @createdAt)
      ON CONFLICT DO NOTHING
    `);
    this.listLinksStmt = db.prepare(`
      SELECT * FROM change_plan_links
      WHERE plan_id = @planId
      ORDER BY created_at ASC, link_kind ASC, link_id ASC
    `);
    this.listLegacyChatPlansStmt = db.prepare(`
      SELECT legacy.*,
             COALESCE(meta.workspace_id, 'default') AS workspace_id
      FROM chat_change_plans AS legacy
      LEFT JOIN chat_session_meta AS meta ON meta.session_id = legacy.session_id
      ORDER BY legacy.created_at ASC, legacy.plan_id ASC
    `);
  }

  /**
   * Idempotently imports the original Chat-only ledger. Pending legacy plans
   * become manual-required because they have no nonce-bound canonical action;
   * they can be reviewed and recreated without replaying an old mutation.
   */
  public backfillLegacyChatPlans(): number {
    const rows = this.listLegacyChatPlansStmt.all() as unknown as LegacyChatChangePlanRow[];
    let inserted = 0;
    this.db.transaction("immediate", () => {
      for (const row of rows) {
        if (this.getStmt.get(row.plan_id)) continue;
        const requestValue = parseObject(row.request_json, "legacy request");
        if (!isChangePlanRequest(requestValue) || requestValue.kind !== row.kind) {
          throw new TypeError(`Legacy Chat Change Plan ${row.plan_id} has invalid intent material.`);
        }
        const status = legacyStatus(row.status);
        const requestJson = canonicalJsonString(requestValue);
        const legacyResult = row.result_json ? parseObject(row.result_json, "legacy result") : undefined;
        const result =
          status === "manual_required"
            ? {
                summary:
                  "This legacy Change Plan was imported without replaying or authorizing its pending effect. Create a fresh plan to continue.",
                failureCode: "legacy_backfill_requires_replan",
              }
            : legacyResult && isChangePlanResult(legacyResult)
              ? legacyResult
              : undefined;
        const target = legacyTarget(row, requestValue.kind);
        const evidenceRefs = result?.evidenceRefs ?? [];
        const rollbackRefs = result?.rollbackRef ? [result.rollbackRef] : [];
        const createdAt = timestamp(row.created_at, "legacy createdAt");
        const appliedAt =
          status === "completed" ? timestamp(row.applied_at ?? row.updated_at, "legacy appliedAt") : null;
        const resultWrite = this.insertStmt.run({
          schemaVersion: CHANGE_PLAN_SCHEMA_VERSION,
          planId: identifier(row.plan_id, "legacy planId"),
          originSurface: "chat",
          workspaceId: identifier(row.workspace_id, "legacy workspaceId"),
          sessionId: identifier(row.session_id, "legacy sessionId"),
          turnId: null,
          requesterActorId: row.requester_actor_id ? identifier(row.requester_actor_id, "legacy actorId") : null,
          requestId: null,
          idempotencyKey: null,
          adapterId: "legacy-chat-change-plan",
          adapterVersion: 1,
          kind: requestValue.kind,
          scope: changePlanScopeForKind(requestValue.kind),
          status,
          phase: changePlanPhaseForStatus(status),
          requestJson,
          intentHash: sha256(requestJson),
          targetOwnerId: target.ownerId,
          targetResourceId: target.resourceId,
          expectedTargetRevision: target.expectedRevision ?? null,
          expectedTargetHash: null,
          activeTargetKey: null,
          title: boundedText(row.title, "legacy title", 180),
          summary: boundedText(row.summary, "legacy summary", 2_000),
          impact: boundedText(row.summary, "legacy impact", 2_000),
          risk:
            requestValue.kind === "product_source_update"
              ? "danger"
              : requestValue.kind === "capability_candidate"
                ? "caution"
                : "safe",
          requiredActionJson: null,
          actionSnapshotHash: null,
          actionNonceHash: null,
          approvalRefsJson: "[]",
          evidenceRefsJson: referenceJson(evidenceRefs),
          rollbackRefsJson: referenceJson(rollbackRefs),
          resultJson: result ? canonicalJsonString(result) : null,
          expiresAt: row.expires_at ? timestamp(row.expires_at, "legacy expiresAt") : null,
          createdAt,
          appliedAt,
        });
        if (resultWrite.changes !== 1) continue;
        this.insertEvent({
          eventId: randomUUID(),
          planId: row.plan_id,
          sequence: 1,
          toStatus: status,
          eventType: "legacy_chat_plan_imported",
          actorId: row.requester_actor_id ?? undefined,
          payload: { legacyRevision: positiveInteger(row.revision, "legacy revision") },
          createdAt,
        });
        this.insertReferences(row.plan_id, "owner", [`${target.ownerId}:${target.resourceId}`], createdAt);
        this.insertReferences(row.plan_id, "evidence", evidenceRefs, createdAt);
        this.insertReferences(row.plan_id, "rollback", rollbackRefs, createdAt);
        inserted += 1;
      }
    });
    return inserted;
  }

  public create(input: ChangePlanRepositoryCreateInput): ChangePlanRecord {
    validateCreateInput(input);
    const planId = randomUUID();
    const now = input.createdAt ? timestamp(input.createdAt, "createdAt") : new Date().toISOString();
    const requestJson = canonicalJsonString(input.request);
    const intentHash = sha256(requestJson);
    const activeTargetKey = targetKey(input.origin.workspaceId, input.target);
    const requiredActionMaterial = actionMaterial(input.requiredAction);
    const resultJson = input.result ? canonicalJsonString(input.result) : null;
    const appliedAt = null;

    return this.db.transaction("immediate", () => {
      const result = this.insertStmt.run({
        schemaVersion: CHANGE_PLAN_SCHEMA_VERSION,
        planId,
        originSurface: input.origin.surface,
        workspaceId: input.origin.workspaceId,
        sessionId: input.origin.sessionId ?? null,
        turnId: input.origin.turnId ?? null,
        requesterActorId: input.origin.actorId ?? null,
        requestId: input.origin.requestId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        adapterId: input.adapter.adapterId,
        adapterVersion: input.adapter.version,
        kind: input.request.kind,
        scope: changePlanScopeForKind(input.request.kind),
        status: input.status,
        phase: changePlanPhaseForStatus(input.status),
        requestJson,
        intentHash,
        targetOwnerId: input.target.ownerId,
        targetResourceId: input.target.resourceId,
        expectedTargetRevision: input.target.expectedRevision ?? null,
        expectedTargetHash: input.target.expectedHash ?? null,
        activeTargetKey: TERMINAL_STATUSES.has(input.status) ? null : activeTargetKey,
        title: input.title.trim(),
        summary: input.summary.trim(),
        impact: input.impact.trim(),
        risk: input.risk,
        requiredActionJson: requiredActionMaterial.json,
        actionSnapshotHash: requiredActionMaterial.snapshotHash,
        actionNonceHash: requiredActionMaterial.nonceHash,
        approvalRefsJson: referenceJson(input.approvalRefs),
        evidenceRefsJson: referenceJson(input.evidenceRefs),
        rollbackRefsJson: referenceJson(input.rollbackRefs),
        resultJson,
        expiresAt: input.expiresAt ?? null,
        createdAt: now,
        appliedAt,
      });
      if (result.changes !== 1) {
        const replay = input.idempotencyKey
          ? this.findByIdempotency(input.origin.workspaceId, input.idempotencyKey)
          : undefined;
        if (replay) {
          if (replay.intentHash !== intentHash || replay.target.resourceId !== input.target.resourceId) {
            throw conflict("Change Plan idempotency key was already used for different material.", replay);
          }
          return replay;
        }
        const active = this.findActiveTarget(activeTargetKey);
        throw conflict("Another active Change Plan already owns this target.", active);
      }
      this.insertEvent({
        eventId: randomUUID(),
        planId,
        sequence: 1,
        toStatus: input.status,
        eventType: "created",
        actorId: input.origin.actorId,
        payload: {},
        createdAt: now,
      });
      this.insertReferences(planId, "approval", input.approvalRefs, now);
      this.insertReferences(planId, "evidence", input.evidenceRefs, now);
      this.insertReferences(planId, "rollback", input.rollbackRefs, now);
      this.insertReferences(planId, "owner", [`${input.target.ownerId}:${input.target.resourceId}`], now);
      return this.get(planId);
    });
  }

  public get(planId: string): ChangePlanRecord {
    const row = this.getStmt.get(identifier(planId, "planId")) as ChangePlanRow | undefined;
    if (!row) throw new NotFoundError({ entity: "Change Plan", id: planId });
    return mapRow(row);
  }

  public findByIdempotency(workspaceId: string, idempotencyKey: string): ChangePlanRecord | undefined {
    const row = this.findByIdempotencyStmt.get({
      workspaceId: identifier(workspaceId, "workspaceId"),
      idempotencyKey: boundedText(idempotencyKey, "idempotencyKey", 512),
    }) as ChangePlanRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public list(input: ChangePlanRepositoryListInput): ChangePlanRecord[] {
    const bindings = {
      workspaceId: identifier(input.workspaceId, "workspaceId"),
      status: input.status ?? null,
      limit: Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 200)),
    };
    const rows = (input.sessionId
      ? this.listSessionStmt.all({ ...bindings, sessionId: identifier(input.sessionId, "sessionId") })
      : this.listWorkspaceStmt.all(bindings)) as unknown as ChangePlanRow[];
    return rows.map(mapRow);
  }

  public listActive(limit = 500): ChangePlanRecord[] {
    const rows = this.listActiveStmt.all({
      limit: Math.max(1, Math.min(Math.trunc(limit), 2_000)),
    }) as unknown as ChangePlanRow[];
    return rows.map(mapRow);
  }

  public transition(planId: string, input: ChangePlanRepositoryTransitionInput): ChangePlanRecord {
    return this.db.transaction("immediate", () => {
      const currentRow = this.getStmt.get(identifier(planId, "planId")) as ChangePlanRow | undefined;
      if (!currentRow) throw new NotFoundError({ entity: "Change Plan", id: planId });
      const current = mapRow(currentRow);
      if (current.revision !== input.expectedRevision) throw staleConflict(current, input.expectedRevision);
      if (!TRANSITIONS[current.status].includes(input.status)) {
        throw conflict(`Change Plan cannot transition from ${current.status} to ${input.status}.`, current);
      }
      validateActionAuthority(currentRow, input);
      if (input.result !== undefined && !isChangePlanResult(input.result)) {
        throw new TypeError("Change Plan result is not a bounded secret-free shape.");
      }
      const target = input.target ?? current.target;
      validateTransitionTarget(current.target, target);
      const now = new Date().toISOString();
      const requiredAction = input.requiredAction === undefined ? undefined : (input.requiredAction ?? undefined);
      const action = actionMaterial(requiredAction);
      const approvals = mergeReferences(current.approvalRefs, input.approvalRefs);
      const evidence = mergeReferences(current.evidenceRefs, input.evidenceRefs);
      const rollbacks = mergeReferences(current.rollbackRefs, input.rollbackRefs);
      const appliedAt = input.appliedAt
        ? timestamp(input.appliedAt, "appliedAt")
        : input.status === "completed" || input.status === "applied"
          ? now
          : (current.appliedAt ?? null);
      const result = this.transitionStmt.run({
        planId: current.planId,
        expectedRevision: current.revision,
        nextRevision: current.revision + 1,
        status: input.status,
        phase: changePlanPhaseForStatus(input.status),
        expectedTargetRevision: target.expectedRevision ?? null,
        expectedTargetHash: target.expectedHash ?? null,
        requiredActionJson: action.json,
        actionSnapshotHash: action.snapshotHash,
        actionNonceHash: action.nonceHash,
        approvalRefsJson: referenceJson(approvals),
        evidenceRefsJson: referenceJson(evidence),
        rollbackRefsJson: referenceJson(rollbacks),
        resultJson: input.result
          ? canonicalJsonString(input.result)
          : current.result
            ? canonicalJsonString(current.result)
            : null,
        activeTargetKey: TERMINAL_STATUSES.has(input.status) ? null : targetKey(current.origin.workspaceId, target),
        updatedAt: now,
        appliedAt,
      });
      if (result.changes !== 1) throw staleConflict(this.get(planId), input.expectedRevision);
      this.insertEvent({
        eventId: randomUUID(),
        planId: current.planId,
        sequence: current.revision + 1,
        fromStatus: current.status,
        toStatus: input.status,
        eventType: input.eventType ?? "status_changed",
        actorId: input.actorId,
        payload: input.eventPayload ?? {},
        createdAt: now,
      });
      this.insertReferences(current.planId, "approval", input.approvalRefs, now);
      this.insertReferences(current.planId, "evidence", input.evidenceRefs, now);
      this.insertReferences(current.planId, "rollback", input.rollbackRefs, now);
      return this.get(current.planId);
    });
  }

  public listEvents(planId: string, limit = 500): ChangePlanEventRecord[] {
    this.get(planId);
    const rows = this.listEventsStmt.all({
      planId,
      limit: Math.max(1, Math.min(Math.trunc(limit), 2_000)),
    }) as unknown as Array<{
      event_id: string;
      plan_id: string;
      sequence: number | string;
      from_status: string | null;
      to_status: string;
      event_type: string;
      actor_id: string | null;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      planId: row.plan_id,
      sequence: positiveInteger(row.sequence, "event sequence"),
      ...(row.from_status && isChangePlanStatus(row.from_status) ? { fromStatus: row.from_status } : {}),
      toStatus: requireStatus(row.to_status),
      eventType: boundedText(row.event_type, "event type", 128),
      ...(row.actor_id ? { actorId: identifier(row.actor_id, "actorId") } : {}),
      payload: parseObject(row.payload_json, "event payload"),
      createdAt: timestamp(row.created_at, "event createdAt"),
    }));
  }

  public listLinks(planId: string): ChangePlanLinkRecord[] {
    this.get(planId);
    const rows = this.listLinksStmt.all({ planId }) as unknown as Array<{
      plan_id: string;
      link_kind: ChangePlanLinkRecord["linkKind"];
      link_id: string;
      material_hash: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      planId: row.plan_id,
      linkKind: row.link_kind,
      linkId: row.link_id,
      ...(row.material_hash ? { materialHash: row.material_hash } : {}),
      createdAt: row.created_at,
    }));
  }

  private findActiveTarget(activeTargetKey: string): ChangePlanRecord | undefined {
    const row = this.findActiveTargetStmt.get({ activeTargetKey }) as ChangePlanRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  private insertEvent(event: ChangePlanEventRecord): void {
    const payloadJson = canonicalJsonString(event.payload);
    if (Buffer.byteLength(payloadJson, "utf8") > 16_384) throw new TypeError("Change Plan event payload is too large.");
    this.insertEventStmt.run({
      eventId: event.eventId,
      planId: event.planId,
      sequence: event.sequence,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus,
      eventType: event.eventType,
      actorId: event.actorId ?? null,
      payloadJson,
      createdAt: event.createdAt,
    });
  }

  private insertReferences(
    planId: string,
    linkKind: ChangePlanLinkRecord["linkKind"],
    refs: readonly string[] | undefined,
    createdAt: string,
  ): void {
    for (const linkId of refs ?? []) {
      this.insertLinkStmt.run({ planId, linkKind, linkId, materialHash: null, createdAt });
    }
  }
}

function validateCreateInput(input: ChangePlanRepositoryCreateInput): void {
  identifier(input.origin.workspaceId, "workspaceId");
  if (input.origin.sessionId) identifier(input.origin.sessionId, "sessionId");
  if (input.origin.turnId) identifier(input.origin.turnId, "turnId");
  if (input.origin.actorId) identifier(input.origin.actorId, "actorId");
  if (input.origin.requestId) identifier(input.origin.requestId, "requestId");
  if (!isChangePlanRequest(input.request)) throw new TypeError("Change Plan request is not allowlisted or bounded.");
  identifier(input.adapter.adapterId, "adapterId");
  positiveInteger(input.adapter.version, "adapter version");
  identifier(input.target.ownerId, "target ownerId");
  identifier(input.target.resourceId, "target resourceId");
  if (input.target.expectedRevision !== undefined) positiveInteger(input.target.expectedRevision, "target revision");
  if (input.target.expectedHash !== undefined) sha256Value(input.target.expectedHash, "target hash");
  boundedText(input.title, "title", 180);
  boundedText(input.summary, "summary", 2_000);
  boundedText(input.impact, "impact", 2_000);
  if (input.idempotencyKey) boundedText(input.idempotencyKey, "idempotencyKey", 512);
  if (input.expiresAt) timestamp(input.expiresAt, "expiresAt");
  validateReferences(input.approvalRefs);
  validateReferences(input.evidenceRefs);
  validateReferences(input.rollbackRefs);
  if (input.result && !isChangePlanResult(input.result)) throw new TypeError("Change Plan result is invalid.");
}

function validateTransitionTarget(current: ChangePlanTargetRef, next: ChangePlanTargetRef): void {
  if (next.ownerId !== current.ownerId || next.resourceId !== current.resourceId) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "A Change Plan cannot change its claimed target identity.",
    });
  }
  identifier(next.ownerId, "target ownerId");
  identifier(next.resourceId, "target resourceId");
  if (next.expectedRevision !== undefined) positiveInteger(next.expectedRevision, "target revision");
  if (next.expectedHash !== undefined) sha256Value(next.expectedHash, "target hash");
}

function legacyStatus(
  value: string,
): Extract<ChangePlanStatus, "completed" | "manual_required" | "failed" | "cancelled"> {
  switch (value) {
    case "applied":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "manual_required":
      return "manual_required";
    case "awaiting_confirmation":
    case "applying":
      return "manual_required";
    default:
      throw new TypeError(`Legacy Chat Change Plan status ${value} is unsupported.`);
  }
}

function legacyTarget(row: LegacyChatChangePlanRow, kind: ChangePlanRequest["kind"]): ChangePlanTargetRef {
  const expectedRevision =
    row.expected_target_revision === null
      ? undefined
      : positiveInteger(row.expected_target_revision, "legacy target revision");
  return {
    ownerId: kind === "session_model" ? "chat_session_prefs" : "legacy_change_owner",
    resourceId: kind === "session_model" ? row.session_id : kind,
    ...(expectedRevision ? { expectedRevision } : {}),
  };
}

function mapRow(row: ChangePlanRow): ChangePlanRecord {
  const schemaVersion = positiveInteger(row.schema_version, "schema version");
  if (schemaVersion !== CHANGE_PLAN_SCHEMA_VERSION)
    throw new TypeError(`Unsupported Change Plan schema version ${schemaVersion}.`);
  if (!isChangePlanKind(row.kind) || !isChangePlanStatus(row.status))
    throw new TypeError("Stored Change Plan kind or status is invalid.");
  const request = parseObject(row.request_json, "request");
  if (!isChangePlanRequest(request) || request.kind !== row.kind)
    throw new TypeError("Stored Change Plan request is invalid.");
  const expectedScope = changePlanScopeForKind(row.kind);
  if (row.scope !== expectedScope) throw new TypeError("Stored Change Plan scope does not match its kind.");
  const expectedPhase = changePlanPhaseForStatus(row.status);
  if (row.phase !== expectedPhase) throw new TypeError("Stored Change Plan phase does not match its status.");
  const result = row.result_json ? parseObject(row.result_json, "result") : undefined;
  if (result && !isChangePlanResult(result)) throw new TypeError("Stored Change Plan result is invalid.");
  const requiredAction = row.required_action_json ? parseRequiredAction(row.required_action_json) : undefined;
  const expectedTargetRevision =
    row.expected_target_revision === null
      ? undefined
      : positiveInteger(row.expected_target_revision, "target revision");
  const record: ChangePlanRecord = {
    schemaVersion: CHANGE_PLAN_SCHEMA_VERSION,
    planId: identifier(row.plan_id, "planId"),
    origin: {
      surface: requireOriginSurface(row.origin_surface),
      workspaceId: identifier(row.workspace_id, "workspaceId"),
      ...(row.session_id ? { sessionId: identifier(row.session_id, "sessionId") } : {}),
      ...(row.turn_id ? { turnId: identifier(row.turn_id, "turnId") } : {}),
      ...(row.requester_actor_id ? { actorId: identifier(row.requester_actor_id, "actorId") } : {}),
      ...(row.request_id ? { requestId: identifier(row.request_id, "requestId") } : {}),
    },
    adapter: {
      adapterId: identifier(row.adapter_id, "adapterId"),
      version: positiveInteger(row.adapter_version, "adapter version"),
    },
    kind: row.kind,
    scope: expectedScope,
    status: row.status,
    phase: expectedPhase,
    revision: positiveInteger(row.revision, "revision"),
    request,
    intentHash: sha256Value(row.intent_hash, "intent hash"),
    target: {
      ownerId: identifier(row.target_owner_id, "target ownerId"),
      resourceId: identifier(row.target_resource_id, "target resourceId"),
      ...(expectedTargetRevision ? { expectedRevision: expectedTargetRevision } : {}),
      ...(row.expected_target_hash ? { expectedHash: sha256Value(row.expected_target_hash, "target hash") } : {}),
    },
    title: boundedText(row.title, "title", 180),
    summary: boundedText(row.summary, "summary", 2_000),
    impact: boundedText(row.impact, "impact", 2_000),
    risk: requireRisk(row.risk),
    ...(requiredAction ? { requiredAction } : {}),
    ...(row.action_snapshot_hash
      ? { actionSnapshotHash: sha256Value(row.action_snapshot_hash, "action snapshot hash") }
      : {}),
    approvalRefs: parseReferences(row.approval_refs_json, "approval refs"),
    evidenceRefs: parseReferences(row.evidence_refs_json, "evidence refs"),
    rollbackRefs: parseReferences(row.rollback_refs_json, "rollback refs"),
    ...(result ? { result } : {}),
    ...(row.expires_at ? { expiresAt: timestamp(row.expires_at, "expiresAt") } : {}),
    createdAt: timestamp(row.created_at, "createdAt"),
    updatedAt: timestamp(row.updated_at, "updatedAt"),
    ...(row.applied_at ? { appliedAt: timestamp(row.applied_at, "appliedAt") } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.requester_actor_id ? { requesterActorId: row.requester_actor_id } : {}),
    ...(expectedTargetRevision ? { expectedTargetRevision } : {}),
  };
  return record;
}

function actionMaterial(action: ChangePlanRequiredAction | undefined): {
  json: string | null;
  snapshotHash: string | null;
  nonceHash: string | null;
} {
  if (!action) return { json: null, snapshotHash: null, nonceHash: null };
  const json = canonicalJsonString(action);
  if (Buffer.byteLength(json, "utf8") > 32_768) throw new TypeError("Change Plan required action is too large.");
  identifier(action.actionId, "actionId");
  boundedText(action.actionNonce, "actionNonce", 512);
  return { json, snapshotHash: sha256(json), nonceHash: sha256(action.actionNonce) };
}

function validateActionAuthority(row: ChangePlanRow, input: ChangePlanRepositoryTransitionInput): void {
  if (!row.action_nonce_hash) return;
  if (input.internal === true) return;
  if (!input.actionNonce || !hashMatches(row.action_nonce_hash, input.actionNonce)) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "Change Plan action nonce is missing, stale, or already consumed.",
    });
  }
}

function parseRequiredAction(json: string): ChangePlanRequiredAction {
  const value = parseObject(json, "required action") as Partial<ChangePlanRequiredAction>;
  if (
    typeof value.kind !== "string" ||
    typeof value.actionId !== "string" ||
    typeof value.actionNonce !== "string" ||
    typeof value.title !== "string"
  ) {
    throw new TypeError("Stored Change Plan required action is invalid.");
  }
  return value as ChangePlanRequiredAction;
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new TypeError(`Stored Change Plan ${label} is invalid.`);
}

function parseReferences(value: string, label: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      validateReferences(parsed);
      return parsed;
    }
  } catch {
    // fall through
  }
  throw new TypeError(`Stored Change Plan ${label} are invalid.`);
}

function validateReferences(value: readonly unknown[] | undefined): void {
  if (!value) return;
  if (
    value.length > 64 ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0 || item.length > 512)
  ) {
    throw new TypeError("Change Plan references are invalid.");
  }
}

function referenceJson(value: readonly string[] | undefined): string {
  validateReferences(value);
  return canonicalJsonString([...(value ?? [])]);
}

function mergeReferences(current: readonly string[], incoming: readonly string[] | undefined): readonly string[] {
  validateReferences(incoming);
  return [...new Set([...current, ...(incoming ?? [])])].slice(0, 64);
}

function targetKey(workspaceId: string, target: ChangePlanTargetRef): string {
  return sha256(canonicalJsonString({ workspaceId, ownerId: target.ownerId, resourceId: target.resourceId }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashMatches(expected: string, raw: string): boolean {
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(sha256(raw), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n\0]/u.test(normalized))
    throw new TypeError(`Change Plan ${label} is invalid.`);
  return normalized;
}

function boundedText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\0]/u.test(normalized))
    throw new TypeError(`Change Plan ${label} is invalid.`);
  return normalized;
}

function timestamp(value: string, label: string): string {
  const normalized = boundedText(value, label, 80);
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`Change Plan ${label} is invalid.`);
  return normalized;
}

function positiveInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`Change Plan ${label} is invalid.`);
  return parsed;
}

function sha256Value(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new TypeError(`Change Plan ${label} is invalid.`);
  return value;
}

function requireRisk(value: string): ChangePlanRisk {
  if (value !== "safe" && value !== "caution" && value !== "danger")
    throw new TypeError("Stored Change Plan risk is invalid.");
  return value;
}

function requireOriginSurface(value: string): ChangePlanOrigin["surface"] {
  if (value !== "chat" && value !== "settings" && value !== "system")
    throw new TypeError("Stored Change Plan origin is invalid.");
  return value;
}

function requireStatus(value: string): ChangePlanStatus {
  if (!isChangePlanStatus(value)) throw new TypeError("Stored Change Plan status is invalid.");
  return value;
}

function staleConflict(current: ChangePlanRecord, expectedRevision: number): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: `Change Plan ${current.planId} changed since revision ${expectedRevision}.`,
    details: {
      resourceKind: "change_plan",
      resourceId: current.planId,
      expectedRevision,
      currentRevision: current.revision,
    },
  });
}

function conflict(message: string, current?: ChangePlanRecord): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message,
    ...(current
      ? { details: { resourceKind: "change_plan", resourceId: current.planId, currentRevision: current.revision } }
      : {}),
  });
}
