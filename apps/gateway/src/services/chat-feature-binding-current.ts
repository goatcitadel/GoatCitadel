import { canonicalJsonString, readDurableChatTurnExecutionPayloadAuthority } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { LlmDispatchGuardRejectedError } from "./llm-dispatch-guard.js";

/** Immutable references are evidence, never an alternative to the live durable owner. */
export async function assertChatFeatureBindingCurrent(
  storage: Pick<AsyncStorage, "durableRuns" | "sessionMutationAdmissions">,
  input: Pick<
    ChatTurnAgentRunnerInput,
    | "featureAdmission"
    | "canonicalWriteFence"
    | "policyRunId"
    | "canonicalDurableRunId"
    | "workspaceId"
    | "sessionId"
    | "turnId"
  >,
): Promise<void> {
  const expected = input.featureAdmission;
  if (!expected) return;
  const runId = input.canonicalDurableRunId ?? input.policyRunId;
  if (!input.canonicalWriteFence || !runId) reject("Feature dispatch requires current durable Chat authority.");
  await input.canonicalWriteFence(async () => {
    const run = await storage.durableRuns.getRun(runId);
    const authority = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflowKey,
      durableRunId: runId,
      payload: run.payload,
    });
    if (
      !authority ||
      run.status !== "running" ||
      authority.capabilityProfileId ||
      authority.featureReferenceSha256 !== expected.referenceSha256 ||
      authority.sessionId !== input.sessionId ||
      authority.turnId !== input.turnId ||
      authority.workspaceId !== input.workspaceId
    ) {
      reject("Feature dispatch no longer matches the canonical durable turn.");
    }
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
    const [actual, binding] = await Promise.all([
      storage.sessionMutationAdmissions.findFeatureReferences(identity),
      storage.sessionMutationAdmissions.findDurableRunBinding(identity),
    ]);
    if (
      !actual ||
      binding?.durableRunId !== runId ||
      actual.referenceSha256 !== expected.referenceSha256 ||
      canonicalJsonString(actual.references) !== canonicalJsonString(expected.references)
    ) {
      reject("Feature dispatch references differ from the immutable admission binding.");
    }
  });
}

function reject(message: string): never {
  throw new LlmDispatchGuardRejectedError(new Error(message));
}
