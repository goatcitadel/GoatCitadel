import { useRef } from "react";

/** How long a press may wait for its address to land before the panel opens; later opens are not that press. */
const PRESS_WINDOW_MS = 2000;

/**
 * Remembers that the operator just pressed a row to open a panel. The press often only moves the address, and the panel
 * opens once that address has landed, so the open that follows takes focus (once) and an open that comes from an
 * address alone (a reload, a tab or chip that writes the address) does not.
 */
export function useDeliberateOpen() {
  const pressedAt = useRef(0);
  const api = useRef({
    /** Call where the operator's press starts an open. */
    press() {
      pressedAt.current = Date.now();
    },
    /** Call where the panel opens: whether this open is the pressed one. Reading it uses it up. */
    take(): boolean {
      const pressed = Date.now() - pressedAt.current < PRESS_WINDOW_MS;
      pressedAt.current = 0;
      return pressed;
    },
  });
  return api.current;
}
