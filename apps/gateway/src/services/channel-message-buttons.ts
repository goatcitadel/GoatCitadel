/**
 * Takes the inline buttons off a message GoatCitadel already sent, once what they asked has been answered. Telegram
 * clears the reply markup here; Discord edits the message's components through its bot runtime.
 */

import { BoundedResponseReadError, readBoundedResponseJson } from "./bounded-response-reader.js";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const TELEGRAM_REASON_MAX_CHARS = 200;
/** Telegram's answer when the message already has no buttons: nothing left to do. */
const TELEGRAM_NOT_MODIFIED = /message is not modified/i;

/** Clears the reply markup on one sent Telegram message. Throws a bounded reason that never carries the token. */
export async function clearTelegramMessageButtons(
  token: string,
  chatId: string,
  messageId: string,
  fetcher: Fetcher,
): Promise<void> {
  const telegramMessageId = /^\d+$/u.test(messageId.trim()) ? Number.parseInt(messageId.trim(), 10) : Number.NaN;
  if (!Number.isSafeInteger(telegramMessageId) || telegramMessageId <= 0) {
    throw new Error("Telegram message id is not a number.");
  }
  const response = await fetcher(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: telegramMessageId, reply_markup: { inline_keyboard: [] } }),
  });
  const payload = await readTelegramPayload(response);
  if (response.ok && payload.ok !== false) {
    return;
  }
  const description = typeof payload.description === "string" ? payload.description : "";
  if (TELEGRAM_NOT_MODIFIED.test(description)) {
    return;
  }
  const reason = description.split(token).join("[redacted]").slice(0, TELEGRAM_REASON_MAX_CHARS);
  throw new Error(`telegram.edit_buttons failed (${response.status})${reason ? `: ${reason}` : ""}`);
}

async function readTelegramPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    return await readBoundedResponseJson<Record<string, unknown>>(response, {
      maxBytes: 64 * 1024,
      timeoutMs: 5_000,
      label: "Telegram edit buttons",
    });
  } catch (error) {
    if (error instanceof BoundedResponseReadError && (error.code === "body_parse" || error.code === "body_missing")) {
      return {};
    }
    throw error;
  }
}
