import { ConflictError, type ChatUserInputPromptRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { parseDurableChatTurnPayload } from "./durable-execution-service.js";

/** Uses the same admitted run and repository as blocking input; this adds no steer queue. */
async function readBoundRun(storage: AsyncStorage, input: ChatTurnAgentRunnerInput) {
  if (!input.policyRunId || !input.canonicalWriteFence || input.parentDelegationStepId || input.mode !== "chat") {
    throw new ConflictError({ message: "Optional input requires an interactive durable Chat turn." });
  }
  const run = await storage.durableRuns.getRun(input.policyRunId);
  const payload = run && parseDurableChatTurnPayload(run);
  if (
    !run ||
    !payload ||
    payload.sessionId !== input.sessionId ||
    payload.turnId !== input.turnId ||
    payload.requestActor.actorKind !== "operator"
  ) {
    throw new ConflictError({ message: "Optional input has no exact operator turn binding." });
  }
  const admissionIdentity = {
    admissionId: payload.admissionId,
    sessionIncarnationId: payload.sessionIncarnationId,
    workspaceId: payload.workspaceId,
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    aggregateRevision: payload.admissionAggregateRevision,
    controllerGeneration: payload.admissionControllerGeneration,
    materialSha256: payload.admissionMaterialSha256,
  };
  await storage.sessionMutationAdmissions.requireExactDurableTurnPayloadIdentity({
    ...admissionIdentity,
    durableRunId: run.runId,
  });
  return { run, admissionIdentity };
}

export async function registerChatOptionalInput(
  storage: AsyncStorage,
  input: ChatTurnAgentRunnerInput,
  prompt: ChatUserInputPromptRecord,
) {
  const { run, admissionIdentity } = await readBoundRun(storage, input);
  return await storage.sessionMutationAdmissions.registerDurableChatOptionalInput({
    admissionIdentity,
    durableRunId: run.runId,
    expectedRunVersion: run.version,
    prompt,
  });
}

export async function readChatOptionalInput(storage: AsyncStorage, input: ChatTurnAgentRunnerInput) {
  const { run, admissionIdentity } = await readBoundRun(storage, input);
  return await storage.sessionMutationAdmissions.projectDurableChatOptionalInput({
    admissionIdentity,
    durableRunId: run.runId,
  });
}
