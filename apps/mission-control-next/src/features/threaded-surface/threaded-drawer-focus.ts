/**
 * Escape belongs to the disclosure that currently owns focus. On wide
 * desktops both panels can be open, so a document-level listener must not
 * close Threads while the operator is working in Activity (or vice versa).
 */
export function panelOwnsActiveFocus(panel: Pick<HTMLElement, "contains"> | null, activeElement: Node | null): boolean {
  return panel === null || panel.contains(activeElement);
}

/**
 * Return the controls that are actually reachable in a modal drawer. Native
 * summaries are focusable, while controls inside a closed <details> element
 * are not; both facts matter when we calculate the Tab boundary ourselves.
 */
export function getDrawerFocusableElements(modalPanel: HTMLElement): HTMLElement[] {
  return Array.from(
    modalPanel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => {
    if (element.tabIndex < 0 || element.closest('[hidden], [aria-hidden="true"], [inert]')) {
      return false;
    }
    const closedDetails = element.closest("details:not([open])");
    return !closedDetails || (element.tagName === "SUMMARY" && element.parentElement === closedDetails);
  });
}

export function resolveDrawerTabTarget({
  activeElement,
  focusable,
  modalPanel,
  shiftKey,
}: {
  activeElement: Node | null;
  focusable: readonly HTMLElement[];
  modalPanel: HTMLElement;
  shiftKey: boolean;
}): HTMLElement | null {
  if (focusable.length === 0) {
    return modalPanel;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const activeIndex = focusable.indexOf(activeElement as HTMLElement);

  // The context sheet deliberately receives focus first. Without this branch,
  // Shift+Tab immediately walks back to the underlying page instead of the
  // dialog's final control. It also recovers focus if a browser extension,
  // stale DOM selection, or a just-closed <details> leaves focus somewhere
  // that is not part of the current focus order.
  if (activeElement === modalPanel || !modalPanel.contains(activeElement) || activeIndex === -1) {
    return shiftKey ? last : first;
  }
  if (shiftKey && activeIndex === 0) {
    return last;
  }
  if (!shiftKey && activeIndex === focusable.length - 1) {
    return first;
  }
  return null;
}
