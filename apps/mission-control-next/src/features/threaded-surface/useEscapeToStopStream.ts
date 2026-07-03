import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Wires a document-level, bubble-phase (non-capture) Escape shortcut that stops the
 * active streaming turn — the keyboard mirror of the rail's Stop control and the
 * composer's "Stop turn" button.
 *
 * Deliberately non-capture: ThreadedSurfacePage.tsx registers its own Escape handlers
 * in the CAPTURE phase for dismissing the session-rail drawer and the context/utility
 * dock (see the two `addEventListener("keydown", handler, { capture: true })` calls
 * there). Capture-phase listeners always run before bubble-phase ones (capture always
 * precedes bubble, independent of registration order), and, in this codebase, always
 * call `event.preventDefault()` when they act. Skipping here whenever
 * `event.defaultPrevented` is already true means an open rail drawer or context dock
 * always wins Escape first; this hook only fires when neither of those capture-phase
 * handlers claimed the key first.
 *
 * Other bubble-phase claimants (e.g. the right-panel/workbench "more" menus) are a
 * different story: they register on the SAME phase as this hook, and same-phase
 * listeners on one node fire strictly in registration order — `stopPropagation()`
 * does not suppress sibling listeners on that node, only later propagation to other
 * nodes. So whichever of "menu opens" or "stream starts" happens second registers
 * second, and a synchronous decision here would only be correct for one of the two
 * orderings (see the ordering regression this hook's history references). The fix is
 * to not decide synchronously at all: schedule a microtask that re-reads
 * `event.defaultPrevented` on the same event object after the FULL dispatch (every
 * phase, every listener on every node) has finished. `defaultPrevented` reflects the
 * final state of the event regardless of which listener ran first, so checking it
 * after dispatch makes the outcome ordering-independent. Because the microtask runs
 * after this render's effect body (and possibly after unmount or a dep change), the
 * enabled/onStop closed over here can go stale by the time it fires; `latestRef`
 * carries the most recently committed values so the microtask always acts on live
 * state, and re-checks `enabled` before calling `onStop`.
 */
export function useEscapeToStopStream(input: { enabled: boolean; onStop: () => void }): void {
  const { enabled, onStop } = input;

  const latestRef = useRef({ enabled, onStop });
  useLayoutEffect(() => {
    latestRef.current = { enabled, onStop };
  });

  useEffect(() => {
    if (!enabled || typeof document === "undefined" || typeof document.addEventListener !== "function") {
      return undefined;
    }

    let torndown = false;

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
      // Do not act (and do not preventDefault) yet: some other bubble-phase listener
      // on this same dispatch — registered before OR after this one — may still claim
      // the event. Defer to a microtask so every listener has had its turn before we
      // look at `event.defaultPrevented`. (No point calling preventDefault ourselves
      // here anymore either: dispatch is over by the time we'd act, so it couldn't
      // suppress anything downstream — see the microtask body below.)
      queueMicrotask(() => {
        if (torndown || event.defaultPrevented) {
          return;
        }
        const latest = latestRef.current;
        if (!latest.enabled) {
          return;
        }
        latest.onStop();
      });
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      torndown = true;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, onStop]);
}
