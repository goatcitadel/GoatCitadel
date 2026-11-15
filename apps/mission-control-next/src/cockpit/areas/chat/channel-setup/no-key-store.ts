import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";

/** GoatCitadel's sentence when it has no secure storage for channel keys, whatever status it comes with. */
export const NO_KEY_STORE_SAID = "Secure channel credential storage is unavailable.";

/** True when the Gateway refused because this computer has no secure storage for channel keys. */
export function isNoKeyStoreFailure(error: unknown): boolean {
  if (!isApiRequestError(error)) return false;
  const body: unknown = error.body;
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return fields.error === NO_KEY_STORE_SAID || fields.message === NO_KEY_STORE_SAID;
}

/** The words of the sentence that link to the channel's guide in Advanced channel setup. */
export function noKeyStoreLinkText(channelName: string): string {
  return `${channelName}'s guide in Advanced channel setup`;
}

/** What a channel page says when keys pasted there need secure storage this computer does not have. */
export function noKeyStoreSentence(channelName: string, secretWord: "key" | "token" | "tokens"): string {
  return `This page stores your ${secretWord} in this computer's secure storage, which isn't available here. Use ${noKeyStoreLinkText(channelName)} with environment variables instead.`;
}

export const TELEGRAM_NO_KEY_STORE = noKeyStoreSentence("Telegram", "key");
export const DISCORD_NO_KEY_STORE = noKeyStoreSentence("Discord", "token");
export const SLACK_NO_KEY_STORE = noKeyStoreSentence("Slack", "tokens");
