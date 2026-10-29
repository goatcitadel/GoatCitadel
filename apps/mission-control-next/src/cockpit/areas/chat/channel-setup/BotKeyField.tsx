import { TokenField } from "./TokenField";

export const WEB_ADDRESS_NOTE =
  "This bot sends its messages to a web address, so GoatCitadel can't read them here. If another app uses that address, it stops getting messages.";
export const OTHER_APP_NOTE =
  "Another app is reading this bot's messages. Stop it there, or make a new bot for GoatCitadel.";

/** What a key that checked out says, naming the bot it belongs to. */
export const keyWorks = (username: string) => `Key works. Your bot is @${username}.`;

/**
 * The field a bot key is pasted into, and the button that checks it: a token field in Telegram's words. The caller
 * keeps what is typed in the volatile credential store and drops it once the key has been checked. Enter checks too.
 */
export function BotKeyField({
  value,
  onChange,
  busy,
  checking,
  onCheck,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Something is in flight: the field is read-only and only the check that is running keeps its button. */
  busy: boolean;
  /** The check itself is in flight. */
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <TokenField
      label="Bot key"
      value={value}
      onChange={onChange}
      busy={busy}
      button={{ label: "Check key", checking, onCheck }}
    />
  );
}
