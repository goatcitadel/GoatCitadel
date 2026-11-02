/**
 * Plain channel messages about a running errand, beyond approvals:
 * - a sign-in pause: "GoatCitadel needs you at the PC to sign in."; a bot-check pause: "GoatCitadel needs you at the
 *   PC." A channel-started errand says so in its own conversation at once; a PC-started errand says so in the conversation the operator picked for errand
 *   approvals, once the pause has lasted ERRAND_ESCALATE_AFTER_MS and only while it is still going. Never a phone push.
 * - the final screenshot of a channel-started errand, sent only into a private conversation; a group gets the
 *   private-only line once instead.
 *
 * Every send is plain text through the Gateway's channel send, without an approval token. A failed send is logged and
 * never reaches the errand.
 */

import type { ErrandApprovalConversation } from "./errand-approval-delivery.js";
import { ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE } from "./errand-approval-message.js";
import { ERRAND_ESCALATE_AFTER_MS } from "./errand-constants.js";
import type { ErrandOrigin } from "./errand-origin.js";

export const ERRAND_SIGN_IN_NOTICE_COPY = "GoatCitadel needs you at the PC to sign in. The errand is paused.";
export const ERRAND_BOT_CHECK_NOTICE_COPY = "GoatCitadel needs you at the PC. The errand is paused.";

/** Why an errand paused for the operator at the PC. */
export type ErrandPauseReason = "sign_in" | "bot_check";

export interface ErrandChannelMessage {
  connectionId: string;
  target: string;
  message: string;
  attachmentIds?: string[];
}

export interface ErrandChannelSendDeps {
  /** The Gateway's channel send, as GoatCitadel's own delivery. */
  send(input: ErrandChannelMessage & { plainText: true }): Promise<unknown>;
}

/** Sends one plain message (and optionally attachments the caller already checked) to one channel conversation. */
export async function sendErrandChannelMessage(
  deps: ErrandChannelSendDeps,
  input: ErrandChannelMessage,
): Promise<void> {
  const { connectionId, target, message, attachmentIds } = input;
  await deps.send({
    connectionId,
    target,
    message,
    plainText: true,
    ...(attachmentIds?.length ? { attachmentIds } : {}),
  });
}

export interface ErrandChannelNoticeDeps extends ErrandChannelSendDeps {
  /** The operator's own direct conversation picked for PC errand approvals; undefined when none is picked. */
  pickedConversation(): Promise<ErrandApprovalConversation | undefined>;
  /** The chat session a stored chat attachment was uploaded to. */
  attachmentSessionId(attachmentId: string): Promise<string | undefined>;
  /** Defaults to ERRAND_ESCALATE_AFTER_MS. */
  afterMs?: number;
}

export interface ErrandFinishedNotice {
  /** The errand's own Chat session; only its own screenshot is attached. */
  sessionId: string;
  finalScreenshotAttachmentId?: string;
}

export interface ErrandChannelNotices {
  /** Starts the notice for a sign-in or bot-check pause; the returned function cancels it when the pause ends. */
  signInPaused(origin: ErrandOrigin, reason: ErrandPauseReason): () => void;
  /** Sends the errand's final screenshot (or the private-only line) to a channel-started errand's conversation. */
  finished(origin: ErrandOrigin, notice: ErrandFinishedNotice): Promise<void>;
}

export function createErrandChannelNotices(deps: ErrandChannelNoticeDeps): ErrandChannelNotices {
  const { pickedConversation, attachmentSessionId } = deps;
  const afterMs = deps.afterMs ?? ERRAND_ESCALATE_AFTER_MS;

  const sendSafely = async (conversation: ErrandApprovalConversation, message: string, attachmentId?: string) => {
    await sendErrandChannelMessage(deps, {
      connectionId: conversation.connectionId,
      target: conversation.target,
      message,
      ...(attachmentId ? { attachmentIds: [attachmentId] } : {}),
    }).catch((error: unknown) => {
      // eslint-disable-next-line no-console -- bounded diagnostic; the errand carries on.
      console.warn("[goatcitadel] errand channel notice was not sent", {
        connectionId: conversation.connectionId,
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    });
  };

  return {
    signInPaused: (origin, reason) => {
      const copy = reason === "bot_check" ? ERRAND_BOT_CHECK_NOTICE_COPY : ERRAND_SIGN_IN_NOTICE_COPY;
      if (origin.kind === "channel") {
        void sendSafely(origin, copy);
        return () => undefined;
      }
      // Set when the pause ends, so a pause that ends while the picked conversation is being read sends nothing.
      let cancelled = false;
      const timer = setTimeout(() => {
        void pickedConversation()
          .catch(() => undefined)
          .then(async (conversation) => {
            if (conversation && !cancelled) {
              await sendSafely(conversation, copy);
            }
          });
      }, afterMs);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    },
    finished: async (origin, notice) => {
      const attachmentId = notice.finalScreenshotAttachmentId?.trim();
      if (origin.kind !== "channel" || !attachmentId) {
        return;
      }
      if (origin.conversation !== "direct") {
        await sendSafely(origin, ERRAND_SCREENSHOT_PRIVATE_ONLY_LINE);
        return;
      }
      const owner = await attachmentSessionId(attachmentId).catch(() => undefined);
      // The errand's own screenshot only; a mismatch or a failed read sends nothing.
      if (owner && owner === notice.sessionId) {
        await sendSafely(origin, "Here is where the errand ended.", attachmentId);
      }
    },
  };
}
