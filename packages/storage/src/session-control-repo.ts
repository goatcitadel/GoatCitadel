/* eslint-disable max-lines -- HX-411 keeps cross-dialect authority, replay, and fencing invariants in one audited boundary. */
import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  SESSION_CONTROL_LIVE_LEASE_SECONDS,
  SESSION_CONTROL_MAX_LIST_ITEMS,
  SESSION_CONTROL_RECONNECT_WINDOW_SECONDS,
  SESSION_CONTROL_TOKEN_TTL_SECONDS,
  ValidationError,
  assertSessionControlEffectiveCapabilities,
  canonicalJsonString,
  normalizeExternalSessionControlCapabilities,
  normalizeSessionControlTokenHashSha256,
  parseSessionControlDetailResponse,
  parseSessionControlEventRecord,
  parseSessionControlListResponse,
  parseSessionControlRecord,
  parseSessionControlRequestRecord,
  sessionControlTokenFingerprint,
  type ExternalSessionControlCapability,
  type ExternalSessionControlCapabilitySet,
  type SessionControlDetailResponse,
  type SessionControlEventRecord,
  type SessionControlListResponse,
  type SessionControlRecord,
  type SessionControlRequestRecord,
} from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export interface InitializeSessionControlInput {
  workspaceId: string;
  sessionId: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface CreateExternalSessionControlRequestInput {
  workspaceId: string;
  sessionId: string;
  companionSessionId: string;
  deviceGrantId: string;
  clientInstanceId: string;
  principalPurpose: "session_control_client";
  expectedGeneration: number;
  tokenHashSha256: string;
  capabilities: readonly ExternalSessionControlCapability[];
  idempotencyKey: string;
  correlationId: string;
}

export interface HandoffSessionControlInput {
  workspaceId: string;
  sessionId: string;
  requestId: string;
  expectedGeneration: number;
  effectiveCapabilities: readonly ExternalSessionControlCapability[];
  operatorActorId: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface CancelExternalSessionControlRequestInput {
  workspaceId: string;
  sessionId: string;
  requestId: string;
  operatorActorId: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface ExternalSessionControlIdentity {
  workspaceId: string;
  sessionId: string;
  companionSessionId: string;
  deviceGrantId: string;
  clientInstanceId: string;
  principalPurpose: "session_control_client";
  expectedGeneration: number;
  tokenHashSha256: string;
  idempotencyKey: string;
  correlationId: string;
}

export type HeartbeatSessionControlInput = ExternalSessionControlIdentity;

export interface MarkSessionControlStaleInput {
  workspaceId: string;
  sessionId: string;
  expectedGeneration: number;
  expectedControlRevision: number;
  idempotencyKey: string;
  correlationId: string;
}

export interface ReconnectSessionControlInput extends ExternalSessionControlIdentity {
  newTokenHashSha256: string;
}

export type ReleaseSessionControlInput = ExternalSessionControlIdentity;

export interface RevokeSessionControlInput {
  workspaceId: string;
  sessionId: string;
  expectedGeneration: number;
  mode: "revoke" | "emergency_takeover";
  operatorActorId: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface RevokeIdentityAmbiguityInput {
  workspaceId: string;
  sessionId: string;
  expectedGeneration: number;
  systemActorId: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface AuthRevokeSessionControlsInput {
  bindingKind: "companion_session" | "device_grant";
  bindingId: string;
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
}

export type ResolveSessionMutationAuthorityInput =
  | {
      actorKind: "operator";
      workspaceId: string;
      sessionId: string;
      expectedGeneration: number;
    }
  | {
      actorKind: "external_companion";
      workspaceId: string;
      sessionId: string;
      expectedGeneration: number;
      companionSessionId: string;
      deviceGrantId: string;
      clientInstanceId: string;
      principalPurpose: "session_control_client";
      tokenHashSha256: string;
      requiredCapability: ExternalSessionControlCapability;
    };

export interface SessionControlTransitionOutcome {
  disposition: "created" | "replayed";
  control: SessionControlRecord;
}

export interface InitializeSessionControlOutcome {
  disposition: "created" | "already_initialized" | "replayed";
  control: SessionControlRecord;
}

export interface CreateSessionControlRequestOutcome {
  disposition: "created" | "replayed";
  request: SessionControlRequestRecord;
  control: SessionControlRecord;
}

export interface HandoffSessionControlOutcome extends SessionControlTransitionOutcome {
  request: SessionControlRequestRecord;
}

export interface CancelSessionControlRequestOutcome {
  disposition: "created" | "replayed";
  request: SessionControlRequestRecord;
  control: SessionControlRecord;
}

export interface AuthRevokeSessionControlsOutcome {
  disposition: "created" | "replayed";
  occurredAt: string;
  occurredAtBasis: "operation" | "legacy_receipt";
  controls: SessionControlRecord[];
}

export interface ListSessionControlEventsOptions {
  limit?: number;
}

/**
 * One content-free control-event paired with its durable `event_sequence`. The
 * sequence travels out-of-band (the contract `SessionControlEventRecord` stays
 * content-free and omits it) so the realtime stream can use it as a monotonic,
 * replay-stable, per-session forward cursor.
 */
export interface SessionControlEventStreamRow {
  readonly sequence: number;
  readonly event: SessionControlEventRecord;
}

interface SessionMetaRow {
  session_id: string;
  workspace_id: string;
}

interface TokenRow {
  token_sha256: string;
  workspace_id: string;
  session_id: string;
  first_request_id: string | null;
  created_at: string;
}

interface AuthBindingRow {
  companion_session_id: string;
  companion_grant_id: string;
  companion_principal_purpose: string;
  device_grant_id: string;
  device_request_id: string;
  device_principal_purpose: string;
  request_principal_purpose: string;
}

interface RequestRow {
  request_id: string;
  workspace_id: string;
  session_id: string;
  companion_session_id: string;
  device_grant_id: string;
  client_instance_id: string;
  principal_purpose: string;
  token_sha256: string;
  requested_capabilities_json: string;
  requested_capabilities_sha256: string;
  requested_generation: number | bigint | string;
  status: string;
  idempotency_key: string;
  request_sha256: string;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
  decided_by_actor_id: string | null;
  decision_reason_code: string | null;
  activated_generation: number | bigint | string | null;
}

interface GrantRow {
  workspace_id: string;
  session_id: string;
  generation: number | bigint | string;
  is_current: number | bigint | string;
  owner_kind: string;
  lease_state: string;
  request_id: string | null;
  companion_session_id: string | null;
  device_grant_id: string | null;
  client_instance_id: string | null;
  principal_purpose: string | null;
  requested_capabilities_json: string;
  requested_capabilities_sha256: string;
  effective_capabilities_json: string;
  effective_capabilities_sha256: string;
  token_sha256: string | null;
  token_expires_at: string | null;
  last_heartbeat_at: string | null;
  lease_expires_at: string | null;
  reconnect_expires_at: string | null;
  control_revision: number | bigint | string;
  transition_idempotency_key: string;
  transition_request_sha256: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

interface EventRow {
  event_id: string;
  workspace_id: string;
  session_id: string;
  event_sequence: number | bigint | string;
  request_id: string | null;
  previous_generation: number | bigint | string | null;
  next_generation: number | bigint | string;
  previous_owner_kind: string | null;
  next_owner_kind: string | null;
  previous_lease_state: string | null;
  next_lease_state: string;
  reason_code: string;
  actor_kind: string;
  actor_id: string;
  companion_session_id: string | null;
  device_grant_id: string | null;
  idempotency_key: string;
  request_sha256: string;
  correlation_id: string;
  created_at: string;
}

interface AuthRevokeReceiptRow {
  idempotency_key: string;
  request_sha256: string;
  binding_kind: string;
  binding_id: string;
  actor_id: string;
  correlation_id: string;
  target_count: number | bigint | string;
  session_count: number | bigint | string;
  event_set_sha256: string;
  created_at: string;
}

interface AuthRevokeOperationRow {
  idempotency_key: string;
  request_sha256: string;
  binding_kind: string;
  binding_id: string;
  actor_id: string;
  correlation_id: string;
  target_count: number | bigint | string;
  session_count: number | bigint | string;
  event_set_sha256: string;
  occurred_at: string;
}

interface AuthRevokeOperationTargetRow {
  operation_idempotency_key: string;
  target_index: number | bigint | string;
  target_kind: "pending_request" | "current_grant";
  workspace_id: string;
  session_id: string;
  request_id: string | null;
  generation: number | bigint | string;
  control_revision: number | bigint | string;
  owner_kind: "operator" | "external_companion";
  lease_state: "operator_active" | "external_live" | "external_stale";
  event_id: string;
  event_sequence: number | bigint | string;
  event_idempotency_key: string;
  event_reason_code: "auth_revoked" | "mutation_denied" | "request_expired";
}

interface DatabaseClockRow {
  now: string;
  token_expires_at: string;
  lease_expires_at: string;
  reconnect_expires_at: string;
}

const EMPTY_CAPABILITIES_JSON = "[]";

export class SessionControlRepository {
  public constructor(private readonly db: DatabaseClient) {}

  public initializeExistingSession(input: InitializeSessionControlInput): InitializeSessionControlOutcome {
    const normalized = normalizeInitializationInput(input);
    const requestSha256 = operationSha256("initialize", normalized);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        this.requireSessionMeta(normalized.workspaceId, normalized.sessionId, true);
        const replay = this.findEventByIdempotency(normalized.idempotencyKey);
        if (replay) {
          assertExactReplay(replay.request_sha256, requestSha256, "session control initialization");
          return { disposition: "replayed", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
        }
        const rows = this.findGrantRows(normalized.sessionId);
        if (rows.length > 0) {
          const current = rows.filter((row) => asBoolean(row.is_current));
          const validLedger =
            rows.every(
              (row, index) =>
                row.workspace_id === normalized.workspaceId && asPositiveInteger(row.generation) === index + 1,
            ) &&
            current.length === 1 &&
            asPositiveInteger(current[0]!.generation) === rows.length &&
            asPositiveInteger(rows[0]!.generation) === 1 &&
            rows[0]!.owner_kind === "operator";
          if (validLedger) {
            return { disposition: "already_initialized", control: this.mapControl(current[0]!) };
          }
          throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control state is corrupt.");
        }
        const clock = this.readDatabaseClock();
        this.insertOperatorGeneration({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          generation: 1,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          now: clock.now,
        });
        this.insertEvent({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          nextGeneration: 1,
          nextOwnerKind: "operator",
          nextLeaseState: "operator_active",
          reasonCode: "session_initialized",
          actorKind: "system",
          actorId: "system",
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          correlationId: normalized.correlationId,
          createdAt: clock.now,
        });
        return { disposition: "created", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
      });
    } catch (error) {
      throw normalizeWriteError(error, "session control initialization");
    }
  }

  public createExternalRequest(input: CreateExternalSessionControlRequestInput): CreateSessionControlRequestOutcome {
    const normalized = normalizeExternalRequestInput(input);
    const requestSha256 = operationSha256("request", normalized);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireAuthCouplingLock();
        this.acquireSessionLock(normalized.sessionId);
        const replay = this.findRequestByIdempotency(normalized.idempotencyKey);
        if (replay) {
          assertExactReplay(replay.request_sha256, requestSha256, "session control request");
          return {
            disposition: "replayed",
            request: this.mapRequest(replay),
            control: this.getControl(normalized.workspaceId, normalized.sessionId),
          };
        }
        this.requireSessionMeta(normalized.workspaceId, normalized.sessionId, true);
        const current = this.requireCurrentGrant(normalized.workspaceId, normalized.sessionId, true);
        if (
          current.owner_kind !== "operator" ||
          current.lease_state !== "operator_active" ||
          asPositiveInteger(current.generation) !== normalized.expectedGeneration
        ) {
          throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control generation is stale.");
        }
        const clock = this.readDatabaseClock();
        this.requireActiveAuthBinding(normalized.companionSessionId, normalized.deviceGrantId, clock.now);
        const requestId = deriveId("scr", normalized.workspaceId, normalized.sessionId, normalized.idempotencyKey);
        const capabilitiesJson = canonicalJsonString(normalized.capabilities);
        const capabilitiesSha256 = sha256(capabilitiesJson);
        this.insertTokenHash({
          tokenHashSha256: normalized.tokenHashSha256,
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          firstRequestId: requestId,
          createdAt: clock.now,
        });
        this.db
          .prepare(
            `
            INSERT INTO chat_session_control_requests (
              request_id, workspace_id, session_id, companion_session_id, device_grant_id,
              client_instance_id, principal_purpose, token_sha256, requested_capabilities_json,
              requested_capabilities_sha256, requested_generation, status, idempotency_key,
              request_sha256, expires_at, created_at
            ) VALUES (
              @requestId, @workspaceId, @sessionId, @companionSessionId, @deviceGrantId,
              @clientInstanceId, 'session_control_client', @tokenHashSha256, @capabilitiesJson,
              @capabilitiesSha256, @requestedGeneration, 'pending', @idempotencyKey,
              @requestSha256, @expiresAt, @createdAt
            )
          `,
          )
          .run({
            requestId,
            workspaceId: normalized.workspaceId,
            sessionId: normalized.sessionId,
            companionSessionId: normalized.companionSessionId,
            deviceGrantId: normalized.deviceGrantId,
            clientInstanceId: normalized.clientInstanceId,
            tokenHashSha256: normalized.tokenHashSha256,
            capabilitiesJson,
            capabilitiesSha256,
            requestedGeneration: normalized.expectedGeneration,
            idempotencyKey: normalized.idempotencyKey,
            requestSha256,
            expiresAt: clock.token_expires_at,
            createdAt: clock.now,
          });
        this.insertEvent({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          requestId,
          previousGeneration: normalized.expectedGeneration,
          nextGeneration: normalized.expectedGeneration,
          previousOwnerKind: "operator",
          nextOwnerKind: "operator",
          previousLeaseState: "operator_active",
          nextLeaseState: "operator_active",
          reasonCode: "request_created",
          actorKind: "external_companion",
          actorId: normalized.companionSessionId,
          companionSessionId: normalized.companionSessionId,
          deviceGrantId: normalized.deviceGrantId,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          correlationId: normalized.correlationId,
          createdAt: clock.now,
        });
        return {
          disposition: "created",
          request: this.getRequest(requestId),
          control: this.getControl(normalized.workspaceId, normalized.sessionId),
        };
      });
    } catch (error) {
      throw normalizeWriteError(error, "session control request");
    }
  }

  public cancelExternalRequest(input: CancelExternalSessionControlRequestInput): CancelSessionControlRequestOutcome {
    const normalized = normalizeCancelRequestInput(input);
    const requestSha256 = operationSha256("cancel_request", normalized);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        const replay = this.findEventByIdempotency(normalized.idempotencyKey);
        if (replay) {
          assertExactReplay(replay.request_sha256, requestSha256, "session control request cancellation");
          return {
            disposition: "replayed",
            request: this.getRequest(normalized.requestId),
            control: this.getControl(normalized.workspaceId, normalized.sessionId),
          };
        }
        this.requireSessionMeta(normalized.workspaceId, normalized.sessionId, true);
        const current = this.requireCurrentGrant(normalized.workspaceId, normalized.sessionId, true);
        const request = this.getRequestRowForUpdate(normalized.requestId);
        if (
          current.owner_kind !== "operator" ||
          current.lease_state !== "operator_active" ||
          request.workspace_id !== normalized.workspaceId ||
          request.session_id !== normalized.sessionId ||
          request.status !== "pending" ||
          asPositiveInteger(request.requested_generation) !== asPositiveInteger(current.generation)
        ) {
          throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control request is not current.");
        }
        const clock = this.readDatabaseClock();
        if (request.expires_at <= clock.now) {
          throw stateConflict("SESSION_CONTROL_RECONNECT_EXPIRED", "Session control request is expired.");
        }
        this.db
          .prepare(
            `UPDATE chat_session_control_requests
             SET status = 'cancelled', decided_at = @decidedAt, decided_by_actor_id = @actorId,
                 decision_reason_code = 'request_cancelled'
             WHERE request_id = @requestId AND status = 'pending'`,
          )
          .run({
            requestId: normalized.requestId,
            decidedAt: clock.now,
            actorId: normalized.operatorActorId,
          });
        const generation = asPositiveInteger(current.generation);
        this.insertEvent({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          requestId: normalized.requestId,
          previousGeneration: generation,
          nextGeneration: generation,
          previousOwnerKind: "operator",
          nextOwnerKind: "operator",
          previousLeaseState: "operator_active",
          nextLeaseState: "operator_active",
          reasonCode: "request_cancelled",
          actorKind: "operator",
          actorId: normalized.operatorActorId,
          companionSessionId: request.companion_session_id,
          deviceGrantId: request.device_grant_id,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          correlationId: normalized.correlationId,
          createdAt: clock.now,
        });
        return {
          disposition: "created",
          request: this.getRequest(normalized.requestId),
          control: this.getControl(normalized.workspaceId, normalized.sessionId),
        };
      });
    } catch (error) {
      throw normalizeWriteError(error, "session control request cancellation");
    }
  }

  public handoff(input: HandoffSessionControlInput): HandoffSessionControlOutcome {
    const normalized = normalizeHandoffInput(input);
    const requestSha256 = operationSha256("handoff", normalized);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireAuthCouplingLock();
        this.acquireSessionLock(normalized.sessionId);
        const replay = this.findEventByIdempotency(normalized.idempotencyKey);
        if (replay) {
          assertExactReplay(replay.request_sha256, requestSha256, "session control handoff");
          const request = this.getRequest(normalized.requestId);
          return {
            disposition: "replayed",
            request,
            control: this.getControl(normalized.workspaceId, normalized.sessionId),
          };
        }
        this.requireSessionMeta(normalized.workspaceId, normalized.sessionId, true);
        const current = this.requireCurrentGrant(normalized.workspaceId, normalized.sessionId, true);
        if (
          current.owner_kind !== "operator" ||
          current.lease_state !== "operator_active" ||
          asPositiveInteger(current.generation) !== normalized.expectedGeneration
        ) {
          throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control generation is stale.");
        }
        const request = this.getRequestRowForUpdate(normalized.requestId);
        if (
          request.workspace_id !== normalized.workspaceId ||
          request.session_id !== normalized.sessionId ||
          request.status !== "pending" ||
          asPositiveInteger(request.requested_generation) !== normalized.expectedGeneration
        ) {
          throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control request is not current.");
        }
        const effectiveCapabilities = assertSessionControlEffectiveCapabilities(
          parseCapabilities(request.requested_capabilities_json),
          normalized.effectiveCapabilities,
        );
        const clock = this.readDatabaseClock();
        if (request.expires_at <= clock.now) {
          throw stateConflict("SESSION_CONTROL_RECONNECT_EXPIRED", "Session control request is expired.");
        }
        this.requireActiveAuthBinding(request.companion_session_id, request.device_grant_id, clock.now);
        const nextGeneration = incrementGeneration(normalized.expectedGeneration);
        this.terminalizeCurrentGrant(current, "superseded", clock.now);
        this.db
          .prepare(
            `
            UPDATE chat_session_control_requests
            SET status = 'activated', decided_at = @decidedAt, decided_by_actor_id = @actorId,
                decision_reason_code = 'handoff', activated_generation = @activatedGeneration
            WHERE request_id = @requestId AND status = 'pending'
          `,
          )
          .run({
            requestId: normalized.requestId,
            decidedAt: clock.now,
            actorId: normalized.operatorActorId,
            activatedGeneration: nextGeneration,
          });
        const effectiveCapabilitiesJson = canonicalJsonString(effectiveCapabilities);
        this.insertExternalGeneration({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          generation: nextGeneration,
          request,
          requestedCapabilitiesJson: request.requested_capabilities_json,
          requestedCapabilitiesSha256: request.requested_capabilities_sha256,
          effectiveCapabilitiesJson,
          effectiveCapabilitiesSha256: sha256(effectiveCapabilitiesJson),
          tokenHashSha256: request.token_sha256,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          clock,
        });
        this.insertEvent({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          requestId: normalized.requestId,
          previousGeneration: normalized.expectedGeneration,
          nextGeneration,
          previousOwnerKind: "operator",
          nextOwnerKind: "external_companion",
          previousLeaseState: "operator_active",
          nextLeaseState: "external_live",
          reasonCode: "handoff",
          actorKind: "operator",
          actorId: normalized.operatorActorId,
          companionSessionId: request.companion_session_id,
          deviceGrantId: request.device_grant_id,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          correlationId: normalized.correlationId,
          createdAt: clock.now,
        });
        return {
          disposition: "created",
          request: this.getRequest(normalized.requestId),
          control: this.getControl(normalized.workspaceId, normalized.sessionId),
        };
      });
    } catch (error) {
      throw normalizeWriteError(error, "session control handoff");
    }
  }

  public heartbeat(input: HeartbeatSessionControlInput): SessionControlTransitionOutcome {
    const normalized = normalizeExternalIdentity(input);
    const requestSha256 = operationSha256("heartbeat", normalized);
    return this.runExternalSameGenerationTransition("heartbeat", normalized, requestSha256, (current, clock) => {
      this.assertExternalIdentity(current, normalized, clock, { requireLiveLease: true });
      this.db
        .prepare(
          `
          UPDATE chat_session_control_grants
          SET last_heartbeat_at = @now, lease_expires_at = @leaseExpiresAt,
              reconnect_expires_at = @reconnectExpiresAt, control_revision = control_revision + 1,
              updated_at = @now
          WHERE session_id = @sessionId AND generation = @generation AND is_current = 1
        `,
        )
        .run({
          sessionId: normalized.sessionId,
          generation: normalized.expectedGeneration,
          now: clock.now,
          leaseExpiresAt: clock.lease_expires_at,
          reconnectExpiresAt: clock.reconnect_expires_at,
        });
      this.insertEvent({
        workspaceId: normalized.workspaceId,
        sessionId: normalized.sessionId,
        requestId: current.request_id ?? undefined,
        previousGeneration: normalized.expectedGeneration,
        nextGeneration: normalized.expectedGeneration,
        previousOwnerKind: "external_companion",
        nextOwnerKind: "external_companion",
        previousLeaseState: "external_live",
        nextLeaseState: "external_live",
        reasonCode: "heartbeat",
        actorKind: "external_companion",
        actorId: normalized.companionSessionId,
        companionSessionId: normalized.companionSessionId,
        deviceGrantId: normalized.deviceGrantId,
        idempotencyKey: normalized.idempotencyKey,
        requestSha256,
        correlationId: normalized.correlationId,
        createdAt: clock.now,
      });
    });
  }

  public markStale(input: MarkSessionControlStaleInput): SessionControlTransitionOutcome {
    const normalized = normalizeMarkStaleInput(input);
    const requestSha256 = operationSha256("mark_stale", normalized);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        const replay = this.findEventByIdempotency(normalized.idempotencyKey);
        if (replay) {
          assertExactReplay(replay.request_sha256, requestSha256, "session control stale transition");
          return { disposition: "replayed", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
        }
        const current = this.requireCurrentGrant(normalized.workspaceId, normalized.sessionId, true);
        const clock = this.readDatabaseClock();
        if (
          current.owner_kind !== "external_companion" ||
          current.lease_state !== "external_live" ||
          asPositiveInteger(current.generation) !== normalized.expectedGeneration ||
          asPositiveInteger(current.control_revision) !== normalized.expectedControlRevision
        ) {
          throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control generation is stale.");
        }
        const updated = this.db
          .prepare(
            `
            UPDATE chat_session_control_grants
            SET lease_state = 'external_stale', control_revision = control_revision + 1, updated_at = @now
            WHERE session_id = @sessionId AND generation = @generation AND is_current = 1
              AND owner_kind = 'external_companion' AND lease_state = 'external_live'
              AND control_revision = @controlRevision
          `,
          )
          .run({
            sessionId: normalized.sessionId,
            generation: normalized.expectedGeneration,
            controlRevision: normalized.expectedControlRevision,
            now: clock.now,
          });
        if (updated.changes !== 1) {
          throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control generation is stale.");
        }
        this.insertEvent({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          requestId: current.request_id ?? undefined,
          previousGeneration: normalized.expectedGeneration,
          nextGeneration: normalized.expectedGeneration,
          previousOwnerKind: "external_companion",
          nextOwnerKind: "external_companion",
          previousLeaseState: "external_live",
          nextLeaseState: "external_stale",
          reasonCode: "lease_stale",
          actorKind: "system",
          actorId: "system",
          companionSessionId: current.companion_session_id ?? undefined,
          deviceGrantId: current.device_grant_id ?? undefined,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          correlationId: normalized.correlationId,
          createdAt: clock.now,
        });
        return { disposition: "created", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
      });
    } catch (error) {
      throw normalizeWriteError(error, "session control stale transition");
    }
  }

  public reconnect(input: ReconnectSessionControlInput): SessionControlTransitionOutcome {
    const normalized = normalizeReconnectInput(input);
    const requestSha256 = operationSha256("reconnect", normalized);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        const replay = this.findEventByIdempotency(normalized.idempotencyKey);
        if (replay) {
          assertExactReplay(replay.request_sha256, requestSha256, "session control reconnect");
          return { disposition: "replayed", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
        }
        const current = this.requireCurrentGrant(normalized.workspaceId, normalized.sessionId, true);
        const clock = this.readDatabaseClock();
        this.assertExternalIdentity(current, normalized, clock, { allowStale: true, requireReconnectWindow: true });
        if (normalized.newTokenHashSha256 === normalized.tokenHashSha256) {
          throw new ValidationError({ message: "Session control reconnect token must rotate." });
        }
        const nextGeneration = incrementGeneration(normalized.expectedGeneration);
        this.insertTokenHash({
          tokenHashSha256: normalized.newTokenHashSha256,
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          createdAt: clock.now,
        });
        this.terminalizeCurrentGrant(current, "superseded", clock.now);
        this.insertExternalGeneration({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          generation: nextGeneration,
          request: currentToSyntheticRequest(current),
          requestedCapabilitiesJson: current.requested_capabilities_json,
          requestedCapabilitiesSha256: current.requested_capabilities_sha256,
          effectiveCapabilitiesJson: current.effective_capabilities_json,
          effectiveCapabilitiesSha256: current.effective_capabilities_sha256,
          tokenHashSha256: normalized.newTokenHashSha256,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          clock,
        });
        this.insertEvent({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          requestId: current.request_id ?? undefined,
          previousGeneration: normalized.expectedGeneration,
          nextGeneration,
          previousOwnerKind: "external_companion",
          nextOwnerKind: "external_companion",
          previousLeaseState: current.lease_state as "external_live" | "external_stale",
          nextLeaseState: "external_live",
          reasonCode: "reconnect",
          actorKind: "external_companion",
          actorId: normalized.companionSessionId,
          companionSessionId: normalized.companionSessionId,
          deviceGrantId: normalized.deviceGrantId,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          correlationId: normalized.correlationId,
          createdAt: clock.now,
        });
        return { disposition: "created", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
      });
    } catch (error) {
      throw normalizeWriteError(error, "session control reconnect");
    }
  }

  public release(input: ReleaseSessionControlInput): SessionControlTransitionOutcome {
    const normalized = normalizeExternalIdentity(input);
    const requestSha256 = operationSha256("release", normalized);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        const replay = this.findEventByIdempotency(normalized.idempotencyKey);
        if (replay) {
          assertExactReplay(replay.request_sha256, requestSha256, "session control release");
          return { disposition: "replayed", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
        }
        const current = this.requireCurrentGrant(normalized.workspaceId, normalized.sessionId, true);
        const clock = this.readDatabaseClock();
        this.assertExternalIdentity(current, normalized, clock, { allowStale: true, requireReconnectWindow: true });
        const nextGeneration = incrementGeneration(normalized.expectedGeneration);
        this.terminalizeCurrentGrant(current, "released", clock.now);
        this.insertOperatorGeneration({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          generation: nextGeneration,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          now: clock.now,
        });
        this.insertEvent({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          requestId: current.request_id ?? undefined,
          previousGeneration: normalized.expectedGeneration,
          nextGeneration,
          previousOwnerKind: "external_companion",
          nextOwnerKind: "operator",
          previousLeaseState: current.lease_state as "external_live" | "external_stale",
          nextLeaseState: "operator_active",
          reasonCode: "release",
          actorKind: "external_companion",
          actorId: normalized.companionSessionId,
          companionSessionId: normalized.companionSessionId,
          deviceGrantId: normalized.deviceGrantId,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          correlationId: normalized.correlationId,
          createdAt: clock.now,
        });
        return { disposition: "created", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
      });
    } catch (error) {
      throw normalizeWriteError(error, "session control release");
    }
  }

  public revoke(input: RevokeSessionControlInput): SessionControlTransitionOutcome {
    const normalized = normalizeRevokeInput(input);
    const requestSha256 = operationSha256("revoke", normalized);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        const replay = this.findEventByIdempotency(normalized.idempotencyKey);
        if (replay) {
          assertExactReplay(replay.request_sha256, requestSha256, "session control revoke");
          return { disposition: "replayed", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
        }
        const current = this.requireCurrentGrant(normalized.workspaceId, normalized.sessionId, true);
        if (
          current.owner_kind !== "external_companion" ||
          !["external_live", "external_stale"].includes(current.lease_state) ||
          asPositiveInteger(current.generation) !== normalized.expectedGeneration
        ) {
          throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control generation is stale.");
        }
        const clock = this.readDatabaseClock();
        const nextGeneration = incrementGeneration(normalized.expectedGeneration);
        this.terminalizeCurrentGrant(current, "revoked", clock.now);
        this.insertOperatorGeneration({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          generation: nextGeneration,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          now: clock.now,
        });
        const reasonCode = normalized.mode === "revoke" ? "operator_revoke" : "emergency_takeover";
        this.insertEvent({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          requestId: current.request_id ?? undefined,
          previousGeneration: normalized.expectedGeneration,
          nextGeneration,
          previousOwnerKind: "external_companion",
          nextOwnerKind: "operator",
          previousLeaseState: current.lease_state as "external_live" | "external_stale",
          nextLeaseState: "operator_active",
          reasonCode,
          actorKind: "operator",
          actorId: normalized.operatorActorId,
          companionSessionId: current.companion_session_id ?? undefined,
          deviceGrantId: current.device_grant_id ?? undefined,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          correlationId: normalized.correlationId,
          createdAt: clock.now,
        });
        return { disposition: "created", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
      });
    } catch (error) {
      throw normalizeWriteError(error, "session control revoke");
    }
  }

  public revokeIdentityAmbiguity(input: RevokeIdentityAmbiguityInput): SessionControlTransitionOutcome {
    const normalized = normalizeIdentityAmbiguityInput(input);
    const requestSha256 = operationSha256("identity_ambiguity", normalized);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        const replay = this.findEventByIdempotency(normalized.idempotencyKey);
        if (replay) {
          assertExactReplay(replay.request_sha256, requestSha256, "session control identity revocation");
          return { disposition: "replayed", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
        }
        const current = this.requireCurrentGrant(normalized.workspaceId, normalized.sessionId, true);
        if (
          current.owner_kind !== "external_companion" ||
          !["external_live", "external_stale"].includes(current.lease_state) ||
          asPositiveInteger(current.generation) !== normalized.expectedGeneration
        ) {
          throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control generation is stale.");
        }
        const clock = this.readDatabaseClock();
        const nextGeneration = incrementGeneration(normalized.expectedGeneration);
        this.terminalizeCurrentGrant(current, "revoked", clock.now);
        this.insertOperatorGeneration({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          generation: nextGeneration,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          now: clock.now,
        });
        this.insertEvent({
          workspaceId: normalized.workspaceId,
          sessionId: normalized.sessionId,
          requestId: current.request_id ?? undefined,
          previousGeneration: normalized.expectedGeneration,
          nextGeneration,
          previousOwnerKind: "external_companion",
          nextOwnerKind: "operator",
          previousLeaseState: current.lease_state as "external_live" | "external_stale",
          nextLeaseState: "operator_active",
          reasonCode: "identity_revoked",
          actorKind: "system",
          actorId: normalized.systemActorId,
          companionSessionId: current.companion_session_id ?? undefined,
          deviceGrantId: current.device_grant_id ?? undefined,
          idempotencyKey: normalized.idempotencyKey,
          requestSha256,
          correlationId: normalized.correlationId,
          createdAt: clock.now,
        });
        return { disposition: "created", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
      });
    } catch (error) {
      throw normalizeWriteError(error, "session control identity revocation");
    }
  }

  public revokeByAuthBinding(input: AuthRevokeSessionControlsInput): AuthRevokeSessionControlsOutcome {
    const normalized = normalizeAuthRevokeInput(input);
    const requestSha256 = operationSha256("auth_revoke", normalized);
    try {
      return this.db.transaction("immediate", () => {
        this.acquireAuthCouplingLock();
        const bindingColumn =
          normalized.bindingKind === "companion_session" ? "companion_session_id" : "device_grant_id";
        const receipt = this.findAuthRevokeReceipt(normalized.idempotencyKey);
        if (receipt) {
          return this.replayAuthRevokeReceipt(receipt, normalized, requestSha256);
        }
        if (this.findAuthRevokeOperation(normalized.idempotencyKey)) {
          throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Auth revoke operation has no immutable receipt.");
        }
        const orphanRoot = this.db
          .prepare(
            `SELECT event_id FROM chat_session_control_events
             WHERE idempotency_key = @idempotencyKey LIMIT 1`,
          )
          .get<{ event_id: string }>({ idempotencyKey: normalized.idempotencyKey });
        if (orphanRoot || this.listAuthRevokeEvents(requestSha256).length > 0) {
          throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Auth revoke receipt evidence is missing or corrupt.");
        }
        const pendingCandidates = this.db
          .prepare(
            `SELECT session_id FROM chat_session_control_requests
             WHERE status = 'pending' AND ${bindingColumn} = @bindingId
             ORDER BY session_id ASC, request_id ASC`,
          )
          .all<{ session_id: string }>({ bindingId: normalized.bindingId });
        const grantCandidates = this.db
          .prepare(
            `SELECT session_id FROM chat_session_control_grants
             WHERE is_current = 1 AND owner_kind = 'external_companion' AND ${bindingColumn} = @bindingId
             ORDER BY session_id ASC`,
          )
          .all<{ session_id: string }>({ bindingId: normalized.bindingId });
        const candidateSessionIds = [
          ...new Set([...pendingCandidates, ...grantCandidates].map((candidate) => candidate.session_id)),
        ].sort();
        for (const sessionId of candidateSessionIds) this.acquireSessionLock(sessionId);
        const pending = this.db
          .prepare(
            `SELECT * FROM chat_session_control_requests
             WHERE status = 'pending' AND ${bindingColumn} = @bindingId
             ORDER BY session_id ASC, request_id ASC${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
          )
          .all<RequestRow>({ bindingId: normalized.bindingId });
        const lockedGrants = this.db
          .prepare(
            `SELECT * FROM chat_session_control_grants
             WHERE is_current = 1 AND owner_kind = 'external_companion' AND ${bindingColumn} = @bindingId
             ORDER BY session_id ASC${this.db.dialect === "postgres" ? " FOR UPDATE" : ""}`,
          )
          .all<GrantRow>({ bindingId: normalized.bindingId });
        const occurredAt = this.readDatabaseClock().now;
        const touchedSessions = new Set<string>();
        let evidenceIndex = 0;
        const evidenceIdempotencyKey = (kind: "pending" | "grant", sessionId: string, targetId: string): string => {
          if (evidenceIndex++ === 0) return normalized.idempotencyKey;
          return deriveAuthRevokeEvidenceIdempotencyKey(normalized.idempotencyKey, kind, sessionId, targetId);
        };
        const nextEventSequences = new Map<string, number>();
        const nextEventSequence = (sessionId: string): number => {
          const previous =
            nextEventSequences.get(sessionId) ??
            asNonNegativeInteger(
              this.db
                .prepare(
                  "SELECT COALESCE(MAX(event_sequence), 0) AS sequence FROM chat_session_control_events WHERE session_id = @sessionId",
                )
                .get<{ sequence: number | bigint | string }>({ sessionId })?.sequence ?? 0,
            );
          const next = previous + 1;
          nextEventSequences.set(sessionId, next);
          return next;
        };
        const pendingPlan: Array<{
          request: RequestRow;
          current: GrantRow;
          event: EventRow;
          target: AuthRevokeOperationTargetRow;
        }> = [];
        const grantPlan: Array<{ current: GrantRow; event: EventRow; target: AuthRevokeOperationTargetRow }> = [];
        let targetIndex = 0;
        for (const request of pending) {
          this.assertRequestIntegrity(request);
          const current = this.requireCurrentGrant(request.workspace_id, request.session_id, true);
          const generation = asPositiveInteger(current.generation);
          const expired = request.expires_at <= occurredAt;
          const idempotencyKey = evidenceIdempotencyKey("pending", request.session_id, request.request_id);
          const reasonCode = expired ? "request_expired" : "mutation_denied";
          const eventSequence = nextEventSequence(request.session_id);
          const eventId = deriveId("sce", request.workspace_id, request.session_id, idempotencyKey, reasonCode);
          const event: EventRow = {
            event_id: eventId,
            workspace_id: request.workspace_id,
            session_id: request.session_id,
            event_sequence: eventSequence,
            request_id: request.request_id,
            previous_generation: generation,
            next_generation: generation,
            previous_owner_kind: current.owner_kind,
            next_owner_kind: current.owner_kind,
            previous_lease_state: current.lease_state,
            next_lease_state: current.lease_state,
            reason_code: reasonCode,
            actor_kind: "system",
            actor_id: normalized.actorId,
            companion_session_id: request.companion_session_id,
            device_grant_id: request.device_grant_id,
            idempotency_key: idempotencyKey,
            request_sha256: requestSha256,
            correlation_id: normalized.correlationId,
            created_at: occurredAt,
          };
          pendingPlan.push({
            request,
            current,
            event,
            target: {
              operation_idempotency_key: normalized.idempotencyKey,
              target_index: targetIndex++,
              target_kind: "pending_request",
              workspace_id: request.workspace_id,
              session_id: request.session_id,
              request_id: request.request_id,
              generation,
              control_revision: asPositiveInteger(current.control_revision),
              owner_kind: current.owner_kind as "operator" | "external_companion",
              lease_state: current.lease_state as "operator_active" | "external_live" | "external_stale",
              event_id: eventId,
              event_sequence: eventSequence,
              event_idempotency_key: idempotencyKey,
              event_reason_code: reasonCode,
            },
          });
        }
        for (const current of lockedGrants) {
          this.assertGrantIntegrity(current);
          const generation = asPositiveInteger(current.generation);
          const nextGeneration = incrementGeneration(generation);
          const idempotencyKey = evidenceIdempotencyKey("grant", current.session_id, String(generation));
          const eventSequence = nextEventSequence(current.session_id);
          const eventId = deriveId("sce", current.workspace_id, current.session_id, idempotencyKey, "auth_revoked");
          const event: EventRow = {
            event_id: eventId,
            workspace_id: current.workspace_id,
            session_id: current.session_id,
            event_sequence: eventSequence,
            request_id: current.request_id,
            previous_generation: generation,
            next_generation: nextGeneration,
            previous_owner_kind: "external_companion",
            next_owner_kind: "operator",
            previous_lease_state: current.lease_state,
            next_lease_state: "operator_active",
            reason_code: "auth_revoked",
            actor_kind: "system",
            actor_id: normalized.actorId,
            companion_session_id: current.companion_session_id,
            device_grant_id: current.device_grant_id,
            idempotency_key: idempotencyKey,
            request_sha256: requestSha256,
            correlation_id: normalized.correlationId,
            created_at: occurredAt,
          };
          grantPlan.push({
            current,
            event,
            target: {
              operation_idempotency_key: normalized.idempotencyKey,
              target_index: targetIndex++,
              target_kind: "current_grant",
              workspace_id: current.workspace_id,
              session_id: current.session_id,
              request_id: current.request_id,
              generation,
              control_revision: asPositiveInteger(current.control_revision),
              owner_kind: "external_companion",
              lease_state: current.lease_state as "external_live" | "external_stale",
              event_id: eventId,
              event_sequence: eventSequence,
              event_idempotency_key: idempotencyKey,
              event_reason_code: "auth_revoked",
            },
          });
        }
        const predictedEvents = [...pendingPlan.map((item) => item.event), ...grantPlan.map((item) => item.event)];
        const targets = [...pendingPlan.map((item) => item.target), ...grantPlan.map((item) => item.target)];
        this.insertAuthRevokeOperation(normalized, requestSha256, predictedEvents, occurredAt);
        for (const target of targets) this.insertAuthRevokeOperationTarget(target);

        for (const plan of pendingPlan) {
          const { request, current, event } = plan;
          const expired = event.reason_code === "request_expired";
          const result = this.db
            .prepare(
              `UPDATE chat_session_control_requests
               SET status = @status, decided_at = @decidedAt, decided_by_actor_id = @actorId,
                   decision_reason_code = @decisionReasonCode
               WHERE request_id = @requestId AND status = 'pending'`,
            )
            .run({
              status: expired ? "expired" : "cancelled",
              decidedAt: occurredAt,
              actorId: normalized.actorId,
              decisionReasonCode: expired ? "request_expired" : "request_cancelled",
              requestId: request.request_id,
            });
          if (result.changes !== 1) {
            throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control request is not current.");
          }
          this.insertEvent({
            workspaceId: request.workspace_id,
            sessionId: request.session_id,
            requestId: request.request_id,
            previousGeneration: asPositiveInteger(event.previous_generation ?? 0),
            nextGeneration: asPositiveInteger(event.next_generation),
            previousOwnerKind: current.owner_kind as "operator" | "external_companion",
            nextOwnerKind: current.owner_kind as "operator" | "external_companion",
            previousLeaseState: current.lease_state as "operator_active" | "external_live" | "external_stale",
            nextLeaseState: current.lease_state as "operator_active" | "external_live" | "external_stale",
            reasonCode: expired ? "request_expired" : "mutation_denied",
            actorKind: "system",
            actorId: normalized.actorId,
            companionSessionId: request.companion_session_id,
            deviceGrantId: request.device_grant_id,
            idempotencyKey: event.idempotency_key,
            requestSha256,
            correlationId: normalized.correlationId,
            createdAt: occurredAt,
          });
          touchedSessions.add(`${request.workspace_id}\u0000${request.session_id}`);
        }
        for (const plan of grantPlan) {
          const { current, event } = plan;
          const generation = asPositiveInteger(current.generation);
          const nextGeneration = incrementGeneration(generation);
          const eventIdempotencyKey = event.idempotency_key;
          this.terminalizeCurrentGrant(current, "revoked", occurredAt);
          this.insertOperatorGeneration({
            workspaceId: current.workspace_id,
            sessionId: current.session_id,
            generation: nextGeneration,
            idempotencyKey: eventIdempotencyKey,
            requestSha256,
            now: occurredAt,
          });
          this.insertEvent({
            workspaceId: current.workspace_id,
            sessionId: current.session_id,
            requestId: current.request_id ?? undefined,
            previousGeneration: generation,
            nextGeneration,
            previousOwnerKind: "external_companion",
            nextOwnerKind: "operator",
            previousLeaseState: current.lease_state as "external_live" | "external_stale",
            nextLeaseState: "operator_active",
            reasonCode: "auth_revoked",
            actorKind: "system",
            actorId: normalized.actorId,
            companionSessionId: current.companion_session_id ?? undefined,
            deviceGrantId: current.device_grant_id ?? undefined,
            idempotencyKey: eventIdempotencyKey,
            requestSha256,
            correlationId: normalized.correlationId,
            createdAt: occurredAt,
          });
          touchedSessions.add(`${current.workspace_id}\u0000${current.session_id}`);
        }
        const evidence = this.listAuthRevokeEvents(requestSha256);
        if (evidence.length !== pending.length + lockedGrants.length) {
          throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Auth revoke event set is corrupt.");
        }
        if (authRevokeEventSetSha256(evidence) !== authRevokeEventSetSha256(predictedEvents)) {
          throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Auth revoke event set changed after it was frozen.");
        }
        this.insertAuthRevokeReceipt(normalized, requestSha256, evidence, occurredAt);
        return {
          disposition: "created",
          occurredAt,
          occurredAtBasis: "operation",
          controls: [...touchedSessions].sort().map((value) => {
            const [workspaceId, sessionId] = value.split("\u0000") as [string, string];
            return this.getControl(workspaceId, sessionId);
          }),
        };
      });
    } catch (error) {
      throw normalizeWriteError(error, "session control auth revoke coupling");
    }
  }

  public resolveMutationAuthority(input: ResolveSessionMutationAuthorityInput): SessionControlRecord {
    const workspaceId = identifier(input.workspaceId, "workspaceId");
    const sessionId = identifier(input.sessionId, "sessionId");
    const expectedGeneration = generation(input.expectedGeneration);
    return this.db.transaction("immediate", () => {
      this.acquireSessionLock(sessionId);
      const current = this.requireCurrentGrant(workspaceId, sessionId, true);
      if (asPositiveInteger(current.generation) !== expectedGeneration) {
        throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control generation is stale.");
      }
      if (input.actorKind === "operator") {
        if (current.owner_kind !== "operator" || current.lease_state !== "operator_active") {
          throw stateConflict("SESSION_CONTROLLED_EXTERNALLY", "Session is controlled externally.");
        }
        return this.mapControl(current);
      }
      const normalized = normalizeExternalAuthorityInput(input);
      const clock = this.readDatabaseClock();
      this.assertExternalIdentity(current, normalized, clock, { requireLiveLease: true });
      const capabilities = parseCapabilities(
        current.effective_capabilities_json,
      ) as readonly ExternalSessionControlCapability[];
      if (!capabilities.includes(normalized.requiredCapability)) {
        throw stateConflict("SESSION_CONTROL_CAPABILITY_DENIED", "Session control capability is denied.");
      }
      return this.mapControl(current);
    });
  }

  public getControl(workspaceIdInput: string, sessionIdInput: string): SessionControlRecord {
    const workspaceId = identifier(workspaceIdInput, "workspaceId");
    const sessionId = identifier(sessionIdInput, "sessionId");
    return this.mapControl(this.requireCurrentGrant(workspaceId, sessionId, false));
  }

  public getDetail(workspaceIdInput: string, sessionIdInput: string): SessionControlDetailResponse {
    const workspaceId = identifier(workspaceIdInput, "workspaceId");
    const sessionId = identifier(sessionIdInput, "sessionId");
    const control = this.getControl(workspaceId, sessionId);
    const pendingRequests =
      control.ownerKind === "operator"
        ? this.db
            .prepare(
              `SELECT * FROM chat_session_control_requests
               WHERE workspace_id = @workspaceId AND session_id = @sessionId AND status = 'pending'
                 AND requested_generation = @generation
               ORDER BY created_at ASC, request_id ASC LIMIT @limit`,
            )
            .all<RequestRow>({
              workspaceId,
              sessionId,
              generation: control.generation,
              limit: SESSION_CONTROL_MAX_LIST_ITEMS,
            })
            .map((row) => this.mapRequest(row))
        : [];
    return parseSessionControlDetailResponse({ control, pendingRequests });
  }

  public listControls(
    workspaceIdInput: string,
    limitInput = SESSION_CONTROL_MAX_LIST_ITEMS,
  ): SessionControlListResponse {
    const workspaceId = identifier(workspaceIdInput, "workspaceId");
    const limit = boundedLimit(limitInput);
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_session_control_grants
         WHERE workspace_id = @workspaceId AND is_current = 1
         ORDER BY updated_at DESC, session_id ASC LIMIT @limit`,
      )
      .all<GrantRow>({ workspaceId, limit });
    return parseSessionControlListResponse({ items: rows.map((row) => this.mapControl(row)) });
  }

  public listEvents(
    workspaceIdInput: string,
    sessionIdInput: string,
    options: ListSessionControlEventsOptions = {},
  ): SessionControlEventRecord[] {
    const workspaceId = identifier(workspaceIdInput, "workspaceId");
    const sessionId = identifier(sessionIdInput, "sessionId");
    const limit = boundedLimit(options.limit ?? SESSION_CONTROL_MAX_LIST_ITEMS);
    this.requireSessionWorkspaceOrTombstone(workspaceId, sessionId);
    return this.db
      .prepare(
        `SELECT * FROM chat_session_control_events
         WHERE workspace_id = @workspaceId AND session_id = @sessionId
         ORDER BY event_sequence ASC LIMIT @limit`,
      )
      .all<EventRow>({ workspaceId, sessionId, limit })
      .map((row) => this.mapEvent(row));
  }

  /**
   * Forward-page the append-only, content-free control-event log by true
   * `event_sequence` (monotonic per session, never reset). Returns events with
   * `event_sequence > afterSequence`, ascending, bounded by `limit`, each paired
   * with its out-of-band sequence. Same workspace+session scoping and tombstone
   * guard as {@link listEvents}. This is the cursor path the session-scoped
   * realtime stream tails so delivery continues past the list cap instead of
   * being pinned to the oldest rows.
   */
  public listEventsAfterSequence(
    workspaceIdInput: string,
    sessionIdInput: string,
    afterSequence: number,
    limitInput: number = SESSION_CONTROL_MAX_LIST_ITEMS,
  ): SessionControlEventStreamRow[] {
    const workspaceId = identifier(workspaceIdInput, "workspaceId");
    const sessionId = identifier(sessionIdInput, "sessionId");
    const after = Number.isSafeInteger(afterSequence) && afterSequence > 0 ? afterSequence : 0;
    const limit = boundedLimit(limitInput);
    this.requireSessionWorkspaceOrTombstone(workspaceId, sessionId);
    return this.db
      .prepare(
        `SELECT * FROM chat_session_control_events
         WHERE workspace_id = @workspaceId AND session_id = @sessionId AND event_sequence > @afterSequence
         ORDER BY event_sequence ASC LIMIT @limit`,
      )
      .all<EventRow>({ workspaceId, sessionId, afterSequence: after, limit })
      .map((row) => ({ sequence: asPositiveInteger(row.event_sequence), event: this.mapEvent(row) }));
  }

  /**
   * Cheap min/max `event_sequence` bounds for a session's control-event log
   * (0/0 when empty). The stream uses `newestSequence` as the honest high
   * watermark — so `truncated` means "keep paging forward", never a silent dead
   * end — and `oldestSequence` to detect a genuinely unreachable cursor. Same
   * scoping and tombstone guard as {@link listEvents}.
   */
  public getEventSequenceBounds(
    workspaceIdInput: string,
    sessionIdInput: string,
  ): { oldestSequence: number; newestSequence: number } {
    const workspaceId = identifier(workspaceIdInput, "workspaceId");
    const sessionId = identifier(sessionIdInput, "sessionId");
    this.requireSessionWorkspaceOrTombstone(workspaceId, sessionId);
    const row = this.db
      .prepare(
        `SELECT COALESCE(MIN(event_sequence), 0) AS oldest, COALESCE(MAX(event_sequence), 0) AS newest
         FROM chat_session_control_events
         WHERE workspace_id = @workspaceId AND session_id = @sessionId`,
      )
      .get<{ oldest: number | bigint | string; newest: number | bigint | string }>({ workspaceId, sessionId });
    return {
      oldestSequence: asNonNegativeInteger(row?.oldest ?? 0),
      newestSequence: asNonNegativeInteger(row?.newest ?? 0),
    };
  }

  private runExternalSameGenerationTransition(
    label: string,
    normalized: ReturnType<typeof normalizeExternalIdentity>,
    requestSha256: string,
    mutate: (current: GrantRow, clock: DatabaseClockRow) => void,
  ): SessionControlTransitionOutcome {
    try {
      return this.db.transaction("immediate", () => {
        this.acquireSessionLock(normalized.sessionId);
        const replay = this.findEventByIdempotency(normalized.idempotencyKey);
        if (replay) {
          assertExactReplay(replay.request_sha256, requestSha256, `session control ${label}`);
          return { disposition: "replayed", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
        }
        const current = this.requireCurrentGrant(normalized.workspaceId, normalized.sessionId, true);
        const clock = this.readDatabaseClock();
        mutate(current, clock);
        return { disposition: "created", control: this.getControl(normalized.workspaceId, normalized.sessionId) };
      });
    } catch (error) {
      throw normalizeWriteError(error, `session control ${label}`);
    }
  }

  private acquireSessionLock(sessionId: string): void {
    if (this.db.dialect !== "postgres") return;
    this.db.prepare("SELECT pg_advisory_xact_lock(hashtextextended(@sessionId, 411)) AS locked").get({ sessionId });
  }

  private acquireAuthCouplingLock(): void {
    if (this.db.dialect !== "postgres") return;
    this.db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended('session-control-auth-coupling', 412)) AS locked")
      .get();
  }

  private requireSessionMeta(workspaceId: string, sessionId: string, forUpdate: boolean): SessionMetaRow {
    const row = this.db
      .prepare(
        `SELECT session_id, workspace_id FROM chat_session_meta WHERE session_id = @sessionId${
          this.db.dialect === "postgres" && forUpdate ? " FOR SHARE" : ""
        }`,
      )
      .get<SessionMetaRow>({ sessionId });
    if (!row || row.workspace_id !== workspaceId) throw new NotFoundError("Chat session not found.");
    return row;
  }

  private requireSessionWorkspaceOrTombstone(workspaceId: string, sessionId: string): void {
    const meta = this.db
      .prepare("SELECT workspace_id FROM chat_session_meta WHERE session_id = @sessionId")
      .get<{ workspace_id: string }>({ sessionId });
    const grant = this.db
      .prepare("SELECT workspace_id FROM chat_session_control_grants WHERE session_id = @sessionId LIMIT 1")
      .get<{ workspace_id: string }>({ sessionId });
    if ((meta?.workspace_id ?? grant?.workspace_id) !== workspaceId) throw new NotFoundError("Chat session not found.");
  }

  private requireCurrentGrant(workspaceId: string, sessionId: string, forUpdate: boolean): GrantRow {
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_session_control_grants
         WHERE session_id = @sessionId AND is_current = 1${
           this.db.dialect === "postgres" && forUpdate ? " FOR UPDATE" : ""
         }`,
      )
      .all<GrantRow>({ sessionId });
    if (rows.length !== 1) {
      const meta = this.db
        .prepare("SELECT workspace_id FROM chat_session_meta WHERE session_id = @sessionId")
        .get<{ workspace_id: string }>({ sessionId });
      if (!meta || meta.workspace_id !== workspaceId) throw new NotFoundError("Chat session not found.");
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control state is corrupt.");
    }
    const current = rows[0]!;
    if (current.workspace_id !== workspaceId) throw new NotFoundError("Chat session not found.");
    this.assertGrantIntegrity(current);
    return current;
  }

  private findGrantRows(sessionId: string): GrantRow[] {
    return this.db
      .prepare("SELECT * FROM chat_session_control_grants WHERE session_id = @sessionId ORDER BY generation ASC")
      .all<GrantRow>({ sessionId });
  }

  private getRequest(requestId: string): SessionControlRequestRecord {
    const row = this.db
      .prepare("SELECT * FROM chat_session_control_requests WHERE request_id = @requestId")
      .get<RequestRow>({ requestId });
    if (!row) throw new NotFoundError("Session control request not found.");
    return this.mapRequest(row);
  }

  private getRequestRowForUpdate(requestId: string): RequestRow {
    const row = this.db
      .prepare(
        `SELECT * FROM chat_session_control_requests WHERE request_id = @requestId${
          this.db.dialect === "postgres" ? " FOR UPDATE" : ""
        }`,
      )
      .get<RequestRow>({ requestId });
    if (!row) throw new NotFoundError("Session control request not found.");
    this.assertRequestIntegrity(row);
    return row;
  }

  private findRequestByIdempotency(idempotencyKey: string): RequestRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM chat_session_control_requests WHERE idempotency_key = @idempotencyKey")
      .get<RequestRow>({ idempotencyKey });
    if (row) this.assertRequestIntegrity(row);
    return row;
  }

  private findEventByIdempotency(idempotencyKey: string): EventRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM chat_session_control_events WHERE idempotency_key = @idempotencyKey")
      .get<EventRow>({ idempotencyKey });
    if (row) this.assertEventIntegrity(row);
    return row;
  }

  private findAuthRevokeReceipt(idempotencyKey: string): AuthRevokeReceiptRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM chat_session_control_auth_revoke_receipts
         WHERE idempotency_key = @idempotencyKey`,
      )
      .get<AuthRevokeReceiptRow>({ idempotencyKey });
  }

  private findAuthRevokeOperation(idempotencyKey: string): AuthRevokeOperationRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM chat_session_control_auth_revoke_operations
         WHERE idempotency_key = @idempotencyKey`,
      )
      .get<AuthRevokeOperationRow>({ idempotencyKey });
  }

  private listAuthRevokeOperationTargets(idempotencyKey: string): AuthRevokeOperationTargetRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat_session_control_auth_revoke_operation_targets
         WHERE operation_idempotency_key = @idempotencyKey
         ORDER BY target_index ASC`,
      )
      .all<AuthRevokeOperationTargetRow>({ idempotencyKey });
  }

  private listAuthRevokeEvents(requestSha256: string): EventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat_session_control_events
         WHERE request_sha256 = @requestSha256
         ORDER BY workspace_id ASC, session_id ASC, event_sequence ASC, event_id ASC`,
      )
      .all<EventRow>({ requestSha256 });
  }

  private replayAuthRevokeReceipt(
    receipt: AuthRevokeReceiptRow,
    normalized: ReturnType<typeof normalizeAuthRevokeInput>,
    requestSha256: string,
  ): AuthRevokeSessionControlsOutcome {
    assertExactReplay(receipt.request_sha256, requestSha256, "session control auth revoke coupling");
    const events = this.listAuthRevokeEvents(receipt.request_sha256);
    const sessionKeys = this.assertAuthRevokeReceiptEvidence(receipt, normalized, events);
    const operation = this.findAuthRevokeOperation(receipt.idempotency_key);
    return {
      disposition: "replayed",
      occurredAt: operation?.occurred_at ?? receipt.created_at,
      occurredAtBasis: operation ? "operation" : "legacy_receipt",
      controls: sessionKeys.map((value) => {
        const [workspaceId, sessionId] = value.split("\u0000") as [string, string];
        return this.getControl(workspaceId, sessionId);
      }),
    };
  }

  private insertAuthRevokeOperation(
    normalized: ReturnType<typeof normalizeAuthRevokeInput>,
    requestSha256: string,
    events: readonly EventRow[],
    occurredAt: string,
  ): void {
    const sessionCount = new Set(events.map((event) => `${event.workspace_id}\u0000${event.session_id}`)).size;
    this.db
      .prepare(
        `INSERT INTO chat_session_control_auth_revoke_operations (
           idempotency_key, request_sha256, binding_kind, binding_id, actor_id,
           correlation_id, target_count, session_count, event_set_sha256, occurred_at
         ) VALUES (
           @idempotencyKey, @requestSha256, @bindingKind, @bindingId, @actorId,
           @correlationId, @targetCount, @sessionCount, @eventSetSha256, @occurredAt
         )`,
      )
      .run({
        idempotencyKey: normalized.idempotencyKey,
        requestSha256,
        bindingKind: normalized.bindingKind,
        bindingId: normalized.bindingId,
        actorId: normalized.actorId,
        correlationId: normalized.correlationId,
        targetCount: events.length,
        sessionCount,
        eventSetSha256: authRevokeEventSetSha256(events),
        occurredAt,
      });
  }

  private insertAuthRevokeOperationTarget(target: AuthRevokeOperationTargetRow): void {
    this.db
      .prepare(
        `INSERT INTO chat_session_control_auth_revoke_operation_targets (
           operation_idempotency_key, target_index, target_kind, workspace_id, session_id,
           request_id, generation, control_revision, owner_kind, lease_state,
           event_id, event_sequence, event_idempotency_key, event_reason_code
         ) VALUES (
           @operationIdempotencyKey, @targetIndex, @targetKind, @workspaceId, @sessionId,
           @requestId, @generation, @controlRevision, @ownerKind, @leaseState,
           @eventId, @eventSequence, @eventIdempotencyKey, @eventReasonCode
         )`,
      )
      .run({
        operationIdempotencyKey: target.operation_idempotency_key,
        targetIndex: target.target_index,
        targetKind: target.target_kind,
        workspaceId: target.workspace_id,
        sessionId: target.session_id,
        requestId: target.request_id,
        generation: target.generation,
        controlRevision: target.control_revision,
        ownerKind: target.owner_kind,
        leaseState: target.lease_state,
        eventId: target.event_id,
        eventSequence: target.event_sequence,
        eventIdempotencyKey: target.event_idempotency_key,
        eventReasonCode: target.event_reason_code,
      });
  }

  private insertAuthRevokeReceipt(
    normalized: ReturnType<typeof normalizeAuthRevokeInput>,
    requestSha256: string,
    events: readonly EventRow[],
    createdAt: string,
  ): void {
    const sessionCount = new Set(events.map((event) => `${event.workspace_id}\u0000${event.session_id}`)).size;
    const receipt: AuthRevokeReceiptRow = {
      idempotency_key: normalized.idempotencyKey,
      request_sha256: requestSha256,
      binding_kind: normalized.bindingKind,
      binding_id: normalized.bindingId,
      actor_id: normalized.actorId,
      correlation_id: normalized.correlationId,
      target_count: events.length,
      session_count: sessionCount,
      event_set_sha256: authRevokeEventSetSha256(events),
      created_at: createdAt,
    };
    this.assertAuthRevokeReceiptEvidence(receipt, normalized, events);
    this.db
      .prepare(
        `INSERT INTO chat_session_control_auth_revoke_receipts (
           idempotency_key, request_sha256, binding_kind, binding_id, actor_id,
           correlation_id, target_count, session_count, event_set_sha256, created_at
         ) VALUES (
           @idempotencyKey, @requestSha256, @bindingKind, @bindingId, @actorId,
           @correlationId, @targetCount, @sessionCount, @eventSetSha256, @createdAt
         )`,
      )
      .run({
        idempotencyKey: receipt.idempotency_key,
        requestSha256: receipt.request_sha256,
        bindingKind: receipt.binding_kind,
        bindingId: receipt.binding_id,
        actorId: receipt.actor_id,
        correlationId: receipt.correlation_id,
        targetCount: receipt.target_count,
        sessionCount: receipt.session_count,
        eventSetSha256: receipt.event_set_sha256,
        createdAt: receipt.created_at,
      });
  }

  private assertAuthRevokeReceiptEvidence(
    receipt: AuthRevokeReceiptRow,
    normalized: ReturnType<typeof normalizeAuthRevokeInput>,
    events: readonly EventRow[],
  ): string[] {
    const targetCount = asNonNegativeInteger(receipt.target_count);
    const sessionCount = asNonNegativeInteger(receipt.session_count);
    const sessionKeys = [...new Set(events.map((event) => `${event.workspace_id}\u0000${event.session_id}`))].sort();
    const operation = this.findAuthRevokeOperation(receipt.idempotency_key);
    const targets = operation ? this.listAuthRevokeOperationTargets(receipt.idempotency_key) : [];
    for (const event of events) {
      this.mapEvent(event);
    }
    const materialMatches =
      receipt.idempotency_key === normalized.idempotencyKey &&
      receipt.binding_kind === normalized.bindingKind &&
      receipt.binding_id === normalized.bindingId &&
      receipt.actor_id === normalized.actorId &&
      receipt.correlation_id === normalized.correlationId;
    const eventsMatch = events.every(
      (event) =>
        event.request_sha256 === receipt.request_sha256 &&
        event.correlation_id === receipt.correlation_id &&
        (operation
          ? event.created_at === operation.occurred_at
          : isCanonicalTimestamp(event.created_at) && event.created_at <= receipt.created_at) &&
        event.actor_kind === "system" &&
        event.actor_id === receipt.actor_id &&
        ["auth_revoked", "mutation_denied", "request_expired"].includes(event.reason_code) &&
        (receipt.binding_kind === "companion_session"
          ? event.companion_session_id === receipt.binding_id
          : event.device_grant_id === receipt.binding_id),
    );
    const operationMatches =
      !operation ||
      (operation.idempotency_key === receipt.idempotency_key &&
        operation.request_sha256 === receipt.request_sha256 &&
        operation.binding_kind === receipt.binding_kind &&
        operation.binding_id === receipt.binding_id &&
        operation.actor_id === receipt.actor_id &&
        operation.correlation_id === receipt.correlation_id &&
        asNonNegativeInteger(operation.target_count) === targetCount &&
        asNonNegativeInteger(operation.session_count) === sessionCount &&
        operation.event_set_sha256 === receipt.event_set_sha256 &&
        operation.occurred_at === receipt.created_at &&
        targets.length === targetCount &&
        targets.every((target, index) => {
          const event = events.find((candidate) => candidate.event_id === target.event_id);
          return (
            asNonNegativeInteger(target.target_index) === index &&
            event !== undefined &&
            event.workspace_id === target.workspace_id &&
            event.session_id === target.session_id &&
            event.request_id === target.request_id &&
            asPositiveInteger(event.event_sequence) === asPositiveInteger(target.event_sequence) &&
            event.idempotency_key === target.event_idempotency_key &&
            event.reason_code === target.event_reason_code &&
            asPositiveInteger(event.previous_generation ?? 0) === asPositiveInteger(target.generation)
          );
        }));
    const rootCount = events.filter((event) => event.idempotency_key === receipt.idempotency_key).length;
    if (
      !materialMatches ||
      !operationMatches ||
      !isCanonicalTimestamp(receipt.created_at) ||
      targetCount !== events.length ||
      sessionCount !== sessionKeys.length ||
      rootCount !== (targetCount === 0 ? 0 : 1) ||
      !eventsMatch ||
      receipt.event_set_sha256 !== authRevokeEventSetSha256(events)
    ) {
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Auth revoke receipt or event set is corrupt.");
    }
    return sessionKeys;
  }

  private requireTokenBinding(
    tokenHashSha256: string,
    workspaceId: string,
    sessionId: string,
    firstRequestId?: string,
  ): TokenRow {
    const token = this.db
      .prepare("SELECT * FROM chat_session_control_tokens WHERE token_sha256 = @tokenHashSha256")
      .get<TokenRow>({ tokenHashSha256 });
    if (
      !token ||
      token.workspace_id !== workspaceId ||
      token.session_id !== sessionId ||
      (firstRequestId !== undefined && token.first_request_id !== firstRequestId)
    ) {
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control token binding is corrupt.");
    }
    return token;
  }

  private requireActiveAuthBinding(companionSessionId: string, deviceGrantId: string, now: string): AuthBindingRow {
    const companionExpiryPredicate =
      this.db.dialect === "postgres"
        ? "gc_try_parse_timestamptz(companion_session.refresh_token_expires_at) > gc_try_parse_timestamptz(@now)"
        : `strftime('%Y-%m-%dT%H:%M:%fZ', companion_session.refresh_token_expires_at, '+0 days')
             = companion_session.refresh_token_expires_at
           AND companion_session.refresh_token_expires_at > @now`;
    const grantExpiryPredicate =
      this.db.dialect === "postgres"
        ? `(device_grant.expires_at IS NULL
             OR gc_try_parse_timestamptz(device_grant.expires_at) > gc_try_parse_timestamptz(@now))`
        : `(device_grant.expires_at IS NULL OR (
             strftime('%Y-%m-%dT%H:%M:%fZ', device_grant.expires_at, '+0 days') = device_grant.expires_at
             AND device_grant.expires_at > @now
           ))`;
    const row = this.db
      .prepare(
        `SELECT companion_session.session_id AS companion_session_id,
                companion_session.grant_id AS companion_grant_id,
                companion_session.principal_purpose AS companion_principal_purpose,
                device_grant.grant_id AS device_grant_id,
                device_grant.request_id AS device_request_id,
                device_grant.principal_purpose AS device_principal_purpose,
                device_request.principal_purpose AS request_principal_purpose
         FROM companion_sessions companion_session
         JOIN auth_device_grants device_grant ON device_grant.grant_id = companion_session.grant_id
         JOIN auth_device_requests device_request ON device_request.request_id = device_grant.request_id
         WHERE companion_session.session_id = @companionSessionId
           AND companion_session.grant_id = @deviceGrantId
           AND device_grant.grant_id = @deviceGrantId
           AND companion_session.principal_purpose = 'session_control_client'
           AND device_grant.principal_purpose = 'session_control_client'
           AND device_request.principal_purpose = 'session_control_client'
           AND companion_session.revoked_at IS NULL
           AND device_grant.revoked_at IS NULL
           AND ${companionExpiryPredicate}
           AND ${grantExpiryPredicate}
         LIMIT 1${
           this.db.dialect === "postgres" ? " FOR UPDATE OF companion_session, device_grant, device_request" : ""
         }`,
      )
      .get<AuthBindingRow>({ companionSessionId, deviceGrantId, now });
    if (
      !row ||
      row.companion_session_id !== companionSessionId ||
      row.companion_grant_id !== deviceGrantId ||
      row.device_grant_id !== deviceGrantId ||
      row.companion_principal_purpose !== "session_control_client" ||
      row.device_principal_purpose !== "session_control_client" ||
      row.request_principal_purpose !== "session_control_client"
    ) {
      throw stateConflict(
        "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED",
        "Session control principal binding is inactive or invalid.",
      );
    }
    return row;
  }

  private assertRequestIntegrity(row: RequestRow): void {
    assertCanonicalCapabilityBinding(row.requested_capabilities_json, row.requested_capabilities_sha256, false);
    this.requireTokenBinding(row.token_sha256, row.workspace_id, row.session_id, row.request_id);
    const requestedGeneration = asPositiveInteger(row.requested_generation);
    const hasDecision = Boolean(row.decided_at && row.decided_by_actor_id && row.decision_reason_code);
    const terminalShape =
      (row.status === "activated" &&
        hasDecision &&
        row.decision_reason_code === "handoff" &&
        row.activated_generation !== null &&
        asPositiveInteger(row.activated_generation) === incrementGeneration(requestedGeneration)) ||
      (row.status === "rejected" &&
        hasDecision &&
        row.decision_reason_code === "request_rejected" &&
        row.activated_generation === null) ||
      (row.status === "cancelled" &&
        hasDecision &&
        row.decision_reason_code === "request_cancelled" &&
        row.activated_generation === null) ||
      (row.status === "expired" &&
        hasDecision &&
        row.decision_reason_code === "request_expired" &&
        row.activated_generation === null);
    const pendingShape =
      row.status === "pending" &&
      row.decided_at === null &&
      row.decided_by_actor_id === null &&
      row.decision_reason_code === null &&
      row.activated_generation === null;
    if (!pendingShape && !terminalShape) {
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control request state is corrupt.");
    }
  }

  private assertGrantIntegrity(row: GrantRow): void {
    const requestedCapabilities = assertCanonicalCapabilityBinding(
      row.requested_capabilities_json,
      row.requested_capabilities_sha256,
      true,
    );
    const effectiveCapabilities = assertCanonicalCapabilityBinding(
      row.effective_capabilities_json,
      row.effective_capabilities_sha256,
      true,
    );
    if (row.owner_kind === "operator") {
      if (requestedCapabilities.length !== 0 || effectiveCapabilities.length !== 0) {
        throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control grant state is corrupt.");
      }
      return;
    }
    if (
      row.owner_kind !== "external_companion" ||
      !row.request_id ||
      !row.companion_session_id ||
      !row.device_grant_id ||
      !row.client_instance_id ||
      row.principal_purpose !== "session_control_client" ||
      !row.token_sha256 ||
      requestedCapabilities.length === 0 ||
      effectiveCapabilities.length === 0
    ) {
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control grant state is corrupt.");
    }
    this.requireTokenBinding(row.token_sha256, row.workspace_id, row.session_id);
    const request = this.db
      .prepare("SELECT * FROM chat_session_control_requests WHERE request_id = @requestId")
      .get<RequestRow>({ requestId: row.request_id });
    if (!request) throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control grant request is corrupt.");
    this.assertRequestIntegrity(request);
    const activatedGeneration =
      request.activated_generation === null ? 0 : asPositiveInteger(request.activated_generation);
    const grantGeneration = asPositiveInteger(row.generation);
    if (
      request.workspace_id !== row.workspace_id ||
      request.session_id !== row.session_id ||
      request.companion_session_id !== row.companion_session_id ||
      request.device_grant_id !== row.device_grant_id ||
      request.client_instance_id !== row.client_instance_id ||
      request.principal_purpose !== row.principal_purpose ||
      request.requested_capabilities_json !== row.requested_capabilities_json ||
      request.requested_capabilities_sha256 !== row.requested_capabilities_sha256 ||
      request.status !== "activated" ||
      request.decision_reason_code !== "handoff" ||
      activatedGeneration !== incrementGeneration(asPositiveInteger(request.requested_generation)) ||
      activatedGeneration > grantGeneration
    ) {
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control grant request binding is corrupt.");
    }
    try {
      assertSessionControlEffectiveCapabilities(requestedCapabilities, effectiveCapabilities);
    } catch {
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control grant capabilities are corrupt.");
    }
    if (grantGeneration === activatedGeneration) {
      if (row.token_sha256 !== request.token_sha256) {
        throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control activation token binding is corrupt.");
      }
      return;
    }
    const prior = this.db
      .prepare(
        `SELECT * FROM chat_session_control_grants
         WHERE session_id = @sessionId AND generation = @generation`,
      )
      .get<GrantRow>({ sessionId: row.session_id, generation: grantGeneration - 1 });
    if (
      !prior ||
      prior.workspace_id !== row.workspace_id ||
      prior.owner_kind !== "external_companion" ||
      prior.request_id !== row.request_id ||
      prior.companion_session_id !== row.companion_session_id ||
      prior.device_grant_id !== row.device_grant_id ||
      prior.client_instance_id !== row.client_instance_id ||
      prior.principal_purpose !== row.principal_purpose ||
      prior.requested_capabilities_json !== row.requested_capabilities_json ||
      prior.requested_capabilities_sha256 !== row.requested_capabilities_sha256 ||
      prior.effective_capabilities_json !== row.effective_capabilities_json ||
      prior.effective_capabilities_sha256 !== row.effective_capabilities_sha256
    ) {
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control reconnect lineage is corrupt.");
    }
  }

  private assertEventIntegrity(row: EventRow): void {
    if (!row.request_id) return;
    const request = this.db
      .prepare("SELECT * FROM chat_session_control_requests WHERE request_id = @requestId")
      .get<RequestRow>({ requestId: row.request_id });
    if (!request) throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control event request is corrupt.");
    this.assertRequestIntegrity(request);
    if (
      request.workspace_id !== row.workspace_id ||
      request.session_id !== row.session_id ||
      request.companion_session_id !== row.companion_session_id ||
      request.device_grant_id !== row.device_grant_id
    ) {
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control event request attribution is corrupt.");
    }
  }

  private insertTokenHash(input: {
    tokenHashSha256: string;
    workspaceId: string;
    sessionId: string;
    firstRequestId?: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chat_session_control_tokens (
           token_sha256, workspace_id, session_id, first_request_id, created_at
         ) VALUES (@tokenHashSha256, @workspaceId, @sessionId, @firstRequestId, @createdAt)`,
      )
      .run({ ...input, firstRequestId: input.firstRequestId ?? null });
  }

  private insertOperatorGeneration(input: {
    workspaceId: string;
    sessionId: string;
    generation: number;
    idempotencyKey: string;
    requestSha256: string;
    now: string;
  }): void {
    const emptySha256 = sha256(EMPTY_CAPABILITIES_JSON);
    this.db
      .prepare(
        `
        INSERT INTO chat_session_control_grants (
          workspace_id, session_id, generation, is_current, owner_kind, lease_state,
          requested_capabilities_json, requested_capabilities_sha256,
          effective_capabilities_json, effective_capabilities_sha256,
          control_revision, transition_idempotency_key, transition_request_sha256,
          created_at, updated_at
        ) VALUES (
          @workspaceId, @sessionId, @generation, 1, 'operator', 'operator_active',
          '[]', @emptySha256, '[]', @emptySha256,
          1, @idempotencyKey, @requestSha256, @now, @now
        )
      `,
      )
      .run({ ...input, emptySha256 });
  }

  private insertExternalGeneration(input: {
    workspaceId: string;
    sessionId: string;
    generation: number;
    request: Pick<RequestRow, "request_id" | "companion_session_id" | "device_grant_id" | "client_instance_id">;
    requestedCapabilitiesJson: string;
    requestedCapabilitiesSha256: string;
    effectiveCapabilitiesJson: string;
    effectiveCapabilitiesSha256: string;
    tokenHashSha256: string;
    idempotencyKey: string;
    requestSha256: string;
    clock: DatabaseClockRow;
  }): void {
    this.db
      .prepare(
        `
        INSERT INTO chat_session_control_grants (
          workspace_id, session_id, generation, is_current, owner_kind, lease_state,
          request_id, companion_session_id, device_grant_id, client_instance_id, principal_purpose,
          requested_capabilities_json, requested_capabilities_sha256,
          effective_capabilities_json, effective_capabilities_sha256,
          token_sha256, token_expires_at, last_heartbeat_at, lease_expires_at, reconnect_expires_at,
          control_revision, transition_idempotency_key, transition_request_sha256, created_at, updated_at
        ) VALUES (
          @workspaceId, @sessionId, @generation, 1, 'external_companion', 'external_live',
          @requestId, @companionSessionId, @deviceGrantId, @clientInstanceId, 'session_control_client',
          @requestedCapabilitiesJson, @requestedCapabilitiesSha256,
          @effectiveCapabilitiesJson, @effectiveCapabilitiesSha256,
          @tokenHashSha256, @tokenExpiresAt, @lastHeartbeatAt, @leaseExpiresAt, @reconnectExpiresAt,
          1, @idempotencyKey, @requestSha256, @createdAt, @createdAt
        )
      `,
      )
      .run({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        generation: input.generation,
        requestId: input.request.request_id,
        companionSessionId: input.request.companion_session_id,
        deviceGrantId: input.request.device_grant_id,
        clientInstanceId: input.request.client_instance_id,
        requestedCapabilitiesJson: input.requestedCapabilitiesJson,
        requestedCapabilitiesSha256: input.requestedCapabilitiesSha256,
        effectiveCapabilitiesJson: input.effectiveCapabilitiesJson,
        effectiveCapabilitiesSha256: input.effectiveCapabilitiesSha256,
        tokenHashSha256: input.tokenHashSha256,
        tokenExpiresAt: input.clock.token_expires_at,
        lastHeartbeatAt: input.clock.now,
        leaseExpiresAt: input.clock.lease_expires_at,
        reconnectExpiresAt: input.clock.reconnect_expires_at,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
        createdAt: input.clock.now,
      });
  }

  private terminalizeCurrentGrant(
    current: GrantRow,
    leaseState: "released" | "revoked" | "superseded",
    now: string,
  ): void {
    const result = this.db
      .prepare(
        `
        UPDATE chat_session_control_grants
        SET is_current = 0, lease_state = @leaseState, control_revision = control_revision + 1,
            updated_at = @now, terminal_at = @now
        WHERE session_id = @sessionId AND generation = @generation AND is_current = 1
      `,
      )
      .run({
        sessionId: current.session_id,
        generation: asPositiveInteger(current.generation),
        leaseState,
        now,
      });
    if (result.changes !== 1)
      throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control generation is stale.");
  }

  private insertEvent(input: {
    workspaceId: string;
    sessionId: string;
    requestId?: string;
    previousGeneration?: number;
    nextGeneration: number;
    previousOwnerKind?: "operator" | "external_companion";
    nextOwnerKind?: "operator" | "external_companion";
    previousLeaseState?: "operator_active" | "external_live" | "external_stale";
    nextLeaseState: "operator_active" | "external_live" | "external_stale" | "deleted";
    reasonCode:
      | "session_initialized"
      | "request_created"
      | "request_expired"
      | "request_cancelled"
      | "handoff"
      | "heartbeat"
      | "lease_stale"
      | "reconnect"
      | "release"
      | "operator_revoke"
      | "emergency_takeover"
      | "identity_revoked"
      | "auth_revoked"
      | "mutation_denied";
    actorKind: "operator" | "external_companion" | "system";
    actorId: string;
    companionSessionId?: string;
    deviceGrantId?: string;
    idempotencyKey: string;
    requestSha256: string;
    correlationId: string;
    createdAt: string;
  }): void {
    const eventId = deriveId("sce", input.workspaceId, input.sessionId, input.idempotencyKey, input.reasonCode);
    const eventSequence =
      asNonNegativeInteger(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(event_sequence), 0) AS sequence FROM chat_session_control_events WHERE session_id = @sessionId",
          )
          .get<{ sequence: number | bigint | string }>({ sessionId: input.sessionId })?.sequence ?? 0,
      ) + 1;
    this.db
      .prepare(
        `
        INSERT INTO chat_session_control_events (
          event_id, workspace_id, session_id, event_sequence, request_id, previous_generation, next_generation,
          previous_owner_kind, next_owner_kind, previous_lease_state, next_lease_state,
          reason_code, actor_kind, actor_id, companion_session_id, device_grant_id,
          idempotency_key, request_sha256, correlation_id, created_at
        ) VALUES (
          @eventId, @workspaceId, @sessionId, @eventSequence, @requestId, @previousGeneration, @nextGeneration,
          @previousOwnerKind, @nextOwnerKind, @previousLeaseState, @nextLeaseState,
          @reasonCode, @actorKind, @actorId, @companionSessionId, @deviceGrantId,
          @idempotencyKey, @requestSha256, @correlationId, @createdAt
        )
      `,
      )
      .run({
        eventId,
        eventSequence,
        ...input,
        requestId: input.requestId ?? null,
        previousGeneration: input.previousGeneration ?? null,
        previousOwnerKind: input.previousOwnerKind ?? null,
        nextOwnerKind: input.nextOwnerKind ?? null,
        previousLeaseState: input.previousLeaseState ?? null,
        companionSessionId: input.companionSessionId ?? null,
        deviceGrantId: input.deviceGrantId ?? null,
      });
  }

  private assertExternalIdentity(
    current: GrantRow,
    identity: ReturnType<typeof normalizeExternalIdentity>,
    clock: DatabaseClockRow,
    options: { allowStale?: boolean; requireLiveLease?: boolean; requireReconnectWindow?: boolean },
  ): void {
    if (
      current.owner_kind !== "external_companion" ||
      asPositiveInteger(current.generation) !== identity.expectedGeneration ||
      current.companion_session_id !== identity.companionSessionId ||
      current.device_grant_id !== identity.deviceGrantId ||
      current.client_instance_id !== identity.clientInstanceId ||
      current.principal_purpose !== "session_control_client"
    ) {
      throw stateConflict("SESSION_CONTROL_GENERATION_STALE", "Session control identity is stale.");
    }
    if (
      current.token_sha256 !== identity.tokenHashSha256 ||
      !current.token_expires_at ||
      current.token_expires_at <= clock.now
    ) {
      throw stateConflict("SESSION_CONTROL_TOKEN_INVALID", "Session control token is invalid.");
    }
    const permittedStates = options.allowStale ? ["external_live", "external_stale"] : ["external_live"];
    if (!permittedStates.includes(current.lease_state)) {
      throw stateConflict("SESSION_CONTROL_STALE", "Session control lease is stale.");
    }
    if (options.requireLiveLease && (!current.lease_expires_at || current.lease_expires_at <= clock.now)) {
      throw stateConflict("SESSION_CONTROL_STALE", "Session control lease is stale.");
    }
    if (
      options.requireReconnectWindow &&
      (!current.reconnect_expires_at || current.reconnect_expires_at <= clock.now)
    ) {
      throw stateConflict("SESSION_CONTROL_RECONNECT_EXPIRED", "Session control reconnect window is expired.");
    }
  }

  private mapControl(row: GrantRow): SessionControlRecord {
    this.assertGrantIntegrity(row);
    const event = this.db
      .prepare(
        `SELECT * FROM chat_session_control_events
         WHERE session_id = @sessionId
         ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get<EventRow>({ sessionId: row.session_id });
    if (!event || event.workspace_id !== row.workspace_id) {
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control state is corrupt.");
    }
    this.assertEventIntegrity(event);
    const base = {
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      generation: asPositiveInteger(row.generation),
      lastEventId: event.event_id,
      lastEventReasonCode: event.reason_code,
      updatedAt: row.updated_at,
    };
    if (row.owner_kind === "operator" && row.lease_state === "operator_active") {
      return parseSessionControlRecord({
        ...base,
        ownerKind: "operator",
        leaseState: "operator_active",
        capabilities: [],
      });
    }
    if (
      row.owner_kind !== "external_companion" ||
      !["external_live", "external_stale"].includes(row.lease_state) ||
      !row.companion_session_id ||
      !row.client_instance_id ||
      !row.token_sha256 ||
      !row.last_heartbeat_at ||
      !row.lease_expires_at ||
      !row.reconnect_expires_at
    ) {
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control state is corrupt.");
    }
    return parseSessionControlRecord({
      ...base,
      ownerKind: "external_companion",
      leaseState: row.lease_state,
      capabilities: parseCapabilities(row.effective_capabilities_json),
      boundExternalController: {
        companionSessionId: row.companion_session_id,
        clientInstanceId: row.client_instance_id,
        principalPurpose: "session_control_client",
        tokenFingerprint: sessionControlTokenFingerprint(row.token_sha256),
      },
      lastHeartbeatAt: row.last_heartbeat_at,
      leaseExpiresAt: row.lease_expires_at,
      reconnectExpiresAt: row.reconnect_expires_at,
    });
  }

  private mapRequest(row: RequestRow): SessionControlRequestRecord {
    this.assertRequestIntegrity(row);
    const base = {
      requestId: row.request_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      companionSessionId: row.companion_session_id,
      clientInstanceId: row.client_instance_id,
      tokenFingerprint: sessionControlTokenFingerprint(row.token_sha256),
      requestedCapabilities: parseCapabilities(row.requested_capabilities_json),
      requestedGeneration: asPositiveInteger(row.requested_generation),
      idempotencyKey: row.idempotency_key,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
    if (row.status === "pending") return parseSessionControlRequestRecord({ ...base, status: "pending" });
    if (!row.decided_at || !row.decided_by_actor_id || !row.decision_reason_code) {
      throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control request state is corrupt.");
    }
    if (row.status === "activated" && row.activated_generation !== null) {
      return parseSessionControlRequestRecord({
        ...base,
        status: "activated",
        activatedGeneration: asPositiveInteger(row.activated_generation),
        decidedAt: row.decided_at,
        decidedByActorId: row.decided_by_actor_id,
        decisionReasonCode: "handoff",
      });
    }
    if (["rejected", "expired", "cancelled"].includes(row.status)) {
      return parseSessionControlRequestRecord({
        ...base,
        status: row.status,
        decidedAt: row.decided_at,
        decidedByActorId: row.decided_by_actor_id,
        decisionReasonCode: row.decision_reason_code,
      });
    }
    throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control request state is corrupt.");
  }

  private mapEvent(row: EventRow): SessionControlEventRecord {
    this.assertEventIntegrity(row);
    return parseSessionControlEventRecord({
      eventId: row.event_id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      ...(row.previous_generation === null ? {} : { previousGeneration: asPositiveInteger(row.previous_generation) }),
      nextGeneration: asPositiveInteger(row.next_generation),
      ...(row.previous_owner_kind === null ? {} : { previousOwnerKind: row.previous_owner_kind }),
      ...(row.next_owner_kind === null ? {} : { nextOwnerKind: row.next_owner_kind }),
      ...(row.previous_lease_state === null ? {} : { previousLeaseState: row.previous_lease_state }),
      nextLeaseState: row.next_lease_state,
      reasonCode: row.reason_code,
      actorKind: row.actor_kind,
      actorId: row.actor_id,
      correlationId: row.correlation_id,
      createdAt: row.created_at,
    });
  }

  private readDatabaseClock(): DatabaseClockRow {
    if (this.db.dialect === "sqlite") {
      return this.db
        .prepare(
          `SELECT
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${SESSION_CONTROL_TOKEN_TTL_SECONDS} seconds') AS token_expires_at,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${SESSION_CONTROL_LIVE_LEASE_SECONDS} seconds') AS lease_expires_at,
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${SESSION_CONTROL_RECONNECT_WINDOW_SECONDS} seconds') AS reconnect_expires_at`,
        )
        .get<DatabaseClockRow>()!;
    }
    return this.db
      .prepare(
        `WITH database_clock AS (SELECT clock_timestamp() AS value)
         SELECT
           to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now,
           to_char((value + make_interval(secs => ${SESSION_CONTROL_TOKEN_TTL_SECONDS})) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS token_expires_at,
           to_char((value + make_interval(secs => ${SESSION_CONTROL_LIVE_LEASE_SECONDS})) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_expires_at,
           to_char((value + make_interval(secs => ${SESSION_CONTROL_RECONNECT_WINDOW_SECONDS})) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reconnect_expires_at
         FROM database_clock`,
      )
      .get<DatabaseClockRow>()!;
  }
}

function normalizeInitializationInput(input: InitializeSessionControlInput): InitializeSessionControlInput {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function normalizeExternalRequestInput(input: CreateExternalSessionControlRequestInput) {
  if (input.principalPurpose !== "session_control_client") {
    throw stateConflict("SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED", "Session control principal purpose is denied.");
  }
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    companionSessionId: identifier(input.companionSessionId, "companionSessionId"),
    deviceGrantId: identifier(input.deviceGrantId, "deviceGrantId"),
    clientInstanceId: identifier(input.clientInstanceId, "clientInstanceId"),
    principalPurpose: "session_control_client" as const,
    expectedGeneration: generation(input.expectedGeneration),
    tokenHashSha256: normalizeSessionControlTokenHashSha256(input.tokenHashSha256),
    capabilities: normalizeExternalSessionControlCapabilities(input.capabilities),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function normalizeHandoffInput(input: HandoffSessionControlInput) {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    requestId: identifier(input.requestId, "requestId"),
    expectedGeneration: generation(input.expectedGeneration),
    effectiveCapabilities: normalizeExternalSessionControlCapabilities(input.effectiveCapabilities),
    operatorActorId: identifier(input.operatorActorId, "operatorActorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function normalizeCancelRequestInput(input: CancelExternalSessionControlRequestInput) {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    requestId: identifier(input.requestId, "requestId"),
    operatorActorId: identifier(input.operatorActorId, "operatorActorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function normalizeExternalIdentity(input: ExternalSessionControlIdentity) {
  if (input.principalPurpose !== "session_control_client") {
    throw stateConflict("SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED", "Session control principal purpose is denied.");
  }
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    companionSessionId: identifier(input.companionSessionId, "companionSessionId"),
    deviceGrantId: identifier(input.deviceGrantId, "deviceGrantId"),
    clientInstanceId: identifier(input.clientInstanceId, "clientInstanceId"),
    principalPurpose: "session_control_client" as const,
    expectedGeneration: generation(input.expectedGeneration),
    tokenHashSha256: normalizeSessionControlTokenHashSha256(input.tokenHashSha256),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function normalizeReconnectInput(input: ReconnectSessionControlInput) {
  return {
    ...normalizeExternalIdentity(input),
    newTokenHashSha256: normalizeSessionControlTokenHashSha256(input.newTokenHashSha256),
  };
}

function normalizeMarkStaleInput(input: MarkSessionControlStaleInput) {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    expectedGeneration: generation(input.expectedGeneration),
    expectedControlRevision: generation(input.expectedControlRevision),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function normalizeRevokeInput(input: RevokeSessionControlInput) {
  if (input.mode !== "revoke" && input.mode !== "emergency_takeover") {
    throw new ValidationError({ field: "mode" });
  }
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    expectedGeneration: generation(input.expectedGeneration),
    mode: input.mode,
    operatorActorId: identifier(input.operatorActorId, "operatorActorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function normalizeIdentityAmbiguityInput(input: RevokeIdentityAmbiguityInput) {
  return {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    sessionId: identifier(input.sessionId, "sessionId"),
    expectedGeneration: generation(input.expectedGeneration),
    systemActorId: identifier(input.systemActorId, "systemActorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function normalizeAuthRevokeInput(input: AuthRevokeSessionControlsInput) {
  if (input.bindingKind !== "companion_session" && input.bindingKind !== "device_grant") {
    throw new ValidationError({ field: "bindingKind" });
  }
  return {
    bindingKind: input.bindingKind,
    bindingId: identifier(input.bindingId, "bindingId"),
    actorId: identifier(input.actorId, "actorId"),
    idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"),
    correlationId: identifier(input.correlationId, "correlationId"),
  };
}

function normalizeExternalAuthorityInput(
  input: Extract<ResolveSessionMutationAuthorityInput, { actorKind: "external_companion" }>,
) {
  const normalized = normalizeExternalIdentity({
    ...input,
    idempotencyKey: "authority-check",
    correlationId: "authority-check",
  });
  if (input.requiredCapability !== "send" && input.requiredCapability !== "read") {
    throw new ValidationError({ field: "requiredCapability" });
  }
  return { ...normalized, requiredCapability: input.requiredCapability };
}

function currentToSyntheticRequest(
  current: GrantRow,
): Pick<RequestRow, "request_id" | "companion_session_id" | "device_grant_id" | "client_instance_id"> {
  if (!current.request_id || !current.companion_session_id || !current.device_grant_id || !current.client_instance_id) {
    throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control state is corrupt.");
  }
  return {
    request_id: current.request_id,
    companion_session_id: current.companion_session_id,
    device_grant_id: current.device_grant_id,
    client_instance_id: current.client_instance_id,
  };
}

function parseCapabilities(value: string): ExternalSessionControlCapabilitySet | readonly [] {
  if (value === EMPTY_CAPABILITIES_JSON) return [];
  try {
    return normalizeExternalSessionControlCapabilities(JSON.parse(value) as unknown);
  } catch {
    throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control capability state is corrupt.");
  }
}

function assertCanonicalCapabilityBinding(
  value: string,
  storedSha256: string,
  allowEmpty: boolean,
): ExternalSessionControlCapabilitySet | readonly [] {
  const capabilities = parseCapabilities(value);
  if (
    canonicalJsonString(capabilities) !== value ||
    sha256(value) !== storedSha256 ||
    (!allowEmpty && capabilities.length === 0)
  ) {
    throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control capability binding is corrupt.");
  }
  return capabilities;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new ValidationError({ field });
  }
  return value;
}

function generation(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError({ field: "generation" });
  }
  return value;
}

function incrementGeneration(value: number): number {
  if (value === Number.MAX_SAFE_INTEGER) {
    throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control generation cannot advance.");
  }
  return value + 1;
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > SESSION_CONTROL_MAX_LIST_ITEMS) {
    throw new ValidationError({ field: "limit" });
  }
  return value;
}

function asPositiveInteger(value: number | bigint | string): number {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control numeric state is corrupt.");
  }
  return parsed;
}

function asNonNegativeInteger(value: number | bigint | string): number {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", "Session control numeric state is corrupt.");
  }
  return parsed;
}

function asBoolean(value: number | bigint | string): boolean {
  return value === 1 || value === 1n || value === "1";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function authRevokeEventSetSha256(events: readonly EventRow[]): string {
  return sha256(
    canonicalJsonString(
      [...events]
        .sort(
          (left, right) =>
            left.workspace_id.localeCompare(right.workspace_id) ||
            left.session_id.localeCompare(right.session_id) ||
            asPositiveInteger(left.event_sequence) - asPositiveInteger(right.event_sequence) ||
            left.event_id.localeCompare(right.event_id),
        )
        .map((event) => ({
          actorId: event.actor_id,
          actorKind: event.actor_kind,
          companionSessionId: event.companion_session_id,
          correlationId: event.correlation_id,
          createdAt: event.created_at,
          deviceGrantId: event.device_grant_id,
          eventId: event.event_id,
          eventSequence: asPositiveInteger(event.event_sequence),
          idempotencyKey: event.idempotency_key,
          nextGeneration: asPositiveInteger(event.next_generation),
          nextLeaseState: event.next_lease_state,
          nextOwnerKind: event.next_owner_kind,
          previousGeneration: event.previous_generation === null ? null : asPositiveInteger(event.previous_generation),
          previousLeaseState: event.previous_lease_state,
          previousOwnerKind: event.previous_owner_kind,
          reasonCode: event.reason_code,
          requestId: event.request_id,
          requestSha256: event.request_sha256,
          sessionId: event.session_id,
          workspaceId: event.workspace_id,
        })),
    ),
  );
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function operationSha256(operation: string, value: unknown): string {
  return sha256(canonicalJsonString({ operation, value }));
}

function deriveId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${sha256(canonicalJsonString(parts)).slice(0, 48)}`;
}

function deriveAuthRevokeEvidenceIdempotencyKey(
  rootIdempotencyKey: string,
  kind: "pending" | "grant",
  sessionId: string,
  targetId: string,
): string {
  return deriveId("scare", rootIdempotencyKey, kind, sessionId, targetId);
}

function assertExactReplay(storedSha256: string, requestSha256: string, label: string): void {
  if (storedSha256 !== requestSha256)
    throw stateConflict("SESSION_CONTROL_STATE_CORRUPT", `${label} replay conflicts.`);
}

function stateConflict(sessionControlCode: string, message: string): ConflictError {
  return new ConflictError({ code: "STATE_CONFLICT", message, details: { sessionControlCode } });
}

function normalizeWriteError(error: unknown, label: string): Error {
  if (error instanceof ConflictError || error instanceof NotFoundError || error instanceof ValidationError)
    return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:23505|23514|SQLITE_CONSTRAINT)/u.test(code) || /unique|constraint|invariant|immutable/iu.test(message)) {
    return stateConflict("SESSION_CONTROL_STATE_CORRUPT", `${label} conflicts with durable authority.`);
  }
  return error instanceof Error ? error : new Error(`${label} failed.`);
}
