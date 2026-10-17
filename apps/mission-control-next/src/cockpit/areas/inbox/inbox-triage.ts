import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { INBOX_GROUPS, inboxItemKindLabel } from "./inbox-presentation";
import { hasExpired } from "./use-minute-clock";

type InboxRisk = NonNullable<OperatorInboxItem["riskLevel"]>;

/** Expired decisions leave "Needs decision" but stay visible in their own group, below the others (IN-05). */
export const INBOX_VIEW_GROUPS = [
  ...INBOX_GROUPS,
  { id: "expired", label: "Expired", description: "Decisions whose time ran out; they can no longer be decided" },
] as const;
export type InboxViewGroupId = (typeof INBOX_VIEW_GROUPS)[number]["id"];

/** The visible order, said in words next to the filters (IN-09). */
export const INBOX_SORT_DESCRIPTION = "Sorted by risk, then expiry, then age.";

export interface InboxFilters {
  kind: "all" | OperatorInboxItem["kind"];
  risk: "all" | InboxRisk;
}
export const NO_INBOX_FILTERS: InboxFilters = { kind: "all", risk: "all" };
export const INBOX_RISK_FILTERS: readonly InboxRisk[] = ["nuclear", "danger", "caution", "safe"];

const RISK_RANK: Readonly<Record<InboxRisk, number>> = { nuclear: 4, danger: 3, caution: 2, safe: 1 };

export function inboxViewGroup(item: OperatorInboxItem, now: number): InboxViewGroupId {
  return item.group === "needs_decision" && hasExpired(item.expiresAt, now) ? "expired" : item.group;
}

/** Highest risk first, then the soonest expiry, then the oldest item. */
export function compareInboxItems(a: OperatorInboxItem, b: OperatorInboxItem): number {
  const expiry = (item: OperatorInboxItem) => (item.expiresAt ? Date.parse(item.expiresAt) : Infinity);
  return (
    RISK_RANK[b.riskLevel ?? "safe"] - RISK_RANK[a.riskLevel ?? "safe"] ||
    expiry(a) - expiry(b) ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
}

export function inboxFiltersActive(filters: InboxFilters): boolean {
  return filters.kind !== "all" || filters.risk !== "all";
}

export function matchesInboxFilters(item: OperatorInboxItem, filters: InboxFilters): boolean {
  return (
    (filters.kind === "all" || item.kind === filters.kind) &&
    (filters.risk === "all" || item.riskLevel === filters.risk)
  );
}

/** Kind choices for the loaded items only, so the filter never offers a kind that cannot match. */
export function inboxKindOptions(
  items: readonly OperatorInboxItem[],
): { value: OperatorInboxItem["kind"]; label: string }[] {
  const kinds = [...new Set(items.map((item) => item.kind))];
  return kinds
    .map((kind) => ({ value: kind, label: inboxItemKindLabel(kind) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * A group heading's count. Unfiltered it is the Gateway count (or its lower bound); filtered it says how many of
 * that count are shown, so a filtered heading never reads as the whole group.
 */
export function inboxGroupCountLabel({
  known,
  exact,
  shown,
  filtered,
}: {
  known: number;
  exact: boolean;
  shown: number;
  filtered: boolean;
}): string {
  const total = exact ? String(known) : known > 0 ? `at least ${known}` : "";
  if (filtered) return total ? `${shown} of ${total} shown` : `${shown} shown; not fully checked`;
  if (exact) return String(known);
  return known > 0 ? `At least ${known}` : "Not fully checked";
}
