import { createHash } from "node:crypto";

export interface InboundChannelDeterministicIdentity {
  inboundEventId: string;
  userMessageId: string;
  turnId: string;
  assistantMessageId: string;
  durableRunId: string;
  deliveryIdempotencyKey: string;
  onDurableRunLaunched?: (runId: string) => void | Promise<void>;
  onDeliveryEnqueued?: (evidence: {
    deliveryId?: string;
    providerMessageId?: string;
    idempotencyKey?: string;
  }) => void | Promise<void>;
}

export function buildDeterministicIdentity(eventId: string, messageId: string): InboundChannelDeterministicIdentity {
  return {
    inboundEventId: eventId,
    userMessageId: messageId,
    turnId: stableInboundId("turn", eventId),
    assistantMessageId: stableInboundId("assistant", eventId),
    durableRunId: stableInboundId("run", eventId),
    deliveryIdempotencyKey: stableInboundId("delivery", eventId),
  };
}

export function stableInboundId(kind: string, ...parts: string[]): string {
  return `inbound-${kind}-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
