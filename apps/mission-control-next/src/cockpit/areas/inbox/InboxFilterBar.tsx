import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { presentRiskLevel } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import {
  INBOX_RISK_FILTERS,
  INBOX_SORT_DESCRIPTION,
  inboxFiltersActive,
  inboxKindOptions,
  NO_INBOX_FILTERS,
  type InboxFilters,
} from "./inbox-triage";

const SELECT_CLASS = "mt-1 h-8 rounded-md border border-line-control bg-canvas px-2 text-sm text-fg";

/**
 * Kind and risk filters over the items this page has loaded, the visible sort order, and how many loaded items
 * the filters show (IN-09). Filtering never claims to search items the Inbox did not load.
 */
export function InboxFilterBar({
  items,
  shownCount,
  filters,
  onChange,
}: {
  items: readonly OperatorInboxItem[];
  shownCount: number;
  filters: InboxFilters;
  onChange: (filters: InboxFilters) => void;
}) {
  const kinds = inboxKindOptions(items);
  const active = inboxFiltersActive(filters);
  return (
    <div className="grid gap-2 text-sm text-fg-secondary">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs text-fg-muted">
          Kind
          <select
            aria-label="Filter loaded items by kind"
            value={filters.kind}
            onChange={(event) => onChange({ ...filters, kind: event.target.value as InboxFilters["kind"] })}
            className={`block ${SELECT_CLASS}`}
          >
            <option value="all">All kinds</option>
            {kinds.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-fg-muted">
          Risk
          <select
            aria-label="Filter loaded items by risk"
            value={filters.risk}
            onChange={(event) => onChange({ ...filters, risk: event.target.value as InboxFilters["risk"] })}
            className={`block ${SELECT_CLASS}`}
          >
            <option value="all">Any risk</option>
            {INBOX_RISK_FILTERS.map((risk) => (
              <option key={risk} value={risk}>
                {presentRiskLevel(risk).label}
              </option>
            ))}
          </select>
        </label>
        {active ? (
          <Button size="sm" onClick={() => onChange(NO_INBOX_FILTERS)}>
            Clear filters
          </Button>
        ) : null}
      </div>
      <p data-inbox-filter-summary tabIndex={-1} className="text-xs text-fg-muted">
        {active
          ? `${shownCount} of ${plural(items.length, "loaded item")} shown. ${INBOX_SORT_DESCRIPTION}`
          : INBOX_SORT_DESCRIPTION}
      </p>
    </div>
  );
}
