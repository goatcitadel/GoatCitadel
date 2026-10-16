import { Keyboard } from "lucide-react";
import { IconButton } from "../../ui/IconButton";
import { Kbd } from "../../ui/Kbd";

export const INBOX_SHORTCUTS_PANEL_ID = "inbox-keyboard-shortcuts";

const KEYS: readonly { keys: string[]; action: string }[] = [
  { keys: ["J", "K"], action: "Select the next or previous item" },
  { keys: ["O"], action: "Open details" },
  { keys: ["A", "D"], action: "Focus the approval's approve or deny action" },
  { keys: ["E"], action: "Focus the source link" },
];

/** The header's keyboard icon: a disclosure for the Inbox shortcut help and switch (IN-10, IN-18). */
export function InboxShortcutsToggle({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <IconButton
      label="Keyboard shortcuts"
      aria-expanded={open}
      aria-controls={open ? INBOX_SHORTCUTS_PANEL_ID : undefined}
      onClick={() => onOpenChange(!open)}
      icon={<Keyboard aria-hidden="true" className="size-4" />}
    />
  );
}

/** Shortcut help and the letter-shortcut switch, shown under the page description while the disclosure is open. */
export function InboxShortcutsPanel({
  enabled,
  onEnabledChange,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <section
      id={INBOX_SHORTCUTS_PANEL_ID}
      aria-label="Inbox keyboard shortcuts"
      className="mt-3 grid gap-2 text-sm text-fg-secondary"
    >
      <ul className="grid gap-1.5">
        {KEYS.map((entry) => (
          <li key={entry.action} className="flex items-baseline gap-2">
            <span className="flex shrink-0 gap-1">
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </span>
            {entry.action}
          </li>
        ))}
      </ul>
      <p className="text-xs text-fg-muted">Shortcuts only move focus. Confirm to decide.</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
        Enable Inbox letter shortcuts
      </label>
    </section>
  );
}
