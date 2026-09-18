import {
  REMOTE_WORKER_ASSIGNMENT_INFERENCE_EXCHANGE_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION,
  REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256,
  canonicalJsonString,
  normalizeRemoteWorkerInferenceFramePayload,
  normalizeRemoteWorkerInferenceUsageEventIds,
  remoteWorkerInferenceFramePayloadSha256,
  remoteWorkerInferenceFrameSha256,
  remoteWorkerInferenceRequestSha256,
  remoteWorkerInferenceUsageEventIdsSha256,
  verifyRemoteWorkerChatContextBinding,
  remoteWorkerChatInferenceMessages,
  type RemoteWorkerChatContextSnapshot,
  type RemoteWorkerInferenceRequestSubmission,
  type RemoteWorkerInferenceToolCall,
} from "@goatcitadel/contracts";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import { sha256Utf8, type RouteContext, type LeaseBinding } from "./connected-worker-routes.js";
import { normalizeRemoteWorkerNativeChatContext, appendRemoteWorkerNativeChatContext, remoteWorkerNativeChatContextSha256,
  remoteWorkerChatInferenceIdentity, normalizeRemoteWorkerNativeChatHistory, REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS } from "@goatcitadel/contracts";

export interface WorkerInferenceResult {
  readonly status: "completed" | "requires_tools" | "waiting" | "blocked";
  readonly lines: readonly string[];
  readonly usageEventIds: readonly string[];
  readonly requestSha256: string;
  readonly toolCalls?: readonly RemoteWorkerInferenceToolCall[];
}

export function workerInferenceRequestHash(submission: RemoteWorkerInferenceRequestSubmission): string {
  const { leaseToken, ...authorized } = submission;
  void leaseToken;
  return remoteWorkerInferenceRequestSha256(authorized);
}

/** Uses the admitted Chat request. Provider selection and budget remain Gateway-owned. */
export function buildWorkerInferenceSubmission(
  workload: Record<string, unknown>,
  lease: LeaseBinding,
): RemoteWorkerInferenceRequestSubmission {
  if (Object.hasOwn(workload, "nativeContinuation") && !workload.nativeChatContext)
    throw new Error("Native continuation must finish through its canonical owner before Chat inference.");
  const native = workload.nativeChatContext ? normalizeRemoteWorkerNativeChatContext(workload.nativeChatContext) : undefined;
  const history = Object.hasOwn(workload, "nativeChatHistory") ? normalizeRemoteWorkerNativeChatHistory(workload.nativeChatHistory) : undefined;
  if (history && (!native || history.nativeContextSha256 !== remoteWorkerNativeChatContextSha256(native) ||
    history.contextSnapshotSha256 !== workload.contextSnapshotSha256 || history.priorModelSteps >= REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS))
    throw new Error("Native Chat history is unbound or its model step limit is exhausted.");
  if (native && native.continuation.assignmentGeneration !== lease.assignmentGeneration)
    throw new Error("Native Chat context belongs to another assignment generation.");
  if (native && canonicalJsonString(native.continuation) !== canonicalJsonString(workload.nativeContinuation))
    throw new Error("Native Chat context differs from its continuation.");
  const payload = record(workload.payload, "workload payload");
  const request = record(payload.request, "Chat request");
  const identity = {
    schemaVersion: workload.schemaVersion,
    registryWorkspaceId: workload.registryWorkspaceId,
    assignmentId: workload.assignmentId,
    assignmentManifestSha256: workload.assignmentManifestSha256,
    durableRunId: workload.durableRunId,
    durableRunVersion: workload.durableRunVersion,
    durableRunPayloadSha256: workload.durableRunPayloadSha256,
    capabilityProfileId: workload.capabilityProfileId,
    capabilityProfileSha256: workload.capabilityProfileSha256,
    contextSnapshotSha256: workload.contextSnapshotSha256,
    ...(native ? { nativeContinuation: native.continuation, nativeChatContext: native } : {}),
    ...(history ? { nativeChatHistory: history } : {}),
  };
  if (
    identity.schemaVersion !== REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION ||
    workload.registryWorkspaceId !== lease.registryWorkspaceId ||
    workload.assignmentId !== lease.assignmentId ||
    !Number.isSafeInteger(identity.durableRunVersion) ||
    Number(identity.durableRunVersion) < 1 ||
    [identity.durableRunId, identity.capabilityProfileId].some((value) => typeof value !== "string" || !value.trim()) ||
    [identity.assignmentManifestSha256, identity.durableRunPayloadSha256, identity.capabilityProfileSha256].some(
      (value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value),
    ) ||
    payload.capabilityProfileId !== identity.capabilityProfileId ||
    payload.capabilityProfileHash !== identity.capabilityProfileSha256 ||
    typeof workload.contextSnapshotSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(workload.contextSnapshotSha256) ||
    typeof workload.workloadSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(workload.workloadSha256) ||
    typeof request.content !== "string" ||
    !request.content.trim() ||
    request.content.length > 64_000
  ) {
    throw new Error("Worker inference requires an assignment-bound, bounded Chat workload.");
  }
  // This verifies the canonical identity material. The payload itself arrives over the
  // authenticated Gateway transport; its retained raw JSON hash is not reconstructed.
  if (sha256Utf8(canonicalJsonString(identity)) !== workload.workloadSha256)
    throw new Error("Worker workload identity hash verification failed.");
  if (payload.version === "chat.turn.execute.v2" && workload.chatContext === undefined)
    throw new Error("Worker inference requires the admitted Chat context snapshot.");
  const chatContext =
    workload.chatContext === undefined
      ? undefined
      : verifyRemoteWorkerChatContextBinding(workload.chatContext as RemoteWorkerChatContextSnapshot, payload);
  if (
    chatContext &&
    (chatContext.contextSha256 !== workload.contextSnapshotSha256 ||
      chatContext.durableRunId !== workload.durableRunId ||
      chatContext.capabilityProfileId !== workload.capabilityProfileId)
  )
    throw new Error("Worker Chat context differs from its workload identity.");
  const baseMessages = chatContext
    ? remoteWorkerChatInferenceMessages(chatContext)
    : [{ role: "user" as const, text: request.content }];
  if (history && canonicalJsonString(history.messages.slice(0, baseMessages.length)) !== canonicalJsonString(baseMessages))
    throw new Error("Native Chat history lost its original frozen context.");
  const messages = native ? appendRemoteWorkerNativeChatContext(history?.messages ?? baseMessages, native) : baseMessages;
  return {
    registryWorkspaceId: lease.registryWorkspaceId,
    assignmentId: lease.assignmentId,
    assignmentGeneration: lease.assignmentGeneration,
    ...remoteWorkerChatInferenceIdentity({ ...lease, ...(native ? { continuationSha256: remoteWorkerNativeChatContextSha256(native) } : {}) }, 0),
    leaseToken: lease.leaseToken,
    messages,
    inputSha256: sha256Utf8(canonicalJsonString(messages)),
    contextSha256: workload.contextSnapshotSha256,
    modelIntentSha256: sha256Utf8("gateway-assignment-route-v1"),
    outputTokenCeiling: 4096,
    reasoningTokenCeiling: 0,
    temperatureMilli: 0,
  };
}

export async function exchangeWorkerInference(
  context: RouteContext,
  submission: RemoteWorkerInferenceRequestSubmission,
  signal?: AbortSignal,
): Promise<WorkerInferenceResult> {
  const response = await callProtectedRoute({
    ...context,
    rawPath: "/api/v1/remote-workers/assignment-inference-exchanges",
    operation: "assignment.inference.exchange",
    idempotencyKey: submission.idempotencyKey,
    ...(signal === undefined ? {} : { signal }),
    payload: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_INFERENCE_EXCHANGE_SCHEMA_VERSION,
      registryWorkspaceId: submission.registryWorkspaceId,
      assignmentId: submission.assignmentId,
      submission,
    },
  });
  return projectWorkerInferenceResponse(response.body, submission);
}

/** Verify request binding, every payload hash, sequence, and chain link before showing any output. */
export function projectWorkerInferenceResponse(
  body: Record<string, unknown>,
  submission: RemoteWorkerInferenceRequestSubmission,
): WorkerInferenceResult {
  const request = record(body.request, "inference receipt");
  const expectedHash = workerInferenceRequestHash(submission);
  if (
    request.registryWorkspaceId !== submission.registryWorkspaceId ||
    request.assignmentId !== submission.assignmentId ||
    request.assignmentGeneration !== submission.assignmentGeneration ||
    request.inferenceRequestId !== submission.inferenceRequestId ||
    request.attempt !== submission.attempt ||
    request.requestSha256 !== expectedHash
  )
    throw new Error("Inference receipt does not bind this request.");
  if (body.disposition === "waiting_approval")
    return { status: "waiting", lines: [], usageEventIds: [], requestSha256: expectedHash };
  if (!["delivered", "replayed"].includes(String(body.disposition)) || request.state !== "completed")
    return { status: "blocked", lines: [], usageEventIds: [], requestSha256: expectedHash };
  if (
    !Array.isArray(body.frames) ||
    body.frames.length < 1 ||
    body.frames.length > 256 ||
    typeof request.effectiveRouteSha256 !== "string"
  )
    throw new Error("Inference frame evidence is missing or exceeds its bound.");
  let previous = REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256;
  let terminal = false;
  let toolCalls: readonly RemoteWorkerInferenceToolCall[] | undefined;
  let bytes = 0;
  const lines: string[] = [];
  const usageEventIds = normalizeRemoteWorkerInferenceUsageEventIds(request.usageEventIds as readonly string[]);
  if (remoteWorkerInferenceUsageEventIdsSha256(usageEventIds) !== request.usageEventIdsSha256)
    throw new Error("Inference provider-attempt evidence hash verification failed.");
  for (let index = 0; index < body.frames.length; index++) {
    const frame = record(body.frames[index], "inference frame");
    if (
      terminal ||
      frame.frameSequence !== index + 1 ||
      frame.previousFrameSha256 !== previous ||
      typeof frame.payloadJson !== "string" ||
      frame.payloadJson.length > 128_000
    )
      throw new Error("Inference frames are out of order or exceed their bound.");
    const payload = normalizeRemoteWorkerInferenceFramePayload(JSON.parse(frame.payloadJson));
    const payloadSha256 = remoteWorkerInferenceFramePayloadSha256(payload);
    const hash = remoteWorkerInferenceFrameSha256({
      ...submission,
      frameSequence: index + 1,
      frameKind: payload.kind,
      payloadSha256,
      previousFrameSha256: previous,
      effectiveRouteSha256: request.effectiveRouteSha256,
    });
    if (payloadSha256 !== frame.payloadSha256 || hash !== frame.frameSha256 || frame.frameKind !== payload.kind)
      throw new Error("Inference frame hash verification failed.");
    previous = hash;
    if (payload.kind === "output_text") {
      bytes += Buffer.byteLength(payload.text, "utf8");
      if (bytes > 256 * 1024) throw new Error("Inference output exceeds worker capacity.");
      lines.push(payload.text);
    } else {
      if (payload.terminalState !== "completed" || payload.usageEventId !== usageEventIds.at(-1))
        throw new Error("Inference completion lacks canonical usage evidence.");
      terminal = true;
      toolCalls = payload.toolCalls;
    }
  }
  if (!terminal || (!toolCalls && !lines.some((line) => line.trim()))) throw new Error("Inference has no completed output.");
  return {
    status: toolCalls ? "requires_tools" : "completed",
    lines,
    usageEventIds,
    requestSha256: expectedHash,
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value as Record<string, unknown>;
}
