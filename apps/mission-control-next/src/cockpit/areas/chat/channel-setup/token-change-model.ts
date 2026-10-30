import { SAVE_KEY_WORDING } from "./telegram-key-change-model";
import type { TurnOnWording } from "./TurnOnStep";

/** What changing a Discord, Slack or WhatsApp channel's tokens has to know: what a check found, and whether the bot changed. */

/** The secrets a channel's tokens are, as the page's fields hold them. A channel with one token ignores the other. */
export interface TokenInputs {
  botToken: string;
  appToken: string;
}

/** What a check of the new tokens found. Names are for the page to show; the id is only compared, never shown. */
export interface CheckedTokens {
  /** The bot's id with its channel: Discord's application id, Slack's bot user id. */
  botId: string;
  /** The bot as the page names it. */
  botName: string;
  /** What the step says once the tokens work. */
  works: string;
  /** Why the bot cannot be used yet although its tokens work, in one sentence. Absent when nothing is in the way. */
  inTheWay?: string;
}

/** The new tokens were stored and read, or one was not accepted (and nothing more was written to the draft). */
export type TokenCheckOutcome =
  | {
      kind: "checked";
      checked: CheckedTokens;
      /** Settings the draft keeps of the bot, which the saved channel follows. Empty when the gateway takes none. */
      draftValues: Readonly<Record<string, unknown>>;
    }
  | { kind: "rejected"; error: string };

/**
 * The one thing saving does that the operator can see in their chat. The setup pages say "there" after naming where the
 * bot posts; this page lists nothing before the line, so it names the place itself.
 */
export const KEY_CHANGE_TEST_MESSAGE = "GoatCitadel sends a test message where your bot posts and then removes it";

/** Said of the bot the channel has now when nothing names it. */
export const BOT_IT_USES_NOW = "the bot this channel uses now";

/** The sentence that follows a bot change, in the words of one token or of several. */
function switchSentence(many: boolean): string {
  return `Saving ${many ? "them" : "it"} switches the bot people message.`;
}

/** The warning for tokens that belong to a different bot than the channel has now. */
export function botChangeNote(many: boolean, newName: string, oldName: string | undefined): string {
  const subject = many ? "These tokens are" : "This token is";
  return `${subject} for ${newName}, not ${oldName ?? BOT_IT_USES_NOW}. ${switchSentence(many)}`;
}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Whether the tokens are for a different bot than the channel was saved with. False when the channel never recorded
 * one: it cannot claim a switch it cannot see.
 */
export function botChanged(config: Readonly<Record<string, unknown>>, savedKey: string, botId: string): boolean {
  const saved = textOf(config[savedKey]);
  return saved !== undefined && saved !== botId.trim();
}

/** A bot's name from what the running channel reports about itself, or nothing when it does not say. */
export function runningBotName(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  return textOf(metadata?.[key]);
}

/** The words of Save key for a channel: the shared button, and the ending and cleanup that name the channel. */
export function saveKeyWording(ending: Pick<TurnOnWording, "done" | "doneLink" | "cleanup">): TurnOnWording {
  return { ...SAVE_KEY_WORDING, ...ending };
}
