import type { AsyncStorage } from "@goatcitadel/storage";
import type { ChatSendMessageRequest } from "@goatcitadel/contracts";
import {
  SessionControlService,
  computeEffectiveChatTurnRequestMaterialSha256,
} from "../../src/services/session-control-service.js";
import type { ActiveTurnAdmission } from "../../src/services/chat-turn-types.js";
import { buildDelegatedChatSendRequest } from "../../src/services/delegated-chat-request.js";
import { buildStableDelegationTurnIdentity } from "../../src/services/chat-delegation-identity.js";
import type { LocalDelegationTurnAuthorityInput } from "../../src/services/chat-local-delegation-authority.js";

/** Test-only canonical repository fixture; the public-route proof is separate. */
export async function seedLocalDelegationAuthority(storage: AsyncStorage): Promise<{
  input: LocalDelegationTurnAuthorityInput;
  parentAdmission: ActiveTurnAdmission;
  dispatchToken: string;
  admitChild: () => Promise<ActiveTurnAdmission>;
}> {
  const service = new SessionControlService(storage);
  const now = new Date().toISOString();
  for (const sessionId of ["local-parent-session", "local-child-session"]) {
    await storage.sessions.upsert({
      sessionId,
      sessionKey: sessionId,
      kind: "dm",
      channel: "chat",
      account: "operator",
      timestamp: now,
    });
    await storage.chatSessionMeta.ensure(sessionId, now, "default");
  }
  const actor = { operatorId: "operator", authActorId: "operator", authActorSource: "token" as const };
  const parentRequest: ChatSendMessageRequest = { content: "Parent", mode: "chat", subagentPolicy: "off", ...actor };
  const parentAdmission = await service.admitOperatorChatTurn({
    sessionId: "local-parent-session",
    turnId: "local-parent-turn",
    request: parentRequest,
    runtimeOwnerId: "local-parent-owner",
    actorId: "operator",
    idempotencyKey: "parent-admit",
    correlationId: "parent-admit",
  });
  await storage.durableRuns.createRun({
    runId: "local-parent-run",
    workflowKey: "chat.turn.execute",
    payload: localDelegationPayload(parentAdmission, "local-parent-user", "local-parent-assistant", "local-parent-run"),
  });
  await service.bindDurableRun(parentAdmission, "local-parent-run");
  await storage.tasks.create(
    {
      title: "Local delegation",
      workspaceId: "default",
      createdBy: "chat",
      status: "in_progress",
      priority: "normal",
      agenticContext: {
        runId: "local-delegation",
        parentRunId: "local-parent-run",
        parentSessionId: "local-parent-session",
      },
    },
    now,
    { taskId: "local-task" },
  );
  await storage.chatDelegationRuns.create({
    runId: "local-delegation",
    parentRunId: "local-parent-run",
    sessionId: "local-parent-session",
    taskId: "local-task",
    objective: "One reviewed child",
    roles: ["researcher"],
    mode: "sequential",
    status: "running",
    citations: [],
  });
  const stepId = "local-step";
  const identity = buildStableDelegationTurnIdentity("local-delegation", stepId);
  const expiresMs = Date.parse(await storage.chatDelegationSteps.readDatabaseNow()) + 300_000;
  const expiresAt = new Date(expiresMs).toISOString();
  const dispatchToken = "delegation-dispatch:v1:" + expiresMs + ":" + identity.turnId + ":fixture";
  await storage.chatDelegationSteps.create({
    stepId,
    runId: "local-delegation",
    role: "researcher",
    index: 0,
    status: "pending",
    instructionSnapshot: { objective: "One reviewed child" },
  });
  await storage.chatDelegationSteps.claimPendingForDispatch(stepId, "claim-fixture", expiresAt, now);
  await storage.chatDelegationSteps.linkClaimedDispatch(
    stepId,
    "claim-fixture",
    "local-child-session",
    dispatchToken,
    expiresAt,
  );
  const request = buildDelegatedChatSendRequest({
    content: "One reviewed child",
    parentDelegationStepId: stepId,
    policyRunId: "local-delegation",
    policyTaskId: "local-task",
    mode: "chat",
    memoryMode: "off",
    webMode: "off",
    thinkingLevel: "standard",
    retrievalMode: "standard",
    ...actor,
  });
  const admission = await service.admitOperatorChatTurn({
    sessionId: "local-child-session",
    turnId: identity.turnId,
    request,
    runtimeOwnerId: "local-child-owner",
    actorId: "operator",
    idempotencyKey: "child-admit",
    correlationId: "child-admit",
  });
  return {
    input: { ...identity, sessionId: "local-child-session", request, admission },
    parentAdmission,
    dispatchToken,
    admitChild: async () => {
      await storage.runImmediateTransaction(async () => {
        await storage.durableRuns.createRun({
          runId: "local-child-run",
          workflowKey: "chat.turn.execute",
          payload: localDelegationPayload(admission, identity.userMessageId, identity.assistantMessageId),
        });
        const bound = await storage.chatDelegationSteps.bindOwnedDurableRun({
          stepId,
          childSessionId: "local-child-session",
          expectedDispatchToken: dispatchToken,
          durableRunId: "local-child-run",
        });
        if (!bound) throw new Error("Fixture lost its dispatch owner");
        await storage.chatDelegationSteps.patch(stepId, { childTurnId: identity.turnId });
        await storage.durableChildWatchers.create({
          watcherId: "delegation-child:" + stepId,
          parentRunId: "local-parent-run",
          childRunId: "local-child-run",
          source: "chat_delegation",
          metadata: {
            delegationRunId: "local-delegation",
            stepId,
            childSessionId: "local-child-session",
            childTurnId: identity.turnId,
          },
        });
        await service.bindDurableRun(admission, "local-child-run");
      });
      const run = await storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({
        runId: "local-child-run",
        workerId: "local-executor",
        leaseDurationMs: 300_000,
      });
      if (!run?.leaseOwnerId) throw new Error("Fixture has no durable claim");
      return {
        ...admission,
        durableClaim: { durableRunId: run.runId, leaseOwnerId: run.leaseOwnerId, attemptCount: run.attemptCount },
      };
    },
  };
}

export function localDelegationPayload(
  admission: ActiveTurnAdmission,
  userMessageId: string,
  assistantMessageId: string,
  runId?: string,
): Record<string, unknown> {
  const identity = admission.identity;
  return {
    version: "chat.turn.execute.v2",
    admissionId: identity.admissionId,
    sessionIncarnationId: identity.sessionIncarnationId,
    admissionMaterialSha256: identity.materialSha256,
    workspaceId: identity.workspaceId,
    admissionAggregateRevision: identity.aggregateRevision,
    admissionControllerGeneration: identity.controllerGeneration,
    effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(
      identity.materialSha256,
      admission.admittedRequest,
    ),
    ...(!admission.admittedRequest.policyRunId
      ? { policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId } }
      : {}),
    requestActor: admission.requestActor,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    userMessageId,
    assistantMessageId,
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request: admission.admittedRequest,
  };
}
