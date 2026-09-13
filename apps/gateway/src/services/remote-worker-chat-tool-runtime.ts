import {
  normalizeRemoteWorkerChatToolSubmission,
  remoteWorkerChatInferenceStepIndex,
  remoteWorkerInferenceCanonicalSha256,
  type RemoteWorkerChatToolResult,
  type RemoteWorkerChatToolSubmission,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  buildRemoteWorkerChatSequenceContext,
  readCanonicalWorkerChatInput,
  readCanonicalWorkerInferenceOutput,
} from "./remote-worker-chat-output-service.js";
import {
  resolveRemoteWorkerChatProfile,
  type RemoteWorkerChatAuthorityDependencies,
} from "./remote-worker-chat-authority.js";
import { modelToolIntentKey, readCanonicalWorkerModelToolResult } from "./remote-worker-chat-tool-result.js";
import type {
  DispatchRemoteWorkerEffectInput,
  DispatchRemoteWorkerEffectResult,
  RemoteWorkerEffectExecutionFence,
} from "./remote-worker-effect-settlement-service.js";

export interface DispatchRemoteWorkerChatToolInput {
  readonly fence: RemoteWorkerEffectExecutionFence;
  readonly submission: RemoteWorkerChatToolSubmission;
  readonly signal?: AbortSignal;
}

export interface RemoteWorkerChatToolRuntimeDependencies extends RemoteWorkerChatAuthorityDependencies {
  storage: AsyncStorage;
  effects: { dispatchEffect(input: DispatchRemoteWorkerEffectInput): Promise<DispatchRemoteWorkerEffectResult> };
}

/** The worker cannot manufacture a tool selector, arguments, or a completed tool
 * result. The retained provider call and canonical effect owners supply them. */
export class RemoteWorkerChatToolRuntime {
  public constructor(private readonly dependencies: RemoteWorkerChatToolRuntimeDependencies) {}

  public async dispatchTool(input: DispatchRemoteWorkerChatToolInput): Promise<RemoteWorkerChatToolResult> {
    const submission = normalizeRemoteWorkerChatToolSubmission(input.submission);
    const { storage } = this.dependencies;
    const { fence } = input;
    const key = {
      registryWorkspaceId: fence.registryWorkspaceId,
      assignmentId: fence.assignmentId,
      assignmentGeneration: fence.assignmentGeneration,
      inferenceRequestId: submission.inferenceRequestId,
      attempt: submission.attempt,
    };
    const check = async () => {
      input.signal?.throwIfAborted();
      if (!fence.protectedAuthority) throw new Error("Worker model tools require protected native authority.");
      const execution = await storage.remoteWorkerAssignments.resolveActiveChatExecution(
        fence,
        fence.protectedAuthority,
      );
      if (!execution.authority.assignment.manifest.requiredCapabilityClasses.includes("governed_tool"))
        throw new Error("Worker assignment does not admit governed tools.");
      const { profile } = await resolveRemoteWorkerChatProfile(this.dependencies, execution);
      const output = await readCanonicalWorkerInferenceOutput(
        storage.remoteWorkerInference,
        key,
        await storage.remoteWorkerInference.getRequest(key),
      );
      const { record } = output;
      const messages = await readCanonicalWorkerChatInput(storage.remoteWorkerInference, record,
        remoteWorkerChatInferenceStepIndex(record), buildRemoteWorkerChatSequenceContext(storage, profile, execution));
      if (
        record.executionWorkspaceId !== profile.identity.workspaceId ||
        record.sessionId !== profile.identity.sessionId ||
        record.turnId !== profile.identity.turnId ||
        record.durableRunId !== profile.identity.durableRunId ||
        record.capabilityProfileSha256 !== profile.hashes.profileHash ||
        record.inputSha256 !== remoteWorkerInferenceCanonicalSha256(messages) ||
        record.contextSha256 !== execution.workload.contextSnapshotSha256 ||
        record.taskId !== execution.authority.assignment.manifest.taskId ||
        record.routedContextSha256 !== execution.workload.contextSnapshotSha256 ||
        record.workerId !== execution.authority.generation.workerId ||
        record.workerGeneration !== execution.authority.generation.workerGeneration
      )
        throw new Error("Worker model tool request belongs to another execution.");
      const previousCallIds = new Set(messages.flatMap((message) => message.toolCalls?.map((call) => call.callId) ?? []));
      if (output.toolCalls?.some((call) => previousCallIds.has(call.callId)))
        throw new Error("Worker model tool call identity repeats an earlier step.");
      const call = output.toolCalls?.[submission.callIndex];
      if (!call) throw new Error("Worker model tool selection is not a retained provider request.");
      const selected = profile.selection.tools.find((tool) => tool.modelName === call.modelToolName);
      if (
        !selected ||
        !profile.selection.modelNameAllowMap.some(
          (binding) => binding.modelName === call.modelToolName && binding.canonicalName === selected.canonicalName,
        )
      )
        throw new Error("Worker model tool selection is outside its frozen allow map.");
      return { profile, record, call, selected, calls: output.toolCalls! };
    };
    const admitted = await check();
    // Ordering is canonical: a later call cannot skip an unresolved earlier one.
    for (const call of admitted.calls.slice(0, submission.callIndex)) {
      const previous = await readCanonicalWorkerModelToolResult(storage, admitted.record, admitted.profile, call);
      if (previous?.status !== "completed") throw new Error("An earlier worker model tool call is unresolved.");
    }
    const intentKey = modelToolIntentKey(admitted.record, admitted.call);
    const intent = await storage.runImmediateTransaction(async () => {
      const current = await check();
      return await storage.remoteWorkerEffects.recordNextIntent({
        registryWorkspaceId: key.registryWorkspaceId,
        assignmentId: key.assignmentId,
        assignmentGeneration: key.assignmentGeneration,
        effectSelector: current.selected.canonicalName,
        canonicalArgs: JSON.parse(current.call.argumentsJson),
        workerIdempotencyKey: intentKey,
        idempotencyKey: intentKey,
      });
    });
    await this.dependencies.effects.dispatchEffect({
      fence,
      intentIndex: intent.intentIndex,
      effectSelector: admitted.selected.canonicalName,
      canonicalArgs: JSON.parse(admitted.call.argumentsJson),
      workerIdempotencyKey: intentKey,
      intentIdempotencyKey: intentKey,
      signal: input.signal,
    });
    // Replaying an immutable effect receipt does not bypass current authority.
    await check();
    const result = await readCanonicalWorkerModelToolResult(storage, admitted.record, admitted.profile, admitted.call);
    if (!result) throw new Error("Worker tool result is unavailable for continuation.");
    return {
      ...result,
      inferenceRequestId: submission.inferenceRequestId,
      attempt: submission.attempt,
      callIndex: submission.callIndex,
      requestSha256: admitted.record.requestSha256,
      callId: admitted.call.callId,
      modelToolName: admitted.call.modelToolName,
    };
  }

}
