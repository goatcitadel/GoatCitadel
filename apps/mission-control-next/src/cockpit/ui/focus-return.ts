const USABLE_CONTROL =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Hands keyboard focus back after a layer closed or its opener went away. Goes to the control that opened it when it
 * is still on the page and usable; otherwise to the first usable control in the region around it; otherwise nowhere,
 * so a focus the operator already moved is never overridden by a guess.
 */
export function restoreFocus(preferred: HTMLElement | null, region: HTMLElement | null): void {
  if (preferred?.isConnected && !preferred.matches(":disabled")) {
    preferred.focus();
    return;
  }
  if (!region?.isConnected) return;
  region.querySelector<HTMLElement>(USABLE_CONTROL)?.focus();
}
