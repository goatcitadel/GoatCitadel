import { RESPONSIVE_QUERIES } from "@goatcitadel/mission-control-shared/hooks/responsive-breakpoints";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Code,
  FilePen,
  FlaskConical,
  Network,
  Puzzle,
  RefreshCw,
  Server,
  Share2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { CapabilityCatalogEntry } from "@goatcitadel/contracts";
import { fetchEffectivePermissionProfile } from "@goatcitadel/mission-control-shared/api/approvals";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  deriveCapabilityStatus,
  presentCapabilityDescription,
  presentCapabilityStatus,
  presentCapabilityTitle,
} from "@goatcitadel/mission-control-shared/content/capability-rows";
import { capabilityCategoryLabel, capabilityKindLabel, freeText } from "./capability-vocabulary";
import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { queryKeys } from "../../data/query-keys";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { Sheet } from "../../ui/Sheet";
import { StatusBadge } from "../../ui/StatusBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/Tabs";
import {
  CapabilityPolicyEvidence,
  CapabilitySourceEvidence,
  readWorkspacePolicyEvidence,
  type WorkspacePolicyEvidence,
} from "./CapabilityEvidence";
import { CapabilityPolicyInspector } from "./CapabilityPolicyInspector";
import { CapabilityCatalogEmpty } from "./CapabilityCatalogEmpty";
import { CapabilityCatalogFilters } from "./CapabilityCatalogFilters";
import { libraryCatalogItems } from "./library-catalog-kinds";
import { CapabilitySettings } from "./CapabilitySettings";
import { CapabilityLastUsed, CapabilityUsageEvidence } from "./CapabilityUsageEvidence";
import {
  capabilityUsage,
  filterCapabilities,
  loadCapabilityCatalog,
  type CapabilityCatalogView,
  type CapabilityUsage,
} from "./capability-catalog";
import { catalogHref, readCatalogLocation } from "./capability-catalog-route";
import { AREA_COLUMN } from "../../ui/area-layout";
import { WindowedRecordList } from "../../ui/WindowedRecordList";
import { AreaHeader } from "../../ui/AreaHeader";
import { LIBRARY_SECTION_LABELS } from "./library-sections";

/** The row icon says what kind of capability it is (LB-07); the kind's words stay in the detail. */
const KIND_ICONS: Record<string, LucideIcon> = {
  tool: Wrench,
  skill: BookOpen,
  code_mode: Code,
  proposal: FilePen,
  candidate_skill: FlaskConical,
  mesh_tool: Network,
  mesh_mcp_server: Server,
  mesh_skill: Share2,
};
const kindIcon = (kind: string): LucideIcon => KIND_ICONS[kind] ?? Puzzle;
const PILL = "rounded-full border border-line px-2 py-0.5 text-xs text-fg-muted";
const TAB_LABELS = {
  overview: "Overview",
  policy: "Policy",
  usage: "Usage",
  source: "Source",
  settings: "Settings",
} as const;

const EMPTY_ITEMS: CapabilityCatalogEntry[] = [];
const COUNT_ANNOUNCE_DELAY_MS = 500;

function CatalogDetail({
  item,
  callableKnown,
  usage,
  skillsKnown,
  skill,
  workspaceId,
  workspacePolicy,
  workspacePolicyState,
  onRefresh,
}: {
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
  const presented = callableKnown
    ? presentCapabilityStatus(item)
    : { label: "Callability unknown", tone: "neutral" as const };
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-fg-secondary">{presentCapabilityDescription(item)}</p>
      <div className="flex flex-wrap gap-2">
        <StatusBadge status={presented} />
        <span className={PILL}>{capabilityKindLabel(item.kind)}</span>
        <span className={PILL}>{item.trustLabel ? freeText(item.trustLabel) : "Trust not labeled"}</span>
      </div>
      <Tabs defaultValue="overview">
        <TabsList className="justify-between" aria-label="Capability details">
          {(["overview", "policy", "usage", "source", "settings"] as const).map((tab) => (
            <TabsTrigger className="whitespace-nowrap px-1 text-xs" key={tab} value={tab}>
              {TAB_LABELS[tab]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="space-y-2 py-3 text-sm text-fg-secondary">
          <p>
            {callableKnown
              ? status.reason
              : "The callable catalog is unavailable. Refresh before relying on this status."}
          </p>
          <p>Category: {capabilityCategoryLabel(item.category)}</p>
          {item.reviewWarning ? (
            <p role="alert" className="text-status-waiting">
              {item.reviewWarning}
            </p>
          ) : null}
        </TabsContent>
        <TabsContent value="policy" className="space-y-2 py-3 text-sm text-fg-secondary">
          <CapabilityPolicyEvidence
            item={item}
            callableKnown={callableKnown}
            workspacePolicy={workspacePolicy}
            workspacePolicyState={workspacePolicyState}
          />
          <CapabilityPolicyInspector
            key={JSON.stringify([workspaceId, item.toolName])}
            workspaceId={workspaceId}
            toolName={item.toolName}
          />
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
    </div>
  );
}

/** Above this many capabilities the list windows instead of rendering every row. */
const CATALOG_WINDOW_THRESHOLD = 200;

/** `footer` is page content under the catalog (the skill packs and Mesh publications on the Candidates and mesh tab). */
export function CapabilityCatalog({ footer }: { footer?: ReactNode | ((search: string) => ReactNode) } = {}) {
  const route = useCockpitRoute();
  const location = readCatalogLocation(route.rest, route.search);
  const { search, kind, status, trust } = location.filters;
  const setFilters = (updates: Partial<typeof location.filters>) =>
    route.navigate(catalogHref({ ...location.filters, ...updates }), { replace: true });
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
  // Skills and tools are listed in Capabilities; the Library lists the rest of the Gateway's catalog.
  const items = useMemo(() => libraryCatalogItems(view?.items ?? EMPTY_ITEMS), [view?.items]);
  const callableKnown = view?.callableKnown ?? false;
  const kinds = useMemo(() => [...new Set(items.map((item) => item.kind))].sort(), [items]);
  const trustLabels = useMemo(() => [...new Set(items.map((item) => item.trustLabel ?? "unlabeled"))].sort(), [items]);
  const filtered = useMemo(
    () =>
      filterCapabilities(items, {
        search,
        kind,
        status: callableKnown ? status : "all",
        trust,
      }),
    [items, search, kind, status, trust, callableKnown],
  );
  // Announce a short count only after typing or filtering settles, instead of on every keystroke.
  const shownCount = `${filtered.length} of ${items.length} shown`;
  const [announcedCount, setAnnouncedCount] = useState(shownCount);
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncedCount(shownCount), COUNT_ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [shownCount]);
  const selected = location.invalidSelection
    ? null
    : location.selection
      ? (filtered.find(
          (item) => item.capabilityId === location.selection!.id && item.kind === location.selection!.kind,
        ) ?? null)
      : (filtered[0] ?? null);
  const missingSelection = location.invalidSelection || Boolean(location.selection && !selected);
  const selectedUsage = selected && view ? capabilityUsage(selected, view) : { status: "unavailable" as const };
  const selectedSkill = selected?.skillId ? view?.skillsById[selected.skillId] : undefined;
  const workspacePolicy = !workspacePolicyQuery.isError
    ? readWorkspacePolicyEvidence(workspacePolicyQuery.data, workspaceId)
    : null;
  const workspacePolicyState = workspacePolicyQuery.isPending ? "loading" : workspacePolicy ? "ready" : "unavailable";

  return (
    // The list uses the page's height (one scroll, whole rows); the detail pane stays in view beside it.
    <section className={`${AREA_COLUMN} flex flex-col gap-3 p-4 sm:p-6`}>
      <AreaHeader
        title={LIBRARY_SECTION_LABELS.capabilities}
        description="Review skill candidates, capability proposals, and what mesh nodes publish."
        actions={
          <Button
            size="sm"
            onClick={() => {
              void catalog.refetch();
              void workspacePolicyQuery.refetch();
            }}
            disabled={catalog.isFetching || workspacePolicyQuery.isFetching}
          >
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh
          </Button>
        }
      />
      {view?.issues.map((issue) => (
        <p
          key={issue}
          role="alert"
          className="rounded-md border border-status-waiting/40 p-2 text-sm text-fg-secondary"
        >
          {issue}
        </p>
      ))}
      {catalog.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading catalog…
        </p>
      ) : null}
      {catalog.isError ? (
        <EmptyState
          title="Library unavailable"
          description={describeApiError(catalog.error).summary}
          action={<Button onClick={() => void catalog.refetch()}>Try again</Button>}
        />
      ) : null}
      {view ? (
        <>
          <CapabilityCatalogFilters
            filters={location.filters}
            kinds={kinds}
            trustLabels={trustLabels}
            callableKnown={callableKnown}
            setFilters={setFilters}
          />
          <p className="text-xs text-fg-muted">
            {filtered.length} of {items.length} capabilities shown. Usage dates appear only when recorded; inspect a
            capability for availability and provenance.{view.issues.length ? " · partial catalog" : ""}
          </p>
          <p role="status" className="sr-only">
            {announcedCount}
          </p>
          {missingSelection ? (
            <EmptyState
              title="Capability unavailable"
              description="The linked capability is not in this catalog view. Refresh, or return to the catalog."
              action={
                <Button size="sm" onClick={() => route.navigate(catalogHref(location.filters), { replace: true })}>
                  Return to catalog
                </Button>
              }
            />
          ) : null}
          {filtered.length ? (
            <div className="flex items-start gap-4">
              {/* Typical catalogs render in page height (one scroll, whole rows); very large ones window
                  inside a viewport-tall list so rendering stays bounded. */}
              <div className="min-w-0 flex-1 border-t border-line-subtle">
                <WindowedRecordList
                  items={filtered}
                  itemKey={(item) => item.capabilityId}
                  label="Capabilities"
                  threshold={CATALOG_WINDOW_THRESHOLD}
                  className="h-dvh min-h-48"
                >
                  {(item) => {
                    const presented = callableKnown
                      ? presentCapabilityStatus(item)
                      : { label: "Callability unknown", tone: "neutral" as const };
                    const usage = capabilityUsage(item, view);
                    const KindIcon = kindIcon(item.kind);
                    return (
                      <button
                        type="button"
                        key={item.capabilityId}
                        onClick={() => route.navigate(catalogHref(location.filters, item))}
                        aria-current={selected?.capabilityId === item.capabilityId ? "true" : undefined}
                        className="flex w-full items-center gap-3 border-b border-line-subtle p-3 text-left hover:bg-sunken aria-[current=true]:bg-sunken"
                      >
                        <KindIcon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">
                            {presentCapabilityTitle(item)}
                          </span>
                          <span className="block truncate text-xs text-fg-muted">
                            {presentCapabilityDescription(item)}
                          </span>
                          {usage.status === "recorded" ? (
                            <span className="block truncate text-xs text-fg-muted">
                              <CapabilityLastUsed usage={usage} />
                            </span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
                          {item.trustLabel ? <span className={PILL}>{freeText(item.trustLabel)}</span> : null}
                          <StatusBadge status={presented} />
                        </span>
                      </button>
                    );
                  }}
                </WindowedRecordList>
              </div>
              {!isPhone && selected ? (
                <aside
                  aria-label="Capability details"
                  className="sticky top-4 hidden max-h-dvh w-80 shrink-0 self-start overflow-y-auto border-l border-line-subtle pl-4 sm:block xl:w-96"
                >
                  <h2 className="mb-2 text-base font-semibold text-fg">{presentCapabilityTitle(selected)}</h2>
                  <CatalogDetail
                    key={selected.capabilityId}
                    item={selected}
                    callableKnown={callableKnown}
                    usage={selectedUsage}
                    skillsKnown={view.skillsKnown}
                    skill={selectedSkill}
                    workspaceId={workspaceId}
                    workspacePolicy={workspacePolicy}
                    workspacePolicyState={workspacePolicyState}
                    onRefresh={() => void catalog.refetch()}
                  />
                </aside>
              ) : null}
            </div>
          ) : (
            <CapabilityCatalogEmpty hasEntries={items.length > 0} />
          )}
          {isPhone && selected ? (
            <Sheet
              open={Boolean(location.selection)}
              onOpenChange={(open) => {
                if (!open) route.navigate(catalogHref(location.filters), { replace: true });
              }}
              title={presentCapabilityTitle(selected)}
            >
              <CatalogDetail
                key={selected.capabilityId}
                item={selected}
                callableKnown={callableKnown}
                usage={selectedUsage}
                skillsKnown={view.skillsKnown}
                skill={selectedSkill}
                workspaceId={workspaceId}
                workspacePolicy={workspacePolicy}
                workspacePolicyState={workspacePolicyState}
                onRefresh={() => void catalog.refetch()}
              />
            </Sheet>
          ) : null}
        </>
      ) : null}
      {typeof footer === "function" ? footer(search) : footer}
    </section>
  );
}
