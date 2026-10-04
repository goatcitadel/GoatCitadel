import type { KeyboardEvent } from "react";

/**
 * The Enter that confirms an IME composition (Japanese, Chinese or Korean input) must not send
 * or choose anything. Safari clears `isComposing` on that key but still reports keyCode 229.
 */
export function isImeEnter(event: Pick<KeyboardEvent, "keyCode" | "nativeEvent">): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.keyCode === 229;
}
