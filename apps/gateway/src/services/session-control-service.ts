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
  Storage,
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

/**
 * Stateless Gateway domain boundary over the durable session-control stores.
 * It never infers authority from ambient request state or from current metadata
 * after admission; callers must keep passing the frozen turn identity.
 */
export class SessionControlService {
  public constructor(private readonly storage: SessionControlStorage) {}

  public admitOperatorChatTurn(input: AdmitOperatorChatTurnInput): ActiveTurnAdmission {
    if (input.authenticatedOperator) {
      return this.admitAuthenticatedOperatorChatTurn(input, input.authenticatedOperator);
    }
    return this.admitChatTurn({
      ...input,
      actor: { actorKind: "operator", actorId: input.actorId },
    });
  }

  private admitAuthenticatedOperatorChatTurn(
    input: AdmitOperatorChatTurnInput,
    authenticatedOperator: AuthenticatedOperatorAdmissionContext,
  ): ActiveTurnAdmission {
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

    const meta = this.storage.chatSessionMeta.get(input.sessionId);
    if (!meta) {
      throw new NotFoundError({ entity: "Chat session", id: input.sessionId });
    }
    const observedControl = this.storage.sessionControls.getControl(meta.workspaceId, input.sessionId);
    const control = this.storage.sessionControls.resolveMutationAuthority({
      actorKind: "operator",
      workspaceId: meta.workspaceId,
      sessionId: input.sessionId,
      expectedGeneration: observedControl.generation,
    });
    const admittedRequest = freezeChatTurnExecutionRequest(input.request);
    const requestActor = freezeChatTurnRequestActor(input.request, { actorKind: "operator", actorId });
    const materialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(admittedRequest);
    const outcome = this.storage.sessionMutationAdmissions.preemptHeartbeatAndAdmitOperatorTurn({
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
    return activeAdmissionFromRecord(outcome.admission, materialSha256, admittedRequest, requestActor, true);
  }

  public admitChatTurn(input: AdmitChatTurnInput): ActiveTurnAdmission {
    const meta = this.storage.chatSessionMeta.get(input.sessionId);
    if (!meta) {
      throw new NotFoundError({ entity: "Chat session", id: input.sessionId });
    }
    const observedControl = this.storage.sessionControls.getControl(meta.workspaceId, input.sessionId);
    const actor = normalizeChatTurnAdmissionActor(input.actor);
    const control =
      actor.actorKind === "external_companion"
        ? this.storage.sessionControls.resolveMutationAuthority({
            actorKind: "external_companion",
            workspaceId: meta.workspaceId,
            sessionId: input.sessionId,
            expectedGeneration: observedControl.generation,
            companionSessionId: actor.companionSessionId,
            deviceGrantId: actor.deviceGrantId,
            clientInstanceId: actor.clientInstanceId,
            principalPurpose: actor.principalPurpose,
            tokenHashSha256: actor.tokenHashSha256,
            requiredCapability: actor.requiredCapability,
          })
        : this.storage.sessionControls.resolveMutationAuthority({
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
    const outcome = this.storage.sessionMutationAdmissions.admit({
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
   * Admit the exact heartbeat callback prepared by the storage claim owner.
   * This method is deliberately synchronous: cadence consumption, admission,
   * and occurrence insertion must remain inside one database transaction.
   */
  public admitSystemHeartbeatOccurrence(input: AdmitSystemHeartbeatOccurrenceInput): AdmittedSystemHeartbeatOccurrence {
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
    const meta = this.storage.chatSessionMeta.get(admissionInput.sessionId);
    if (!meta || meta.workspaceId !== admissionInput.workspaceId) {
      throw new ConflictError({ message: "The heartbeat occurrence callback has no exact Chat session workspace." });
    }
    const outcome = this.storage.sessionMutationAdmissions.admit(admissionInput);
    const admission = activeAdmissionFromRecord(
      outcome.admission,
      materialSha256,
      admittedRequest,
      requestActor,
      true,
      freezeSystemHeartbeatOccurrenceAdmission(outcome.admission, {
        occurrenceId: occurrenceRequest.occurrenceId,
        claimSha256: occurrenceRequest.claimSha256,
        durableRunId: occurrenceRequest.child.durableRunId,
      }),
    );
    return { admission, record: outcome.admission };
  }

  /** Recover only the exact expired pre-bind lease owned by one occurrence. */
  public recoverSystemHeartbeatOccurrence(
    input: RecoverSystemHeartbeatOccurrenceInput,
  ): RecoverSystemHeartbeatOccurrenceOutcome {
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
    const stored = this.storage.sessionMutationAdmissions.require(occurrence.admissionId);
    const outcome: ReclaimExpiredSystemTurnWriteRequestLeaseOutcome =
      this.storage.sessionMutationAdmissions.reclaimExpiredSystemTurnWriteRequestLease({
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

  public renewRequestLease(admission: ActiveTurnAdmission): ActiveTurnAdmission {
    const claim = requireRequestClaim(admission);
    const record = this.storage.sessionMutationAdmissions.renewTurnWriteRequestLease({
      ...toStorageIdentity(admission.identity),
      requestRuntimeClaim: claim,
    });
    assertAdmissionIdentity(record, admission.identity);
    const nextClaim = requireStoredRequestClaim(record);
    claim.runtimeOwnerId = nextClaim.runtimeOwnerId;
    claim.leaseRevision = nextClaim.leaseRevision;
    return admission;
  }

  public bindDurableRun(admission: ActiveTurnAdmission, durableRunId: string): void {
    const requestRuntimeClaim = requireRequestClaim(admission);
    assertAdmissionIdentity(
      this.storage.sessionMutationAdmissions.require(admission.identity.admissionId),
      admission.identity,
    );
    assertAdmissionActor(
      this.storage.sessionMutationAdmissions.require(admission.identity.admissionId),
      admission.requestActor,
    );
    this.storage.sessionMutationAdmissions.bindDurableRun({
      ...toStorageIdentity(admission.identity),
      durableRunId,
      requestRuntimeClaim,
    });
    admission.requestClaim = undefined;
  }

  public assertActiveTurnWrite(admission: ActiveTurnAdmission): SessionMutationAdmissionRecord {
    const requestRuntimeClaim = admission.requestClaim ? toStorageRequestClaim(admission.requestClaim) : undefined;
    const durableClaim = admission.durableClaim ? toStorageDurableClaim(admission.durableClaim) : undefined;
    if (!requestRuntimeClaim && !durableClaim) {
      throw new ConflictError({ message: "The Chat turn has no active request or durable execution claim." });
    }
    const outcome = this.storage.sessionMutationAdmissions.assertActiveTurnWrite({
      ...toStorageIdentity(admission.identity),
      ...(requestRuntimeClaim ? { requestRuntimeClaim } : {}),
      ...(durableClaim ? { durableClaim } : {}),
    });
    assertAdmissionIdentity(outcome.admission, admission.identity);
    assertAdmissionActor(outcome.admission, admission.requestActor);
    return outcome.admission;
  }

  public closeTurnWrite(input: CloseChatTurnAdmissionInput): SessionMutationAdmissionRecord {
    const requestRuntimeClaim = input.admission.requestClaim
      ? toStorageRequestClaim(input.admission.requestClaim)
      : undefined;
    const durableClaim = input.admission.durableClaim ? toStorageDurableClaim(input.admission.durableClaim) : undefined;
    if (!requestRuntimeClaim && !durableClaim) {
      throw new ConflictError({ message: "The Chat turn has no active claim for terminal closure." });
    }
    const record = this.storage.sessionMutationAdmissions.closeTurnWrite({
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

  public cancelExpiredUnboundTurnAdmissions(input: {
    actorId: string;
    idempotencyKeyPrefix: string;
    correlationId: string;
    limit?: number;
  }): string[] {
    return this.storage.sessionMutationAdmissions.cancelExpiredUnboundTurnAdmissions(input).cancelledAdmissionIds;
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

  public createExternalRequest(command: CreateExternalSessionControlCommand): SessionControlRequestResponse {
    const actor = requireExternalCompanionActor(command.actor);
    const capabilities = normalizeCapabilitySet(command.input.capabilities);
    if (command.input.clientInstanceId !== actor.clientInstanceId) {
      throw sessionControlConflict(
        "SESSION_CONTROL_PRINCIPAL_PURPOSE_DENIED",
        "The request client instance does not match the authenticated companion.",
      );
    }
    const { workspaceId } = this.resolveSessionWorkspace(command.sessionId);
    const outcome = this.storage.sessionControls.createExternalRequest({
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

  public handoff(command: HandoffSessionControlCommand): SessionControlHandoffResponse {
    const actor = requireOperatorControlActor(command.actor);
    const effectiveCapabilities = normalizeCapabilitySet(command.input.effectiveCapabilities);
    const { workspaceId } = this.resolveSessionWorkspace(command.sessionId);
    const outcome = this.storage.sessionControls.handoff({
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

  public heartbeat(command: HeartbeatSessionControlCommand): SessionControlHeartbeatResponse {
    const actor = requireExternalCompanionActor(command.actor);
    const tokenHashSha256 = normalizePresentedControlToken(command.presentedTokenHashSha256);
    const { workspaceId } = this.resolveSessionWorkspace(command.sessionId);
    const outcome = this.storage.sessionControls.heartbeat({
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

  public reconnect(command: ReconnectSessionControlCommand): SessionControlReconnectResponse {
    const actor = requireExternalCompanionActor(command.actor);
    const tokenHashSha256 = normalizePresentedControlToken(command.presentedTokenHashSha256);
    const { workspaceId } = this.resolveSessionWorkspace(command.sessionId);
    const outcome = this.storage.sessionControls.reconnect({
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

  public release(command: ReleaseSessionControlCommand): SessionControlReleaseResponse {
    const actor = requireExternalCompanionActor(command.actor);
    const tokenHashSha256 = normalizePresentedControlToken(command.presentedTokenHashSha256);
    const { workspaceId } = this.resolveSessionWorkspace(command.sessionId);
    const outcome = this.storage.sessionControls.release({
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

  public revoke(command: RevokeSessionControlCommand): SessionControlRevokeResponse {
    const actor = requireOperatorControlActor(command.actor);
    const { workspaceId } = this.resolveSessionWorkspace(command.sessionId);
    if (command.input.target === "request") {
      const outcome = this.storage.sessionControls.cancelExternalRequest({
        workspaceId,
        sessionId: command.sessionId,
        requestId: command.input.requestId,
        operatorActorId: actor.actorId,
        idempotencyKey: command.input.idempotencyKey,
        correlationId: command.correlationId,
      });
      return parseSessionControlRevokeResponse({ target: "request", request: outcome.request });
    }
    const outcome = this.storage.sessionControls.revoke({
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

  public cancelExternalRequest(command: CancelExternalSessionControlRequestCommand): SessionControlRequestRecord {
    const actor = requireOperatorControlActor(command.actor);
    const { workspaceId } = this.resolveSessionWorkspace(command.sessionId);
    const outcome = this.storage.sessionControls.cancelExternalRequest({
      workspaceId,
      sessionId: command.sessionId,
      requestId: command.requestId,
      operatorActorId: actor.actorId,
      idempotencyKey: command.idempotencyKey,
      correlationId: command.correlationId,
    });
    return outcome.request;
  }

  public getControl(query: ReadSessionControlQuery): SessionControlRecord {
    const { workspaceId } = this.resolveSessionWorkspace(query.sessionId);
    const control = this.storage.sessionControls.getControl(workspaceId, query.sessionId);
    if (query.actor.actorKind === "operator") return control;
    const actor = requireExternalCompanionActor(query.actor);
    if (!isCompanionBoundController(control, actor)) {
      this.requireCompanionPendingRequest(workspaceId, query.sessionId, actor);
    }
    return control;
  }

  public getDetail(query: ReadSessionControlQuery): SessionControlDetailResponse {
    const { workspaceId } = this.resolveSessionWorkspace(query.sessionId);
    const detail = this.storage.sessionControls.getDetail(workspaceId, query.sessionId);
    if (query.actor.actorKind === "operator") return detail;
    const actor = requireExternalCompanionActor(query.actor);
    if (isCompanionBoundController(detail.control, actor)) return detail;
    const ownPending =
      detail.control.ownerKind === "operator"
        ? detail.pendingRequests.filter(
            (request) =>
              request.companionSessionId === actor.companionSessionId &&
              request.clientInstanceId === actor.clientInstanceId,
          )
        : [];
    if (ownPending.length === 0) {
      throw sessionControlConflict("SESSION_CONTROL_CAPABILITY_DENIED", "Session control read is denied.");
    }
    return parseSessionControlDetailResponse({ control: detail.control, pendingRequests: ownPending });
  }

  public listControls(query: ListSessionControlsQuery): SessionControlListResponse {
    requireOperatorControlActor(query.actor);
    return this.storage.sessionControls.listControls(query.workspaceId, query.limit);
  }

  public listEvents(query: ListSessionControlEventsQuery): SessionControlEventRecord[] {
    const { workspaceId } = this.resolveSessionWorkspace(query.sessionId);
    if (query.actor.actorKind !== "operator") {
      const actor = requireExternalCompanionActor(query.actor);
      const control = this.storage.sessionControls.getControl(workspaceId, query.sessionId);
      const hasReadCapability =
        control.ownerKind === "external_companion" && control.capabilities.some((capability) => capability === "read");
      if (!isCompanionBoundController(control, actor) || !hasReadCapability) {
        throw sessionControlConflict("SESSION_CONTROL_CAPABILITY_DENIED", "Session control event read is denied.");
      }
    }
    return this.storage.sessionControls.listEvents(
      workspaceId,
      query.sessionId,
      query.limit === undefined ? {} : { limit: query.limit },
    );
  }

  private resolveSessionWorkspace(sessionId: string): { workspaceId: string } {
    const meta = this.storage.chatSessionMeta.get(sessionId);
    if (!meta) {
      throw new NotFoundError({ entity: "Chat session", id: sessionId });
    }
    return { workspaceId: meta.workspaceId };
  }

  private requireCompanionPendingRequest(
    workspaceId: string,
    sessionId: string,
    actor: SessionControlExternalCompanionActor,
  ): void {
    const detail = this.storage.sessionControls.getDetail(workspaceId, sessionId);
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
