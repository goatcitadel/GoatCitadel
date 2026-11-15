export const SUGGESTIONS_HINT_ID = "cockpit-composer-suggestions-hint";

/**
 * Read with the message box (not a live region) while its suggestion list is open. The box stays a plain textbox:
 * HTML-ARIA allows no combobox role on a textarea, so the list is described instead.
 */
export function ComposerSuggestionsHint({ open }: { open: boolean }) {
  return (
    <span id={SUGGESTIONS_HINT_ID} className="sr-only">
      {open ? "Suggestions are open. Use the up and down arrows to choose one and Enter to insert it." : ""}
    </span>
  );
}

/** The ids a message box is described by, space-joined; undefined when there are none. */
export function composerDescribedBy(reasonId: string | null, suggestionsOpen: boolean): string | undefined {
  return [reasonId, suggestionsOpen ? SUGGESTIONS_HINT_ID : null].filter(Boolean).join(" ") || undefined;
}
