/**
 * Sends a waiting errand approval beyond the window and Chat. A channel-started errand asks in its own conversation;
 * a PC-started errand asks in the conversation the operator picked for errand approvals, and on the phone.
 *
 * The approval is re-read first, so an approval answered in the meantime goes nowhere. A channel that can't take the
 * approval (disconnected, unready, failed send) is skipped with a warning: the phone still gets its push, and the
 * approval keeps waiting in the window and Chat.
 */

import type { ApprovalRequest } from "@goatcitadel/contracts";
import type {
  ErrandApprovalConversation,
  ErrandApprovalDeliveryInput,
  ErrandApprovalDeliveryResult,
} from "./errand-approval-delivery.js";
import type { ErrandOrigin } from "./errand-origin.js";

export interface ErrandEscalationDeps {
  /** The stored approval record. */
  readApproval(approvalId: string): Promise<ApprovalRequest>;
  /** Sends the approval to one channel conversation (see `deliverErrandApproval`). */
  deliver(input: ErrandApprovalDeliveryInput): Promise<ErrandApprovalDeliveryResult>;
  /** The Chat session id of the conversation the operator picked for PC errand approvals; undefined when none. */
  approvalSessionId(): string | undefined;
  /** The channel conversation a Chat session is bound to, or undefined when it isn't bound to one. */
  conversationFor(sessionId: string): Promise<ErrandApprovalConversation | undefined>;
  /** Queues the one phone push for this approval; the push itself checks the approval is still pending. */
  pushToPhone(approvalId: string): Promise<unknown>;
}

export type ErrandEscalate = (approval: ApprovalRequest, origin: ErrandOrigin) => Promise<void>;

export function createErrandEscalation(deps: ErrandEscalationDeps): ErrandEscalate {
  const { readApproval, deliver, approvalSessionId, conversationFor, pushToPhone } = deps;

  const sendToConversation = async (
    approval: ApprovalRequest,
    conversation: ErrandApprovalConversation,
  ): Promise<void> => {
    const screenshotAttachmentId = readScreenshotAttachmentId(approval);
    const result = await deliver({
      approval,
      origin: conversation,
      ...(screenshotAttachmentId ? { screenshotAttachmentId } : {}),
    }).catch((error: unknown): ErrandApprovalDeliveryResult => {
      warn("errand approval delivery failed", approval, conversation.connectionId, errorText(error));
      return { delivered: false, reason: "delivery_failed" };
    });
    if (!result.delivered) {
      warn("errand approval skipped the channel conversation", approval, conversation.connectionId, result.reason);
    }
  };

  const pickedConversation = async (approval: ApprovalRequest): Promise<ErrandApprovalConversation | undefined> => {
    const sessionId = approvalSessionId()?.trim();
    if (!sessionId) {
      return undefined;
    }
    const conversation = await conversationFor(sessionId).catch(() => undefined);
    if (!conversation) {
      warn("errand approval conversation is not a channel conversation", approval, undefined, "no_binding");
    }
    return conversation;
  };

  const sendToPhone = async (approval: ApprovalRequest): Promise<void> => {
    await pushToPhone(approval.approvalId).catch((error: unknown) => {
      warn("errand approval phone push could not be queued", approval, undefined, errorText(error));
    });
  };

  return async (approval, origin) => {
    const current = await readApproval(approval.approvalId).catch(() => undefined);
    if (!current || current.status !== "pending") {
      return;
    }
    if (origin.kind === "channel") {
      await sendToConversation(current, origin);
      return;
    }
    const conversation = await pickedConversation(current);
    if (conversation) {
      await sendToConversation(current, conversation);
    }
    await sendToPhone(current);
  };
}

/** Only the gate's own screenshot for this approval, as recorded on the approval. */
function readScreenshotAttachmentId(approval: ApprovalRequest): string | undefined {
  const value = approval.preview?.screenshotAttachmentId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(message: string, approval: ApprovalRequest, connectionId: string | undefined, detail: string): void {
  // eslint-disable-next-line no-console -- bounded diagnostic; the approval keeps waiting in the window and Chat.
  console.warn(`[goatcitadel] ${message}`, {
    approvalId: approval.approvalId,
    ...(connectionId ? { connectionId } : {}),
    detail: detail.slice(0, 500),
  });
}
