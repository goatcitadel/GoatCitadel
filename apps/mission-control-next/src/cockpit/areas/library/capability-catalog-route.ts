import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import type { CapabilityStatusFilter } from "@goatcitadel/mission-control-shared/content/capability-rows";
import type { CatalogFilters } from "./capability-catalog";

const STATUSES: readonly CapabilityStatusFilter[] = ["all", "available", "configured", "inspect-only", "degraded", "unavailable"];

export function readCatalogLocation(rest: readonly string[], search: string) {
  const params = new URLSearchParams(search);
  const status = params.get("status");
  const filters: CatalogFilters = {
    search: (params.get("q") ?? "").slice(0, 200),
    kind: params.get("type") || "all",
    status: STATUSES.includes(status as CapabilityStatusFilter) ? status as CapabilityStatusFilter : "all",
    trust: params.get("trust") || "all",
  };
  if (!rest.length) return { filters, selection: null, invalidSelection: false };
  const legacyKind = rest.length === 1 ? ({ skills: "skill", tools: "tool", capabilities: "all" } as Record<string, string>)[rest[0]!] : undefined;
  if (legacyKind) return { filters: { ...filters, kind: legacyKind }, selection: null, invalidSelection: false };
  if (rest.length !== 2) return { filters, selection: null, invalidSelection: true };
  try {
    const kind = decodeURIComponent(rest[0]!);
    const id = decodeURIComponent(rest[1]!);
    return { filters, selection: kind && id ? { kind, id } : null, invalidSelection: !kind || !id };
  } catch {
    return { filters, selection: null, invalidSelection: true };
  }
}

export function catalogHref(filters: CatalogFilters, selected?: Pick<CapabilityCatalogEntry, "kind" | "capabilityId">): string {
  const params = new URLSearchParams({ shell: "cockpit" });
  if (filters.search) params.set("q", filters.search);
  if (filters.kind !== "all") params.set("type", filters.kind);
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.trust !== "all") params.set("trust", filters.trust);
  const pathname = selected ? `/library/${encodeURIComponent(selected.kind)}/${encodeURIComponent(selected.capabilityId)}` : "/library";
  return `${pathname}?${params.toString()}`;
}
