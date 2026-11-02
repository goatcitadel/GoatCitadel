/**
 * Takes the Approve / Deny buttons off the channel messages that carried an errand approval once it is answered, from
 * any surface. Best effort: the approval is already decided, so a failed edit only logs a bounded warning.
 */

import { NotFoundError, type DurableCheckpointRecord } from "@goatcitadel/contracts";
import type { ErrandTrackedDelivery } from "./errand-approval-delivery.js";

/** One delivered channel message, named by the provider's own message id. */
export interface ErrandButtonMessage {
  connectionId: string;
  target: string;
  messageId: string;
}

/** Removes the inline buttons from one channel message: Telegram's reply markup, Discord's components. */
export type ClearChannelMessageButtons = (message: ErrandButtonMessage) => Promise<unknown>;

/** Removes the buttons from the given deliveries' messages; never rejects. */
export type ClearErrandApprovalButtons = (deliveries: readonly ErrandTrackedDelivery[]) => Promise<void>;

export interface ErrandButtonSources {
  /** The Gateway's channel button clearing for a connection's message. */
  clearChannelMessageButtons: ClearChannelMessageButtons;
}

const WARNING_DETAIL_MAX_CHARS = 500;

/**
 * Each delivery that was sent with buttons and whose provider message id is known has them removed. A delivery sent
 * without buttons, or one whose send never completed, is left alone. Never throws.
 */
export async function clearErrandApprovalButtons(
  deliveries: readonly ErrandTrackedDelivery[],
  clearButtons: ClearChannelMessageButtons,
): Promise<void> {
  await Promise.all(
    deliveries
      .filter((delivery) => delivery.buttons === true)
      .map(async (delivery) => {
        try {
          const messageId = (await delivery.providerMessageId?.())?.trim();
          if (!messageId) {
            return;
          }
          await clearButtons({ connectionId: delivery.connectionId, target: delivery.target, messageId });
        } catch (error) {
          warnButtonsKept(delivery, error);
        }
      }),
  );
}

/** The clearing the errand service uses, built from the Gateway's channel pieces. */
export function createGatewayErrandButtonClearer(sources: ErrandButtonSources): ClearErrandApprovalButtons {
  return (deliveries) =>
    clearErrandApprovalButtons(deliveries, (message) => sources.clearChannelMessageButtons(message));
}

/**
 * The provider message id a completed `connector.delivery` run recorded for its send, or undefined while the run has
 * not completed (or recorded none). A run that no longer exists reads as undefined; other read failures are thrown.
 */
export async function connectorDeliveryProviderMessageId(
  runs: {
    getLatestCheckpointByKind(runId: string, kind: "run_completed"): Promise<DurableCheckpointRecord | undefined>;
  },
  runId: string,
): Promise<string | undefined> {
  const completed = await runs.getLatestCheckpointByKind(runId, "run_completed").catch((error: unknown) => {
    if (error instanceof NotFoundError) {
      return undefined;
    }
    throw error;
  });
  const result = completed?.state.result;
  const providerMessageId =
    typeof result === "object" && result !== null ? (result as Record<string, unknown>).providerMessageId : undefined;
  return typeof providerMessageId === "string" && providerMessageId.trim() ? providerMessageId.trim() : undefined;
}

/** For a clearing that failed as a whole (it is built never to); the errand carries on. */
export function warnErrandButtonClearFailure(error: unknown): void {
  // eslint-disable-next-line no-console -- bounded diagnostic; the approval itself is already decided.
  console.warn("[goatcitadel] errand approval buttons could not be removed", {
    detail: (error instanceof Error ? error.message : String(error)).slice(0, WARNING_DETAIL_MAX_CHARS),
  });
}

function warnButtonsKept(delivery: ErrandTrackedDelivery, error: unknown): void {
  // eslint-disable-next-line no-console -- bounded diagnostic; the approval itself is already decided.
  console.warn("[goatcitadel] errand approval buttons could not be removed", {
    approvalId: delivery.approvalId,
    connectionId: delivery.connectionId,
    detail: (error instanceof Error ? error.message : String(error)).slice(0, WARNING_DETAIL_MAX_CHARS),
  });
}
