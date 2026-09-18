import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import {
  normalizeRemoteWorkerInferenceMessages,
  type RemoteWorkerInferenceMessage,
} from "./remote-worker-inference.js";
import {
  REMOTE_WORKER_CHAT_MAX_TOOL_CALL_BYTES,
  normalizeRemoteWorkerInferenceToolCalls,
  type RemoteWorkerChatToolResult,
  type RemoteWorkerInferenceToolCall,
} from "./remote-worker-chat-tool-calls.js";

/** Sixteen model steps still fit the 32 canonical root-attempt settlement IDs
 * when every step uses its primary plus one bounded recovery attempt. */
export const REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS = 16;

export interface RemoteWorkerChatWorkflowScope {
  readonly registryWorkspaceId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: number;
  readonly continuationSha256?: string;
}

export function remoteWorkerChatInferenceIdentity(scope: RemoteWorkerChatWorkflowScope, stepIndex: number) {
  if (!Number.isSafeInteger(stepIndex) || stepIndex < 0 || stepIndex >= REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS)
    throw new TypeError("Worker Chat model step exceeds its bound.");
  const suffix = stepIndex === 0 ? "" : `:step:${stepIndex}`;
  if (scope.continuationSha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/u.test(scope.continuationSha256) || /^0+$/u.test(scope.continuationSha256))
      throw new TypeError("Worker Chat continuation identity is invalid.");
    const key = sha256Hex(canonicalJsonString({ registryWorkspaceId: scope.registryWorkspaceId, assignmentId: scope.assignmentId,
      assignmentGeneration: scope.assignmentGeneration, continuationSha256: scope.continuationSha256 }));
    return { inferenceRequestId: `worker-native-${key}${suffix}`, attempt: 1, idempotencyKey: `inference-native:${key}${suffix}` } as const;
  }
  return {
    inferenceRequestId: `worker-${scope.assignmentId}${suffix}`,
    attempt: 1,
    idempotencyKey: `inference:${scope.assignmentId}:${scope.assignmentGeneration}${suffix}`,
  } as const;
}

/** Keys select one canonical linear step. Arbitrary aliases cannot start a
 * second model request for the same continuation. Step zero remains compatible. */
export function remoteWorkerChatInferenceStepIndex(
  input: RemoteWorkerChatWorkflowScope & {
    inferenceRequestId: string;
    attempt: number;
    idempotencyKey: string;
  },
): number {
  for (let step = 0; step < REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS; step++) {
    const identity = remoteWorkerChatInferenceIdentity(input, step);
    if (
      identity.inferenceRequestId === input.inferenceRequestId &&
      identity.attempt === input.attempt &&
      identity.idempotencyKey === input.idempotencyKey
    )
      return step;
  }
  throw new TypeError("Worker inference does not select a canonical Chat step.");
}

export function appendRemoteWorkerChatToolResults(
  messages: readonly RemoteWorkerInferenceMessage[],
  response: { text: string; toolCalls: readonly RemoteWorkerInferenceToolCall[] },
  results: readonly Pick<
    RemoteWorkerChatToolResult,
    "status" | "callId" | "modelToolName" | "resultJson" | "resultSha256"
  >[],
): readonly RemoteWorkerInferenceMessage[] {
  const calls = normalizeRemoteWorkerInferenceToolCalls(response.toolCalls);
  if (results.length !== calls.length) throw new TypeError("Worker Chat tool result inventory is incomplete.");
  const previousIds = new Set(messages.flatMap((message) => message.toolCalls?.map((call) => call.callId) ?? []));
  const toolMessages = calls.map((call, index): RemoteWorkerInferenceMessage => {
    const result = results[index]!;
    if (previousIds.has(call.callId)) throw new TypeError("Worker Chat model call identity repeats an earlier step.");
    if (
      result.status !== "completed" ||
      result.callId !== call.callId ||
      result.modelToolName !== call.modelToolName ||
      typeof result.resultJson !== "string" ||
      new TextEncoder().encode(result.resultJson).byteLength > REMOTE_WORKER_CHAT_MAX_TOOL_CALL_BYTES
    )
      throw new TypeError("Worker Chat continuation requires an exact completed tool result.");
    const value: unknown = JSON.parse(result.resultJson);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      sha256Hex(canonicalJsonString(value)) !== result.resultSha256
    )
      throw new TypeError("Worker Chat continuation tool result hash changed.");
    return { role: "tool", text: result.resultJson, tool_call_id: call.callId };
  });
  return normalizeRemoteWorkerInferenceMessages([
    ...messages,
    { role: "assistant", text: response.text, toolCalls: calls },
    ...toolMessages,
  ]);
}
