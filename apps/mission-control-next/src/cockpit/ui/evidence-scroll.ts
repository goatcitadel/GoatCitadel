import type { KeyboardEvent } from "react";

/** Keep boundary keys in a focused evidence scroller instead of scrolling its enclosing dialog. */
export function handleEvidenceScrollKeyDown(event: KeyboardEvent<HTMLElement>) {
  const region = event.currentTarget;
  if (
    event.defaultPrevented ||
    event.target !== region ||
    region.ownerDocument.activeElement !== region ||
    region.isContentEditable ||
    event.nativeEvent.isComposing ||
    event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
    (event.key !== "Home" && event.key !== "End")
  ) return;

  // Native Home/End can scroll the ancestor even while this region retains focus.
  // Leave all other keys and nested controls native; move only this region, without animation.
  event.preventDefault();
  region.scrollTo({
    top: event.key === "Home" ? 0 : Math.max(0, region.scrollHeight - region.clientHeight),
    behavior: "instant",
  });
}
