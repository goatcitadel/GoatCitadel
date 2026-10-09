import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Virtuoso } from "react-virtuoso";
import { Library, RefreshCw } from "lucide-react";
import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import { fetchEffectivePermissionProfile } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { deriveCapabilityStatus, presentCapabilityDescription, presentCapabilityStatus, presentCapabilityTitle, type CapabilityStatusFilter } from "@goatcitadel/mission-control-shared/content/capability-rows";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { Sheet } from "../../ui/Sheet";
import { StatusBadge } from "../../ui/StatusBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/Tabs";
import { CapabilityPolicyEvidence, CapabilitySourceEvidence, readWorkspacePolicyEvidence, type WorkspacePolicyEvidence } from "./CapabilityEvidence";
import { CapabilityPolicyInspector } from "./CapabilityPolicyInspector";
import { CapabilitySettings } from "./CapabilitySettings";
import { CapabilityLastUsed, CapabilityUsageEvidence } from "./CapabilityUsageEvidence";
import { capabilityUsage, filterCapabilities, loadCapabilityCatalog, type CapabilityCatalogView, type CapabilityUsage } from "./capability-catalog";
import { catalogHref, readCatalogLocation } from "./capability-catalog-route";
import { AREA_COLUMN } from "../../ui/area-layout";

const STATUS_OPTIONS: readonly { value: CapabilityStatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "available", label: "Available" },
  { value: "configured", label: "Configured" },
  { value: "inspect-only", label: "Inspect only" },
  { value: "degraded", label: "Degraded" },
  { value: "unavailable", label: "Unavailable" },
];
const EMPTY_ITEMS: CapabilityCatalogEntry[] = [];

function CatalogDetail({ item, callableKnown, usage, skillsKnown, skill, workspaceId, workspacePolicy, workspacePolicyState, onRefresh }: {
  item: CapabilityCatalogEntry;
  callableKnown: boolean;
  usage: CapabilityUsage;
  skillsKnown: boolean;
  skill?: CapabilityCatalogView["skillsById"][string];
  workspaceId: string;
  workspacePolicy: WorkspacePolicyEvidence | null;
  workspacePolicyState: "loading" | "unavailable" | "ready";
  onRefresh: () => void;
}) {
  const status = deriveCapabilityStatus(item);
  const presented = callableKnown ? presentCapabilityStatus(item) : { label: "Callability unknown", tone: "neutral" as const };
  return <div className="space-y-4">
    <p className="text-sm leading-relaxed text-fg-secondary">{presentCapabilityDescription(item)}</p>
    <div className="flex flex-wrap gap-2">
      <StatusBadge status={presented} />
      <span className="rounded-full border border-line px-2 py-0.5 text-xs text-fg-muted">{humanizeToken(item.kind)}</span>
      <span className="rounded-full border border-line px-2 py-0.5 text-xs text-fg-muted">{item.trustLabel ? humanizeToken(item.trustLabel) : "Trust not labeled"}</span>
    </div>
    <Tabs defaultValue="overview">
      <TabsList className="justify-between" aria-label="Capability details">
        {(["overview", "policy", "usage", "source", "settings"] as const).map((tab) => <TabsTrigger className="whitespace-nowrap px-1 text-xs" key={tab} value={tab}>{humanizeToken(tab)}</TabsTrigger>)}
      </TabsList>
      <TabsContent value="overview" className="space-y-2 py-3 text-sm text-fg-secondary">
        <p>{callableKnown ? status.reason : "The callable catalog is unavailable. Refresh before relying on this status."}</p>
        <p>Category: {humanizeToken(item.category)}</p>
        {item.reviewWarning ? <p role="alert" className="text-status-waiting">{item.reviewWarning}</p> : null}
      </TabsContent>
      <TabsContent value="policy" className="space-y-2 py-3 text-sm text-fg-secondary">
        <CapabilityPolicyEvidence item={item} callableKnown={callableKnown} workspacePolicy={workspacePolicy} workspacePolicyState={workspacePolicyState} />
        <CapabilityPolicyInspector key={JSON.stringify([workspaceId, item.toolName])} workspaceId={workspaceId} toolName={item.toolName} />
      </TabsContent>
      <TabsContent value="usage" className="py-3 text-sm text-fg-secondary">
        <CapabilityUsageEvidence usage={usage} />
      </TabsContent>
      <TabsContent value="source" className="space-y-2 py-3 text-sm text-fg-secondary">
        <CapabilitySourceEvidence item={item} />
      </TabsContent>
      <TabsContent value="settings" className="space-y-3 py-3 text-sm text-fg-secondary">
        <CapabilitySettings item={item} skillsKnown={skillsKnown} skill={skill} onRefresh={onRefresh} />
      </TabsContent>
    </Tabs>
  </div>;
}

export function CapabilityCatalog() {
  const route = useCockpitRoute();
  const location = readCatalogLocation(route.rest, route.search);
  const { search, kind, status, trust } = location.filters;
  const setFilters = (updates: Partial<typeof location.filters>) => route.navigate(catalogHref({ ...location.filters, ...updates }), { replace: true });
  const catalog = useQuery({ queryKey: queryKeys.capabilities(), queryFn: loadCapabilityCatalog });
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const workspacePolicyQuery = useQuery({
    queryKey: ["approvals", "workspace-tools-profile", workspaceId],
    queryFn: () => fetchEffectivePermissionProfile({ workspaceId, surface: "tools" }),
    enabled: !catalog.isError && Boolean(catalog.data),
    refetchInterval: 60_000,
  });
  const isPhone = useMediaQuery(RESPONSIVE_QUERIES.phone);
  const view = catalog.isError ? undefined : catalog.data;
  const items = view?.items ?? EMPTY_ITEMS;
  const callableKnown = view?.callableKnown ?? false;
  const kinds = useMemo(() => [...new Set(items.map((item) => item.kind))].sort(), [items]);
  const trustLabels = useMemo(() => [...new Set(items.map((item) => item.trustLabel ?? "unlabeled"))].sort(), [items]);
  const filtered = useMemo(() => filterCapabilities(items, {
    search, kind, status: callableKnown ? status : "all", trust,
  }), [items, search, kind, status, trust, callableKnown]);
  const selected = location.invalidSelection ? null : location.selection
    ? filtered.find((item) => item.capabilityId === location.selection!.id && item.kind === location.selection!.kind) ?? null
    : filtered[0] ?? null;
  const missingSelection = location.invalidSelection || Boolean(location.selection && !selected);
  const selectedUsage = selected && view ? capabilityUsage(selected, view) : { status: "unavailable" as const };
  const selectedSkill = selected?.skillId ? view?.skillsById[selected.skillId] : undefined;
  const workspacePolicy = !workspacePolicyQuery.isError ? readWorkspacePolicyEvidence(workspacePolicyQuery.data, workspaceId) : null;
  const workspacePolicyState = workspacePolicyQuery.isPending ? "loading" : workspacePolicy ? "ready" : "unavailable";

  return <section className={`${AREA_COLUMN} flex h-full min-h-0 flex-col gap-3 p-4 sm:p-6`}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-display text-xl font-semibold text-fg">Skills and tools</h1>
        <p className="text-sm text-fg-secondary">Inspect skills, tools, and other capabilities from the Gateway catalog.</p>
      </div>
      <Button size="sm" onClick={() => { void catalog.refetch(); void workspacePolicyQuery.refetch(); }} disabled={catalog.isFetching || workspacePolicyQuery.isFetching}>
        <RefreshCw aria-hidden="true" className="size-4" /> Refresh
      </Button>
    </header>
    {view?.issues.map((issue) => <p key={issue} role="alert" className="rounded-md border border-status-waiting/40 p-2 text-sm text-fg-secondary">{issue}</p>)}
    {catalog.isLoading ? <p role="status" className="text-sm text-fg-muted">Loading catalog…</p> : null}
    {catalog.isError ? <EmptyState title="Library unavailable" description={describeApiError(catalog.error).summary} action={<Button onClick={() => void catalog.refetch()}>Try again</Button>} /> : null}
    {view ? <>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <label className="col-span-2 text-xs text-fg-muted lg:col-span-1">Search
          <input value={search} maxLength={200} onChange={(event) => setFilters({ search: event.target.value })} placeholder="Find a capability" className="mt-1 h-9 w-full rounded-md border border-line bg-raised px-2 text-base text-fg" />
        </label>
        <label className="text-xs text-fg-muted">Type
          <select value={kind} onChange={(event) => setFilters({ kind: event.target.value })} className="mt-1 h-9 w-full rounded-md border border-line bg-raised px-2 text-base text-fg">
            <option value="all">All types</option>
            {kind !== "all" && !kinds.includes(kind as CapabilityCatalogEntry["kind"]) ? <option value={kind}>Type unavailable</option> : null}
            {kinds.map((value) => <option key={value} value={value}>{humanizeToken(value)}</option>)}
          </select>
        </label>
        <label className="text-xs text-fg-muted">Status
          <select value={callableKnown ? status : "all"} onChange={(event) => setFilters({ status: event.target.value as CapabilityStatusFilter })} disabled={!callableKnown} className="mt-1 h-9 w-full rounded-md border border-line bg-raised px-2 text-base text-fg disabled:opacity-60">
            {callableKnown ? STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>) : <option value="all">Status unavailable</option>}
          </select>
        </label>
        <label className="text-xs text-fg-muted">Trust
          <select value={trust} onChange={(event) => setFilters({ trust: event.target.value })} className="mt-1 h-9 w-full rounded-md border border-line bg-raised px-2 text-base text-fg">
            <option value="all">All trust levels</option>
            {trust !== "all" && !trustLabels.includes(trust) ? <option value={trust}>Trust label unavailable</option> : null}
            {trustLabels.map((value) => <option key={value} value={value}>{value === "unlabeled" ? "Not labeled" : humanizeToken(value)}</option>)}
          </select>
        </label>
      </div>
      <p role="status" className="text-xs text-fg-muted">{filtered.length} of {items.length} capabilities shown. Usage dates appear only when recorded; inspect a capability for availability and provenance.{view.issues.length ? " · partial catalog" : ""}</p>
      {missingSelection ? <EmptyState title="Capability unavailable" description="The linked capability is not in this catalog view. Refresh its owner evidence or return to the catalog."
        action={<Button size="sm" onClick={() => route.navigate(catalogHref(location.filters), { replace: true })}>Return to catalog</Button>} /> : null}
      {filtered.length ? <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-raised">
          <Virtuoso data={filtered} className="h-full w-full" itemContent={(_index, item) => {
            const presented = callableKnown ? presentCapabilityStatus(item) : { label: "Callability unknown", tone: "neutral" as const };
            const usage = capabilityUsage(item, view);
            return <button type="button" key={item.capabilityId} onClick={() => route.navigate(catalogHref(location.filters, item))}
              aria-current={selected?.capabilityId === item.capabilityId ? "true" : undefined}
              className="flex w-full items-center gap-3 border-b border-line-subtle p-3 text-left hover:bg-sunken aria-[current=true]:bg-sunken">
              <Library aria-hidden="true" className="size-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">{presentCapabilityTitle(item)}</span>
                <span className="block truncate text-xs text-fg-muted">{presentCapabilityDescription(item)}</span>
                {usage.status === "recorded" ? <span className="block truncate text-xs text-fg-muted"><CapabilityLastUsed usage={usage} /></span> : null}
              </span>
              {item.trustLabel ? <span className="hidden text-xs text-fg-muted md:block">{humanizeToken(item.trustLabel)}</span> : null}
              <StatusBadge status={presented} />
            </button>;
          }} />
        </div>
        {!isPhone && selected ? <aside aria-label="Capability details" className="hidden w-80 shrink-0 overflow-y-auto rounded-lg border border-line bg-raised p-4 sm:block xl:w-96">
          <h2 className="mb-2 font-display text-lg font-semibold text-fg">{presentCapabilityTitle(selected)}</h2>
          <CatalogDetail key={selected.capabilityId} item={selected} callableKnown={callableKnown} usage={selectedUsage}
            skillsKnown={view.skillsKnown} skill={selectedSkill} workspaceId={workspaceId} workspacePolicy={workspacePolicy} workspacePolicyState={workspacePolicyState} onRefresh={() => void catalog.refetch()} />
        </aside> : null}
      </div> : <EmptyState title="No matching capabilities" description="Try a different search or filter." />}
      {isPhone && selected ? <Sheet open={Boolean(location.selection)} onOpenChange={(open) => { if (!open) route.navigate(catalogHref(location.filters), { replace: true }); }} title={presentCapabilityTitle(selected)}>
        <CatalogDetail key={selected.capabilityId} item={selected} callableKnown={callableKnown} usage={selectedUsage}
          skillsKnown={view.skillsKnown} skill={selectedSkill} workspaceId={workspaceId} workspacePolicy={workspacePolicy} workspacePolicyState={workspacePolicyState} onRefresh={() => void catalog.refetch()} />
      </Sheet> : null}
    </> : null}
  </section>;
}
