import { useId } from "react";

/** Matches what the operator typed against the phrase, ignoring case and surrounding spaces. */
export function typedConfirmationMatches(typed: string, phrase: string): boolean {
  return typed.trim().toLowerCase() === phrase.trim().toLowerCase();
}

/**
 * The one typed confirmation in the cockpit, for actions that need more than a click (nuclear-risk approvals,
 * installation-wide rejection). The phrase is shown in monospace and the hint is linked to the field.
 */
export function TypedConfirmation({
  phrase,
  value,
  onChange,
  disabled,
  consequence,
}: {
  phrase: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** What stays unavailable until the phrase matches, for example "Approve once". */
  consequence: string;
}) {
  const id = useId();
  const matched = typedConfirmationMatches(value, phrase);
  return (
    <div className="space-y-1 text-sm text-fg-secondary">
      <label htmlFor={id} className="block font-medium">
        Type <code className="rounded-sm bg-sunken px-1 font-mono text-fg">{phrase}</code> to confirm
      </label>
      <input
        id={id}
        value={value}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-required="true"
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full rounded-md border border-line-control bg-canvas px-3 font-mono text-fg"
      />
      <p id={`${id}-hint`} className="text-xs text-fg-muted">
        {matched ? `${consequence} is available.` : `${consequence} stays unavailable until the text matches.`}
      </p>
    </div>
  );
}
