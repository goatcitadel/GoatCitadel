import {
  REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS,
  REMOTE_WORKER_INFERENCE_MAX_REQUEST_CHARS,
  appendRemoteWorkerChatToolResults,
  appendRemoteWorkerNativeChatContext,
  canonicalJsonString,
  normalizeRemoteWorkerInferenceAuthorizedSubmission,
  normalizeRemoteWorkerInferenceMessages,
  normalizeRemoteWorkerNativeChatContext,
  normalizeRemoteWorkerNativeChatHistory,
  remoteWorkerChatInferenceIdentity,
  remoteWorkerInferenceCanonicalRequestBody,
  remoteWorkerInferenceCanonicalSha256 as digest,
  remoteWorkerInferenceRequestSha256,
  remoteWorkerNativeChatContextSha256,
  readRemoteWorkerNativeChatBoundary,
  type RemoteWorkerChatWorkflowScope,
  type RemoteWorkerInferenceMessage,
  type RemoteWorkerNativeChatContext,
} from "@goatcitadel/contracts";
import type { AsyncStorage, RemoteWorkerInferenceRequestRecord } from "@goatcitadel/storage";
import { readCanonicalWorkerInferenceOutput, type RemoteWorkerChatSequenceContext } from "./remote-worker-chat-output-service.js";
import { readCanonicalWorkerModelToolResult } from "./remote-worker-chat-tool-result.js";

/** Rehydrate prior messages only from immutable Gateway requests, frame chains
 * and settled tool owners. This read does not dispatch, renew, or authorize work.
 * baseMessages must be the original frozen context, before the current native facts. */
export async function readRemoteWorkerNativeChatHistory(
  inference: Pick<AsyncStorage["remoteWorkerInference"], "listAssignmentChatRequests" | "listFramesAfter">,
  scope: RemoteWorkerChatWorkflowScope,
  context: RemoteWorkerChatSequenceContext,
  nativeContext: RemoteWorkerNativeChatContext,
) {
  const native = normalizeRemoteWorkerNativeChatContext(nativeContext);
  if (native.continuation.assignmentGeneration !== scope.assignmentGeneration)
    throw new Error("Native Chat history belongs to another assignment generation.");
  const currentHash = remoteWorkerNativeChatContextSha256(native);
  const currentKeys = new Set<string>(Array.from({ length: REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS }, (_, step) =>
    remoteWorkerChatInferenceIdentity({ ...scope, continuationSha256: currentHash }, step).idempotencyKey));
  const inventory = await inference.listAssignmentChatRequests(scope);
  if (inventory.length > REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS)
    throw new Error("Worker Chat exceeded its assignment-wide model step limit.");
  const prior = inventory.filter(record => !currentKeys.has(record.idempotencyKey)).map(record => ({
    record, messages: readBoundRequest(record, scope, context),
  })).sort((a, b) => a.messages.length - b.messages.length);
  let messages = normalizeRemoteWorkerInferenceMessages(context.baseMessages);
  let continuationSha256: string | undefined;
  let stepIndex = 0;
  let previousWasFinal = false;
  const nativeHashes = new Set<string>();
  const requestHashes: string[] = [];
  const usageEventIds: string[] = [];
  const toolIntentIds: string[] = [];
  for (const entry of prior) {
    const boundary = readRemoteWorkerNativeChatBoundary(messages, entry.messages);
    if (boundary) {
      const hash = remoteWorkerNativeChatContextSha256(boundary);
      if (hash === currentHash || nativeHashes.has(hash) || boundary.continuation.assignmentGeneration !== scope.assignmentGeneration)
        throw new Error("Native Chat history repeats or substitutes a continuation.");
      nativeHashes.add(hash);
      continuationSha256 = hash;
      stepIndex = 0;
      messages = appendRemoteWorkerNativeChatContext(messages, boundary);
    } else if (previousWasFinal) {
      throw new Error("A final Chat answer cannot start another model step without a native continuation.");
    }
    const expected = remoteWorkerChatInferenceIdentity({ ...scope, continuationSha256 }, stepIndex);
    if (canonicalJsonString(messages) !== canonicalJsonString(entry.messages) ||
      entry.record.inferenceRequestId !== expected.inferenceRequestId || entry.record.idempotencyKey !== expected.idempotencyKey ||
      entry.record.attempt !== expected.attempt)
      throw new Error("Native Chat history is missing, reordered, branched or substituted.");
    const output = await readCanonicalWorkerInferenceOutput(inference, scope, entry.record);
    if (output.toolCalls) {
      const results = [];
      for (const call of output.toolCalls) {
        const result = await readCanonicalWorkerModelToolResult(context.toolStorage, entry.record, context.profile, call);
        if (result?.status !== "completed") throw new Error("Native Chat history has unresolved tools.");
        results.push({ ...result, callId: call.callId, modelToolName: call.modelToolName });
        toolIntentIds.push(result.intentId);
      }
      messages = appendRemoteWorkerChatToolResults(messages, { text: output.text, toolCalls: output.toolCalls }, results);
    } else {
      if (!output.text.trim()) throw new Error("Native Chat history has an empty final answer.");
      messages = normalizeRemoteWorkerInferenceMessages([...messages, { role: "assistant", text: output.text }]);
    }
    previousWasFinal = !output.toolCalls;
    requestHashes.push(entry.record.requestSha256);
    usageEventIds.push(...output.usageEventIds);
    stepIndex += 1;
  }
  if (new Set(requestHashes).size !== requestHashes.length || new Set(usageEventIds).size !== usageEventIds.length)
    throw new Error("Native Chat history repeats request or usage identities.");
  return Object.freeze({ history: normalizeRemoteWorkerNativeChatHistory({
    schemaVersion: "goatcitadel.remote-worker-native-chat-history.v1", nativeContextSha256: currentHash,
    contextSnapshotSha256: context.contextSha256, messages, priorModelSteps: prior.length,
    priorRequestSha256s: requestHashes, usageEventIds }), toolIntentIds: Object.freeze(toolIntentIds) });
}

function readBoundRequest(record: RemoteWorkerInferenceRequestRecord, scope: RemoteWorkerChatWorkflowScope,
  context: RemoteWorkerChatSequenceContext): readonly RemoteWorkerInferenceMessage[] {
  if (record.requestBodyJson.length > REMOTE_WORKER_INFERENCE_MAX_REQUEST_CHARS * 2)
    throw new Error("Native Chat history request exceeds its bound.");
  const body = JSON.parse(record.requestBodyJson);
  const submission = normalizeRemoteWorkerInferenceAuthorizedSubmission({
    registryWorkspaceId: record.registryWorkspaceId, assignmentId: record.assignmentId, assignmentGeneration: record.assignmentGeneration,
    inferenceRequestId: record.inferenceRequestId, attempt: record.attempt, idempotencyKey: record.idempotencyKey,
    messages: body.messages, inputSha256: record.inputSha256, contextSha256: record.contextSha256,
    modelIntentSha256: record.modelIntentSha256, outputTokenCeiling: record.outputTokenCeiling,
    reasoningTokenCeiling: record.reasoningTokenCeiling, temperatureMilli: record.temperatureMilli,
  });
  if (record.registryWorkspaceId !== scope.registryWorkspaceId || record.assignmentId !== scope.assignmentId ||
    record.assignmentGeneration !== scope.assignmentGeneration || record.workerId !== context.workerId ||
    record.workerGeneration !== context.workerGeneration || record.taskId !== context.taskId ||
    record.executionWorkspaceId !== context.profile.identity.workspaceId || record.sessionId !== context.profile.identity.sessionId ||
    record.turnId !== context.profile.identity.turnId || record.durableRunId !== context.profile.identity.durableRunId ||
    record.capabilityProfileSha256 !== context.profile.hashes.profileHash || record.contextSha256 !== context.contextSha256 ||
    record.routedContextSha256 !== context.contextSha256 || digest(submission.messages) !== record.inputSha256 ||
    canonicalJsonString(body) !== canonicalJsonString(remoteWorkerInferenceCanonicalRequestBody(submission)) ||
    remoteWorkerInferenceRequestSha256(submission) !== record.requestSha256)
    throw new Error("Native Chat history request differs from its canonical context or identity.");
  return submission.messages;
}
