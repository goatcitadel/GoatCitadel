import { clsx } from "clsx";

/**
 * ResultCount — the visible "Showing N of M" affordance for truncated or
 * filtered lists. Operator lists across the app cap with `slice(0, N)` and
 * silently drop the remainder, so a partial list is indistinguishable from a
 * complete one. This makes truncation legible (and announces the count to
 * assistive tech via an aria-live region), with an optional "View all" action.
 *
 * Standardizes the two prior one-offs: the visible count text
 * (TrustPolicySection's `.mc-next-settings-field-note`) and the sr-only
 * aria-live count (MemoryRoutePage).
 */
export interface ResultCountProps {
  /** How many items are currently rendered. */
  shown: number;
  /** How many items exist in total. */
  total: number;
  /** Plural noun for the items, e.g. "rows", "skills". Default "items". */
  noun?: string;
  /** Optional "View all" affordance, shown only when the list is truncated. */
  onViewAll?: () => void;
  viewAllLabel?: string;
  className?: string;
}

export function ResultCount({
  shown,
  total,
  noun = "items",
  onViewAll,
  viewAllLabel = "View all",
  className,
}: ResultCountProps) {
  const truncated = shown < total;
  const text = truncated
    ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`
    : `${total.toLocaleString()} ${noun}`;
  return (
    <p className={clsx("mc-next-result-count", className)}>
      <span aria-live="polite" aria-atomic="true">
        {text}
      </span>
      {truncated && onViewAll ? (
        <button type="button" className="mc-next-result-count-action" onClick={onViewAll}>
          {viewAllLabel}
        </button>
      ) : null}
    </p>
  );
}
