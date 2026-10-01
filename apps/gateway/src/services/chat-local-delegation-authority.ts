import {
  canonicalJsonString,
  ConflictError,
  isDurableRunTerminal,
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatSendMessageRequest,
  type DurableChatTurnExecutionPayloadAuthority,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { buildStableDelegationTurnIdentity, type DelegationTurnIdentity } from "./chat-delegation-identity.js";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import { computeFrozenChatTurnAdmissionMaterialSha256 } from "./session-control-service.js";

export type LocalDelegationAuthorityStorage = Pick<
  AsyncStorage,
  | "chatDelegationRuns"
  | "chatDelegationSteps"
  | "chatSessionMeta"
  | "chatSessionLifecycles"
  | "chatTurnTraces"
  | "durableRuns"
  | "durableChildWatchers"
  | "sessionMutationAdmissions"
  | "tasks"
  | "runImmediateTransaction"
>;

export interface LocalDelegationTurnAuthorityInput extends DelegationTurnIdentity {
  sessionId: string;
  request: ChatSendMessageRequest;
  admission?: ActiveTurnAdmission;
}

/**
 * Live-capability delegation is deliberately limited to operator-reviewed,
 * ordinary local children of a real admitted Chat turn. These reads never
 * create a capability profile, requester credential, or remote-worker grant.
 * The caller must also fence the current request/durable claim through the
 * session-control owner. Nested calls join the durable admission transaction.
 */
export async function assertLocalDelegationTurnAuthority(
  storage: LocalDelegationAuthorityStorage,
  input: LocalDelegationTurnAuthorityInput,
): Promise<void> {
  const admission = input.admission;
  if (
    !admission ||
    admission.requestActor.actorKind !== "operator" ||
    Boolean(admission.requestClaim) === Boolean(admission.durableClaim) ||
    admission.identity.sessionId !== input.sessionId ||
    admission.identity.turnId !== input.turnId
  )
    reject();
  const admitted = admission.admittedRequest;
  if (
    computeFrozenChatTurnAdmissionMaterialSha256(admitted) !== admission.identity.materialSha256 ||
    !admitted.parentDelegationStepId ||
    !admitted.policyRunId ||
    !admitted.policyTaskId ||
    admitted.mode !== "chat" ||
    admitted.subagentPolicy !== "off" ||
    admitted.prefsOverride?.subagentPolicy !== "off" ||
    admitted.prefsOverride?.planningMode !== "off" ||
    admitted.prefsOverride?.orchestrationEnabled !== false ||
    admitted.prefsOverride?.proactiveMode !== "off" ||
    admitted.prefsOverride?.reflectionMode !== "off" ||
    admitted.workspaceSnapshot !== undefined ||
    admitted.modelCouncil?.enabled ||
    input.request.contextRefs?.length ||
    input.request.parentDelegationStepId !== admitted.parentDelegationStepId ||
    input.request.policyRunId !== admitted.policyRunId ||
    input.request.policyTaskId !== admitted.policyTaskId ||
    input.request.permissionProfileId !== admitted.permissionProfileId ||
    input.request.localOperatorOverrideId !== admitted.localOperatorOverrideId ||
    input.request.operatorId !== admission.requestActor.operatorId ||
    input.request.authActorId !== admission.requestActor.authActorId ||
    input.request.authActorSource !== admission.requestActor.authActorSource
  )
    reject();

  await storage.runImmediateTransaction(async () => {
    const delegation = await storage.chatDelegationRuns.getForUpdate(admitted.policyRunId!);
    const step = await storage.chatDelegationSteps.getForUpdate(admitted.parentDelegationStepId!);
    const expected = buildStableDelegationTurnIdentity(delegation.runId, step.stepId);
    if (
      delegation.workflowTemplate ||
      delegation.executionPlanId ||
      !delegation.parentRunId ||
      delegation.sessionId === input.sessionId ||
      delegation.taskId !== admitted.policyTaskId ||
      step.runId !== delegation.runId ||
      step.scopeControl ||
      !step.instructionSnapshot ||
      step.childSessionId !== input.sessionId ||
      (step.childTurnId !== undefined && step.childTurnId !== expected.turnId) ||
      input.turnId !== expected.turnId ||
      input.userMessageId !== expected.userMessageId ||
      input.assistantMessageId !== expected.assistantMessageId
    )
      reject();

    const parent = await storage.durableRuns.getRunForUpdate(delegation.parentRunId);
    const parentAuthority = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: parent.workflowKey,
      durableRunId: parent.runId,
      payload: parent.payload,
    });
    if (
      !parentAuthority ||
      parentAuthority.sessionId !== delegation.sessionId ||
      parentAuthority.workspaceId !== admission.identity.workspaceId ||
      parentAuthority.requestActor.actorKind !== "operator" ||
      canonicalJsonString(parentAuthority.requestActor) !== canonicalJsonString(admission.requestActor) ||
      parentAuthority.request.parentDelegationStepId ||
      (isDurableRunTerminal(parent.status) && parent.status !== "completed")
    )
      reject();
    await assertCanonicalParentAdmission(storage, parentAuthority, parent.runId);
    await assertCurrentIncarnation(
      storage,
      delegation.sessionId,
      parentAuthority.workspaceId,
      parentAuthority.sessionIncarnationId,
    );
    await assertCurrentIncarnation(
      storage,
      input.sessionId,
      admission.identity.workspaceId,
      admission.identity.sessionIncarnationId,
    );
    const task = await storage.tasks.getForUpdate(delegation.taskId);
    if (
      (task.workspaceId?.trim() || "default") !== admission.identity.workspaceId ||
      task.agenticContext?.runId !== delegation.runId ||
      task.agenticContext.parentRunId !== parent.runId ||
      task.agenticContext.parentSessionId !== delegation.sessionId
    )
      reject();

    if (admission.requestClaim) {
      const claim = await storage.chatDelegationSteps.getDispatchClaim(step.stepId);
      if (
        delegation.status !== "running" ||
        step.status !== "running" ||
        step.durableRunId ||
        !claim ||
        !claim.token.startsWith(`delegation-dispatch:v1:`) ||
        claim.token.split(":")[3] !== expected.turnId ||
        !(await storage.chatDelegationSteps.ownsLinkedDispatch(step.stepId, input.sessionId, claim.token))
      )
        reject();
      return;
    }

    const execution = admission.durableClaim!;
    if (step.durableRunId !== execution.durableRunId) reject();
    const child = await storage.durableRuns.getRunForUpdate(execution.durableRunId);
    const childAuthority = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: child.workflowKey,
      durableRunId: child.runId,
      payload: child.payload,
    });
    if (
      !childAuthority ||
      child.status !== "running" ||
      child.leaseOwnerId !== execution.leaseOwnerId ||
      child.attemptCount !== execution.attemptCount ||
      childAuthority.admissionId !== admission.identity.admissionId ||
      childAuthority.sessionIncarnationId !== admission.identity.sessionIncarnationId ||
      childAuthority.workspaceId !== admission.identity.workspaceId ||
      childAuthority.sessionId !== input.sessionId ||
      childAuthority.turnId !== input.turnId ||
      childAuthority.userMessageId !== input.userMessageId ||
      childAuthority.assistantMessageId !== input.assistantMessageId ||
      childAuthority.admissionMaterialSha256 !== admission.identity.materialSha256 ||
      canonicalJsonString(childAuthority.requestActor) !== canonicalJsonString(admission.requestActor) ||
      childAuthority.request.parentDelegationStepId !== step.stepId ||
      childAuthority.request.policyRunId !== delegation.runId ||
      childAuthority.request.policyTaskId !== task.taskId ||
      childAuthority.capabilityProfileId ||
      child.metadata?.remoteWorkerChatContextSha256
    )
      reject();
    const watcher = await storage.durableChildWatchers.get(`delegation-child:${step.stepId}`);
    if (
      watcher.parentRunId !== parent.runId ||
      watcher.childRunId !== child.runId ||
      watcher.source !== "chat_delegation" ||
      !watcher.metadata ||
      watcher.metadata.delegationRunId !== delegation.runId ||
      watcher.metadata.stepId !== step.stepId ||
      watcher.metadata.childSessionId !== input.sessionId ||
      watcher.metadata.childTurnId !== input.turnId
    )
      reject();
    if (step.status === "running" && delegation.status === "running") return;
    // A confirmed terminal child can still owe durable postcommit settlement.
    // It may not regain provider authority from a terminal delegation record.
    const trace = await storage.chatTurnTraces.get(input.turnId);
    if (
      step.status !== "completed" ||
      !["running", "completed"].includes(delegation.status) ||
      trace.status !== "completed" ||
      trace.sessionId !== input.sessionId ||
      trace.userMessageId !== input.userMessageId ||
      trace.assistantMessageId !== input.assistantMessageId ||
      trace.durable?.runId !== child.runId
    )
      reject();
  });
}

async function assertCurrentIncarnation(
  storage: LocalDelegationAuthorityStorage,
  sessionId: string,
  workspaceId: string,
  incarnationId: string,
): Promise<void> {
  const meta = await storage.chatSessionMeta.getForUpdate(sessionId);
  const intent = meta?.lifecycleIntentId
    ? await storage.chatSessionLifecycles.getIntent(meta.lifecycleIntentId)
    : undefined;
  if (
    !meta ||
    meta.lifecycleStatus !== "active" ||
    meta.workspaceId !== workspaceId ||
    !intent ||
    intent.sessionId !== sessionId ||
    intent.workspaceId !== workspaceId ||
    intent.intentKind === "delete" ||
    intent.sessionIncarnationId !== incarnationId
  )
    reject();
}

async function assertCanonicalParentAdmission(
  storage: LocalDelegationAuthorityStorage,
  authority: DurableChatTurnExecutionPayloadAuthority,
  runId: string,
): Promise<void> {
  const identity = {
    admissionId: authority.admissionId,
    sessionIncarnationId: authority.sessionIncarnationId,
    workspaceId: authority.workspaceId,
    sessionId: authority.sessionId,
    turnId: authority.turnId,
    aggregateRevision: authority.admissionAggregateRevision,
    controllerGeneration: authority.admissionControllerGeneration,
    materialSha256: authority.admissionMaterialSha256,
  };
  const binding = await storage.sessionMutationAdmissions.findDurableRunBinding(identity);
  const admission = await storage.sessionMutationAdmissions.get(authority.admissionId);
  if (
    binding?.durableRunId !== runId ||
    !admission ||
    admission.status === "cancelled" ||
    admission.operation !== "chat_turn" ||
    admission.sessionId !== authority.sessionId ||
    admission.turnId !== authority.turnId ||
    admission.workspaceId !== authority.workspaceId ||
    admission.sessionIncarnationId !== authority.sessionIncarnationId ||
    admission.aggregateRevision !== authority.admissionAggregateRevision ||
    admission.controllerGeneration !== authority.admissionControllerGeneration ||
    admission.actorKind !== authority.requestActor.actorKind ||
    admission.actorId !== authority.requestActor.actorId ||
    admission.materialSha256 !== authority.admissionMaterialSha256
  )
    reject();
}

function reject(): never {
  throw new ConflictError({
    message: "Local delegated Chat requires current supervised parent, child, and durable admission authority.",
  });
}
