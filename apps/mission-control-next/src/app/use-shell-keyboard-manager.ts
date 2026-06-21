import { useEffect, useRef } from "react";
import type { PrimaryArea } from "./route-model";

/*
 * H-7 (ship punchlist): shell-level keyboard model.
 *
 * Listens on `document` for the canonical Mission Control shortcuts:
 *
 *   Cmd/Ctrl+K   → open command palette
 *   Escape       → close topmost dismissible (caller decides priority)
 *   g, <letter>  → route jump (Linear pattern, e.g. g+c = chat)
 *
 * The hook keeps no business state — every effect is delegated via a callback.
 * Callers (MissionControlNextApp) own the actual UI state (palette open,
 * inspector open, drawer open, etc.) and decide what to dismiss in priority
 * order via `onDismissTopmost`.
 *
 * Suppressions:
 *   - Cmd+K fires regardless of focus context (matches Claude.ai / Linear).
 *   - Escape ALWAYS fires (input fields use it for their own UX too, e.g.
 *     clearing a search; we just let the dismiss callback decide whether
 *     to act).
 *   - g+letter is suppressed while focus is inside an editable element
 *     (textarea, contenteditable, input) so typing actual words like "go"
 *     does NOT trigger navigation.
 */

const G_PREFIX_TIMEOUT_MS = 1500;

const G_ROUTE_LETTERS: Partial<Record<string, PrimaryArea>> = {
  c: "chat",
  w: "cowork",
  o: "code",
  p: "projects",
  l: "library",
  m: "ops",
  s: "settings",
};

export type ShellKeyboardManagerOptions = {
  /** Called when the user presses Cmd/Ctrl+K. */
  onOpenPalette: () => void;
  /** Called when the user presses Escape and the palette is currently open. */
  onClosePalette?: () => void;
  /** Snapshot of whether the palette is currently open. */
  isPaletteOpen: boolean;
  /**
   * Called when Escape fires and the palette is NOT open. Return true if a
   * dismissible was closed (so we don't double-handle). Return false to allow
   * default behavior (browsers won't do anything by default for Esc).
   */
  onDismissTopmost?: () => boolean;
  /**
   * Called when the user completes a g+letter sequence with a known area.
   * Letters: c=chat w=cowork o=code p=projects l=library m=ops s=settings
   */
  onJumpToArea?: (area: PrimaryArea) => void;
  /** Called when the user presses "?" (Shift+/) to toggle the shortcuts overlay. */
  onToggleShortcuts?: () => void;
};

/** True if the focused element is an editable input the user is typing into. */
function isEditableFocus(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** True if the key combo is the canonical "Cmd+K" / "Ctrl+K" trigger. */
function isCommandPaletteTrigger(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "k") return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  // Reject Cmd+Shift+K, Cmd+Alt+K etc. — keep the trigger pure.
  if (event.shiftKey || event.altKey) return false;
  return true;
}

export function useShellKeyboardManager(options: ShellKeyboardManagerOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const gPrefixActiveRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    // Test environments often mock `document` with a partial shape; bail out
    // when we don't have a real addEventListener instead of crashing tests.
    if (typeof document.addEventListener !== "function") return;

    function clearGPrefix() {
      if (gPrefixActiveRef.current !== null) {
        window.clearTimeout(gPrefixActiveRef.current);
        gPrefixActiveRef.current = null;
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      const opts = optionsRef.current;

      // Cmd+K — open palette. Fires regardless of focus.
      if (isCommandPaletteTrigger(event)) {
        event.preventDefault();
        event.stopPropagation();
        opts.onOpenPalette();
        clearGPrefix();
        return;
      }

      // Escape — palette first, then delegated dismiss.
      if (event.key === "Escape") {
        if (opts.isPaletteOpen && opts.onClosePalette) {
          event.preventDefault();
          event.stopPropagation();
          opts.onClosePalette();
          clearGPrefix();
          return;
        }
        if (opts.onDismissTopmost) {
          const handled = opts.onDismissTopmost();
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
          }
        }
        clearGPrefix();
        return;
      }

      // g+letter route jump — suppressed in editable focus.
      if (isEditableFocus(event.target)) {
        // Still respect a g-prefix that was set while focus was elsewhere —
        // clear it so a stale prefix doesn't survive into typing.
        clearGPrefix();
        return;
      }

      // "?" (Shift+/) — toggle the keyboard-shortcuts overlay. Reached only when
      // focus is NOT in an editable element (handled by the check above).
      if (event.key === "?") {
        if (opts.onToggleShortcuts) {
          event.preventDefault();
          opts.onToggleShortcuts();
        }
        clearGPrefix();
        return;
      }

      // Ignore modified keys so Cmd+G (find next) etc. don't engage navigation.
      if (event.metaKey || event.ctrlKey || event.altKey) {
        clearGPrefix();
        return;
      }

      if (gPrefixActiveRef.current !== null) {
        const letter = event.key.toLowerCase();
        const area = G_ROUTE_LETTERS[letter];
        clearGPrefix();
        if (area && opts.onJumpToArea) {
          event.preventDefault();
          opts.onJumpToArea(area);
        }
        return;
      }

      if (event.key === "g" && !event.shiftKey) {
        event.preventDefault();
        gPrefixActiveRef.current = window.setTimeout(() => {
          gPrefixActiveRef.current = null;
        }, G_PREFIX_TIMEOUT_MS);
      }
    }

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
      clearGPrefix();
    };
  }, []);
}

/** Exposed for the command palette / docs so the shortcut copy stays in sync. */
export const SHELL_ROUTE_SHORTCUT_LETTERS: ReadonlyMap<PrimaryArea, string> = new Map(
  Object.entries(G_ROUTE_LETTERS).map(([letter, area]) => [area as PrimaryArea, letter] as const),
);
