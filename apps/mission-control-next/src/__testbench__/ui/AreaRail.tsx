import type { DomainSummary } from "./filters";

export interface AreaRailProps {
  readonly domains: readonly DomainSummary[];
  readonly selected: string | undefined;
  readonly onSelect: (domain: string | undefined) => void;
}

export function AreaRail({ domains, selected, onSelect }: AreaRailProps) {
  return (
    <nav className="testbench-rail" aria-label="Areas">
      <select
        className="testbench-rail-select"
        aria-label="Area"
        value={selected ?? ""}
        onChange={(event) => onSelect(event.currentTarget.value || undefined)}
      >
        <option value="">All areas</option>
        {domains.map((summary) => (
          <option key={summary.domain} value={summary.domain}>
            {`${summary.label} (${summary.passed}/${summary.total})`}
          </option>
        ))}
      </select>
      <ul className="testbench-rail-list">
        <li>
          <button
            type="button"
            aria-current={selected === undefined ? "true" : undefined}
            onClick={() => onSelect(undefined)}
          >
            <span>All areas</span>
          </button>
        </li>
        {domains.map((summary) => (
          <li key={summary.domain}>
            <button
              type="button"
              aria-current={selected === summary.domain ? "true" : undefined}
              onClick={() => onSelect(summary.domain)}
            >
              <span>{summary.label}</span>
              <span className="testbench-meta">
                {`${summary.failing > 0 ? `✕ ${summary.failing} · ` : ""}${summary.passed}/${summary.total}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
