import { forwardRef, type KeyboardEvent, type ReactNode } from "react";

export type FilterPillProps = {
  /** Visible label for the pill (e.g. "all", "knowledge"). */
  label: ReactNode;
  /** Optional numeric count rendered to the right of the label. */
  count?: number;
  /** Whether this pill is the currently selected filter. */
  selected: boolean;
  /** Tab index for roving keyboard focus inside a tablist. */
  tabIndex: number;
  /** Stable id used by the parent tablist for keyboard wiring. */
  id?: string;
  /** Click handler — invoked when activated via mouse, Enter, or Space. */
  onSelect: () => void;
  /** Keyboard handler — forwarded so the parent tablist can implement Arrow/Home/End navigation. */
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** Accessible label override when the visible label is not descriptive enough. */
  ariaLabel?: string;
};

/**
 * Toggleable filter pill rendered inside a `role="tablist"` group.
 * Visual reference: `apps/mission-control-next/mockups/memory.html` namespace pills.
 * Pairs with a parent `FilterPillGroup` (the tablist owner) that coordinates
 * keyboard navigation across pills.
 */
export const FilterPill = forwardRef<HTMLButtonElement, FilterPillProps>(function FilterPill(
  { label, count, selected, tabIndex, id, onSelect, onKeyDown, ariaLabel },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={id}
      aria-selected={selected}
      tabIndex={tabIndex}
      className={`mc-next-filter-pill${selected ? " is-selected" : ""}`}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      aria-label={ariaLabel}
    >
      <span className="mc-next-filter-pill-label">{label}</span>
      {typeof count === "number" ? <span className="mc-next-filter-pill-count">{count}</span> : null}
    </button>
  );
});
