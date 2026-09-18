import { readDurableChatTurnExecutionPayloadAuthority, type DurableRunRecord } from "@goatcitadel/contracts";
import type { AsyncStorage, GovernedRemediationStoredState } from "@goatcitadel/storage";
import type {
  GovernedRemediationDurableParentPort,
  GovernedRemediationDurableResumeRequest,
  GovernedRemediationParentReservationRequest,
} from "./governed-remediation-coordinator.js";
import { verifySettledChatWaitingAuthority } from "./chat-durable-waiting-authority.js";

type ParentStorage = Pick<AsyncStorage, "runImmediateTransaction" | "durableRuns" | "sessionMutationAdmissions" | "governedRemediations">;
export interface GovernedRemediationParentMutationAuthority {
  readonly operation: "reserve" | "resume";
  readonly request: GovernedRemediationParentReservationRequest | GovernedRemediationDurableResumeRequest;
  readonly state: GovernedRemediationStoredState;
  readonly run: DurableRunRecord;
}

/** The injected authority owner must check current deny-wins policy and exact,
 * purpose-specific approvals. No permissive default is provided. The adapter
 * binds its decision and the storage CAS to one immediate transaction. */
export class GovernedRemediationDurableParentAdapter implements GovernedRemediationDurableParentPort {
  public constructor(private readonly storage: ParentStorage,
    private readonly authorizeMutation: (input: GovernedRemediationParentMutationAuthority) => Promise<void>) {}

  public async reserve(request: GovernedRemediationParentReservationRequest) {
    return this.storage.runImmediateTransaction(async () => {
      const parent = await this.readParent(request);
      await this.requireWaiting(parent.run, request, [request.expectedWaitingRunVersion, request.expectedWaitingRunVersion + 1]);
      await this.authorizeMutation({ operation: "reserve", request, state: parent.state, run: parent.run });
      const result = await this.storage.sessionMutationAdmissions.reserveDurableChatRemediation({ ...request, ...parent.identity });
      return { status: "reserved" as const, reservationId: result.reservationId, replayed: result.replayed };
    });
  }

  public async resume(request: GovernedRemediationDurableResumeRequest) {
    return this.storage.runImmediateTransaction(async () => {
      const parent = await this.readParent(request);
      const input = { ...parent.identity, ...request, reservationId: request.parentReservationId,
        expectedReservedRunVersion: request.expectedWaitingRunVersion + 1 };
      const prior = await this.storage.sessionMutationAdmissions.findDurableChatRemediationResume(input);
      if (prior) return { status: "resumed" as const, resumedRunVersion: prior.resultingRunVersion, replayed: true };
      const promptId = await this.requireWaiting(parent.run, request, [input.expectedReservedRunVersion]);
      await this.authorizeMutation({ operation: "resume", request, state: parent.state, run: parent.run });
      const result = await this.storage.sessionMutationAdmissions.resumeDurableChatRemediation({ ...input,
        stateRevision: parent.state.record.revision, promptId });
      return { status: "resumed" as const, resumedRunVersion: result.resultingRunVersion, replayed: result.replayed };
    });
  }

  public async observeResume(request: GovernedRemediationDurableResumeRequest) {
    return this.storage.runImmediateTransaction(async () => {
      const parent = await this.readParent(request);
      const prior = await this.storage.sessionMutationAdmissions.findDurableChatRemediationResume({ ...parent.identity, ...request,
        reservationId: request.parentReservationId, expectedReservedRunVersion: request.expectedWaitingRunVersion + 1 });
      if (prior) return { observation: "resume_completed" as const, resumedRunVersion: prior.resultingRunVersion };
      // A queued/running projection without the exact immutable resolution never proves success.
      return { observation: "unknown" as const };
    });
  }

  private async readParent(request: GovernedRemediationParentReservationRequest | GovernedRemediationDurableResumeRequest) {
    const observed = await this.storage.durableRuns.getRun(request.durableRunId);
    const payload = readDurableChatTurnExecutionPayloadAuthority({ workflowKey: observed.workflowKey,
      durableRunId: observed.runId, payload: observed.payload });
    if (!payload || payload.requestActor.actorKind !== "operator" || payload.requestActor.actorId !== request.requesterActorId
      || payload.workspaceId !== request.workspaceId) throw new Error("Remediation parent has no exact operator Chat authority.");
    const identity = { admissionId: payload.admissionId, sessionIncarnationId: payload.sessionIncarnationId,
      workspaceId: payload.workspaceId, sessionId: payload.sessionId, turnId: payload.turnId };
    // Acquire session -> admission -> run locks in the repository's canonical order.
    // The outer transaction keeps them held through policy checks and mutation.
    await this.storage.sessionMutationAdmissions.requireExactDurableTurnPayloadIdentity({ ...identity, durableRunId: observed.runId });
    const run = await this.storage.durableRuns.getRun(request.durableRunId);
    const state = await this.storage.governedRemediations.getState(request.remediationId);
    const record = state.record;
    if (record.workspaceId !== identity.workspaceId || record.sessionId !== identity.sessionId || record.sourceTurnId !== identity.turnId
      || record.requesterActorId !== request.requesterActorId || record.durableRunId !== run.runId
      || record.blockedCheckpointId !== request.blockedCheckpointId || record.recipeSha256 !== request.recipeSha256
      || record.expectedWaitingRunVersion !== request.expectedWaitingRunVersion
      || (record.effectId !== null && record.effectId !== request.effectId)
      || ("parentReservationId" in request && record.parentReservationId !== request.parentReservationId)) {
      throw new Error("Remediation parent does not match its durable state bindings.");
    }
    return { identity, run, state };
  }

  private async requireWaiting(run: DurableRunRecord,
    request: GovernedRemediationParentReservationRequest | GovernedRemediationDurableResumeRequest, versions: number[]) {
    if (run.status !== "waiting" || run.leaseOwnerId || run.leaseExpiresAt || !versions.includes(run.version))
      throw new Error("Remediation parent is not parked at its expected waiting version.");
    const { authority, waitingCheckpoint } = await verifySettledChatWaitingAuthority(this.storage, run);
    const wait = authority.material.waitForEvent;
    if (waitingCheckpoint.checkpointId !== request.blockedCheckpointId || authority.material.traceStatus !== "waiting_for_user_input"
      || wait?.eventKey !== "chat.user_input.resolved" || !wait.correlationId)
      throw new Error("Remediation parent does not own this settled user-input wait.");
    return wait.correlationId;
  }
}
