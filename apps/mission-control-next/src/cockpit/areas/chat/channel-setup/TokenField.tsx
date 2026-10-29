import { Button } from "../../../ui/Button";
import { Field } from "../../../ui/Field";
import { cockpitInputClass } from "../../../ui/input-class";

/**
 * A secret pasted into a masked field, and optionally the button that checks it. The caller keeps what is typed in the
 * volatile credential store and drops it once the check is done. Without a button this is the field alone, so a page
 * with two secrets (a bot token and an app token) can put both in one form and check them with one button; with one,
 * Enter in the field checks too.
 */
export function TokenField({
  label,
  value,
  onChange,
  busy,
  placeholder,
  button,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Something is in flight: the field is read-only and only the check that is running keeps its button. */
  busy: boolean;
  placeholder?: string;
  button?: {
    label: string;
    /** The check itself is in flight. */
    checking: boolean;
    onCheck: () => void;
  };
}) {
  const field = (
    <Field label={label}>
      {(props) => (
        <input
          {...props}
          type="password"
          // Browsers ignore "off" on a password field, and offer to save it when this form goes away.
          autoComplete="new-password"
          autoCapitalize="off"
          spellCheck={false}
          className={cockpitInputClass}
          value={value}
          placeholder={placeholder}
          readOnly={busy}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
  if (!button) return field;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        button.onCheck();
      }}
    >
      {field}
      <Button
        type="submit"
        variant="primary"
        loading={button.checking}
        loadingLabel="Checking…"
        disabled={!value.trim() || (busy && !button.checking)}
      >
        {button.label}
      </Button>
    </form>
  );
}
