/**
 * The one cockpit text input, select and textarea look: a 44px touch target, the control border, and a
 * dimmed disabled state. Text is 16px on phones (iOS zooms into smaller inputs) and 14px from `sm`. Spacing around
 * the control belongs to the caller (`Field` already spaces it).
 */
export const cockpitInputClass =
  "block min-h-11 w-full min-w-0 rounded-md border border-line-control bg-canvas px-3 py-2 text-md text-fg sm:text-sm disabled:opacity-60";
