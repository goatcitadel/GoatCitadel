const USABLE_CONTROL =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Whether the element can take focus now: on the page, enabled, shown, and not inside a closed disclosure. */
function canTakeFocus(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(":disabled") || element.closest("[hidden], [inert]")) return false;
  const closed = element.closest("details:not([open])");
  // The summary is what a closed disclosure shows; everything else inside it is not reachable.
  if (closed && !(element.parentElement === closed && element.tagName === "SUMMARY")) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function focusPageStart(): void {
  const target =
    document.querySelector<HTMLElement>("main h1") ??
    document.querySelector<HTMLElement>("h1") ??
    document.querySelector<HTMLElement>("main, [role='main']");
  if (!target) return;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus();
}

/**
 * Hands keyboard focus back after a layer closed or its opener went away. Goes to the control that opened it when it
 * is still on the page and can take focus; otherwise to the first control in the region around it that can; otherwise
 * to the page's main heading, so focus is never left on the page's body.
 */
export function restoreFocus(preferred: HTMLElement | null, region: HTMLElement | null): void {
  if (preferred && canTakeFocus(preferred)) {
    preferred.focus();
    return;
  }
  const fallback = region?.isConnected
    ? [...region.querySelectorAll<HTMLElement>(USABLE_CONTROL)].find(canTakeFocus)
    : undefined;
  if (fallback) fallback.focus();
  else focusPageStart();
}
