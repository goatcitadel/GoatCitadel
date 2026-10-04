import type { StatusCounts } from "../runner/state";
import type { CheckTier } from "../runner/types";
import { countForFilter, toggleTier, type CheckFilters, type StatusFilter } from "./filters";

const STATUS_FILTERS: ReadonlyArray<{ readonly value: StatusFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "failing", label: "✕ Failing" },
  { value: "blocked", label: "◐ Blocked" },
  { value: "skipped", label: "– Skipped" },
  { value: "not-run", label: "○ Not run" },
];

const TIERS: readonly CheckTier[] = ["read", "mutate", "host", "external"];

export interface FilterBarProps {
  readonly filters: CheckFilters;
  readonly counts: StatusCounts;
  readonly onChange: (filters: CheckFilters) => void;
}

export function FilterBar({ filters, counts, onChange }: FilterBarProps) {
  return (
    <div className="testbench-filters" role="group" aria-label="Filters">
      {STATUS_FILTERS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="testbench-chip"
          aria-pressed={filters.status === option.value}
          onClick={() => onChange({ ...filters, status: option.value })}
        >
          {option.value === "all" ? option.label : `${option.label} ${countForFilter(counts, option.value)}`}
        </button>
      ))}
      <span className="testbench-divider" aria-hidden="true" />
      {TIERS.map((tier) => (
        <button
          key={tier}
          type="button"
          className="testbench-chip"
          aria-pressed={filters.tiers.has(tier)}
          onClick={() => onChange({ ...filters, tiers: toggleTier(filters.tiers, tier) })}
        >
          {tier}
        </button>
      ))}
      <input
        className="testbench-search"
        type="search"
        placeholder="Search checks and routes"
        aria-label="Search checks and routes"
        value={filters.query}
        onChange={(event) => onChange({ ...filters, query: event.currentTarget.value })}
      />
    </div>
  );
}
