import { createHash } from "node:crypto";
import type {
  ChannelDeliveryDiagnostics,
  ChannelDeliveryStatus,
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
const CHANNEL_DELIVERY_FAILURE_STATUSES = new Set<ChannelDeliveryStatus>([
  "degraded",
  "blocked",
  "not_available",
  "manual_reconciliation_required",
]);
const CHANNEL_DELIVERY_CHUNK_LIMITS: Record<string, number> = {
  discord: 1_900,
  telegram: 3_900,
  whatsapp: 3_500,
  line: 4_500,
  "nextcloud-talk": 3_900,
  slack: 32_000,
};

type ToolInvokeResultLike = Omit<ToolInvokeResult, "outcome"> & {
  outcome: ToolInvokeResult["outcome"] | "failed";
};

type ChannelDeliverySender = (input: ChannelSendInput) => Promise<ToolInvokeResult | Record<string, unknown>>;

export function buildChannelDeliveryPayload(input: ChannelSendInput, channelKey: string): Record<string, unknown> {
  if (/grat_[A-Za-z0-9_-]{43}/.test(JSON.stringify(input.interactiveActions ?? null))) {
    throw new Error("Raw remote approval bearer cannot be queued; use an interactive action secret reference.");
  }
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
    interactiveActionTemplate: input.interactiveActionTemplate,
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
    interactiveActionTemplate:
      typeof payload.interactiveActionTemplate === "object" && payload.interactiveActionTemplate !== null
        ? (payload.interactiveActionTemplate as ChannelSendInput["interactiveActionTemplate"])
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

export async function sendQueuedChannelDelivery(
  send: ChannelDeliverySender,
  input: ChannelDeliveryRuntimeSendInput,
): Promise<{ providerMessageId?: string; deliveryDiagnostics?: ChannelDeliveryDiagnostics }> {
  const baseInput = channelDeliveryPayloadToSendInput(input);
  const messageParts = readChannelDeliveryMessageParts(input.payload);
  if (messageParts.length <= 1) {
    let result: Awaited<ReturnType<ChannelDeliverySender>>;
    try {
      result = await send(baseInput);
    } catch (error) {
      throw coerceChannelDeliveryFailureError(error);
    }
    const unwrapped = extractCommsSendResult(result);
    if (unwrapped.status === "failed") {
      throw createChannelDeliveryFailureError(
        readOptionalString(unwrapped.error) ??
          readOptionalString(unwrapped.fallbackReason) ??
          "Channel delivery failed.",
        unwrapped.deliveryStatus,
        readOptionalString(unwrapped.providerMessageId),
      );
    }
    return { providerMessageId: readOptionalString(unwrapped.providerMessageId) };
  }

  let providerMessageId: string | undefined;
  for (let index = 0; index < messageParts.length; index += 1) {
    let unwrapped: Record<string, unknown>;
    try {
      const result = await send({
        ...baseInput,
        message: messageParts[index] ?? "",
        attachments: index === 0 ? baseInput.attachments : undefined,
        attachmentIds: index === 0 ? baseInput.attachmentIds : undefined,
        interactiveActions: index === messageParts.length - 1 ? baseInput.interactiveActions : undefined,
        interactiveActionTemplate: index === messageParts.length - 1 ? baseInput.interactiveActionTemplate : undefined,
        replyToMessageId: index === 0 ? baseInput.replyToMessageId : (providerMessageId ?? baseInput.replyToMessageId),
        replyToPartIndex: index,
      });
      unwrapped = extractCommsSendResult(result);
    } catch (error) {
      const failure = coerceChannelDeliveryFailureError(error);
      if (index > 0) {
        throw createChannelDeliveryFailureError(
          `partial_channel_delivery_sent: ${index} of ${messageParts.length} chunks were sent before failure; manual retry required. ${failure.message}`,
          "manual_reconciliation_required",
          providerMessageId,
        );
      }
      throw failure;
    }
    if (unwrapped.status === "failed") {
      const reason =
        readOptionalString(unwrapped.error) ??
        readOptionalString(unwrapped.fallbackReason) ??
        "Channel delivery chunk failed.";
      const failedProviderMessageId = readOptionalString(unwrapped.providerMessageId);
      const sentChunkCount = index + (failedProviderMessageId ? 1 : 0);
      throw createChannelDeliveryFailureError(
        index > 0
          ? `partial_channel_delivery_sent: ${sentChunkCount} of ${messageParts.length} chunks were sent before failure; manual retry required. ${reason}`
          : reason,
        index > 0 ? "manual_reconciliation_required" : unwrapped.deliveryStatus,
        failedProviderMessageId ?? providerMessageId,
      );
    }
    providerMessageId = readOptionalString(unwrapped.providerMessageId) ?? providerMessageId;
  }

  return {
    providerMessageId,
    deliveryDiagnostics: readDeliveryDiagnostics(input.payload.deliveryDiagnostics),
  };
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
      throw createChannelDeliveryFailureError(
        result.policyReason || `channel.send returned ${result.outcome}`,
        result.outcome === "failed" ? "manual_reconciliation_required" : "blocked",
      );
    }
    return result.result ?? {};
  }
  return result;
}

export function createChannelDeliveryFailureError(message: string, status: unknown, providerMessageId?: string): Error {
  const error = new Error(message) as Error & {
    deliveryStatus?: ChannelDeliveryStatus;
    providerMessageId?: string;
  };
  if (typeof status === "string" && CHANNEL_DELIVERY_FAILURE_STATUSES.has(status as ChannelDeliveryStatus)) {
    error.deliveryStatus = status as ChannelDeliveryStatus;
  }
  if (providerMessageId?.trim()) {
    error.providerMessageId = providerMessageId.trim();
  }
  return error;
}

export function coerceChannelDeliveryFailureError(error: unknown): Error {
  if (error instanceof Error) {
    const status = (error as Error & { deliveryStatus?: unknown }).deliveryStatus;
    if (typeof status === "string" && CHANNEL_DELIVERY_FAILURE_STATUSES.has(status as ChannelDeliveryStatus)) {
      return error;
    }
  }
  return createChannelDeliveryFailureError(
    error instanceof Error ? error.message : String(error),
    "manual_reconciliation_required",
  );
}

function isToolInvokeResultLike(value: unknown): value is ToolInvokeResultLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === "executed" || outcome === "blocked" || outcome === "approval_required" || outcome === "failed";
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
