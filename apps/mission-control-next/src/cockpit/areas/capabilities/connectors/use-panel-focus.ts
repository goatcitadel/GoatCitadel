import { useLayoutEffect, useRef, type RefObject } from "react";

/** A connector panel's root, the flow's button in it, and its header, where focus can land when nothing else fits. */
const PANEL = "[data-connector-panel]";
const PRIMARY = "[data-flow-primary]";
const LANDING = "[data-focus-landing]";

function focusLost() {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/**
 * Keeps keyboard focus in a connector panel whose controls come and go as an install flow moves on: Stop, Dismiss and
 * Finish signing in disappear once they have done their work, and the install panel turns into the saved server's view
 * when the install is done. Call it in a component that re-renders when the flow changes, with a ref to an element in
 * the panel. When focus was inside the panel before a change and the change took the focused control away, focus moves
 * to the flow's button, or to the panel's header (`prefer: "landing"`, or when there is no button). Focus anywhere else
 * on the page is left alone.
 */
export function usePanelFocus(anchor: RefObject<HTMLElement | null>, prefer: "primary" | "landing") {
  const hadFocus = useRef(false);
  // Read while rendering, before the change reaches the page, as the inspector reads the control that opened it.
  const panel = anchor.current?.closest(PANEL);
  hadFocus.current = Boolean(panel?.contains(document.activeElement));
  useLayoutEffect(() => {
    if (!hadFocus.current || !focusLost()) return;
    const root = anchor.current?.closest(PANEL);
    const primary = root?.querySelector<HTMLElement>(PRIMARY);
    const landing = root?.querySelector<HTMLElement>(LANDING);
    (prefer === "landing" ? (landing ?? primary) : (primary ?? landing))?.focus();
  });
}
