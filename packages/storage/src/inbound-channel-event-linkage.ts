import { ConflictError, type InboundChannelEventLinkage, type InboundChannelEventRecord } from "@goatcitadel/contracts";

export function assertLinkageCompatible(current: InboundChannelEventRecord, linkage: InboundChannelEventLinkage): void {
  for (const key of [
    "sessionKey",
    "sessionId",
    "messageId",
    "turnId",
    "assistantMessageId",
    "durableRunId",
    "deliveryId",
    "providerMessageId",
    "messageContentHash",
    "deliveryPayloadHash",
    "commandOperationKey",
    "commandResultText",
  ] as const) {
    if (current[key] && linkage[key] && current[key] !== linkage[key]) {
      throw new ConflictError({
        message: `Inbound channel event ${current.eventId} is already linked to a different ${key}.`,
        details: { eventId: current.eventId, field: key },
      });
    }
  }
}
