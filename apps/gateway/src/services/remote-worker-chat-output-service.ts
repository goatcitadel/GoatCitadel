import {
  REMOTE_WORKER_CHAT_OUTPUT_PROFILE,
  REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS,
  REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256,
  normalizeRemoteWorkerInferenceFramePayload,
  normalizeRemoteWorkerInferenceUsageEventIds,
  remoteWorkerInferenceFramePayloadSha256,
  remoteWorkerInferenceFrameSha256,
  remoteWorkerInferenceUsageEventIdsSha256,
  remoteWorkerInferenceCanonicalSha256 as digest,
  remoteWorkerChatInferenceIdentity,
  remoteWorkerChatInferenceMessages,
  appendRemoteWorkerChatToolResults,
  type ChatTurnCapabilityProfileRecord,
  type RemoteWorkerChatWorkflowScope,
  type RemoteWorkerInferenceMessage,
  type RemoteWorkerInferenceToolCall,
} from "@goatcitadel/contracts";
import type { AsyncStorage, RemoteWorkerInferenceRequestRecord } from "@goatcitadel/storage";
import {
  readCanonicalWorkerModelToolResult,
  type RemoteWorkerChatToolResultStorage,
} from "./remote-worker-chat-tool-result.js";

export interface RemoteWorkerChatSequenceContext {
  readonly profile: ChatTurnCapabilityProfileRecord;
  readonly baseMessages: readonly RemoteWorkerInferenceMessage[];
  readonly contextSha256: string;
  readonly taskId: string;
  readonly workerId: string;
  readonly workerGeneration: number;
  readonly toolStorage: RemoteWorkerChatToolResultStorage;
}

type InferenceReader = Pick<AsyncStorage["remoteWorkerInference"], "getRequestByIdempotency" | "listFramesAfter">;

export function buildRemoteWorkerChatSequenceContext(
  toolStorage: RemoteWorkerChatToolResultStorage,
  profile: ChatTurnCapabilityProfileRecord,
  execution: Awaited<ReturnType<AsyncStorage["remoteWorkerAssignments"]["resolveActiveChatExecution"]>>,
): RemoteWorkerChatSequenceContext {
  const content = (execution.workload.payload.request as Record<string, unknown> | undefined)?.content;
  if (typeof content !== "string") throw new Error("Worker Chat workload has no admitted request.");
  return {
    profile,
    toolStorage,
    baseMessages: execution.workload.chatContext
      ? remoteWorkerChatInferenceMessages(execution.workload.chatContext)
      : [{ role: "user", text: content }],
    contextSha256: execution.workload.contextSnapshotSha256,
    taskId: execution.authority.assignment.manifest.taskId,
    workerId: execution.authority.generation.workerId,
    workerGeneration: execution.authority.generation.workerGeneration,
  };
}

/** Shared by artifact verification and Chat materialization. Worker transcript
 * text is not an authority for the assistant answer. */
export async function readCanonicalWorkerChatOutput(
  inference: InferenceReader,
  input: RemoteWorkerChatWorkflowScope,
  context?: RemoteWorkerChatSequenceContext,
) {
  let messages = context?.baseMessages ?? [];
  const steps: Array<{ record: RemoteWorkerInferenceRequestRecord; usageEventIds: readonly string[] }> = [];
  const toolIntentIds: string[] = [];
  for (let stepIndex = 0; stepIndex < REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS; stepIndex++) {
    const result = await readSequenceStep(inference, input, stepIndex, messages, context);
    steps.push({ record: result.record, usageEventIds: result.usageEventIds });
    if (!result.toolCalls) {
      if (!result.text.trim()) throw new Error("Worker output has no completed canonical response.");
      const usageEventIds = normalizeRemoteWorkerInferenceUsageEventIds(
        steps.flatMap((step) => [...step.usageEventIds]),
      );
      return { ...result, usageEventIds, steps, toolIntentIds };
    }
    if (!context) throw new Error("Worker output still requires governed tool completion.");
    const continuation = await continueSequence(context, messages, result);
    messages = continuation.messages;
    toolIntentIds.push(...continuation.toolIntentIds);
  }
  throw new Error("Worker Chat exceeded its model step limit.");
}

/** Reconstruct the exact next input from immutable model requests and settled
 * canonical tool results. A worker cannot invent, skip or reorder a step. */
export async function readCanonicalWorkerChatInput(
  inference: InferenceReader,
  scope: RemoteWorkerChatWorkflowScope,
  stepIndex: number,
  context: RemoteWorkerChatSequenceContext,
): Promise<readonly RemoteWorkerInferenceMessage[]> {
  remoteWorkerChatInferenceIdentity(scope, stepIndex);
  let messages = context.baseMessages;
  for (let step = 0; step < stepIndex; step++) {
    const result = await readSequenceStep(inference, scope, step, messages, context);
    messages = (await continueSequence(context, messages, result)).messages;
  }
  return messages;
}

async function readSequenceStep(
  inference: InferenceReader,
  scope: RemoteWorkerChatWorkflowScope,
  stepIndex: number,
  messages: readonly RemoteWorkerInferenceMessage[],
  context?: RemoteWorkerChatSequenceContext,
) {
  const identity = remoteWorkerChatInferenceIdentity(scope, stepIndex);
  const result = await readCanonicalWorkerInferenceOutput(
    inference,
    scope,
    await inference.getRequestByIdempotency(scope.registryWorkspaceId, identity.idempotencyKey),
  );
  const { record } = result;
  if (
    context &&
    (record.inferenceRequestId !== identity.inferenceRequestId ||
      record.attempt !== identity.attempt ||
      record.idempotencyKey !== identity.idempotencyKey ||
      record.inputSha256 !== digest(messages) ||
      record.contextSha256 !== context.contextSha256 ||
      record.routedContextSha256 !== context.contextSha256 ||
      record.capabilityProfileSha256 !== context.profile.hashes.profileHash ||
      record.executionWorkspaceId !== context.profile.identity.workspaceId ||
      record.sessionId !== context.profile.identity.sessionId ||
      record.turnId !== context.profile.identity.turnId ||
      record.durableRunId !== context.profile.identity.durableRunId ||
      record.taskId !== context.taskId ||
      record.workerId !== context.workerId ||
      record.workerGeneration !== context.workerGeneration)
  )
    throw new Error("Worker Chat sequence differs from its canonical execution or input.");
  return result;
}

async function continueSequence(
  context: RemoteWorkerChatSequenceContext,
  messages: readonly RemoteWorkerInferenceMessage[],
  output: Awaited<ReturnType<typeof readCanonicalWorkerInferenceOutput>>,
): Promise<{ messages: readonly RemoteWorkerInferenceMessage[]; toolIntentIds: string[] }> {
  if (!output.toolCalls) throw new Error("A completed worker answer cannot authorize another model step.");
  const results = [];
  for (const call of output.toolCalls) {
    const result = await readCanonicalWorkerModelToolResult(context.toolStorage, output.record, context.profile, call);
    if (result?.status !== "completed") throw new Error("Worker Chat continuation has unresolved tools.");
    results.push({ ...result, callId: call.callId, modelToolName: call.modelToolName });
  }
  return { messages: appendRemoteWorkerChatToolResults(messages, { text: output.text, toolCalls: output.toolCalls }, results),
    toolIntentIds: results.map((result) => result.intentId) };
}

/** Retained provider output is a request to the tool owner, never execution evidence. */
export async function readCanonicalWorkerInferenceOutput(
  inference: Pick<AsyncStorage["remoteWorkerInference"], "listFramesAfter">,
  input: { registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number },
  record: RemoteWorkerInferenceRequestRecord | undefined,
) {
  if (
    !record ||
    record.registryWorkspaceId !== input.registryWorkspaceId ||
    record.assignmentId !== input.assignmentId ||
    record.assignmentGeneration !== input.assignmentGeneration ||
    record.state !== "completed" ||
    record.budgetAuthorityState !== "settled"
  )
    throw new Error("Worker output lacks settled canonical inference.");
  const usageEventIds = normalizeRemoteWorkerInferenceUsageEventIds(JSON.parse(record.usageEventIdsJson ?? "[]"));
  if (!usageEventIds.length || remoteWorkerInferenceUsageEventIdsSha256(usageEventIds) !== record.usageEventIdsSha256)
    throw new Error("Worker output usage identity changed.");
  const key = {
    registryWorkspaceId: input.registryWorkspaceId,
    assignmentId: input.assignmentId,
    assignmentGeneration: input.assignmentGeneration,
    inferenceRequestId: record.inferenceRequestId,
    attempt: record.attempt,
  };
  const frames = await inference.listFramesAfter(key, 0);
  if (frames.length !== record.outputFrameCount || frames.length > 256)
    throw new Error("Worker output frame inventory is incomplete.");
  let previous = REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256;
  let text = "";
  let terminal = false;
  let toolCalls: readonly RemoteWorkerInferenceToolCall[] | undefined;
  for (const [index, frame] of frames.entries()) {
    const payload = normalizeRemoteWorkerInferenceFramePayload(JSON.parse(frame.payloadJson));
    const payloadSha256 = remoteWorkerInferenceFramePayloadSha256(payload);
    const hash = remoteWorkerInferenceFrameSha256({
      ...key,
      frameSequence: index + 1,
      frameKind: payload.kind,
      payloadSha256,
      previousFrameSha256: previous,
      effectiveRouteSha256: record.effectiveRouteSha256,
    });
    if (
      terminal ||
      frame.frameSequence !== index + 1 ||
      frame.frameKind !== payload.kind ||
      frame.payloadSha256 !== payloadSha256 ||
      frame.previousFrameSha256 !== previous ||
      frame.frameSha256 !== hash
    )
      throw new Error("Worker output frame chain changed.");
    previous = hash;
    if (payload.kind === "output_text") {
      text += payload.text;
      if (Buffer.byteLength(text, "utf8") > REMOTE_WORKER_CHAT_OUTPUT_PROFILE.maxBytes)
        throw new Error("Worker output exceeds the Chat artifact bound.");
    } else {
      toolCalls = payload.toolCalls;
      terminal =
        payload.terminalState === "completed" &&
        frame.frameSequence === record.terminalFrameSequence &&
        payload.usageEventId === usageEventIds.at(-1);
    }
  }
  if (!terminal) throw new Error("Worker output has no completed canonical response.");
  return { record, text, usageEventIds, ...(toolCalls ? { toolCalls } : {}) };
}
