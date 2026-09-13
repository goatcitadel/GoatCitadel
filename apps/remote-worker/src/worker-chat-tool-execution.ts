import {
  REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
  REMOTE_WORKER_CHAT_MAX_TOOL_CALL_BYTES,
  canonicalJsonString,
  normalizeRemoteWorkerChatToolSubmission,
  type RemoteWorkerChatToolResult,
  type RemoteWorkerChatToolSubmission,
} from "@goatcitadel/contracts";
import { callProtectedRoute } from "./worker-protected-route-client.js";
import { sha256Utf8, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import type { WorkerInferenceResult } from "./worker-inference-execution.js";

export async function exchangeWorkerChatTool(
  context: RouteContext,
  lease: LeaseBinding,
  submission: RemoteWorkerChatToolSubmission,
  inference: WorkerInferenceResult,
  signal?: AbortSignal,
): Promise<RemoteWorkerChatToolResult> {
  const selection = normalizeRemoteWorkerChatToolSubmission(submission);
  if (inference.status !== "requires_tools" || !inference.toolCalls?.[selection.callIndex])
    throw new Error("Worker Chat tool selection lacks a verified model request.");
  const response = await callProtectedRoute({
    ...context,
    rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
    operation: "assignment.settlement.submit",
    idempotencyKey: `chat-tool:${sha256Utf8(
      canonicalJsonString({
        assignmentId: lease.assignmentId,
        generation: lease.assignmentGeneration,
        requestSha256: inference.requestSha256,
        selection,
      }),
    )}`,
    signal,
    payload: {
      schemaVersion: REMOTE_WORKER_ASSIGNMENT_SETTLEMENT_SUBMISSION_SCHEMA_VERSION,
      ...lease,
      submission: selection,
    },
  });
  return projectWorkerChatToolResponse(response.body, selection, inference);
}

export function projectWorkerChatToolResponse(
  body: Record<string, unknown>,
  submission: RemoteWorkerChatToolSubmission,
  inference: WorkerInferenceResult,
): RemoteWorkerChatToolResult {
  const call = inference.toolCalls?.[submission.callIndex];
  const result = body.tool as RemoteWorkerChatToolResult | undefined;
  if (
    body.disposition !== "chat_tool_recorded" ||
    !result ||
    !call ||
    result.inferenceRequestId !== submission.inferenceRequestId ||
    result.attempt !== submission.attempt ||
    result.callIndex !== submission.callIndex ||
    result.requestSha256 !== inference.requestSha256 ||
    result.callId !== call.callId ||
    result.modelToolName !== call.modelToolName ||
    typeof result.intentId !== "string" ||
    !result.intentId ||
    result.toolRunId !== `remote-tool:${result.intentId}` ||
    !["completed", "waiting_approval", "blocked"].includes(result.status)
  )
    throw new Error("Worker Chat tool result does not bind the verified model call.");
  if (result.status === "completed") {
    if (
      typeof result.resultJson !== "string" ||
      Buffer.byteLength(result.resultJson, "utf8") > REMOTE_WORKER_CHAT_MAX_TOOL_CALL_BYTES
    )
      throw new Error("Worker Chat tool result exceeds its bound.");
    const value: unknown = JSON.parse(result.resultJson);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      sha256Utf8(canonicalJsonString(value)) !== result.resultSha256
    )
      throw new Error("Worker Chat tool result hash verification failed.");
  } else if (result.resultJson !== undefined || result.resultSha256 !== undefined) {
    throw new Error("Unsettled worker Chat tools cannot supply completed results.");
  }
  return Object.freeze({ ...result });
}
