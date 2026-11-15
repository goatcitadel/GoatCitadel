import { useRef } from "react";
import { useCockpitNavigation } from "../../app/cockpit-navigation-context";

/** How long a press may wait for its address to land before the panel opens; later opens are not that press. */
export const PRESS_WINDOW_MS = 2000;

/** The press the operator made: which panel it was for, and when. */
export interface Press {
  key: string;
  at: number;
}

/** Pure rules, so they are testable without a page: a press counts for its own key, once, inside the window. */
export function takePress(press: Press | null, key: string, now: number): { took: boolean; press: Press | null } {
  if (!press) return { took: false, press: null };
  if (now - press.at >= PRESS_WINDOW_MS) return { took: false, press: null };
  if (press.key !== key) return { took: false, press };
  return { took: true, press: null };
}

/**
 * Remembers that the operator just pressed a row to open one panel (`key` names it, as its inspector source does). The
 * press often only moves the address, and the panel opens once that address has landed, so the open of that same panel
 * that follows takes focus (once). An open of another panel, or from an address alone (a reload, a chip that writes
 * the address), does not.
 */
export function useDeliberateOpen() {
  const pressed = useRef<Press | null>(null);
  const { isTransitionPending } = useCockpitNavigation();
  const api = useRef({
    /** Call where the operator's press starts an open of the panel `key`. */
    press(key: string) {
      pressed.current = { key, at: Date.now() };
    },
    /** The press moved nowhere (the leave review declined it): it is not waiting for a panel any more. */
    clear() {
      pressed.current = null;
    },
    /** Call where the panel `key` opens: whether this open is the pressed one. Reading it uses it up. */
    take(key: string): boolean {
      const result = takePress(pressed.current, key, Date.now());
      pressed.current = result.press;
      return result.took;
    },
  });
  const pending = useRef(isTransitionPending);
  pending.current = isTransitionPending;
  /** Presses `key` and moves the address; a move that went nowhere and is not under review ends the press. */
  const go = useRef((key: string, navigate: () => void) => {
    api.current.press(key);
    const before = window.location.href;
    navigate();
    if (window.location.href === before && !pending.current()) api.current.clear();
  });
  return { ...api.current, go: go.current };
}
