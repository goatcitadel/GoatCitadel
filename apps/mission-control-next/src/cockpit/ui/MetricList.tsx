import type { ReactNode } from "react";

export interface Metric {
  term: string;
  value: ReactNode;
  /** A short qualifier under the value, for example "at least" or "last 7 days". */
  hint?: ReactNode;
}

/**
 * Numbers as an inline definition list (DESIGN.md › Page anatomy) instead of hero tiles: a page leads with a sentence
 * that says what the numbers mean, then this list. Values use tabular figures so they line up.
 */
export function MetricList({ items, label }: { items: readonly Metric[]; label?: string }) {
  return (
    <dl aria-label={label} className="flex flex-wrap gap-x-8 gap-y-3">
      {items.map((item) => (
        <div key={item.term} className="min-w-0">
          <dt className="text-xs text-fg-muted">{item.term}</dt>
          <dd className="text-base font-semibold tabular-nums text-fg">{item.value}</dd>
          {item.hint ? <dd className="text-xs text-fg-muted">{item.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
