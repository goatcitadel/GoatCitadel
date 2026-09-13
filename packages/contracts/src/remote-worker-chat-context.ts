import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import type { ChatCompletionMessage } from "./llm.js";
import type { RemoteWorkerInferenceMessage } from "./remote-worker-inference.js";
import { readDurableChatTurnExecutionPayloadAuthority } from "./durable-chat-turn-payload.js";

export const REMOTE_WORKER_CHAT_CONTEXT_SCHEMA_VERSION = "goatcitadel.remote-worker-chat-context.v1" as const;
export const REMOTE_WORKER_CHAT_CONTEXT_MAX_BYTES = 384 * 1024;

/** Only resource bounds permit ordinary Chat to keep its local runner. Invalid
 * admission, scope or message data remains an error, never a placement fallback. */
export class RemoteWorkerChatContextLimitError extends TypeError {}

/** Gateway-prepared input, retained before an offer can expose the turn to a
 * worker. Retains history, guidance, activated skills and routed context. Later
 * QMD memory and hook augmentation remain completion-owner work; this record
 * must not be presented as evidence that those later stages executed. */
export interface RemoteWorkerChatContextMaterial {
  readonly schemaVersion: typeof REMOTE_WORKER_CHAT_CONTEXT_SCHEMA_VERSION;
  readonly durableRunId: string;
  readonly admissionId: string;
  readonly sessionIncarnationId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly requestMaterialSha256: string;
  readonly capabilityProfileId: string;
  readonly capabilityProfileSha256: string;
  readonly routedContextSnapshotId?: string;
  readonly routedContextSnapshotSha256?: string;
  readonly messages: readonly Readonly<ChatCompletionMessage>[];
}

export interface RemoteWorkerChatContextSnapshot extends RemoteWorkerChatContextMaterial {
  readonly contextSha256: string;
}

export function trySealRemoteWorkerChatContextForTurn(
  durableRunId: string,
  payload: unknown,
  messages: readonly Readonly<ChatCompletionMessage>[],
): RemoteWorkerChatContextSnapshot | undefined {
  try {
    return sealRemoteWorkerChatContextForTurn(durableRunId, payload, messages);
  } catch (error) {
    if (error instanceof RemoteWorkerChatContextLimitError) return undefined;
    throw error;
  }
}

export function sealRemoteWorkerChatContextForTurn(
  durableRunId: string,
  payload: unknown,
  messages: readonly Readonly<ChatCompletionMessage>[],
): RemoteWorkerChatContextSnapshot {
  const authority = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: "chat.turn.execute",
    durableRunId,
    payload,
  });
  if (!authority || !authority.capabilityProfileId || !authority.capabilityProfileHash)
    throw new TypeError("Remote Chat context requires an admitted capability profile.");
  return sealRemoteWorkerChatContext({
    schemaVersion: REMOTE_WORKER_CHAT_CONTEXT_SCHEMA_VERSION,
    durableRunId,
    admissionId: authority.admissionId,
    sessionIncarnationId: authority.sessionIncarnationId,
    workspaceId: authority.workspaceId,
    sessionId: authority.sessionId,
    turnId: authority.turnId,
    requestMaterialSha256: authority.effectiveRequestMaterialSha256,
    capabilityProfileId: authority.capabilityProfileId,
    capabilityProfileSha256: authority.capabilityProfileHash,
    ...(authority.routedContextSnapshotId
      ? {
          routedContextSnapshotId: authority.routedContextSnapshotId,
          routedContextSnapshotSha256: authority.routedContextSnapshotHash,
        }
      : {}),
    messages,
  });
}

/** Strict JSON validation preserves structured provider input without inventing
 * a second message format or silently dropping names, tool results or images. */
export function sealRemoteWorkerChatContext(input: RemoteWorkerChatContextMaterial): RemoteWorkerChatContextSnapshot {
  const row = plainRecord(input);
  const keys = [
    "schemaVersion",
    "durableRunId",
    "admissionId",
    "sessionIncarnationId",
    "workspaceId",
    "sessionId",
    "turnId",
    "requestMaterialSha256",
    "capabilityProfileId",
    "capabilityProfileSha256",
    "routedContextSnapshotId",
    "routedContextSnapshotSha256",
    "messages",
  ];
  if (
    Object.keys(row).some((key) => !keys.includes(key)) ||
    input.schemaVersion !== REMOTE_WORKER_CHAT_CONTEXT_SCHEMA_VERSION
  )
    throw new TypeError("Unsupported remote Chat context material.");
  for (const key of [
    "durableRunId",
    "admissionId",
    "sessionIncarnationId",
    "workspaceId",
    "sessionId",
    "turnId",
    "capabilityProfileId",
  ])
    identifier(row[key]);
  for (const hash of [input.requestMaterialSha256, input.capabilityProfileSha256]) digest(hash);
  if ((input.routedContextSnapshotId === undefined) !== (input.routedContextSnapshotSha256 === undefined))
    throw new TypeError("Remote Chat routed-context binding is incomplete.");
  if (input.routedContextSnapshotId !== undefined) {
    identifier(input.routedContextSnapshotId);
    digest(input.routedContextSnapshotSha256);
  }
  normalizeRemoteWorkerChatMessages(input.messages);
  const serialized = canonicalJsonString(input);
  if (new TextEncoder().encode(serialized).byteLength > REMOTE_WORKER_CHAT_CONTEXT_MAX_BYTES)
    throw new RemoteWorkerChatContextLimitError("Remote Chat context exceeds its byte bound.");
  return deepFreeze({
    ...JSON.parse(serialized),
    contextSha256: sha256Hex(serialized),
  }) as RemoteWorkerChatContextSnapshot;
}

export function normalizeRemoteWorkerChatMessages(
  messages: readonly Readonly<ChatCompletionMessage>[],
): ChatCompletionMessage[] {
  if (!Array.isArray(messages) || !messages.length)
    throw new TypeError("Remote Chat context requires at least one message.");
  if (messages.length > 256)
    throw new RemoteWorkerChatContextLimitError("Remote Chat context message count exceeds its bound.");
  for (const message of messages) {
    const value = plainRecord(message);
    if (
      Object.keys(value).some((key) => !["role", "content", "name", "tool_call_id"].includes(key)) ||
      !["system", "developer", "user", "assistant", "tool"].includes(message.role) ||
      !(typeof message.content === "string" || Array.isArray(message.content))
    )
      throw new TypeError("Invalid remote Chat context message.");
    if (Array.isArray(message.content)) for (const part of message.content) plainRecord(part);
    if (message.name !== undefined) identifier(message.name);
    if (message.tool_call_id !== undefined) identifier(message.tool_call_id);
    assertJson(value, 0);
  }
  const serialized = canonicalJsonString(messages);
  if (new TextEncoder().encode(serialized).byteLength > REMOTE_WORKER_CHAT_CONTEXT_MAX_BYTES)
    throw new RemoteWorkerChatContextLimitError("Remote Chat context exceeds its byte bound.");
  return deepFreeze(JSON.parse(serialized)) as ChatCompletionMessage[];
}

export function remoteWorkerChatInferenceMessages(
  snapshot: RemoteWorkerChatContextSnapshot,
): readonly RemoteWorkerInferenceMessage[] {
  return Object.freeze(
    verifyRemoteWorkerChatContext(snapshot).messages.map((message) =>
      Object.freeze({
        role: message.role,
        text: typeof message.content === "string" ? message.content : "",
        ...(Array.isArray(message.content) ? { parts: message.content } : {}),
        ...(message.name === undefined ? {} : { name: message.name }),
        ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }),
      }),
    ),
  );
}

export function verifyRemoteWorkerChatContext(input: RemoteWorkerChatContextSnapshot): RemoteWorkerChatContextSnapshot {
  const { contextSha256, ...material } = plainRecord(input);
  digest(contextSha256);
  const sealed = sealRemoteWorkerChatContext(material as unknown as RemoteWorkerChatContextMaterial);
  if (sealed.contextSha256 !== contextSha256) throw new TypeError("Remote Chat context hash mismatch.");
  return sealed;
}

export function verifyRemoteWorkerChatContextBinding(
  input: RemoteWorkerChatContextSnapshot,
  payload: unknown,
): RemoteWorkerChatContextSnapshot {
  const snapshot = verifyRemoteWorkerChatContext(input);
  const authority = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: "chat.turn.execute",
    durableRunId: snapshot.durableRunId,
    payload,
  });
  if (
    !authority ||
    authority.admissionId !== snapshot.admissionId ||
    authority.sessionIncarnationId !== snapshot.sessionIncarnationId ||
    authority.workspaceId !== snapshot.workspaceId ||
    authority.sessionId !== snapshot.sessionId ||
    authority.turnId !== snapshot.turnId ||
    authority.effectiveRequestMaterialSha256 !== snapshot.requestMaterialSha256 ||
    authority.capabilityProfileId !== snapshot.capabilityProfileId ||
    authority.capabilityProfileHash !== snapshot.capabilityProfileSha256 ||
    authority.routedContextSnapshotId !== snapshot.routedContextSnapshotId ||
    authority.routedContextSnapshotHash !== snapshot.routedContextSnapshotSha256
  )
    throw new TypeError("Remote Chat context differs from its admitted durable turn.");
  return snapshot;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError("Remote Chat context requires plain JSON objects.");
  return value as Record<string, unknown>;
}

function identifier(value: unknown): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new TypeError("Invalid remote Chat context identifier.");
}

function digest(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new TypeError("Invalid remote Chat context hash.");
}

function assertJson(value: unknown, depth: number): void {
  if (depth > 32) throw new TypeError("Remote Chat context nesting exceeds its bound.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const child of value) assertJson(child, depth + 1);
    return;
  }
  for (const child of Object.values(plainRecord(value))) {
    if (child !== undefined) assertJson(child, depth + 1);
  }
}

function deepFreeze(value: unknown): unknown {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
