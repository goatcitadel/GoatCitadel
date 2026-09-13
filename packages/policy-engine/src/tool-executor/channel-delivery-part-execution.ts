import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import {
  channelDeliveryPartRequestHash,
  isChannelDeliveryPartId,
  type AsyncStorage,
  type ChannelDeliveryPartRecord,
  type CommsDeliveryRecord,
} from "@goatcitadel/storage";

export interface CommsProviderReceipt {
  delivery: CommsDeliveryRecord;
  part?: ChannelDeliveryPartRecord;
}

/** Commit the queue/part/provider relationship before any provider request. */
export async function createCommsProviderReceipt(
  storage: AsyncStorage,
  request: ToolInvokeRequest,
  input: Parameters<AsyncStorage["commsDeliveries"]["createQueued"]>[0],
): Promise<CommsProviderReceipt> {
  if (!isChannelDeliveryPartId(request.toolRunId)) {
    return { delivery: await storage.commsDeliveries.createQueued(input) };
  }
  if (request.toolName !== "channel.send") throw new Error("Channel delivery parts can only dispatch channel.send.");
  const partId = request.toolRunId;
  return storage.runImmediateTransaction(async () => {
    const delivery = await storage.commsDeliveries.createQueued(input);
    const part = await storage.channelDeliveryParts.attachProvider(
      partId,
      channelDeliveryPartRequestHash(request),
      delivery.deliveryId,
    );
    return { delivery, part };
  });
}

export async function markCommsProviderSent(
  storage: AsyncStorage,
  receipt: CommsProviderReceipt,
  providerMessageId: string | undefined,
): Promise<void> {
  const now = new Date().toISOString();
  const settle = async () => {
    if (receipt.part) await storage.commsDeliveries.markSent(receipt.delivery.deliveryId, providerMessageId, now);
    else await storage.commsDeliveries.markSent(receipt.delivery.deliveryId, providerMessageId);
    if (
      receipt.part &&
      !(await storage.channelDeliveryParts.finish(
        receipt.part.partId,
        receipt.delivery.deliveryId,
        receipt.part.revision,
        "sent",
        now,
      ))
    )
      throw new Error(
        "Channel delivery lost its provider receipt claim after dispatch; manual reconciliation required.",
      );
  };
  if (receipt.part) await storage.runImmediateTransaction(settle);
  else await settle();
}

export async function markCommsProviderFailed(
  storage: AsyncStorage,
  receipt: CommsProviderReceipt,
  input: { error: string; deliveryStatus: string; providerMessageId?: string },
): Promise<void> {
  const now = new Date().toISOString();
  const settle = async () => {
    if (input.providerMessageId) {
      await storage.commsDeliveries.markFailed(
        receipt.delivery.deliveryId,
        input.error,
        now,
        input.deliveryStatus,
        undefined,
        input.providerMessageId,
      );
    } else {
      await storage.commsDeliveries.markFailed(receipt.delivery.deliveryId, input.error, now, input.deliveryStatus);
    }
    if (
      receipt.part &&
      !(await storage.channelDeliveryParts.finish(
        receipt.part.partId,
        receipt.delivery.deliveryId,
        receipt.part.revision,
        input.deliveryStatus === "manual_reconciliation_required" ? "manual_reconciliation_required" : "failed",
        now,
      ))
    )
      throw new Error("Channel delivery lost its provider failure receipt claim; manual reconciliation required.");
  };
  if (receipt.part) await storage.runImmediateTransaction(settle);
  else await settle();
}
