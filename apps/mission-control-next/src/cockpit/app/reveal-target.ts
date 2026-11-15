/**
 * Brings what an "open" action opened into view and puts keyboard focus on it, so keyboard and screen reader users land
 * where the page moved to. `first-field` focuses the first control inside the target; `self` focuses the target itself,
 * which then needs `tabIndex={-1}`. Returns false when there is no element to reveal.
 */
export function revealTarget(element: HTMLElement | null, focus: "first-field" | "self" = "first-field"): boolean {
  if (!element) return false;
  element.scrollIntoView?.({ block: "start" });
  const focusable = focus === "self" ? element : element.querySelector<HTMLElement>("input, select, textarea, button");
  focusable?.focus({ preventScroll: true });
  return true;
}
