import { createHash } from "node:crypto";
import type {
  ChannelDeliveryDiagnostics,
  ChannelSendInput,
  ToolInvokeResult,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import { sanitizeChannelOutboundMessage } from "@goatcitadel/contracts";
import type {
  ChannelDeliveryRuntimeRecord,
  ChannelDeliveryRuntimeSendInput,
} from "../channel-delivery-runtime-service.js";

const CHANNEL_DELIVERY_DEFAULT_CHUNK_LIMIT = 3_900;
const CHANNEL_DELIVERY_CHUNK_LIMITS: Record<string, number> = {
  discord: 1_900,
  telegram: 3_900,
  whatsapp: 3_500,
  line: 4_500,
  "nextcloud-talk": 3_900,
  slack: 32_000,
};

export function buildChannelDeliveryPayload(input: ChannelSendInput, channelKey: string): Record<string, unknown> {
  const sanitized = sanitizeChannelOutboundMessage(input.message ?? "");
  const chunkLimit = getChannelDeliveryChunkLimit(channelKey);
  const messageParts = splitChannelOutboundMessage(sanitized.message, chunkLimit);
  const deliveryDiagnostics = buildChannelDeliveryDiagnostics(sanitized.message, messageParts, chunkLimit);
  return {
    connectionId: input.connectionId,
    target: input.target,
    message: messageParts[0] ?? "",
    messageParts: messageParts.length > 1 ? messageParts : undefined,
    deliveryDiagnostics,
    attachments: input.attachments,
    attachmentIds: input.attachmentIds,
    interactiveActions: input.interactiveActions,
    replyToMessageId: input.replyToMessageId,
    replyToPartIndex: input.replyToPartIndex,
    effectId: input.effectId,
    subject: input.subject,
    commitmentId: input.commitmentId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    taskId: input.taskId,
    runId: input.runId,
    operatorId: input.operatorId,
    authActorId: input.authActorId,
    authActorSource: input.authActorSource,
    permissionProfileId: input.permissionProfileId,
    localOperatorOverrideId: input.localOperatorOverrideId,
    surface: input.surface,
  };
}

function getChannelDeliveryChunkLimit(channelKey: string): number {
  return CHANNEL_DELIVERY_CHUNK_LIMITS[channelKey.toLowerCase()] ?? CHANNEL_DELIVERY_DEFAULT_CHUNK_LIMIT;
}

function splitChannelOutboundMessage(message: string, maxPartUtf16Length: number): string[] {
  if (!message) {
    return [""];
  }
  if (message.length <= maxPartUtf16Length) {
    return [message];
  }
  const parts = splitUnicodeGraphemes(message);
  const chunks: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current && current.length + part.length > maxPartUtf16Length) {
      chunks.push(current);
      current = "";
    }
    current += part;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function splitUnicodeGraphemes(message: string): string[] {
  const SegmenterCtor = Intl.Segmenter;
  if (typeof SegmenterCtor === "function") {
    const segmenter = new SegmenterCtor(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(message)].map((item) => item.segment);
  }
  return Array.from(message);
}

function buildChannelDeliveryDiagnostics(
  message: string,
  messageParts: string[],
  maxPartUtf16Length: number,
): ChannelDeliveryDiagnostics | undefined {
  if (messageParts.length <= 1) {
    return undefined;
  }
  return {
    chunking: {
      mode: "unicode_safe",
      originalCodePointLength: splitUnicodeGraphemes(message).length,
      partCount: messageParts.length,
      maxPartUtf16Length,
      parts: messageParts.map((part, index) => ({
        partIndex: index,
        codePointLength: splitUnicodeGraphemes(part).length,
        utf16Length: part.length,
      })),
    },
  };
}

export function channelDeliveryPayloadToSendInput(input: ChannelDeliveryRuntimeSendInput): ChannelSendInput {
  const payload = input.payload;
  return {
    connectionId: readRequiredString(payload.connectionId, "connectionId"),
    target: readRequiredString(payload.target, "target"),
    message: typeof payload.message === "string" ? payload.message : "",
    attachments: Array.isArray(payload.attachments)
      ? (payload.attachments as ChannelSendInput["attachments"])
      : undefined,
    attachmentIds: Array.isArray(payload.attachmentIds) ? (payload.attachmentIds as string[]) : undefined,
    interactiveActions:
      typeof payload.interactiveActions === "object" && payload.interactiveActions !== null
        ? (payload.interactiveActions as ChannelSendInput["interactiveActions"])
        : undefined,
    replyToMessageId: typeof payload.replyToMessageId === "string" ? payload.replyToMessageId : undefined,
    replyToPartIndex: typeof payload.replyToPartIndex === "number" ? payload.replyToPartIndex : undefined,
    effectId: typeof payload.effectId === "string" ? payload.effectId : undefined,
    subject: typeof payload.subject === "string" ? payload.subject : undefined,
    commitmentId: typeof payload.commitmentId === "string" ? payload.commitmentId : undefined,
    workspaceId: typeof payload.workspaceId === "string" ? payload.workspaceId : undefined,
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
    agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    taskId: typeof payload.taskId === "string" ? payload.taskId : undefined,
    runId: typeof payload.runId === "string" ? payload.runId : undefined,
    operatorId: typeof payload.operatorId === "string" ? payload.operatorId : undefined,
    authActorId: typeof payload.authActorId === "string" ? payload.authActorId : undefined,
    authActorSource: readAuthActorSource(payload.authActorSource),
    permissionProfileId: typeof payload.permissionProfileId === "string" ? payload.permissionProfileId : undefined,
    localOperatorOverrideId:
      typeof payload.localOperatorOverrideId === "string" ? payload.localOperatorOverrideId : undefined,
    surface: readPermissionSurface(payload.surface),
  };
}

export function readChannelDeliveryMessageParts(payload: Record<string, unknown>): string[] {
  const parts = Array.isArray(payload.messageParts)
    ? payload.messageParts
    : Array.isArray(payload.deliveryChunks)
      ? payload.deliveryChunks
      : undefined;
  if (!parts) {
    return [];
  }
  return parts.filter((item): item is string => typeof item === "string");
}

export function readDeliveryDiagnostics(value: unknown): ChannelDeliveryDiagnostics | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as ChannelDeliveryDiagnostics;
}

function readPermissionSurface(value: unknown): ChannelSendInput["surface"] | undefined {
  return value === "chat" ||
    value === "cowork" ||
    value === "code" ||
    value === "tools" ||
    value === "mcp" ||
    value === "all"
    ? value
    : undefined;
}

function readAuthActorSource(value: unknown): ToolPolicyActorContext["authActorSource"] | undefined {
  return value === "none" ||
    value === "token" ||
    value === "basic" ||
    value === "loopback" ||
    value === "sse" ||
    value === "device" ||
    value === "companion"
    ? value
    : undefined;
}

export function buildChannelDeliveryIdempotencyKey(input: ChannelSendInput, channelKey: string): string | undefined {
  const explicit = (input as ChannelSendInput & { idempotencyKey?: string }).idempotencyKey?.trim();
  if (explicit) {
    return explicit;
  }
  if (input.effectId?.trim()) {
    return `channel-delivery:effect:${input.effectId.trim()}`;
  }
  if (input.sessionId?.trim() && input.replyToMessageId?.trim()) {
    const hash = createHash("sha256")
      .update(JSON.stringify(buildChannelDeliveryPayload(input, channelKey)))
      .digest("hex");
    return `channel-delivery:session:${input.sessionId.trim()}:${input.replyToMessageId.trim()}:${hash}`;
  }
  if (input.taskId?.trim()) {
    const hash = createHash("sha256")
      .update(JSON.stringify(buildChannelDeliveryPayload(input, channelKey)))
      .digest("hex");
    return `channel-delivery:task:${input.taskId.trim()}:${hash}`;
  }
  return undefined;
}

export function mapPersistedChannelDeliveryRuntimeStatus(
  status: "queued" | "sent" | "failed",
  deliveryStatus: string | undefined,
  staleReason: string | undefined,
): ChannelDeliveryRuntimeRecord["status"] {
  if (staleReason) {
    return "stale";
  }
  if (status === "sent") {
    return "sent";
  }
  if (status === "failed") {
    if (deliveryStatus === "manual_reconciliation_required") {
      return "manual_reconciliation_required";
    }
    return "failed";
  }
  return deliveryStatus === "retrying" ? "retrying" : "queued";
}

export function extractCommsSendResult(result: ToolInvokeResult | Record<string, unknown>): Record<string, unknown> {
  if (isToolInvokeResultLike(result)) {
    if (result.outcome !== "executed") {
      throw new Error(result.policyReason || `channel.send returned ${result.outcome}`);
    }
    return result.result ?? {};
  }
  return result;
}

function isToolInvokeResultLike(value: unknown): value is ToolInvokeResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === "executed" || outcome === "blocked" || outcome === "approval_required";
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`Channel delivery payload is missing ${label}.`);
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
