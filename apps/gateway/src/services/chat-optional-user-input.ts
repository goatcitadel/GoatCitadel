import { ConflictError, NotFoundError, type ChatUserInputPromptRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { parseDurableChatTurnPayload } from "./durable-execution-service.js";

/**
 * Uses the same admitted run and repository as blocking input; this adds no steer queue.
 * With `allowNonOperator` (mailbox reads), a system or channel turn bound to this run, or a turn whose
 * policy run is not a durable Chat run, resolves to `null`: those turns never expose
 * `user_input.request`, so their mailbox is empty, not an error.
 */
async function readBoundRun(storage: AsyncStorage, input: ChatTurnAgentRunnerInput, allowNonOperator = false) {
  if (!input.policyRunId || !input.canonicalWriteFence || input.parentDelegationStepId || input.mode !== "chat") {
    throw new ConflictError({ message: "Optional input requires an interactive durable Chat turn." });
  }
  let run: Awaited<ReturnType<AsyncStorage["durableRuns"]["getRun"]>> | undefined;
  try {
    run = await storage.durableRuns.getRun(input.policyRunId);
  } catch (error) {
    // Orchestration phase turns carry a policy run id that is not a durable Chat run.
    if (allowNonOperator && error instanceof NotFoundError) return null;
    throw error;
  }
  const payload = run && parseDurableChatTurnPayload(run);
  if (
    !run ||
    !payload ||
    payload.sessionId !== input.sessionId ||
    payload.turnId !== input.turnId ||
    (payload.requestActor.actorKind !== "operator" && !allowNonOperator)
  ) {
    throw new ConflictError({ message: "Optional input has no exact operator turn binding." });
  }
  if (payload.requestActor.actorKind !== "operator") {
    return null;
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
  const bound = await readBoundRun(storage, input);
  if (!bound) {
    throw new ConflictError({ message: "Optional input has no exact operator turn binding." });
  }
  const { run, admissionIdentity } = bound;
  return await storage.sessionMutationAdmissions.registerDurableChatOptionalInput({
    admissionIdentity,
    durableRunId: run.runId,
    expectedRunVersion: run.version,
    prompt,
  });
}

export async function readChatOptionalInput(storage: AsyncStorage, input: ChatTurnAgentRunnerInput) {
  const bound = await readBoundRun(storage, input, true);
  if (!bound) {
    return { prompts: [], replies: [] };
  }
  const { run, admissionIdentity } = bound;
  return await storage.sessionMutationAdmissions.projectDurableChatOptionalInput({
    admissionIdentity,
    durableRunId: run.runId,
  });
}
