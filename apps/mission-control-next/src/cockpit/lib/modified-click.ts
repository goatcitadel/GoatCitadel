import type { MouseEvent } from "react";

/**
 * True when a link click should be left to the browser: a non-primary button, a modifier key (new tab, new window,
 * download), or a target/download attribute. In-app navigation must only intercept plain primary clicks.
 */
export function isModifiedClick(
  event: MouseEvent<HTMLElement>,
  anchor?: { target?: string; download?: unknown },
): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    Boolean(anchor?.target && anchor.target !== "_self") ||
    anchor?.download !== undefined
  );
}
