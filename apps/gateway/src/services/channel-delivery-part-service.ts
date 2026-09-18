import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import {
  channelDeliveryPartRequestHash,
  type AsyncStorage,
  type ChannelDeliveryPartRecord,
} from "@goatcitadel/storage";
import { ChannelDeliveryApprovalPendingError } from "./channel-delivery-approval-pending.js";
import type { ChannelDeliveryRuntimeSendInput } from "./channel-delivery-runtime-service.js";
import { commsSend, type CommsHost } from "./comms-service.js";
import { createChannelDeliveryFailureError, sendQueuedChannelDelivery } from "./gateway/channel-delivery-helpers.js";

type ChannelDeliveryPartStorage = Pick<
  AsyncStorage,
  "channelDeliveryParts" | "approvals" | "pendingApprovalActions" | "commsDeliveries"
>;

/** Journal normalized executable parts at the existing comms/policy boundary.
 * Recovery reads acknowledged provider receipts; it never re-invokes an approval. */
export async function sendQueuedChannelDeliveryWithParts(
  storage: ChannelDeliveryPartStorage,
  host: CommsHost,
  input: ChannelDeliveryRuntimeSendInput,
) {
  let partIndex = 0;
  return sendQueuedChannelDelivery((sendInput) => {
    const index = partIndex++;
    return commsSend(
      {
        ...host,
        invokeAndUnwrap: async (request, realtimeType) => {
          const part = await storage.channelDeliveryParts.prepare({
            deliveryId: input.deliveryId,
            attempt: input.attempts,
            partIndex: index,
            payloadHash: input.payloadHash ?? "",
            requestHash: channelDeliveryPartRequestHash(request),
            claimExpiresAt: input.nextAttemptAt ?? "",
          });
          if (part.status !== "prepared") return replayPart(storage, part, input);
          let result: Awaited<ReturnType<CommsHost["invokeAndUnwrap"]>>;
          try {
            result = await host.invokeAndUnwrap({ ...request, toolRunId: part.partId }, realtimeType);
          } catch (error) {
            const current = await storage.channelDeliveryParts.find(part.partId);
            if (current?.approvalId) throw new ChannelDeliveryApprovalPendingError(part.partId);
            if (current && current.status !== "prepared") return replayPart(storage, current, input);
            await storage.channelDeliveryParts.reject(part.partId, part.revision);
            throw error;
          }
          const current = await storage.channelDeliveryParts.find(part.partId);
          // Approval registration released our queue lease. Even a fast approval
          // must settle under a newly acquired claim, never the released claim.
          if (current?.approvalId) throw new ChannelDeliveryApprovalPendingError(part.partId);
          if (current && current.status !== "prepared") return replayPart(storage, current, input);
          await storage.channelDeliveryParts.reject(part.partId, part.revision);
          if (result.outcome === "blocked") return result;
          throw manual("Channel tool returned without a durable provider or approval handoff.");
        },
      },
      sendInput,
    );
  }, input);
}

async function replayPart(
  storage: ChannelDeliveryPartStorage,
  part: ChannelDeliveryPartRecord,
  input: ChannelDeliveryRuntimeSendInput,
): Promise<Record<string, unknown>> {
  if (part.status === "waiting_approval") {
    const [approval, action] = await Promise.all([
      storage.approvals.get(part.approvalId!),
      storage.pendingApprovalActions.find(part.approvalId!),
    ]);
    if (
      !approval ||
      !action ||
      action.actionType !== "tool.invoke" ||
      action.request.toolRunId !== part.partId ||
      channelDeliveryPartRequestHash(action.request as unknown as ToolInvokeRequest) !== part.requestHash
    ) {
      throw manual("Channel delivery approval evidence is missing or changed.");
    }
    if (
      (approval.status !== "pending" && approval.status !== "approved") ||
      !approval.expiresAt ||
      Date.parse(approval.expiresAt) <= Date.now() ||
      (action.resolutionStatus && action.resolutionStatus !== "pending")
    ) {
      // A concurrent approved execution may have committed since the read.
      if (!(await storage.channelDeliveryParts.reject(part.partId, part.revision))) {
        throw new ChannelDeliveryApprovalPendingError(part.partId);
      }
      if (action.resolutionStatus === "executed")
        throw manual("Approved channel action has no linked provider receipt.");
      throw createChannelDeliveryFailureError(
        "Channel delivery approval was rejected, expired, or could not execute.",
        "blocked",
      );
    }
    throw new ChannelDeliveryApprovalPendingError(part.partId);
  }
  if (part.status === "dispatching") {
    const queue = await storage.commsDeliveries.getById(input.deliveryId);
    if (part.approvalId && Date.now() - Date.parse(part.updatedAt) < (queue?.staleAfterMs ?? 900_000)) {
      throw new ChannelDeliveryApprovalPendingError(part.partId);
    }
    throw manual("Channel provider dispatch has no terminal receipt; manual reconciliation is required.");
  }
  if (part.status === "failed" && !part.providerDeliveryId) {
    throw createChannelDeliveryFailureError("Channel delivery was rejected before provider dispatch.", "blocked");
  }
  const provider = part.providerDeliveryId ? await storage.commsDeliveries.getById(part.providerDeliveryId) : undefined;
  if (
    !provider ||
    provider.connectionId !== input.connectionId ||
    provider.channelKey !== input.channelKey ||
    provider.target !== input.target ||
    (part.status === "sent"
      ? provider.status !== "sent" || provider.deliveryStatus !== "sent"
      : provider.status !== "failed")
  ) {
    throw manual("Channel delivery has no matching terminal provider receipt.");
  }
  return {
    status: provider.status,
    deliveryStatus: provider.deliveryStatus,
    providerMessageId: provider.providerMessageId,
    error: provider.error,
    deliveryId: provider.deliveryId,
  };
}

function manual(message: string): Error {
  return createChannelDeliveryFailureError(message, "manual_reconciliation_required");
}
