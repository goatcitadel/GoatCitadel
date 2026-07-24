import { createHash, randomUUID } from "node:crypto";
import type { ChatSendMessageRequest } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { HeartbeatOccurrenceAdmissionRequest, HeartbeatOccurrenceRecord } from "@goatcitadel/storage";
import type {
  ActiveTurnAdmission,
  FrozenChatTurnExecutionRequest,
  FrozenChatTurnRequestActor,
  SystemHeartbeatOccurrenceTurnAdmission,
  TurnAdmissionDurableClaim,
  TurnAdmissionIdentity,
} from "./chat-turn-types.js";
import {
  DecisionCommittedHeartbeatAdmissionError,
  SessionControlService,
  type AuthenticatedOperatorAdmissionContext,
  type ChatTurnAdmissionActor,
  type DecisionCommittedHeartbeatRecoveryIdentity,
} from "./session-control-service.js";

const REQUEST_LEASE_HEARTBEAT_MS = 20_000;

export interface AdmitRuntimeOwnedChatTurnInput {
  sessionId: string;
  turnId: string;
  request: ChatSendMessageRequest;
  actorId: string;
  idempotencyKey: string;
  correlationId: string;
  authenticatedOperator?: AuthenticatedOperatorAdmissionContext;
}

export interface AdmitRuntimeOwnedActorChatTurnInput extends Omit<AdmitRuntimeOwnedChatTurnInput, "actorId"> {
  actor: ChatTurnAdmissionActor;
}

export interface AdmitRuntimeOwnedSystemChatTurnInput extends Omit<AdmitRuntimeOwnedChatTurnInput, "actorId"> {
  systemActorId: string;
  occurrenceId: string;
}

export interface TurnAdmissionHeartbeatHandle {
  stop(): void;
  assertHealthy(): void;
}

export type RecoverDecisionCommittedHeartbeat = (identity: DecisionCommittedHeartbeatRecoveryIdentity) => Promise<void>;

/**
 * Process owner for explicit pre-durable turn leases. The WeakMap only ensures
 * one owner per Storage instance; it is never used to recover turn authority.
 * Every operation still receives the complete admission identity explicitly.
 */
export class SessionControlRuntimeOwner {
  public constructor(private readonly service: SessionControlService) {}

  public admitOperatorChatTurn(input: AdmitRuntimeOwnedChatTurnInput): ActiveTurnAdmission {
    return this.service.admitOperatorChatTurn({
      ...input,
      runtimeOwnerId: `chat-turn-request:${randomUUID()}`,
    });
  }

  /**
   * Authenticated operator ingress may encounter the narrow window after a
   * heartbeat decision transaction commits but before its canonical durable
   * finalizer closes the heartbeat admission. Freeze one request-runtime owner,
   * request exact recovery, and replay the identical admission once. No other
   * caller receives this recovery authority.
   */
  public async admitAuthenticatedOperatorChatTurnWithHeartbeatRecovery(
    input: AdmitRuntimeOwnedChatTurnInput & { authenticatedOperator: AuthenticatedOperatorAdmissionContext },
    recover: RecoverDecisionCommittedHeartbeat,
  ): Promise<ActiveTurnAdmission> {
    const ownedInput = Object.freeze({
      ...input,
      runtimeOwnerId: `chat-turn-request:${randomUUID()}`,
    });
    try {
      return this.service.admitOperatorChatTurn(ownedInput);
    } catch (error) {
      if (!(error instanceof DecisionCommittedHeartbeatAdmissionError)) throw error;
      await recover(error.recovery);
    }
    try {
      return this.service.admitOperatorChatTurn(ownedInput);
    } catch (error) {
      if (error instanceof DecisionCommittedHeartbeatAdmissionError) {
        throw new DecisionCommittedHeartbeatAdmissionError(error.recovery);
      }
      throw error;
    }
  }

  public admitChatTurn(input: AdmitRuntimeOwnedActorChatTurnInput): ActiveTurnAdmission {
    return this.service.admitChatTurn({
      ...input,
      runtimeOwnerId: `chat-turn-request:${randomUUID()}`,
    });
  }

  /**
   * Trusted internal occurrences use a deterministic pre-durable lease owner.
   * A process crash can therefore replay the same still-live lease, while an
   * unrelated request can never claim it by choosing a fresh runtime UUID.
   */
  public admitSystemChatTurn(input: AdmitRuntimeOwnedSystemChatTurnInput): ActiveTurnAdmission {
    const occurrenceId = input.occurrenceId.trim();
    if (!occurrenceId) throw new Error("System Chat turn admission requires an occurrence identity.");
    const runtimeOwnerId = `chat-turn-system:${createHash("sha256")
      .update(`${input.sessionId}\0${input.turnId}\0${occurrenceId}`)
      .digest("hex")}`;
    const { systemActorId, ...admissionInput } = input;
    return this.service.admitChatTurn({
      ...admissionInput,
      runtimeOwnerId,
      actor: { actorKind: "system", actorId: systemActorId },
    });
  }

  public admitSystemHeartbeatOccurrence(input: {
    occurrenceRequest: HeartbeatOccurrenceAdmissionRequest;
    request: ChatSendMessageRequest;
  }): ReturnType<SessionControlService["admitSystemHeartbeatOccurrence"]> {
    return this.service.admitSystemHeartbeatOccurrence(input);
  }

  public recoverSystemHeartbeatOccurrence(input: {
    occurrence: HeartbeatOccurrenceRecord;
    request: ChatSendMessageRequest;
  }): ReturnType<SessionControlService["recoverSystemHeartbeatOccurrence"]> {
    return this.service.recoverSystemHeartbeatOccurrence(input);
  }

  public startRequestLeaseHeartbeat(
    admission: ActiveTurnAdmission,
    onFailure?: (error: unknown) => void,
  ): TurnAdmissionHeartbeatHandle {
    let stopped = false;
    let failure: unknown;
    const timer = setInterval(() => {
      if (stopped || failure) return;
      if (!admission.requestClaim) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      try {
        this.service.renewRequestLease(admission);
      } catch (error) {
        failure = error;
        onFailure?.(error);
      }
    }, REQUEST_LEASE_HEARTBEAT_MS);
    timer.unref?.();
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      },
      assertHealthy: () => {
        if (failure) throw failure;
      },
    };
  }

  public renewRequestLease(admission: ActiveTurnAdmission): ActiveTurnAdmission {
    return this.service.renewRequestLease(admission);
  }

  public bindDurableRun(admission: ActiveTurnAdmission, durableRunId: string): void {
    this.service.bindDurableRun(admission, durableRunId);
  }

  public withDurableClaim(
    identity: TurnAdmissionIdentity,
    admittedRequest: FrozenChatTurnExecutionRequest,
    requestActor: FrozenChatTurnRequestActor,
    durableClaim: TurnAdmissionDurableClaim,
    systemHeartbeatOccurrence?: Readonly<SystemHeartbeatOccurrenceTurnAdmission>,
  ): ActiveTurnAdmission {
    return {
      identity,
      admittedRequest,
      requestActor,
      durableClaim: Object.freeze({ ...durableClaim }),
      ...(systemHeartbeatOccurrence
        ? { systemHeartbeatOccurrence: Object.freeze({ ...systemHeartbeatOccurrence }) }
        : {}),
    };
  }

  public assertActiveTurnWrite(admission: ActiveTurnAdmission): void {
    this.service.assertActiveTurnWrite(admission);
  }

  public closeTurnWrite(input: Parameters<SessionControlService["closeTurnWrite"]>[0]): void {
    this.service.closeTurnWrite(input);
  }

  public cancelExpiredUnboundTurnAdmissions(
    input: Parameters<SessionControlService["cancelExpiredUnboundTurnAdmissions"]>[0],
  ): string[] {
    return this.service.cancelExpiredUnboundTurnAdmissions(input);
  }

  // ---------------------------------------------------------------------------
  // Controller-protocol business ownership (HX-411). These are stateless thin
  // pass-throughs to the sole control-domain owner, surfaced on the same runtime
  // seam the entry/route layers already use for turn admission. They hold no
  // process-local authority; the service resolves every stored binding.
  // ---------------------------------------------------------------------------

  public createExternalRequest(
    command: Parameters<SessionControlService["createExternalRequest"]>[0],
  ): ReturnType<SessionControlService["createExternalRequest"]> {
    return this.service.createExternalRequest(command);
  }

  public cancelExternalRequest(
    command: Parameters<SessionControlService["cancelExternalRequest"]>[0],
  ): ReturnType<SessionControlService["cancelExternalRequest"]> {
    return this.service.cancelExternalRequest(command);
  }

  public handoff(
    command: Parameters<SessionControlService["handoff"]>[0],
  ): ReturnType<SessionControlService["handoff"]> {
    return this.service.handoff(command);
  }

  public heartbeat(
    command: Parameters<SessionControlService["heartbeat"]>[0],
  ): ReturnType<SessionControlService["heartbeat"]> {
    return this.service.heartbeat(command);
  }

  public reconnect(
    command: Parameters<SessionControlService["reconnect"]>[0],
  ): ReturnType<SessionControlService["reconnect"]> {
    return this.service.reconnect(command);
  }

  public release(
    command: Parameters<SessionControlService["release"]>[0],
  ): ReturnType<SessionControlService["release"]> {
    return this.service.release(command);
  }

  public revoke(command: Parameters<SessionControlService["revoke"]>[0]): ReturnType<SessionControlService["revoke"]> {
    return this.service.revoke(command);
  }

  public authorizeExternalSessionRead(
    query: Parameters<SessionControlService["authorizeExternalSessionRead"]>[0],
  ): ReturnType<SessionControlService["authorizeExternalSessionRead"]> {
    return this.service.authorizeExternalSessionRead(query);
  }

  public getControl(
    query: Parameters<SessionControlService["getControl"]>[0],
  ): ReturnType<SessionControlService["getControl"]> {
    return this.service.getControl(query);
  }

  public getDetail(
    query: Parameters<SessionControlService["getDetail"]>[0],
  ): ReturnType<SessionControlService["getDetail"]> {
    return this.service.getDetail(query);
  }

  public listControls(
    query: Parameters<SessionControlService["listControls"]>[0],
  ): ReturnType<SessionControlService["listControls"]> {
    return this.service.listControls(query);
  }

  public listEvents(
    query: Parameters<SessionControlService["listEvents"]>[0],
  ): ReturnType<SessionControlService["listEvents"]> {
    return this.service.listEvents(query);
  }

  public pageControlEventStream(
    query: Parameters<SessionControlService["pageControlEventStream"]>[0],
  ): ReturnType<SessionControlService["pageControlEventStream"]> {
    return this.service.pageControlEventStream(query);
  }
}

const runtimeOwners = new WeakMap<object, SessionControlRuntimeOwner>();

export function getSessionControlRuntimeOwner(storage: Storage): SessionControlRuntimeOwner {
  const existing = runtimeOwners.get(storage);
  if (existing) return existing;
  const created = new SessionControlRuntimeOwner(new SessionControlService(storage));
  runtimeOwners.set(storage, created);
  return created;
}

export function cancelExpiredUnboundChatTurnAdmissionsOnBoot(
  owner: Pick<SessionControlRuntimeOwner, "cancelExpiredUnboundTurnAdmissions">,
  correlationId: string,
): string[] {
  const cancelled: string[] = [];
  const limit = 100;
  for (;;) {
    const batch = owner.cancelExpiredUnboundTurnAdmissions({
      actorId: "system:gateway-startup",
      idempotencyKeyPrefix: "gateway-startup:expired-unbound-chat-turn",
      correlationId,
      limit,
    });
    cancelled.push(...batch);
    if (batch.length < limit) return cancelled;
  }
}
