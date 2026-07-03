import { useEffect } from "react";

/**
 * Wires a document-level, bubble-phase (non-capture) Escape shortcut that stops the
 * active streaming turn — the keyboard mirror of the rail's Stop control and the
 * composer's "Stop turn" button.
 *
 * Deliberately non-capture: ThreadedSurfacePage.tsx registers its own Escape handlers
 * in the CAPTURE phase for dismissing the session-rail drawer and the context/utility
 * dock (see the two `addEventListener("keydown", handler, { capture: true })` calls
 * there). Capture-phase listeners run before bubble-phase ones and, in this codebase,
 * always call `event.preventDefault()` when they act. Registering this hook's listener
 * on the bubble phase — and skipping when `event.defaultPrevented` is already true —
 * means an open rail drawer or context dock always wins Escape first; this hook only
 * fires when neither of those capture-phase handlers claimed the key first.
 */
export function useEscapeToStopStream(input: { enabled: boolean; onStop: () => void }): void {
  const { enabled, onStop } = input;

  useEffect(() => {
    if (!enabled || typeof document === "undefined" || typeof document.addEventListener !== "function") {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      const target = event.target as { closest?: (selector: string) => Element | null } | null;
      if (target?.closest?.('[role="dialog"]')) {
        return;
      }
      onStop();
      event.preventDefault();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onStop]);
}
