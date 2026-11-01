import { useRef } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { CapabilityPluginListItem, CapabilityPluginListResponse } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { pluginListQuery } from "../../../data/capability-plugins-query";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordView, type RecordView } from "../../../data/record-view";
import { Button } from "../../../ui/Button";
import { EmptyState } from "../../../ui/EmptyState";
import { Section } from "../../../ui/Section";
import { CapabilitySearch } from "../CapabilitySearch";
import { CategoryFilter } from "../CategoryFilter";
import { NoticeLine } from "../NoticeLine";
import { PluginRow } from "./PluginRow";
import { pluginItemHref, pluginSourceItemHref, type PluginSourceFormKind } from "./plugin-links";
import { filterPlugins, noPluginsDescription, pluginSearchPlaceholder, pluginTrustOptions } from "./plugin-view";
import { usePluginFilters, type PluginFilterState } from "./use-plugin-filters";

type PluginListQuery = UseQueryResult<CapabilityPluginListResponse>;
type PluginListView = RecordView<CapabilityPluginListResponse>;
type OpenPlugin = (item: CapabilityPluginListItem) => void;

/**
 * The Plugins tab: the plugins installed (install-wide), then the built-in plugins not installed yet, with search and,
 * when both are present, a "Where it comes from" filter. "Install from Git" and "Add from folder" (only where a folder
 * may be added) sit beside the search box. The tab only lists and words what the Gateway returned: it never decides
 * whether a plugin is installed, finished or installable, and it never reads another catalog.
 *
 * A row's button and a source button move the address (`?item=plugin:<id>`, `?item=plugin-source:<kind>`); the
 * panels that open there belong to the install flow and the plugin's panel.
 */
export function PluginsTab() {
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const { navigate } = useCockpitRoute();
  // The list is install-wide, but the route takes a workspace, so the read and its key follow the active one.
  const query = useQuery(pluginListQuery(workspaceId));
  // The loaded list stays while it is read again, and beside a failed recheck.
  const view = recordView(query);
  const filters = usePluginFilters();
  const response = view.record;
  if (!response) return <FirstRead query={query} view={view} />;
  return (
    <PluginsList
      query={query}
      view={view}
      response={response}
      filters={filters}
      onOpen={(item) => navigate(pluginItemHref(item.pluginId))}
      onSource={(kind) => navigate(pluginSourceItemHref(kind))}
    />
  );
}

/** Before the first answer: a quiet checking line, or the one alert that replaces the page when the read failed. */
function FirstRead({ query, view }: { query: PluginListQuery; view: PluginListView }) {
  // Trying again clears the error while the first read runs again, so a read that has failed before keeps this view
  // (and the Try again button, with its focus) until it answers.
  const failed = view.phase === "error" || (query.isFetching && query.errorUpdateCount > 0);
  if (!failed) return <p className="text-sm text-fg-muted">{CHECKING_FOR_CHANGES}</p>;
  return (
    <div className="space-y-2">
      <p role="alert" className="text-sm text-fg">
        Plugins can't be read right now.{query.error ? ` ${describeApiError(query.error).summary}` : ""}
      </p>
      <Button size="sm" loading={query.isFetching} loadingLabel="Trying…" onClick={() => void query.refetch()}>
        Try again
      </Button>
    </div>
  );
}

interface PluginsListProps {
  query: PluginListQuery;
  view: PluginListView;
  response: CapabilityPluginListResponse;
  filters: PluginFilterState;
  onOpen: OpenPlugin;
  onSource: (kind: PluginSourceFormKind) => void;
}

/** The answered list: search and filter, the lines about what couldn't be read, then the two sections. */
function PluginsList({ query, view, response, filters, onOpen, onSource }: PluginsListProps) {
  const filtersRegion = useRef<HTMLDivElement>(null);
  const all = [...response.installed, ...response.builtIn];
  const trustOptions = pluginTrustOptions(all);
  // A chosen button that no longer has a plugin is dropped, so nothing filters the list without showing a button.
  const trusts = filters.trusts.filter((id) => trustOptions.some((option) => option.id === id));
  const narrowing = { query: filters.search, trusts };
  const lastVersion = lastVersionNote(view);
  const clearFilters = () => {
    filters.clearAll();
    // The button that was pressed is about to leave, so focus goes to the search box.
    filtersRegion.current?.querySelector("input")?.focus();
  };
  const sourceButtons = (
    <>
      <Button onClick={() => onSource("git")}>Install from Git</Button>
      {response.folderSourcesAllowed ? <Button onClick={() => onSource("folder")}>Add from folder</Button> : null}
    </>
  );

  return (
    <div className="space-y-4">
      {/* The box and its buttons stay with an empty list: they are where a first plugin is added from. */}
      <div ref={filtersRegion} className="space-y-3">
        <CapabilitySearch
          tabLabel="Plugins"
          value={filters.search}
          onChange={filters.setSearch}
          placeholder={pluginSearchPlaceholder(all)}
          actions={sourceButtons}
        />
        {trustOptions.length >= 2 ? (
          <CategoryFilter
            label="Where it comes from"
            options={trustOptions}
            selected={trusts}
            onChange={filters.setTrusts}
            visibleCount={trustOptions.length}
          />
        ) : null}
      </div>
      {lastVersion ? (
        <NoticeLine>
          {query.error ? `${describeApiError(query.error).summary} ` : ""}
          {lastVersion}
        </NoticeLine>
      ) : null}
      {response.issues.map((issue, index) => (
        <NoticeLine key={`${index}:${issue}`}>{issue}</NoticeLine>
      ))}
      {view.phase === "checking" ? <p className="text-sm text-fg-muted">{CHECKING_FOR_CHANGES}</p> : null}
      <PluginSections
        response={response}
        installed={filterPlugins(response.installed, narrowing)}
        builtIn={filterPlugins(response.builtIn, narrowing)}
        onOpen={onOpen}
        onClear={clearFilters}
      />
    </div>
  );
}

interface PluginSectionsProps {
  response: CapabilityPluginListResponse;
  /** The installed plugins the search and filter leave. */
  installed: readonly CapabilityPluginListItem[];
  /** The built-in plugins the search and filter leave. */
  builtIn: readonly CapabilityPluginListItem[];
  onOpen: OpenPlugin;
  onClear: () => void;
}

/**
 * "Installed", then "Built in". With nothing installed, the empty state stands in for Installed and names only the
 * places this install offers. A section the search empties is hidden; when it empties both, one no-match state shows.
 */
function PluginSections({ response, installed, builtIn, onOpen, onClear }: PluginSectionsProps) {
  const anyPlugin = response.installed.length + response.builtIn.length > 0;
  if (anyPlugin && installed.length + builtIn.length === 0) {
    return (
      <EmptyState
        title="No plugins match"
        description="Try a different search, or clear the filters."
        action={<Button onClick={onClear}>Clear filters</Button>}
      />
    );
  }
  return (
    <>
      {response.installed.length === 0 ? (
        <EmptyState
          title="No plugins yet"
          description={noPluginsDescription({
            builtIn: response.builtIn.length > 0,
            folders: response.folderSourcesAllowed,
          })}
        />
      ) : null}
      {installed.length > 0 ? (
        <PluginSection title="Installed" shown={installed} total={response.installed.length} onOpen={onOpen} />
      ) : null}
      {builtIn.length > 0 ? (
        <PluginSection title="Built in" shown={builtIn} total={response.builtIn.length} onOpen={onOpen} />
      ) : null}
    </>
  );
}

function PluginSection({
  title,
  shown,
  total,
  onOpen,
}: {
  title: string;
  shown: readonly CapabilityPluginListItem[];
  total: number;
  onOpen: OpenPlugin;
}) {
  return (
    <Section
      title={title}
      description={
        shown.length === total
          ? plural(total, "plugin")
          : `${shown.length.toLocaleString()} of ${plural(total, "plugin")}`
      }
    >
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {shown.map((item) => (
          // Until the install flow and the plugin's panel arrive, every action opens the plugin's own address.
          <PluginRow key={item.pluginId} item={item} onInstall={onOpen} onContinue={onOpen} onView={onOpen} />
        ))}
      </ul>
    </Section>
  );
}
