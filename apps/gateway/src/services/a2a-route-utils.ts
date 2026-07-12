import { createHash } from "node:crypto";
import type {
  A2ABridgeMessage,
  A2ABridgeMessagePart,
  A2ABridgeTaskState,
  A2AJsonRpcErrorResponse,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2ATaskBindingRecord,
  ChatSendMessageResponse,
  TaskRecord,
} from "@goatcitadel/contracts";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";
import { A2AJsonRpcServiceError } from "./a2a-json-rpc-error.js";

export function isInboundPeerBinding(binding: "JSONRPC" | "GRPC" | "HTTP_JSON"): boolean {
  return binding === "JSONRPC" || binding === "HTTP_JSON" || binding === "GRPC";
}

export function httpJsonServiceError(statusCode: number, reason: string, message: string): Error {
  const error = new Error(message) as Error & { statusCode: number; reason: string };
  error.statusCode = statusCode;
  error.reason = reason;
  return error;
}

export function parseJsonRpcRequest(
  value: unknown,
): { ok: true; value: A2AJsonRpcRequest } | { ok: false; code: number; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: -32600, message: "Invalid JSON-RPC request." };
  }
  const candidate = value as Partial<A2AJsonRpcRequest>;
  if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") {
    return { ok: false, code: -32600, message: "JSON-RPC 2.0 method is required." };
  }
  if (
    candidate.params !== undefined &&
    (!candidate.params || typeof candidate.params !== "object" || Array.isArray(candidate.params))
  ) {
    return { ok: false, code: -32602, message: "JSON-RPC params must be an object." };
  }
  return { ok: true, value: candidate as A2AJsonRpcRequest };
}

export function normalizeInboundMessage(params: Record<string, unknown>): A2ABridgeMessage {
  const rawMessage = readObject(params.message);
  const message = rawMessage ?? params;
  const rawParts = Array.isArray(message.parts) ? message.parts : undefined;
  const parts = rawParts ? rawParts.map(normalizePart).filter(isMessagePart) : undefined;
  const text = readString(message.text) ?? readString(params.text) ?? readString(params.content);
  return {
    role: readString(message.role) === "agent" ? "agent" : "user",
    messageId: readString(message.messageId) ?? readString(params.messageId) ?? readString(params.id),
    contextId: readString(message.contextId) ?? readString(params.contextId),
    parts: parts?.length ? parts : [{ kind: "text", text: text ?? "" }],
    metadata: readObject(message.metadata) ?? readObject(params.metadata),
  };
}

export function partsToText(parts: A2ABridgeMessagePart[]): string {
  const text = parts
    .map((part) =>
      part.kind === "text" ? part.text : part.kind === "data" ? JSON.stringify(part.data) : part.file.uri,
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || "[A2A message contained no text payload.]";
}

export function buildTaskTitle(message: A2ABridgeMessage, peerId: string): string {
  const text = partsToText(message.parts).replace(/\s+/g, " ").trim();
  return `A2A ${peerId}: ${text.slice(0, 96) || "peer task"}`;
}

export function buildInboundIdempotencyKey(
  peerId: string,
  contextId: string,
  message: A2ABridgeMessage,
  params: Record<string, unknown>,
): string {
  const explicit = message.messageId ?? readString(params.messageId) ?? readString(params.id);
  if (explicit) {
    return hashStableJson({ peerId, contextId, messageId: explicit });
  }
  return hashStableJson({ peerId, contextId, message });
}

export function readInboundMessageFromBinding(binding: A2ATaskBindingRecord): A2ABridgeMessage | undefined {
  const value = binding.metadata.inboundMessage;
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as A2ABridgeMessage;
}

export function mapTaskStatusToA2AState(
  status: TaskRecord["status"],
  fallback: A2ABridgeTaskState,
): A2ABridgeTaskState {
  switch (status) {
    case "done":
      return "completed";
    case "blocked":
      return fallback === "canceled" ? "canceled" : "failed";
    case "planning":
    case "inbox":
    case "assigned":
      return "submitted";
    case "in_progress":
    case "testing":
    case "review":
      return "working";
    default:
      return fallback;
  }
}

export function readTaskMaybe(tasks: Pick<TaskLifecycleService, "getTask">, taskId: string): TaskRecord | undefined {
  try {
    return tasks.getTask(taskId);
  } catch {
    return undefined;
  }
}

export function readDurableRunId(response: ChatSendMessageResponse): string | undefined {
  const candidate = response as unknown as Record<string, unknown>;
  const trace = readObject(candidate.trace);
  return (
    readString(readObject(trace?.durable)?.runId) ??
    readString(candidate.durableRunId) ??
    readString(candidate.agenticRunId) ??
    readString(readObject(candidate.durable)?.runId) ??
    readString(readObject(candidate.agentic)?.runId)
  );
}

export function jsonRpcResult(id: A2AJsonRpcRequest["id"], result: unknown): A2AJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  };
}

export function jsonRpcError(
  id: A2AJsonRpcRequest["id"] | null,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): A2AJsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      data,
    },
  };
}

export function mapJsonRpcServiceError(id: A2AJsonRpcRequest["id"], error: unknown): A2AJsonRpcResponse {
  if (error instanceof A2AJsonRpcServiceError) {
    return jsonRpcError(id, error.code, error.message);
  }
  return jsonRpcError(id, -32603, "A2A method failed.");
}

export function parseJsonRpcResponse(value: unknown): A2AJsonRpcResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return jsonRpcError(null, -32603, "A2A peer returned a malformed JSON-RPC response.");
  }
  const candidate = value as Partial<A2AJsonRpcResponse>;
  if (candidate.jsonrpc !== "2.0") {
    return jsonRpcError(null, -32603, "A2A peer returned a malformed JSON-RPC response.");
  }
  return candidate as A2AJsonRpcResponse;
}

export function buildOutboundHeaders(peer: { token?: string; tokenEnv?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  const token = peer.token?.trim() || (peer.tokenEnv?.trim() ? process.env[peer.tokenEnv.trim()]?.trim() : undefined);
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

export function readBearerToken(value: unknown): string | undefined {
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

export function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function hashStableJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableJson(value)))
    .digest("hex")
    .slice(0, 32);
}

function normalizePart(value: unknown): A2ABridgeMessagePart | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = readString(record.kind) ?? readString(record.type);
  if (kind === "text") {
    return { kind: "text", text: readString(record.text) ?? "" };
  }
  if (kind === "data") {
    return { kind: "data", data: readObject(record.data) ?? {} };
  }
  if (kind === "file") {
    return {
      kind: "file",
      file: {
        name: readString(record.name),
        mimeType: readString(record.mimeType),
        uri: readString(record.uri),
        bytesBase64: readString(record.bytesBase64),
      },
    };
  }
  return undefined;
}

function isMessagePart(value: A2ABridgeMessagePart | undefined): value is A2ABridgeMessagePart {
  return Boolean(value);
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableJson(item)]),
  );
}
