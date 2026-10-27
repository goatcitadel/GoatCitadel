import { Button } from "../../../ui/Button";
import { Field } from "../../../ui/Field";
import { cockpitInputClass } from "../../../ui/input-class";

export const WEB_ADDRESS_NOTE =
  "This bot sends its messages to a web address, so GoatCitadel can't read them here. If another app uses that address, it stops getting messages.";
export const OTHER_APP_NOTE =
  "Another app is reading this bot's messages. Stop it there, or make a new bot for GoatCitadel.";

/** What a key that checked out says, naming the bot it belongs to. */
export const keyWorks = (username: string) => `Key works. Your bot is @${username}.`;

/**
 * The field a bot key is pasted into, and the button that checks it. The field is masked; the caller keeps what is
 * typed in the volatile credential store and drops it once the key has been checked. Enter checks too.
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
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onCheck();
      }}
    >
      <Field label="Bot key">
        {(field) => (
          <input
            {...field}
            type="password"
            // Browsers ignore "off" on a password field, and offer to save it when this form goes away.
            autoComplete="new-password"
            autoCapitalize="off"
            spellCheck={false}
            className={cockpitInputClass}
            value={value}
            readOnly={busy}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="primary"
        loading={checking}
        loadingLabel="Checking…"
        disabled={!value.trim() || (busy && !checking)}
      >
        Check key
      </Button>
    </form>
  );
}
