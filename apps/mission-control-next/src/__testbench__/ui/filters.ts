import { domainOfUrl, splitRouteKey } from "../runner/routes";
import { recordFor, type CheckRunStatus, type RunState, type StatusCounts } from "../runner/state";
import type { CheckDef, CheckTier, RouteKey } from "../runner/types";

export type StatusFilter = "all" | "failing" | "blocked" | "skipped" | "not-run";

export interface CheckFilters {
  readonly status: StatusFilter;
  readonly tiers: ReadonlySet<CheckTier>;
  readonly query: string;
  readonly domain: string | undefined;
}

export interface DomainSummary {
  readonly domain: string;
  readonly label: string;
  readonly total: number;
  readonly passed: number;
  readonly failing: number;
}

export const DEFAULT_FILTERS: CheckFilters = {
  status: "all",
  tiers: new Set<CheckTier>(),
  query: "",
  domain: undefined,
};

const STATUS_FILTER_MATCHES: Readonly<Record<Exclude<StatusFilter, "all">, readonly CheckRunStatus[]>> = {
  failing: ["fail"],
  blocked: ["blocked"],
  skipped: ["skipped"],
  "not-run": ["not-run", "cancelled"],
};

export function filterChecks(checks: readonly CheckDef[], state: RunState, filters: CheckFilters): CheckDef[] {
  const query = filters.query.trim().toLowerCase();
  return checks.filter((check) => {
    if (filters.domain !== undefined && check.domain !== filters.domain) {
      return false;
    }
    if (filters.tiers.size > 0 && !filters.tiers.has(check.tier)) {
      return false;
    }
    if (
      filters.status !== "all" &&
      !STATUS_FILTER_MATCHES[filters.status].includes(recordFor(state, check.id).status)
    ) {
      return false;
    }
    return (
      query === "" ||
      check.title.toLowerCase().includes(query) ||
      check.routes.some((route) => route.toLowerCase().includes(query))
    );
  });
}

export function countForFilter(counts: StatusCounts, filter: Exclude<StatusFilter, "all">): number {
  return STATUS_FILTER_MATCHES[filter].reduce((sum, status) => sum + counts[status], 0);
}

export function toggleTier(tiers: ReadonlySet<CheckTier>, tier: CheckTier): ReadonlySet<CheckTier> {
  return tiers.has(tier) ? new Set([...tiers].filter((existing) => existing !== tier)) : new Set([...tiers, tier]);
}

export function summarizeDomains(
  checks: readonly CheckDef[],
  state: RunState,
  labelFor: (domain: string) => string,
): DomainSummary[] {
  const byDomain = new Map<string, readonly CheckDef[]>();
  for (const check of checks) {
    byDomain.set(check.domain, [...(byDomain.get(check.domain) ?? []), check]);
  }
  return [...byDomain.entries()]
    .map(([domain, list]) => ({
      domain,
      label: labelFor(domain),
      total: list.length,
      passed: list.filter((check) => recordFor(state, check.id).status === "pass").length,
      failing: list.filter((check) => recordFor(state, check.id).status === "fail").length,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function groupRoutesByDomain(routes: readonly RouteKey[]): Array<readonly [string, readonly RouteKey[]]> {
  const groups = new Map<string, readonly RouteKey[]>();
  for (const route of routes) {
    const domain = domainOfUrl(splitRouteKey(route).url);
    groups.set(domain, [...(groups.get(domain) ?? []), route]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}
