import {
  discoverTelegramSetupTargets,
  submitChannelSetupDraftSecrets,
} from "@goatcitadel/mission-control-shared/api/client";

export interface TelegramBotReading {
  bot: { username: string; label?: string };
  /** The bot sends its messages to a web address, so GoatCitadel cannot read them. */
  webhookActive: boolean;
  /** Another app is reading the bot's messages. */
  conflict: boolean;
}

export interface TelegramKeyCheck extends TelegramBotReading {
  /** The draft's version after the key was stored: the one every later call on this draft must carry. */
  revision: number;
}

/**
 * Asks Telegram, through the draft's stored key, which bot this is and whether GoatCitadel can read its messages.
 * It clears the bot's web address only when asked; a check never does. Discovery's own warning strings are not
 * passed on: the page says what it means in its own words.
 */
export async function readTelegramBot(input: {
  draftId: string;
  expectedRevision: number;
  clearWebhook?: true;
}): Promise<TelegramBotReading> {
  const found = await discoverTelegramSetupTargets({
    source: "draft",
    draftId: input.draftId,
    expectedRevision: input.expectedRevision,
    ...(input.clearWebhook ? { clearWebhook: true as const } : {}),
  });
  const identity = found.botIdentity;
  if (!identity?.username) throw new Error("Telegram did not name a bot for this key.");
  return {
    bot: { username: identity.username, ...(identity.label ? { label: identity.label } : {}) },
    webhookActive: found.webhookActive,
    conflict: found.updatesConflict === true,
  };
}

/**
 * Checks a bot key: stores it on the draft, then asks Telegram who the bot is. The key is sent once, to the draft's
 * secure store, and is not returned or kept here. Any failure throws; the caller decides what to tell the operator.
 */
export async function checkTelegramKey(input: {
  draftId: string;
  expectedRevision: number;
  token: string;
}): Promise<TelegramKeyCheck> {
  const stored = await submitChannelSetupDraftSecrets(input.draftId, {
    expectedRevision: input.expectedRevision,
    values: { botToken: input.token },
  });
  const reading = await readTelegramBot({ draftId: input.draftId, expectedRevision: stored.revision });
  return { revision: stored.revision, ...reading };
}
