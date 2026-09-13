import { canonicalJsonString } from "./canonical-json.js";

export const REMOTE_WORKER_CHAT_MAX_TOOL_CALLS = 32;
export const REMOTE_WORKER_CHAT_MAX_TOOL_CALL_BYTES = 64 * 1024;

/** Provider-authored request only. It is not a tool grant or execution receipt. */
export interface RemoteWorkerInferenceToolCall {
  readonly callId: string;
  readonly modelToolName: string;
  readonly argumentsJson: string;
}

/** A worker selects a retained call; its name, arguments, scope and grants are
 * resolved by the Gateway from canonical inference and capability evidence. */
export interface RemoteWorkerChatToolSubmission {
  readonly kind: "chat.tool";
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly callIndex: number;
}

export interface RemoteWorkerChatToolResult {
  readonly status: "completed" | "waiting_approval" | "blocked";
  readonly inferenceRequestId: string;
  readonly attempt: number;
  readonly callIndex: number;
  readonly requestSha256: string;
  readonly callId: string;
  readonly modelToolName: string;
  readonly toolRunId: string;
  readonly intentId: string;
  readonly resultJson?: string;
  readonly resultSha256?: string;
}

export function normalizeRemoteWorkerChatToolSubmission(value: unknown): RemoteWorkerChatToolSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid worker Chat tool submission.");
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).some((key) => !["kind", "inferenceRequestId", "attempt", "callIndex"].includes(key)) ||
    fields.kind !== "chat.tool" ||
    typeof fields.inferenceRequestId !== "string" ||
    !fields.inferenceRequestId.trim() ||
    fields.inferenceRequestId.length > 256 ||
    hasControlCharacters(fields.inferenceRequestId) ||
    !Number.isSafeInteger(fields.attempt) ||
    Number(fields.attempt) < 1 ||
    !Number.isSafeInteger(fields.callIndex) ||
    Number(fields.callIndex) < 0 ||
    Number(fields.callIndex) >= REMOTE_WORKER_CHAT_MAX_TOOL_CALLS
  )
    throw new TypeError("Invalid worker Chat tool selection.");
  return Object.freeze({
    kind: "chat.tool",
    inferenceRequestId: fields.inferenceRequestId,
    attempt: fields.attempt as number,
    callIndex: fields.callIndex as number,
  });
}

/** Preserve exact arguments for replay; malformed or truncated calls cannot
 * become executable through an empty-arguments or generated-ID fallback. */
export function normalizeRemoteWorkerInferenceToolCalls(value: unknown): readonly RemoteWorkerInferenceToolCall[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > REMOTE_WORKER_CHAT_MAX_TOOL_CALLS)
    throw new TypeError("Worker inference tool calls exceed their count bound.");
  const ids = new Set<string>();
  const calls = value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new TypeError("Invalid worker inference tool call.");
    const call = entry as Record<string, unknown>;
    if (Object.keys(call).some((key) => !["callId", "modelToolName", "argumentsJson"].includes(key)))
      throw new TypeError("Worker inference tool call contains unknown fields.");
    for (const key of ["callId", "modelToolName"] as const) {
      if (
        typeof call[key] !== "string" ||
        !call[key].trim() ||
        call[key].length > 256 ||
        hasControlCharacters(call[key])
      )
        throw new TypeError("Invalid worker inference tool call identity.");
    }
    if (
      typeof call.argumentsJson !== "string" ||
      new TextEncoder().encode(call.argumentsJson).byteLength > REMOTE_WORKER_CHAT_MAX_TOOL_CALL_BYTES
    )
      throw new TypeError("Worker inference tool arguments exceed their byte bound.");
    let args: unknown;
    try {
      args = JSON.parse(call.argumentsJson);
    } catch {
      throw new TypeError("Worker inference tool arguments are incomplete JSON.");
    }
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new TypeError("Worker inference tool arguments must be a JSON object.");
    if (ids.has(call.callId as string)) throw new TypeError("Worker inference tool call identities repeat.");
    ids.add(call.callId as string);
    return Object.freeze({
      callId: call.callId as string,
      modelToolName: call.modelToolName as string,
      argumentsJson: call.argumentsJson,
    });
  });
  if (new TextEncoder().encode(canonicalJsonString(calls)).byteLength > REMOTE_WORKER_CHAT_MAX_TOOL_CALL_BYTES)
    throw new TypeError("Worker inference tool calls exceed their byte bound.");
  return Object.freeze(calls);
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
