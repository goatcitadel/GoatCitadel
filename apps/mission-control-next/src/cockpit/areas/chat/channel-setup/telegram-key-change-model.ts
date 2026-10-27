/** What a key change has to know about the channel it changes: how it reads messages, and which bot it was. */

/**
 * Whether the channel reads its messages by asking Telegram for them. This is the gateway's own rule
 * (`readTelegramReceiveMode(config) === "poll"` in gateway-core, which Mission Control does not depend on): the
 * saved mode, trimmed, is exactly "poll". A channel saved before the setting existed reads by web address.
 */
export function channelPolls(config: Readonly<Record<string, unknown>>): boolean {
  const mode = config.receiveMode;
  return typeof mode === "string" && mode.trim() === "poll";
}

const bare = (username: string) => username.trim().replace(/^@/u, "");

/** The bot the channel was saved with, without the @, or undefined when it never recorded one. */
function savedBot(config: Readonly<Record<string, unknown>>): string | undefined {
  const name = config.botUsername;
  return typeof name === "string" && bare(name) ? bare(name) : undefined;
}

/**
 * The warning for a key that belongs to a different bot than the channel has now. Telegram names are not case
 * sensitive. Undefined for the same bot, and when the channel never recorded one: it cannot claim a switch it
 * cannot see.
 */
export function botChangeNote(config: Readonly<Record<string, unknown>>, newUsername: string): string | undefined {
  const before = savedBot(config);
  const after = bare(newUsername);
  if (!before || before.toLowerCase() === after.toLowerCase()) return undefined;
  return `This key is for @${after}, not @${before}. Saving it switches the bot people message.`;
}

export type InTheWay = "web_address" | "other_reader";

/**
 * What the check found that would stop the channel reading the new bot's messages, if anything.
 * - A channel that polls cannot read a bot that sends to a web address. Its own reader may answer Telegram with a
 *   conflict as well; that is not another app, and is ignored.
 * - Any other channel expects a web address. A conflict there is some other app reading the bot.
 */
export function whatIsInTheWay(
  config: Readonly<Record<string, unknown>>,
  reading: { webhookActive: boolean; conflict: boolean },
): InTheWay | null {
  if (channelPolls(config)) return reading.webhookActive ? "web_address" : null;
  return reading.conflict ? "other_reader" : null;
}
