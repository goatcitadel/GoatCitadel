import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import type { CapabilityStatusFilter } from "@goatcitadel/mission-control-shared/content/capability-rows";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { CatalogFilters } from "./capability-catalog";

const STATUS_OPTIONS: readonly { value: CapabilityStatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "available", label: "Available" },
  { value: "configured", label: "Configured" },
  { value: "inspect-only", label: "Inspect only" },
  { value: "degraded", label: "Degraded" },
  { value: "unavailable", label: "Unavailable" },
];

export function CapabilityCatalogFilters({
  filters: { search, kind, status, trust },
  kinds,
  trustLabels,
  callableKnown,
  setFilters,
}: {
  filters: CatalogFilters;
  kinds: readonly CapabilityCatalogEntry["kind"][];
  trustLabels: readonly string[];
  callableKnown: boolean;
  setFilters: (updates: Partial<CatalogFilters>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <label className="col-span-2 text-sm text-fg-muted lg:col-span-1">
        Search
        <input
          value={search}
          maxLength={200}
          onChange={(event) => setFilters({ search: event.target.value })}
          placeholder="Find a capability"
          className="mt-1 min-h-11 w-full rounded-md border border-line-control bg-raised px-2 text-base text-fg"
        />
      </label>
      <label className="text-sm text-fg-muted">
        Type
        <select
          value={kind}
          onChange={(event) => setFilters({ kind: event.target.value })}
          className="mt-1 min-h-11 w-full rounded-md border border-line-control bg-raised px-2 text-base text-fg"
        >
          <option value="all">All types</option>
          {kind !== "all" && !kinds.includes(kind as CapabilityCatalogEntry["kind"]) ? (
            <option value={kind}>Type unavailable</option>
          ) : null}
          {kinds.map((value) => (
            <option key={value} value={value}>
              {humanizeToken(value)}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm text-fg-muted">
        Status
        <select
          value={callableKnown ? status : "all"}
          onChange={(event) => setFilters({ status: event.target.value as CapabilityStatusFilter })}
          disabled={!callableKnown}
          className="mt-1 min-h-11 w-full rounded-md border border-line-control bg-raised px-2 text-base text-fg disabled:opacity-60"
        >
          {callableKnown ? (
            STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))
          ) : (
            <option value="all">Status unavailable</option>
          )}
        </select>
      </label>
      <label className="text-sm text-fg-muted">
        Trust
        <select
          value={trust}
          onChange={(event) => setFilters({ trust: event.target.value })}
          className="mt-1 min-h-11 w-full rounded-md border border-line-control bg-raised px-2 text-base text-fg"
        >
          <option value="all">All trust levels</option>
          {trust !== "all" && !trustLabels.includes(trust) ? (
            <option value={trust}>Trust label unavailable</option>
          ) : null}
          {trustLabels.map((value) => (
            <option key={value} value={value}>
              {value === "unlabeled" ? "Not labeled" : humanizeToken(value)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
