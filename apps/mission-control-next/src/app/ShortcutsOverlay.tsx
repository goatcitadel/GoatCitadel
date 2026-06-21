import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "lucide-react";
import { KbdHint } from "../features/native-routes/primitives";

export interface ShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
  /** Area route jumps: { label, letter } for each g+<letter> shortcut. */
  routeShortcuts: Array<{ label: string; letter: string }>;
}

/**
 * ShortcutsOverlay (C2) — a `?`-triggered cheat-sheet for the shell keyboard
 * model. The full g+letter / Cmd+K shortcut set already ships in
 * use-shell-keyboard-manager but was undiscoverable; this surfaces it.
 *
 * A self-contained modal (no shared CommandPalette dependency): scrim + centred
 * card, focus moved in on open and restored on close, Tab trapped, dismissed by
 * Escape (via the shell keyboard manager's dismiss chain), backdrop click, or
 * the close button. Route letters come from SHELL_ROUTE_SHORTCUT_LETTERS (passed
 * in as routeShortcuts) so the copy can never drift from the handler.
 */
export function ShortcutsOverlay({ open, onClose, routeShortcuts }: ShortcutsOverlayProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    cardRef.current?.focus();
    return () => {
      const previous = restoreFocusRef.current;
      // Only restore if the trigger is still in the document — otherwise let the
      // browser fall back rather than focusing a detached node.
      if (previous && document.contains(previous)) {
        previous.focus?.();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") {
      return;
    }
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const focusables = card.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])');
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    // Focus on the card wrapper (tabIndex=-1) or anywhere outside the dialog:
    // pull it back in so Tab/Shift+Tab can never reach the page behind the modal.
    if (active === card || !card.contains(active)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="mc-next-shortcuts-overlay" role="presentation" onClick={onClose}>
      <div
        ref={cardRef}
        className="mc-next-shortcuts-card"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="mc-next-shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button
            type="button"
            className="mc-next-icon-button"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <dl className="mc-next-shortcuts-list">
          <div className="mc-next-shortcuts-row">
            <dt>Command palette</dt>
            <dd>
              <KbdHint keys={["Ctrl", "K"]} />
            </dd>
          </div>
          <div className="mc-next-shortcuts-row">
            <dt>Keyboard shortcuts</dt>
            <dd>
              <KbdHint keys={["?"]} />
            </dd>
          </div>
          {routeShortcuts.map(({ label, letter }) => (
            <div className="mc-next-shortcuts-row" key={letter}>
              <dt>Go to {label}</dt>
              <dd>
                <KbdHint keys={["g", letter]} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
