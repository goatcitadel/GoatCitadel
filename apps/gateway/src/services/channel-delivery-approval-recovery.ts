import type { AsyncStorage } from "@goatcitadel/storage";
import { ChannelDeliveryApprovalPendingError } from "./channel-delivery-approval-pending.js";

interface ChannelApprovalRecoveryPort {
  parts?: Pick<AsyncStorage["channelDeliveryParts"], "list" | "park">;
}

/** Resume only an existing, contiguous attempt whose parts entered governed dispatch. */
export async function hasResumableChannelDeliveryParts(
  deps: ChannelApprovalRecoveryPort,
  deliveryId: string,
  attempts: number,
): Promise<boolean> {
  const parts = attempts > 0 ? ((await deps.parts?.list(deliveryId, attempts)) ?? []) : [];
  return parts.length > 0 && parts.every((part, index) => part.partIndex === index && part.status !== "prepared");
}

type ChannelApprovalPause =
  | { status: "not_applicable" }
  | { status: "claim_lost" }
  | { status: "parked"; updatedAt: string; nextAttemptAt: string };

/** Park through the canonical part/attempt fence before projecting an approval wait. */
export async function parkChannelDeliveryApproval(
  deps: ChannelApprovalRecoveryPort,
  error: unknown,
  input: { claimExpiresAt: string; baseBackoffMs: number; now: () => string },
): Promise<ChannelApprovalPause> {
  if (!(error instanceof ChannelDeliveryApprovalPendingError) || !deps.parts) return { status: "not_applicable" };
  const now = input.now();
  const nextAttemptAt = new Date(Date.parse(now) + Math.max(1_000, input.baseBackoffMs)).toISOString();
  if (!(await deps.parts.park(error.partId, input.claimExpiresAt, nextAttemptAt, now))) return { status: "claim_lost" };
  return { status: "parked", updatedAt: now, nextAttemptAt };
}
