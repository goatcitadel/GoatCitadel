/* eslint-disable max-lines -- HX-411 keeps turn-admission and controller-protocol authority in one audited control-domain owner; routes must not reach storage directly. */
import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  HEARTBEAT_PERMISSION_PROFILE_ID,
  HEARTBEAT_RESTRICTED_PROFILE,
  NotFoundError,
  ValidationError,
  normalizeExternalSessionControlCapabilities,
  normalizeSessionControlTokenHashSha256,
  SESSION_CONTROL_MAX_LIST_ITEMS,
  parseSessionControlDetailResponse,
  parseSessionControlHandoffResponse,
  parseSessionControlHeartbeatResponse,
  parseSessionControlReconnectResponse,
  parseSessionControlReleaseResponse,
  parseSessionControlRequestResponse,
  parseSessionControlRevokeResponse,
  type ExternalSessionControlCapability,
  type ChatSendMessageRequest,
  type SessionControlConflictCode,
  type SessionControlDetailResponse,
  type SessionControlEventRecord,
  type SessionControlHandoffInput,
  type SessionControlHandoffResponse,
  type SessionControlHeartbeatInput,
  type SessionControlHeartbeatResponse,
  type SessionControlListResponse,
  type SessionControlReconnectInput,
  type SessionControlReconnectResponse,
  type SessionControlRecord,
  type SessionControlReleaseInput,
  type SessionControlReleaseResponse,
  type SessionControlRequestInput,
  type SessionControlRequestRecord,
  type SessionControlRequestResponse,
  type SessionControlRevokeInput,
  type SessionControlRevokeResponse,
} from "@goatcitadel/contracts";
import type {
  HeartbeatOccurrenceAdmissionRequest,
  HeartbeatOccurrenceRecord,
  ReclaimExpiredSystemTurnWriteRequestLeaseOutcome,
  DurableTurnWriteClaim,
  RequestRuntimeLeaseClaim,
  SessionMutationAdmissionRecord,
  PreemptHeartbeatAndAdmitOperatorTurnOutcome,
  AsyncStorage as Storage,
} from "@goatcitadel/storage";
import type {
  ActiveTurnAdmission,
  ChatTurnSurfaceDerivation,
  FrozenChatTurnExecutionRequest,
  FrozenChatTurnRequestActor,
  SystemHeartbeatOccurrenceTurnAdmission,
  TurnAdmissionDurableClaim,
  TurnAdmissionIdentity,
  TurnAdmissionRequestClaim,
} from "./chat-turn-types.js";
import { HEARTBEAT_SYSTEM_PROMPT } from "./gateway/heartbeat-service.js";

export interface AdmitOperatorChatTurnInput {
  sessionId: string;
  turnId: string;
  request: ChatSendMessageRequest;
  runtimeOwnerId: string;
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
  /**
   * Server-authored proof that this admission originated at the authenticated
   * operator HTTP route. It is never accepted from a Chat request body and is
   * intentionally absent for A2A, delegation, scheduler, and other internal
   * callers.
   */
  authenticatedOperator?: AuthenticatedOperatorAdmissionContext;
}

const AUTHENTICATED_OPERATOR_ADMISSION_CONTEXT = Symbol("goatcitadel.authenticated-operator-admission");

type AuthenticatedOperatorSource = Extract<
  NonNullable<ChatSendMessageRequest["authActorSource"]>,
  "none" | "token" | "basic" | "loopback"
>;

export interface AuthenticatedOperatorAdmissionContext {
  readonly kind: "authenticated_operator_http";
  readonly actorId: string;
  readonly authActorSource: AuthenticatedOperatorSource;
  readonly [AUTHENTICATED_OPERATOR_ADMISSION_CONTEXT]: true;
}

export type DecisionCommittedHeartbeatRecoveryIdentity = Readonly<
  Pick<
    Extract<PreemptHeartbeatAndAdmitOperatorTurnOutcome, { disposition: "decision_committed" }>,
    | "workspaceId"
    | "sessionId"
    | "sessionIncarnationId"
    | "turnId"
    | "occurrenceId"
    | "heartbeatAdmissionId"
    | "durableRunId"
  >
>;

export class DecisionCommittedHeartbeatAdmissionError extends ConflictError {
  public readonly recovery: DecisionCommittedHeartbeatRecoveryIdentity;

  public constructor(recovery: DecisionCommittedHeartbeatRecoveryIdentity) {
    super({
      message:
        "A system heartbeat decision is committed and must finish canonical recovery before this operator turn can be admitted.",
      details: { ...recovery },
    });
    this.recovery = Object.freeze({ ...recovery });
  }
}

export class ActiveTurnNotPreemptibleError extends ConflictError {
  public readonly recoveryOutcome = "not_preemptible" as const;
  public readonly activeAdmission: SessionMutationAdmissionRecord;

  public constructor(activeAdmission: SessionMutationAdmissionRecord) {
    super({
      code: "STATE_CONFLICT",
      message: "The active Chat turn is not a preemptible system heartbeat; reconnect to that turn before retrying.",
      details: {
        recoveryOutcome: "not_preemptible",
        mutated: false,
        activeAdmissionId: activeAdmission.admissionId,
        activeTurnId: activeAdmission.turnId,
        activeActorKind: activeAdmission.actorKind,
        activeOperation: activeAdmission.operation,
      },
    });
    this.activeAdmission = activeAdmission;
  }
}

export function createAuthenticatedOperatorAdmissionContext(input: {
  actorId: string;
  authActorSource: NonNullable<ChatSendMessageRequest["authActorSource"]>;
}): AuthenticatedOperatorAdmissionContext {
  const actorId = input.actorId.trim();
  if (!actorId || !["none", "token", "basic", "loopback"].includes(input.authActorSource)) {
    throw new ConflictError({ message: "Authenticated operator admission requires operator control-plane authority." });
  }
  const context = {
    kind: "authenticated_operator_http" as const,
    actorId,
    authActorSource: input.authActorSource as AuthenticatedOperatorSource,
  } as AuthenticatedOperatorAdmissionContext;
  Object.defineProperty(context, AUTHENTICATED_OPERATOR_ADMISSION_CONTEXT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
  return Object.freeze(context);
}

const EXTERNAL_COMPANION_ADMISSION_CONTEXT = Symbol("goatcitadel.external-companion-admission");

/**
 * Server-authored proof that a Chat send originates from an authenticated,
 * currently bound `session_control_client` controller. Like the authenticated
 * operator context it is branded so a Chat request body can never masquerade as
 * one: every field is derived from the authenticated companion binding, the
 * dedicated non-loggable control-token header, and the presented control
 * generation. No delegated capability is stored here — the send site always
 * requires `send`, which the durable authority checks against the controller's
 * stored effective capability set.
 */
export interface ExternalCompanionAdmissionContext {
  readonly kind: "session_control_companion_send";
  readonly companionSessionId: string;
  readonly deviceGrantId: string;
  readonly clientInstanceId: string;
  readonly principalPurpose: "session_control_client";
  /** Lowercase SHA-256 of the plaintext control secret presented in the dedicated header. */
  readonly tokenHashSha256: string;
  /** Controller generation the client presented; the durable CAS rejects any mismatch. */
  readonly expectedGeneration: number;
  readonly [EXTERNAL_COMPANION_ADMISSION_CONTEXT]: true;
}

export function createExternalCompanionAdmissionContext(input: {
  companionSessionId: string;
  deviceGrantId: string;
  clientInstanceId: string;
  tokenHashSha256: string;
  expectedGeneration: number;
}): ExternalCompanionAdmissionContext {
  const companionSessionId = input.companionSessionId.trim();
  const deviceGrantId = input.deviceGrantId.trim();
  const clientInstanceId = input.clientInstanceId.trim();
  if (!companionSessionId || !deviceGrantId || !clientInstanceId) {
    throw new ConflictError({
      message: "External session-control admission requires the exact bound companion, device, and client identity.",
    });
  }
  const tokenHashSha256 = normalizePresentedControlToken(input.tokenHashSha256);
  if (!Number.isInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
    throw sessionControlConflict(
      "SESSION_CONTROL_GENERATION_STALE",
      "External session-control admission requires a positive expected controller generation.",
    );
  }
  const context = {
    kind: "session_control_companion_send" as const,
    companionSessionId,
    deviceGrantId,
    clientInstanceId,
    principalPurpose: "session_control_client" as const,
    tokenHashSha256,
    expectedGeneration: input.expectedGeneration,
  } as ExternalCompanionAdmissionContext;
  Object.defineProperty(context, EXTERNAL_COMPANION_ADMISSION_CONTEXT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
  return Object.freeze(context);
}

/**
 * Re-validate the server brand before a send enters canonical admission. A
 * body-derived object cannot carry the non-enumerable brand, so it fails closed
 * with a purpose denial rather than reaching the durable authority.
 */
export function assertExternalCompanionAdmissionContext(
  context: ExternalCompanionAdmissionContext,
): ExternalCompanionAdmissionContext {
  if (
    context.kind !== "session_control_companion_send" ||
    context[EXTERNAL_COMPANION_ADMISSION_CONTEXT] !== true ||
    context.principalPurpose !== "session_control_client"
  ) {
    throw sessionControlConflict(
      "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED",
      "External session-control admission context is not route-authored.",
    );
  }
  return context;
}

export type ChatTurnAdmissionActor =
  | {
      actorKind: "operator" | "system";
      actorId: string;
    }
  | {
      actorKind: "external_companion";
      /** Raw authenticated companion session id. Never use an authActorId projection such as companion:<id>. */
      actorId: string;
      companionSessionId: string;
      deviceGrantId: string;
      clientInstanceId: string;
      principalPurpose: "session_control_client";
      tokenHashSha256: string;
      requiredCapability: ExternalSessionControlCapability;
      /** Controller generation the caller presented; admission CASes it against the current grant. */
      expectedGeneration: number;
    };

export interface AdmitChatTurnInput {
  sessionId: string;
  turnId: string;
  request: ChatSendMessageRequest;
  runtimeOwnerId: string;
  actor: ChatTurnAdmissionActor;
  idempotencyKey: string;
  correlationId: string;
}

export interface CloseChatTurnAdmissionInput {
  admission: ActiveTurnAdmission;
  status: "completed" | "cancelled";
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
}

export interface AdmitSystemHeartbeatOccurrenceInput {
  occurrenceRequest: HeartbeatOccurrenceAdmissionRequest;
  request: ChatSendMessageRequest;
}

export interface AdmittedSystemHeartbeatOccurrence {
  admission: ActiveTurnAdmission;
  record: SessionMutationAdmissionRecord;
}

export interface RecoverSystemHeartbeatOccurrenceInput {
  occurrence: HeartbeatOccurrenceRecord;
  request: ChatSendMessageRequest;
}

export type RecoverSystemHeartbeatOccurrenceOutcome =
  | { disposition: "live" }
  | { disposition: "durable_bound" }
  | { disposition: "closed_or_authority_drift"; reason: "closed" | "authority_drift" | "lifecycle_drift" }
  | { disposition: "reclaimed"; admission: ActiveTurnAdmission };

type SessionControlStorage = Pick<Storage, "chatSessionMeta" | "sessionControls" | "sessionMutationAdmissions">;

/**
 * The authenticated local operator resolved by the control-plane route. The
 * service never derives operator authority from a Chat request body.
 */
export interface SessionControlOperatorActor {
  readonly actorKind: "operator";
  readonly actorId: string;
}

/**
 * The authenticated `session_control_client` companion resolved by the route.
 * `clientInstanceId` is a client-chosen instance identifier the route presents
 * from the signed request; every other field is an authenticated stored binding.
 * No secret material is carried here: the presented control-token hash arrives
 * as an explicit per-command argument, and a request's client-generated hash
 * arrives in its bounded input body.
 */
export interface SessionControlExternalCompanionActor {
  readonly actorKind: "external_companion";
  readonly companionSessionId: string;
  readonly deviceGrantId: string;
  readonly clientInstanceId: string;
  readonly principalPurpose: "session_control_client";
}

export type SessionControlProtocolActor = SessionControlOperatorActor | SessionControlExternalCompanionActor;

export interface CreateExternalSessionControlCommand {
  actor: SessionControlExternalCompanionActor;
  sessionId: string;
  correlationId: string;
  input: SessionControlRequestInput;
}

export interface HandoffSessionControlCommand {
  actor: SessionControlOperatorActor;
  sessionId: string;
  correlationId: string;
  input: SessionControlHandoffInput;
}

interface ExternalControllerProtocolCommand {
  actor: SessionControlExternalCompanionActor;
  sessionId: string;
  correlationId: string;
  /** Lowercase SHA-256 of the plaintext control secret presented in the dedicated header. */
  presentedTokenHashSha256: string;
}

export interface HeartbeatSessionControlCommand extends ExternalControllerProtocolCommand {
  input: SessionControlHeartbeatInput;
}

export interface ReconnectSessionControlCommand extends ExternalControllerProtocolCommand {
  input: SessionControlReconnectInput;
}

export interface ReleaseSessionControlCommand extends ExternalControllerProtocolCommand {
  input: SessionControlReleaseInput;
}

export interface RevokeSessionControlCommand {
  actor: SessionControlOperatorActor;
  sessionId: string;
  correlationId: string;
  input: SessionControlRevokeInput;
}

export interface CancelExternalSessionControlRequestCommand {
  actor: SessionControlOperatorActor;
  sessionId: string;
  correlationId: string;
  requestId: string;
  idempotencyKey: string;
}

export interface ReadSessionControlQuery {
  actor: SessionControlProtocolActor;
  sessionId: string;
}

export interface ListSessionControlsQuery {
  actor: SessionControlOperatorActor;
  workspaceId: string;
  limit?: number;
}

export interface ListSessionControlEventsQuery {
  actor: SessionControlProtocolActor;
  sessionId: string;
  limit?: number;
}

export interface ControlEventStreamPageQuery {
  actor: SessionControlProtocolActor;
  sessionId: string;
  /** Client-supplied ordinal cursor; only events with a strictly greater cursor are returned. */
  afterCursor?: number;
  limit?: number;
}

export interface ControlEventStreamEnvelope {
  /**
   * The event's durable `event_sequence` — monotonic per session and never
   * reset — used as the stream's forward cursor. Stable across reconnects and
   * unaffected by the list cap, so the tail continues past 200 lifetime events.
   */
  readonly cursor: number;
  readonly event: SessionControlEventRecord;
}

export interface ControlEventStreamPage {
  readonly events: ControlEventStreamEnvelope[];
  /** Oldest retained `event_sequence` for the session (0 when empty). */
  readonly oldestSequence: number;
  /** Newest retained `event_sequence` for the session (0 when empty). */
  readonly newestSequence: number;
  /**
   * True when this page filled `limit` AND events past its last cursor still
   * remain (`lastCursor < newestSequence`). It means "keep paging forward", not
   * a silent dead end — the caller re-pages from the last cursor until caught up.
   */
  readonly truncated: boolean;
  /** Current controller generation at the moment this page was read. */
  readonly generation: number;
  readonly ownerKind: SessionControlRecord["ownerKind"];
  readonly leaseState: SessionControlRecord["leaseState"];
}

/**
 * Stateless Gateway domain boundary over the durable session-control stores.
 * It never infers authority from ambient request state or from current metadata
 * after admission; callers must keep passing the frozen turn identity.
 */
export class SessionControlService {
  public constructor(private readonly storage: SessionControlStorage) {}

  public async admitOperatorChatTurn(input: AdmitOperatorChatTurnInput): Promise<ActiveTurnAdmission> {
    if (input.authenticatedOperator) {
      return await this.admitAuthenticatedOperatorChatTurn(input, input.authenticatedOperator);
    }
    return await this.admitChatTurn({
      ...input,
      actor: { actorKind: "operator", actorId: input.actorId },
    });
  }

  private async admitAuthenticatedOperatorChatTurn(
    input: AdmitOperatorChatTurnInput,
    authenticatedOperator: AuthenticatedOperatorAdmissionContext,
  ): Promise<ActiveTurnAdmission> {
    const actorId = input.actorId.trim();
    if (
      authenticatedOperator.kind !== "authenticated_operator_http" ||
      authenticatedOperator[AUTHENTICATED_OPERATOR_ADMISSION_CONTEXT] !== true ||
      !actorId ||
      authenticatedOperator.actorId !== actorId ||
      input.request.operatorId !== actorId ||
      input.request.authActorId !== actorId ||
      input.request.authActorSource !== authenticatedOperator.authActorSource
    ) {
      throw new ConflictError({
        message: "The authenticated operator admission context does not match the server-stamped Chat request.",
      });
    }

    const admittedRequest = freezeChatTurnExecutionRequest(input.request);
    const requestActor = freezeChatTurnRequestActor(input.request, { actorKind: "operator", actorId });
    const materialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(admittedRequest);
    let outcome: PreemptHeartbeatAndAdmitOperatorTurnOutcome | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const meta = await this.storage.chatSessionMeta.get(input.sessionId);
      if (!meta) {
        throw new NotFoundError({ entity: "Chat session", id: input.sessionId });
      }
      const observedControl = await this.storage.sessionControls.getControl(meta.workspaceId, input.sessionId);
      const control = await this.storage.sessionControls.resolveMutationAuthority({
        actorKind: "operator",
        workspaceId: meta.workspaceId,
        sessionId: input.sessionId,
        expectedGeneration: observedControl.generation,
      });
      try {
        outcome = await this.storage.sessionMutationAdmissions.preemptHeartbeatAndAdmitOperatorTurn({
          workspaceId: meta.workspaceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          runtimeOwnerId: input.runtimeOwnerId,
          aggregateRevision: meta.revision,
          expectedControllerGeneration: control.generation,
          operatorActorId: actorId,
          operation: "chat_turn",
          materialSha256,
          idempotencyKey: input.idempotencyKey,
          correlationId: input.correlationId,
        });
        break;
      } catch (error) {
        if (attempt > 0 || !isRetryablePreemptionRace(error)) throw error;
        // A restart/concurrent settlement can invalidate the transaction's
        // candidate after it was selected. Re-read canonical active authority
        // and retry once; the repository remains the only preemption owner.
        const active = await this.storage.sessionMutationAdmissions.listActive(meta.workspaceId, input.sessionId);
        if (active.length === 1 && !isExactHeartbeatAdmission(active[0]!)) {
          throw new ActiveTurnNotPreemptibleError(active[0]!);
        }
      }
    }
    if (!outcome) {
      throw new ConflictError({ message: "Operator Chat admission could not resolve canonical active-turn state." });
    }
    if (outcome.disposition === "decision_committed") {
      throw new DecisionCommittedHeartbeatAdmissionError({
        workspaceId: outcome.workspaceId,
        sessionId: outcome.sessionId,
        sessionIncarnationId: outcome.sessionIncarnationId,
        turnId: outcome.turnId,
        occurrenceId: outcome.occurrenceId,
        heartbeatAdmissionId: outcome.heartbeatAdmissionId,
        durableRunId: outcome.durableRunId,
      });
    }
    if (outcome.disposition === "not_preemptible") {
      throw new ActiveTurnNotPreemptibleError(outcome.activeAdmission);
    }
    return activeAdmissionFromRecord(outcome.admission, materialSha256, admittedRequest, requestActor, true);
  }

  public async admitChatTurn(input: AdmitChatTurnInput): Promise<ActiveTurnAdmission> {
    const meta = await this.storage.chatSessionMeta.get(input.sessionId);
    if (!meta) {
      throw new NotFoundError({ entity: "Chat session", id: input.sessionId });
    }
    const observedControl = await this.storage.sessionControls.getControl(meta.workspaceId, input.sessionId);
    const actor = normalizeChatTurnAdmissionActor(input.actor);
    const control =
      actor.actorKind === "external_companion"
        ? await this.storage.sessionControls.resolveMutationAuthority({
            actorKind: "external_companion",
            workspaceId: meta.workspaceId,
            sessionId: input.sessionId,
            // CAS the caller-presented generation, not merely the observed one, so a
            // stale/superseded controller is rejected before canonical admission.
            expectedGeneration: actor.expectedGeneration,
            companionSessionId: actor.companionSessionId,
            deviceGrantId: actor.deviceGrantId,
            clientInstanceId: actor.clientInstanceId,
            principalPurpose: actor.principalPurpose,
            tokenHashSha256: actor.tokenHashSha256,
            requiredCapability: actor.requiredCapability,
          })
        : await this.storage.sessionControls.resolveMutationAuthority({
            // System-owned producers execute under the current operator-owned
            // session generation; their admission actor remains explicitly system.
            actorKind: "operator",
            workspaceId: meta.workspaceId,
            sessionId: input.sessionId,
            expectedGeneration: observedControl.generation,
          });
    const admittedRequest = freezeChatTurnExecutionRequest(input.request);
    const requestActor = freezeChatTurnRequestActor(input.request, actor);
    const materialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(admittedRequest);
    const outcome = await this.storage.sessionMutationAdmissions.admit({
      workspaceId: meta.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runtimeOwnerId: input.runtimeOwnerId,
      admissionKind: "turn_write",
      aggregateRevision: meta.revision,
      controllerGeneration: control.generation,
      actorKind: actor.actorKind,
      actorId: actor.actorId,
      operation: "chat_turn",
      materialSha256,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
    });
    return activeAdmissionFromRecord(outcome.admission, materialSha256, admittedRequest, requestActor, true);
  }

  /**
   * Hydrate the exact heartbeat admission created atomically by the storage
   * claim owner. The callback-free storage composite keeps cadence,
   * admission, and occurrence insertion inside one worker-owned transaction.
   */
  public async admitSystemHeartbeatOccurrence(
    input: AdmitSystemHeartbeatOccurrenceInput,
  ): Promise<AdmittedSystemHeartbeatOccurrence> {
    const occurrenceRequest = input.occurrenceRequest;
    const admissionInput = occurrenceRequest.admissionInput;
    const admittedRequest = freezeChatTurnExecutionRequest(input.request);
    const materialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(admittedRequest);
    const requestActor = freezeChatTurnRequestActor(input.request, {
      actorKind: "system",
      actorId: "system-heartbeat",
    });
    assertCanonicalSystemHeartbeatRequest(input.request, occurrenceRequest);
    if (
      admissionInput.actorKind !== "system" ||
      admissionInput.actorId !== "system-heartbeat" ||
      admissionInput.operation !== "chat_system_heartbeat" ||
      admissionInput.admissionKind !== "turn_write" ||
      admissionInput.turnId !== occurrenceRequest.child.turnId ||
      admissionInput.correlationId !== occurrenceRequest.occurrenceId ||
      admissionInput.idempotencyKey !== `heartbeat-admission:${occurrenceRequest.occurrenceId}` ||
      admissionInput.materialSha256 !== materialSha256
    ) {
      throw new ConflictError({ message: "The heartbeat occurrence callback conflicts with its canonical request." });
    }
    const meta = await this.storage.chatSessionMeta.get(admissionInput.sessionId);
    if (!meta || meta.workspaceId !== admissionInput.workspaceId) {
      throw new ConflictError({ message: "The heartbeat occurrence callback has no exact Chat session workspace." });
    }
    const sessionIncarnationId = admissionInput.expectedSessionIncarnationId;
    if (!sessionIncarnationId) {
      throw new ConflictError({ message: "The heartbeat occurrence admission is missing its session incarnation." });
    }
    const { expectedSessionIncarnationId: _expectedSessionIncarnationId, ...previewInput } = admissionInput;
    const preview = await this.storage.sessionMutationAdmissions.previewAdmissionIdentity({
      ...previewInput,
      sessionIncarnationId,
    });
    const stored = await this.storage.sessionMutationAdmissions.require(preview.admissionId);
    if (stored.requestSha256 !== preview.requestSha256 || stored.sessionIncarnationId !== sessionIncarnationId) {
      throw new ConflictError({ message: "The heartbeat occurrence admission identity drifted after its claim." });
    }
    const admission = activeAdmissionFromRecord(
      stored,
      materialSha256,
      admittedRequest,
      requestActor,
      true,
      freezeSystemHeartbeatOccurrenceAdmission(stored, {
        occurrenceId: occurrenceRequest.occurrenceId,
        claimSha256: occurrenceRequest.claimSha256,
        durableRunId: occurrenceRequest.child.durableRunId,
      }),
    );
    return { admission, record: stored };
  }

  /** Recover only the exact expired pre-bind lease owned by one occurrence. */
  public async recoverSystemHeartbeatOccurrence(
    input: RecoverSystemHeartbeatOccurrenceInput,
  ): Promise<RecoverSystemHeartbeatOccurrenceOutcome> {
    const occurrence = input.occurrence;
    const admittedRequest = freezeChatTurnExecutionRequest(input.request);
    const materialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(admittedRequest);
    assertCanonicalSystemHeartbeatRequest(input.request, {
      occurrenceId: occurrence.occurrenceId,
      claimSha256: occurrence.claimSha256,
      claimedAt: occurrence.claimedAt,
      child: {
        userMessageId: occurrence.userMessageId,
        assistantMessageId: occurrence.assistantMessageId,
        turnId: occurrence.turnId,
        durableRunId: occurrence.durableRunId,
      },
      admissionInput: {
        workspaceId: occurrence.workspaceId,
        sessionId: occurrence.sessionId,
        expectedSessionIncarnationId: occurrence.sessionIncarnationId,
        turnId: occurrence.turnId,
        runtimeOwnerId: occurrence.runtimeOwnerId,
        admissionKind: "turn_write",
        aggregateRevision: occurrence.aggregateRevision,
        controllerGeneration: occurrence.controllerGeneration,
        actorKind: "system",
        actorId: "system-heartbeat",
        operation: "chat_system_heartbeat",
        materialSha256: occurrence.admissionMaterialSha256,
        idempotencyKey: occurrence.admissionIdempotencyKey,
        correlationId: occurrence.admissionCorrelationId,
      },
    });
    if (
      occurrence.systemActorId !== "system-heartbeat" ||
      occurrence.admissionMaterialSha256 !== materialSha256 ||
      occurrence.frozenRequestSha256 !== materialSha256 ||
      (occurrence.boundDurableRunId !== undefined && occurrence.boundDurableRunId !== occurrence.durableRunId)
    ) {
      throw new ConflictError({ message: "The heartbeat occurrence request identity drifted before recovery." });
    }
    const stored = await this.storage.sessionMutationAdmissions.require(occurrence.admissionId);
    const outcome: ReclaimExpiredSystemTurnWriteRequestLeaseOutcome =
      await this.storage.sessionMutationAdmissions.reclaimExpiredSystemTurnWriteRequestLease({
        admissionId: occurrence.admissionId,
        workspaceId: occurrence.workspaceId,
        sessionId: occurrence.sessionId,
        sessionIncarnationId: occurrence.sessionIncarnationId,
        turnId: occurrence.turnId,
        occurrenceId: occurrence.occurrenceId,
        runtimeOwnerId: occurrence.runtimeOwnerId,
        expectedLeaseRevision: requireStoredRequestClaim(stored).leaseRevision,
        actorId: "system-heartbeat",
        operation: "chat_system_heartbeat",
        materialSha256,
        idempotencyKey: occurrence.admissionIdempotencyKey,
        correlationId: occurrence.admissionCorrelationId,
        admissionRequestSha256: occurrence.admissionRequestSha256,
        expectedDurableRunId: occurrence.durableRunId,
        userMessageId: occurrence.userMessageId,
        assistantMessageId: occurrence.assistantMessageId,
        evaluatedPolicySha256: occurrence.evaluatedPolicySha256,
        frozenRequestSha256: occurrence.frozenRequestSha256,
        frozenObjectiveSha256: occurrence.frozenObjectiveSha256,
        claimSha256: occurrence.claimSha256,
      });
    if (outcome.disposition !== "reclaimed") {
      return outcome.disposition === "closed_or_authority_drift"
        ? { disposition: outcome.disposition, reason: outcome.reason }
        : { disposition: outcome.disposition };
    }
    const requestActor = freezeChatTurnRequestActor(input.request, {
      actorKind: "system",
      actorId: "system-heartbeat",
    });
    return {
      disposition: "reclaimed",
      admission: activeAdmissionFromRecord(
        outcome.admission,
        materialSha256,
        admittedRequest,
        requestActor,
        true,
        freezeSystemHeartbeatOccurrenceAdmission(outcome.admission, {
          occurrenceId: occurrence.occurrenceId,
          claimSha256: occurrence.claimSha256,
          durableRunId: occurrence.durableRunId,
        }),
      ),
    };
  }

  public async renewRequestLease(admission: ActiveTurnAdmission): Promise<ActiveTurnAdmission> {
    const claim = requireRequestClaim(admission);
    const record = await this.storage.sessionMutationAdmissions.renewTurnWriteRequestLease({
      ...toStorageIdentity(admission.identity),
      requestRuntimeClaim: claim,
    });
    assertAdmissionIdentity(record, admission.identity);
    const nextClaim = requireStoredRequestClaim(record);
    claim.runtimeOwnerId = nextClaim.runtimeOwnerId;
    claim.leaseRevision = nextClaim.leaseRevision;
    return admission;
  }

  public async bindDurableRun(admission: ActiveTurnAdmission, durableRunId: string): Promise<void> {
    const requestRuntimeClaim = requireRequestClaim(admission);
    assertAdmissionIdentity(
      await this.storage.sessionMutationAdmissions.require(admission.identity.admissionId),
      admission.identity,
    );
    assertAdmissionActor(
      await this.storage.sessionMutationAdmissions.require(admission.identity.admissionId),
      admission.requestActor,
    );
    await this.storage.sessionMutationAdmissions.bindDurableRun({
      ...toStorageIdentity(admission.identity),
      durableRunId,
      requestRuntimeClaim,
    });
    admission.requestClaim = undefined;
  }

  public async assertActiveTurnWrite(admission: ActiveTurnAdmission): Promise<SessionMutationAdmissionRecord> {
    const requestRuntimeClaim = admission.requestClaim ? toStorageRequestClaim(admission.requestClaim) : undefined;
    const durableClaim = admission.durableClaim ? toStorageDurableClaim(admission.durableClaim) : undefined;
    if (!requestRuntimeClaim && !durableClaim) {
      throw new ConflictError({ message: "The Chat turn has no active request or durable execution claim." });
    }
    const outcome = await this.storage.sessionMutationAdmissions.assertActiveTurnWrite({
      ...toStorageIdentity(admission.identity),
      ...(requestRuntimeClaim ? { requestRuntimeClaim } : {}),
      ...(durableClaim ? { durableClaim } : {}),
    });
    assertAdmissionIdentity(outcome.admission, admission.identity);
    assertAdmissionActor(outcome.admission, admission.requestActor);
    return outcome.admission;
  }

  public async closeTurnWrite(input: CloseChatTurnAdmissionInput): Promise<SessionMutationAdmissionRecord> {
    const requestRuntimeClaim = input.admission.requestClaim
      ? toStorageRequestClaim(input.admission.requestClaim)
      : undefined;
    const durableClaim = input.admission.durableClaim ? toStorageDurableClaim(input.admission.durableClaim) : undefined;
    if (!requestRuntimeClaim && !durableClaim) {
      throw new ConflictError({ message: "The Chat turn has no active claim for terminal closure." });
    }
    const record = await this.storage.sessionMutationAdmissions.closeTurnWrite({
      ...toStorageIdentity(input.admission.identity),
      status: input.status,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      ...(requestRuntimeClaim ? { requestRuntimeClaim } : {}),
      ...(durableClaim ? { durableClaim } : {}),
    });
    assertAdmissionIdentity(record, input.admission.identity);
    return record;
  }

  public async cancelExpiredUnboundTurnAdmissions(input: {
    actorId: string;
    idempotencyKeyPrefix: string;
    correlationId: string;
    limit?: number;
  }): Promise<string[]> {
    return (await this.storage.sessionMutationAdmissions.cancelExpiredUnboundTurnAdmissions(input))
      .cancelledAdmissionIds;
  }

  // ---------------------------------------------------------------------------
  // Controller-protocol business ownership (HX-411).
  //
  // These methods are the sole control-domain authorization API. Each resolves
  // the immutable stored workspace binding from session metadata (never a body),
  // gates the authenticated actor kind and principal purpose before any storage
  // mutation, validates capability material at the boundary, and maps the durable
  // CAS outcome into a content-free contract response. The storage layer owns
  // every generation/token/binding/lease CAS check and serializes each op through
  // one aggregate-revision lock; no database transaction is held here across
  // provider, tool, command, filesystem, or stream work. Controller-protocol ops
  // carry no message content, so there is no structured-input digest to compute:
  // the canonical send digest remains owned by the turn-admission path above and
  // is reused unchanged when external send is later wired.
  // ---------------------------------------------------------------------------

  public async createExternalRequest(
    command: CreateExternalSessionControlCommand,
  ): Promise<SessionControlRequestResponse> {
    const actor = requireExternalCompanionActor(command.actor);
    const capabilities = normalizeCapabilitySet(command.input.capabilities);
    if (command.input.clientInstanceId !== actor.clientInstanceId) {
      throw sessionControlConflict(
        "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED",
        "The request client instance does not match the authenticated companion.",
      );
    }
    const { workspaceId } = await this.resolveSessionWorkspace(command.sessionId);
    const outcome = await this.storage.sessionControls.createExternalRequest({
      workspaceId,
      sessionId: command.sessionId,
      companionSessionId: actor.companionSessionId,
      deviceGrantId: actor.deviceGrantId,
      clientInstanceId: actor.clientInstanceId,
      principalPurpose: "session_control_client",
      expectedGeneration: command.input.expectedGeneration,
      tokenHashSha256: command.input.tokenHashSha256,
      capabilities,
      idempotencyKey: command.input.idempotencyKey,
      correlationId: command.correlationId,
    });
    return parseSessionControlRequestResponse({ request: outcome.request });
  }

  public async handoff(command: HandoffSessionControlCommand): Promise<SessionControlHandoffResponse> {
    const actor = requireOperatorControlActor(command.actor);
    const effectiveCapabilities = normalizeCapabilitySet(command.input.effectiveCapabilities);
    const { workspaceId } = await this.resolveSessionWorkspace(command.sessionId);
    const outcome = await this.storage.sessionControls.handoff({
      workspaceId,
      sessionId: command.sessionId,
      requestId: command.input.requestId,
      expectedGeneration: command.input.expectedGeneration,
      effectiveCapabilities,
      operatorActorId: actor.actorId,
      idempotencyKey: command.input.idempotencyKey,
      correlationId: command.correlationId,
    });
    return parseSessionControlHandoffResponse({ request: outcome.request, control: outcome.control });
  }

  public async heartbeat(command: HeartbeatSessionControlCommand): Promise<SessionControlHeartbeatResponse> {
    const actor = requireExternalCompanionActor(command.actor);
    const tokenHashSha256 = normalizePresentedControlToken(command.presentedTokenHashSha256);
    const { workspaceId } = await this.resolveSessionWorkspace(command.sessionId);
    const outcome = await this.storage.sessionControls.heartbeat({
      workspaceId,
      sessionId: command.sessionId,
      companionSessionId: actor.companionSessionId,
      deviceGrantId: actor.deviceGrantId,
      clientInstanceId: actor.clientInstanceId,
      principalPurpose: "session_control_client",
      expectedGeneration: command.input.expectedGeneration,
      tokenHashSha256,
      idempotencyKey: command.input.idempotencyKey,
      correlationId: command.correlationId,
    });
    return parseSessionControlHeartbeatResponse({ generation: outcome.control.generation, control: outcome.control });
  }

  public async reconnect(command: ReconnectSessionControlCommand): Promise<SessionControlReconnectResponse> {
    const actor = requireExternalCompanionActor(command.actor);
    const tokenHashSha256 = normalizePresentedControlToken(command.presentedTokenHashSha256);
    const { workspaceId } = await this.resolveSessionWorkspace(command.sessionId);
    const outcome = await this.storage.sessionControls.reconnect({
      workspaceId,
      sessionId: command.sessionId,
      companionSessionId: actor.companionSessionId,
      deviceGrantId: actor.deviceGrantId,
      clientInstanceId: actor.clientInstanceId,
      principalPurpose: "session_control_client",
      expectedGeneration: command.input.expectedGeneration,
      tokenHashSha256,
      newTokenHashSha256: command.input.newTokenHashSha256,
      idempotencyKey: command.input.idempotencyKey,
      correlationId: command.correlationId,
    });
    return parseSessionControlReconnectResponse({
      supersededGeneration: command.input.expectedGeneration,
      control: outcome.control,
    });
  }

  public async release(command: ReleaseSessionControlCommand): Promise<SessionControlReleaseResponse> {
    const actor = requireExternalCompanionActor(command.actor);
    const tokenHashSha256 = normalizePresentedControlToken(command.presentedTokenHashSha256);
    const { workspaceId } = await this.resolveSessionWorkspace(command.sessionId);
    const outcome = await this.storage.sessionControls.release({
      workspaceId,
      sessionId: command.sessionId,
      companionSessionId: actor.companionSessionId,
      deviceGrantId: actor.deviceGrantId,
      clientInstanceId: actor.clientInstanceId,
      principalPurpose: "session_control_client",
      expectedGeneration: command.input.expectedGeneration,
      tokenHashSha256,
      idempotencyKey: command.input.idempotencyKey,
      correlationId: command.correlationId,
    });
    return parseSessionControlReleaseResponse({
      releasedGeneration: command.input.expectedGeneration,
      control: outcome.control,
    });
  }

  public async revoke(command: RevokeSessionControlCommand): Promise<SessionControlRevokeResponse> {
    const actor = requireOperatorControlActor(command.actor);
    const { workspaceId } = await this.resolveSessionWorkspace(command.sessionId);
    if (command.input.target === "request") {
      const outcome = await this.storage.sessionControls.cancelExternalRequest({
        workspaceId,
        sessionId: command.sessionId,
        requestId: command.input.requestId,
        operatorActorId: actor.actorId,
        idempotencyKey: command.input.idempotencyKey,
        correlationId: command.correlationId,
      });
      return parseSessionControlRevokeResponse({ target: "request", request: outcome.request });
    }
    const outcome = await this.storage.sessionControls.revoke({
      workspaceId,
      sessionId: command.sessionId,
      expectedGeneration: command.input.expectedGeneration,
      mode: command.input.mode,
      operatorActorId: actor.actorId,
      idempotencyKey: command.input.idempotencyKey,
      correlationId: command.correlationId,
    });
    return parseSessionControlRevokeResponse({
      target: "current_controller",
      revokedGeneration: command.input.expectedGeneration,
      mode: command.input.mode,
      control: outcome.control,
    });
  }

  public async cancelExternalRequest(
    command: CancelExternalSessionControlRequestCommand,
  ): Promise<SessionControlRequestRecord> {
    const actor = requireOperatorControlActor(command.actor);
    const { workspaceId } = await this.resolveSessionWorkspace(command.sessionId);
    const outcome = await this.storage.sessionControls.cancelExternalRequest({
      workspaceId,
      sessionId: command.sessionId,
      requestId: command.requestId,
      operatorActorId: actor.actorId,
      idempotencyKey: command.idempotencyKey,
      correlationId: command.correlationId,
    });
    return outcome.request;
  }

  public async getControl(query: ReadSessionControlQuery): Promise<SessionControlRecord> {
    // Purpose gate first: an unauthorized/wrong-purpose companion must be
    // rejected before any session-existence-revealing read so it cannot use a
    // guessed global sessionId as an existence oracle. Operators bypass the gate.
    const companion = query.actor.actorKind === "operator" ? undefined : requireExternalCompanionActor(query.actor);
    const { workspaceId } = await this.resolveSessionWorkspace(query.sessionId);
    const control = await this.storage.sessionControls.getControl(workspaceId, query.sessionId);
    if (!companion) return control;
    if (!isCompanionBoundController(control, companion)) {
      await this.requireCompanionPendingRequest(workspaceId, query.sessionId, companion);
    }
    return control;
  }

  public async getDetail(query: ReadSessionControlQuery): Promise<SessionControlDetailResponse> {
    // Purpose gate first (see getControl): reject before resolving session state.
    const companion = query.actor.actorKind === "operator" ? undefined : requireExternalCompanionActor(query.actor);
    const { workspaceId } = await this.resolveSessionWorkspace(query.sessionId);
    const detail = await this.storage.sessionControls.getDetail(workspaceId, query.sessionId);
    if (!companion) return detail;
    if (isCompanionBoundController(detail.control, companion)) return detail;
    const ownPending =
      detail.control.ownerKind === "operator"
        ? detail.pendingRequests.filter(
            (request) =>
              request.companionSessionId === companion.companionSessionId &&
              request.clientInstanceId === companion.clientInstanceId,
          )
        : [];
    if (ownPending.length === 0) {
      throw sessionControlConflict("SESSION_CONTROL_CAPABILITY_DENIED", "Session control read is denied.");
    }
    return parseSessionControlDetailResponse({ control: detail.control, pendingRequests: ownPending });
  }

  public async listControls(query: ListSessionControlsQuery): Promise<SessionControlListResponse> {
    requireOperatorControlActor(query.actor);
    return await this.storage.sessionControls.listControls(query.workspaceId, query.limit);
  }

  /**
   * The single authoritative gate for external session reads: bounded transcript
   * reads (`/messages`, `/history`, `/thread`, turn stream), control events, and
   * the future session-scoped event stream all delegate here so binding and
   * `read`-capability authority live in one place. Operators read directly. An
   * external companion must be the exact bound controller (matching companion
   * session AND client instance) and hold the delegated `read` capability. The
   * workspace is resolved from stored `chat_session_meta` and fails closed with
   * `NotFound` for an unknown session. Every other denial — cross-session,
   * wrong-companion binding, send-only capability, and non-external-controller
   * ownership — fails closed with `SESSION_CONTROL_CAPABILITY_DENIED`.
   */
  public async authorizeExternalSessionRead(query: ReadSessionControlQuery): Promise<void> {
    // Purpose gate first (see getControl): reject before resolving session state.
    if (query.actor.actorKind === "operator") return;
    const companion = requireExternalCompanionActor(query.actor);
    const { workspaceId } = await this.resolveSessionWorkspace(query.sessionId);
    const control = await this.storage.sessionControls.getControl(workspaceId, query.sessionId);
    const hasReadCapability =
      control.ownerKind === "external_companion" && control.capabilities.some((capability) => capability === "read");
    if (!isCompanionBoundController(control, companion) || !hasReadCapability) {
      throw sessionControlConflict("SESSION_CONTROL_CAPABILITY_DENIED", "Session control read is denied.");
    }
  }

  public async listEvents(query: ListSessionControlEventsQuery): Promise<SessionControlEventRecord[]> {
    await this.authorizeExternalSessionRead({ actor: query.actor, sessionId: query.sessionId });
    const { workspaceId } = await this.resolveSessionWorkspace(query.sessionId);
    return await this.storage.sessionControls.listEvents(
      workspaceId,
      query.sessionId,
      query.limit === undefined ? {} : { limit: query.limit },
    );
  }

  /**
   * Page the session-scoped, content-free control-event log for the realtime
   * stream by durable `event_sequence`. Authorization is delegated to the single
   * external-read gate (`authorizeExternalSessionRead`): operators read directly;
   * an external companion must be the exact bound controller holding delegated
   * `read`; a send-only, wrong-bound, non-controller, or (post-revoke/
   * superseded-away) companion fails closed BEFORE any event is read, so a
   * revoked reader's page throws and its stream can no longer surface new events.
   * The cursor is the event's true `event_sequence` (monotonic per session, never
   * reset, unaffected by the list cap), so forward paging genuinely continues
   * past 200 lifetime events instead of being pinned to the oldest rows. The
   * returned records are the same content-free `SessionControlEventRecord`
   * projection as `listEvents` — no approval action token, message text, prompt,
   * or token material can appear because the control-event table stores none.
   */
  public async pageControlEventStream(query: ControlEventStreamPageQuery): Promise<ControlEventStreamPage> {
    await this.authorizeExternalSessionRead({ actor: query.actor, sessionId: query.sessionId });
    const { workspaceId } = await this.resolveSessionWorkspace(query.sessionId);
    const control = await this.storage.sessionControls.getControl(workspaceId, query.sessionId);
    const bounds = await this.storage.sessionControls.getEventSequenceBounds(workspaceId, query.sessionId);
    const afterCursor = Number.isFinite(query.afterCursor) ? Math.max(0, Math.trunc(query.afterCursor as number)) : 0;
    const requestedLimit = Number.isFinite(query.limit)
      ? Math.trunc(query.limit as number)
      : SESSION_CONTROL_MAX_LIST_ITEMS;
    const limit = Math.min(SESSION_CONTROL_MAX_LIST_ITEMS, Math.max(1, requestedLimit));
    const rows = await this.storage.sessionControls.listEventsAfterSequence(
      workspaceId,
      query.sessionId,
      afterCursor,
      limit,
    );
    const events: ControlEventStreamEnvelope[] = rows.map((row) => ({ cursor: row.sequence, event: row.event }));
    const lastCursor = events.length > 0 ? events[events.length - 1]!.cursor : afterCursor;
    return {
      events,
      oldestSequence: bounds.oldestSequence,
      newestSequence: bounds.newestSequence,
      // "More remain past this page" → keep paging forward; never a silent dead end.
      truncated: events.length >= limit && lastCursor < bounds.newestSequence,
      generation: control.generation,
      ownerKind: control.ownerKind,
      leaseState: control.leaseState,
    };
  }

  private async resolveSessionWorkspace(sessionId: string): Promise<{ workspaceId: string }> {
    const meta = await this.storage.chatSessionMeta.get(sessionId);
    if (!meta) {
      throw new NotFoundError({ entity: "Chat session", id: sessionId });
    }
    return { workspaceId: meta.workspaceId };
  }

  private async requireCompanionPendingRequest(
    workspaceId: string,
    sessionId: string,
    actor: SessionControlExternalCompanionActor,
  ): Promise<void> {
    const detail = await this.storage.sessionControls.getDetail(workspaceId, sessionId);
    const hasPending =
      detail.control.ownerKind === "operator" &&
      detail.pendingRequests.some(
        (request) =>
          request.companionSessionId === actor.companionSessionId &&
          request.clientInstanceId === actor.clientInstanceId,
      );
    if (!hasPending) {
      throw sessionControlConflict("SESSION_CONTROL_CAPABILITY_DENIED", "Session control read is denied.");
    }
  }
}

function sessionControlConflict(code: SessionControlConflictCode, message: string): ConflictError {
  return new ConflictError({ code: "STATE_CONFLICT", message, details: { sessionControlCode: code } });
}

function isRetryablePreemptionRace(error: unknown): error is ConflictError {
  if (!(error instanceof ConflictError) || error.code !== "STATE_CONFLICT") return false;
  const details = error.details as { sessionMutationAdmissionCode?: unknown } | undefined;
  return [
    "SESSION_MUTATION_ADMISSION_AUTHORITY_CHANGED",
    "SESSION_MUTATION_HEARTBEAT_PREEMPTION_CONFLICT",
    "SESSION_MUTATION_ADMISSION_STALE",
  ].includes(String(details?.sessionMutationAdmissionCode ?? ""));
}

function isExactHeartbeatAdmission(admission: SessionMutationAdmissionRecord): boolean {
  return (
    admission.actorKind === "system" &&
    admission.actorId === "system-heartbeat" &&
    admission.operation === "chat_system_heartbeat"
  );
}

function requireOperatorControlActor(actor: SessionControlProtocolActor): SessionControlOperatorActor {
  if (actor.actorKind !== "operator") {
    throw sessionControlConflict(
      "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED",
      "Session control operator authority is required for this operation.",
    );
  }
  const actorId = actor.actorId.trim();
  if (!actorId) {
    throw new ValidationError({ field: "actorId", message: "Session control operator identity is required." });
  }
  return { actorKind: "operator", actorId };
}

function requireExternalCompanionActor(actor: SessionControlProtocolActor): SessionControlExternalCompanionActor {
  if (actor.actorKind !== "external_companion" || actor.principalPurpose !== "session_control_client") {
    throw sessionControlConflict(
      "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED",
      "Session control principal purpose is denied.",
    );
  }
  const companionSessionId = actor.companionSessionId.trim();
  const deviceGrantId = actor.deviceGrantId.trim();
  const clientInstanceId = actor.clientInstanceId.trim();
  if (!companionSessionId || !deviceGrantId || !clientInstanceId) {
    throw new ValidationError({ message: "Session control companion identity is incomplete." });
  }
  return {
    actorKind: "external_companion",
    companionSessionId,
    deviceGrantId,
    clientInstanceId,
    principalPurpose: "session_control_client",
  };
}

function normalizeCapabilitySet(input: unknown): ExternalSessionControlCapability[] {
  try {
    return [...normalizeExternalSessionControlCapabilities(input)];
  } catch {
    throw new ValidationError({ field: "capabilities", message: "Session control capability set is invalid." });
  }
}

function normalizePresentedControlToken(presented: string): string {
  try {
    return normalizeSessionControlTokenHashSha256(presented);
  } catch {
    throw sessionControlConflict("SESSION_CONTROL_TOKEN_INVALID", "Session control token is invalid.");
  }
}

function isCompanionBoundController(
  control: SessionControlRecord,
  actor: SessionControlExternalCompanionActor,
): boolean {
  return (
    control.ownerKind === "external_companion" &&
    control.boundExternalController.companionSessionId === actor.companionSessionId &&
    control.boundExternalController.clientInstanceId === actor.clientInstanceId
  );
}

function assertCanonicalSystemHeartbeatRequest(
  request: ChatSendMessageRequest,
  occurrenceRequest: HeartbeatOccurrenceAdmissionRequest,
): void {
  const policy = (request as ChatSendMessageRequest & { policyContext?: Record<string, unknown> }).policyContext as
    | {
        operatorId?: string;
        authActorId?: string;
        authActorSource?: string;
        permissionProfileId?: string;
        runId?: string;
      }
    | undefined;
  const runId = typeof policy?.runId === "string" ? policy.runId.trim() : "";
  const expectedRequest = {
    content: HEARTBEAT_SYSTEM_PROMPT,
    operatorId: "system-heartbeat",
    authActorId: "system-heartbeat",
    authActorSource: "none",
    permissionProfileId: HEARTBEAT_PERMISSION_PROFILE_ID,
    policyContext: {
      operatorId: "system-heartbeat",
      authActorId: "system-heartbeat",
      authActorSource: "none",
      permissionProfileId: HEARTBEAT_PERMISSION_PROFILE_ID,
      permissionProfile: HEARTBEAT_RESTRICTED_PROFILE,
      surface: "tools",
      workspaceId: occurrenceRequest.admissionInput.workspaceId,
      sessionId: occurrenceRequest.admissionInput.sessionId,
      runId,
    },
  };
  if (!policy || !runId || canonicalJsonString(request) !== canonicalJsonString(expectedRequest)) {
    throw new ConflictError({ message: "The heartbeat request actor or permission profile is not canonical." });
  }
}

export function computeChatTurnAdmissionMaterialSha256(request: ChatSendMessageRequest): string {
  return computeFrozenChatTurnAdmissionMaterialSha256(freezeChatTurnExecutionRequest(request));
}

export function freezeChatTurnExecutionRequest(request: ChatSendMessageRequest): FrozenChatTurnExecutionRequest {
  const {
    signal: _signal,
    operatorId: _operatorId,
    authActorId: _authActorId,
    authActorSource: _authActorSource,
    // Routed-context refs are request transport, never durable-executable
    // identity: the C1 ward strips them from every durable payload and the
    // resolver freezes their exact identity into the routed-context snapshot
    // (sourceRequestHash + snapshotHash + capability-profile/trace bindings).
    // Excluding them here keeps the admission material equal to the refs-less
    // request every durable identity re-verification reconstructs.
    contextRefs: _contextRefs,
    ...serializableExecutionRequest
  } = request;
  const normalized = {
    ...serializableExecutionRequest,
    content: serializableExecutionRequest.content.trim(),
  };
  return JSON.parse(canonicalJsonString(normalized)) as FrozenChatTurnExecutionRequest;
}

export function freezeChatTurnRequestActor(
  request: ChatSendMessageRequest,
  explicitActor?: Pick<ChatTurnAdmissionActor, "actorKind" | "actorId">,
): FrozenChatTurnRequestActor {
  // HX-408 M1-review mandate: this freeze treats every non-`none` auth source
  // as authenticated operator authority. An admitted mesh node is machine
  // identity scoped to the publication surface — it must never be admitted as
  // a trusted Chat request actor, so the source is rejected loudly instead of
  // silently downgraded.
  if (request.authActorSource === "mesh_node") {
    throw new ConflictError({
      message: "A mesh node identity can never act as a trusted Chat request actor.",
    });
  }
  const operatorId = request.operatorId?.trim();
  const authActorId = request.authActorId?.trim();
  const trustedAuthActor = Boolean(authActorId && request.authActorSource && request.authActorSource !== "none");
  const actorKind = explicitActor?.actorKind ?? "operator";
  if (actorKind === "operator" && trustedAuthActor && operatorId && operatorId !== authActorId) {
    throw new ConflictError({ message: "The Chat request actor identities conflict." });
  }
  const actorId = explicitActor?.actorId.trim() ?? (trustedAuthActor ? authActorId : (operatorId ?? "operator:local"));
  if (!actorId) {
    throw new ConflictError({ message: "The Chat request actor identity is empty." });
  }
  if (
    actorKind === "operator" &&
    explicitActor &&
    ((operatorId && operatorId !== actorId) || (trustedAuthActor && authActorId !== actorId))
  ) {
    throw new ConflictError({ message: "The Chat request actor does not match its admitted operator authority." });
  }
  return JSON.parse(
    canonicalJsonString({
      actorKind,
      actorId,
      ...(actorKind === "operator" && operatorId ? { operatorId } : {}),
      ...(actorKind === "operator" && authActorId ? { authActorId } : {}),
      ...(actorKind === "operator" && request.authActorSource ? { authActorSource: request.authActorSource } : {}),
    }),
  ) as FrozenChatTurnRequestActor;
}

export function resolveChatTurnAdmissionActorId(request: ChatSendMessageRequest): string {
  return freezeChatTurnRequestActor(request).actorId;
}

export function computeFrozenChatTurnAdmissionMaterialSha256(request: FrozenChatTurnExecutionRequest): string {
  return createHash("sha256")
    .update(
      canonicalJsonString({
        version: 2,
        request,
      }),
    )
    .digest("hex");
}

export function computeEffectiveChatTurnRequestMaterialSha256(
  admissionMaterialSha256: string,
  request: FrozenChatTurnExecutionRequest,
): string {
  return createHash("sha256")
    .update(canonicalJsonString({ version: 1, admissionMaterialSha256, request }))
    .digest("hex");
}

export function deriveChatTurnSurfaceDerivation(
  admittedRequest: FrozenChatTurnExecutionRequest,
  effectiveRequest: FrozenChatTurnExecutionRequest,
): ChatTurnSurfaceDerivation | undefined {
  if (canonicalJsonString(admittedRequest) === canonicalJsonString(effectiveRequest)) return undefined;
  const expectedEffective = { ...admittedRequest, mode: "chat" as const, autoRoute: false };
  if (canonicalJsonString(expectedEffective) !== canonicalJsonString(effectiveRequest)) {
    throw new ConflictError({ message: "The effective Chat request is not an admitted surface-routing derivation." });
  }
  return {
    version: 1,
    originalMode: admittedRequest.mode ?? null,
    originalAutoRoute: admittedRequest.autoRoute ?? null,
    effectiveMode: "chat",
    effectiveAutoRoute: false,
  };
}

export function reconstructAdmittedChatTurnRequest(
  effectiveRequest: FrozenChatTurnExecutionRequest,
  derivation: ChatTurnSurfaceDerivation | undefined,
): FrozenChatTurnExecutionRequest {
  if (!derivation) return effectiveRequest;
  if (
    derivation.version !== 1 ||
    derivation.effectiveMode !== "chat" ||
    derivation.effectiveAutoRoute !== false ||
    effectiveRequest.mode !== "chat" ||
    effectiveRequest.autoRoute !== false
  ) {
    throw new ConflictError({ message: "The durable Chat surface derivation is invalid." });
  }
  const admitted = { ...effectiveRequest } as ChatSendMessageRequest;
  if (derivation.originalMode === null) delete admitted.mode;
  else admitted.mode = derivation.originalMode;
  if (derivation.originalAutoRoute === null) delete admitted.autoRoute;
  else admitted.autoRoute = derivation.originalAutoRoute;
  return freezeChatTurnExecutionRequest(admitted);
}

function activeAdmissionFromRecord(
  record: SessionMutationAdmissionRecord,
  materialSha256: string,
  admittedRequest: FrozenChatTurnExecutionRequest,
  requestActor: FrozenChatTurnRequestActor,
  requireRequestLease: boolean,
  systemHeartbeatOccurrence?: Readonly<SystemHeartbeatOccurrenceTurnAdmission>,
): ActiveTurnAdmission {
  assertAdmissionMaterial(record, materialSha256);
  assertAdmissionActor(record, requestActor);
  if (record.status !== "active") {
    throw new ConflictError({
      message: `The Chat turn occurrence is already terminal (${record.terminalAuthorityKind ?? record.status}).`,
    });
  }
  if (!record.turnId) {
    throw new ConflictError({ message: "The admitted Chat turn is missing its immutable turn id." });
  }
  const identity: TurnAdmissionIdentity = {
    admissionId: record.admissionId,
    sessionIncarnationId: record.sessionIncarnationId,
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    aggregateRevision: record.aggregateRevision,
    controllerGeneration: record.controllerGeneration,
    materialSha256,
  };
  return {
    identity,
    admittedRequest,
    requestActor,
    ...(systemHeartbeatOccurrence ? { systemHeartbeatOccurrence } : {}),
    ...(requireRequestLease ? { requestClaim: requireStoredRequestClaim(record) } : {}),
  };
}

function freezeSystemHeartbeatOccurrenceAdmission(
  record: SessionMutationAdmissionRecord,
  input: Pick<SystemHeartbeatOccurrenceTurnAdmission, "occurrenceId" | "claimSha256" | "durableRunId">,
): Readonly<SystemHeartbeatOccurrenceTurnAdmission> {
  if (
    record.operation !== "chat_system_heartbeat" ||
    record.correlationId !== input.occurrenceId ||
    !input.occurrenceId ||
    !input.claimSha256 ||
    !input.durableRunId
  ) {
    throw new ConflictError({ message: "The heartbeat admission lacks its exact occurrence discriminator." });
  }
  return Object.freeze({
    kind: "system_heartbeat_occurrence",
    operation: "chat_system_heartbeat",
    occurrenceId: input.occurrenceId,
    correlationId: record.correlationId,
    claimSha256: input.claimSha256,
    durableRunId: input.durableRunId,
  });
}

function normalizeChatTurnAdmissionActor(actor: ChatTurnAdmissionActor): ChatTurnAdmissionActor {
  const actorId = actor.actorId.trim();
  if (!actorId) {
    throw new ConflictError({ message: "The Chat turn admission actor identity is empty." });
  }
  if (actor.actorKind === "external_companion") {
    const companionSessionId = actor.companionSessionId.trim();
    if (!companionSessionId || actorId !== companionSessionId) {
      throw new ConflictError({
        message: "External Chat turn admission requires the raw authenticated companion session id.",
      });
    }
    if (!Number.isInteger(actor.expectedGeneration) || actor.expectedGeneration < 1) {
      throw sessionControlConflict(
        "SESSION_CONTROL_GENERATION_STALE",
        "External Chat turn admission requires a positive expected controller generation.",
      );
    }
    return { ...actor, actorId, companionSessionId };
  }
  return { ...actor, actorId };
}

function requireStoredRequestClaim(record: SessionMutationAdmissionRecord): TurnAdmissionRequestClaim {
  if (!record.runtimeOwnerId || !record.runtimeLeaseRevision) {
    throw new ConflictError({ message: "The admitted Chat turn is missing its request-runtime lease." });
  }
  return { runtimeOwnerId: record.runtimeOwnerId, leaseRevision: record.runtimeLeaseRevision };
}

function requireRequestClaim(admission: ActiveTurnAdmission): TurnAdmissionRequestClaim {
  if (!admission.requestClaim || admission.durableClaim) {
    throw new ConflictError({ message: "The Chat turn is not owned by an exclusive request-runtime claim." });
  }
  return admission.requestClaim;
}

function toStorageIdentity(identity: TurnAdmissionIdentity) {
  return {
    admissionId: identity.admissionId,
    workspaceId: identity.workspaceId,
    sessionId: identity.sessionId,
    sessionIncarnationId: identity.sessionIncarnationId,
    turnId: identity.turnId,
  };
}

function toStorageRequestClaim(claim: TurnAdmissionRequestClaim): RequestRuntimeLeaseClaim {
  return { runtimeOwnerId: claim.runtimeOwnerId, leaseRevision: claim.leaseRevision };
}

function toStorageDurableClaim(claim: TurnAdmissionDurableClaim): DurableTurnWriteClaim {
  return {
    durableRunId: claim.durableRunId,
    leaseOwnerId: claim.leaseOwnerId,
    attemptCount: claim.attemptCount,
  };
}

function assertAdmissionMaterial(record: SessionMutationAdmissionRecord, materialSha256: string): void {
  if (record.materialSha256 !== materialSha256) {
    throw new ConflictError({ message: "The Chat turn admission material digest conflicts." });
  }
}

function assertAdmissionActor(record: SessionMutationAdmissionRecord, requestActor: FrozenChatTurnRequestActor): void {
  if (record.actorKind !== requestActor.actorKind || record.actorId !== requestActor.actorId) {
    throw new ConflictError({ message: "The Chat turn admission actor authority conflicts." });
  }
}

function assertAdmissionIdentity(record: SessionMutationAdmissionRecord, identity: TurnAdmissionIdentity): void {
  assertAdmissionMaterial(record, identity.materialSha256);
  if (
    record.admissionId !== identity.admissionId ||
    record.sessionIncarnationId !== identity.sessionIncarnationId ||
    record.workspaceId !== identity.workspaceId ||
    record.sessionId !== identity.sessionId ||
    record.turnId !== identity.turnId ||
    record.aggregateRevision !== identity.aggregateRevision ||
    record.controllerGeneration !== identity.controllerGeneration
  ) {
    throw new ConflictError({ message: "The Chat turn admission identity conflicts." });
  }
}
