import { useRef } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { CapabilityPluginListItem, CapabilityPluginListResponse } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { pluginListQuery } from "../../../data/capability-plugins-query";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordView, type RecordView } from "../../../data/record-view";
import { Button } from "../../../ui/Button";
import { EmptyState } from "../../../ui/EmptyState";
import { Section } from "../../../ui/Section";
import { CapabilitySearch } from "../CapabilitySearch";
import { CategoryFilter } from "../CategoryFilter";
import { NoticeLine } from "../NoticeLine";
import { PluginRow } from "./PluginRow";
import { PLUGINS_LIST_ID, type PluginSourceFormKind } from "./plugin-links";
import { filterPlugins, noPluginsDescription, pluginSearchPlaceholder, pluginTrustOptions } from "./plugin-view";
import { usePluginFilters, type PluginFilterState } from "./use-plugin-filters";
import { usePluginInstallPanel, type PluginInstallPanelOpener } from "./use-plugin-install-panel";
import { usePluginPanel } from "./use-plugin-panel";

type PluginListQuery = UseQueryResult<CapabilityPluginListResponse>;
type PluginListView = RecordView<CapabilityPluginListResponse>;
type OpenPlugin = (item: CapabilityPluginListItem) => void;

/**
 * The Plugins tab: the plugins installed (install-wide), then the built-in plugins not installed yet, with search and,
 * when both are present, a "Where it comes from" filter. "Install from Git" and "Add from folder" (only where a folder
 * may be added) sit beside the search box. The tab only lists and words what the Gateway returned: it never decides
 * whether a plugin is installed, finished or installable, and it never reads another catalog.
 *
 * Install (a built-in plugin), Continue (an install that isn't finished) and the source buttons open the install panel;
 * View opens the plugin's own panel (`?item=plugin:<id>`), where it can be uninstalled.
 */
export function PluginsTab() {
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  // The list is install-wide, but the route takes a workspace, so the read and its key follow the active one.
  const query = useQuery(pluginListQuery(workspaceId));
  // The loaded list stays while it is read again, and beside a failed recheck.
  const view = recordView(query);
  const filters = usePluginFilters();
  const installPanel = usePluginInstallPanel(view.record);
  const pluginPanel = usePluginPanel(view.record, installPanel.install);
  const response = view.record;
  if (!response) return <FirstRead query={query} view={view} />;
  return (
    <PluginsList
      query={query}
      view={view}
      response={response}
      filters={filters}
      actions={{ ...installPanel, view: pluginPanel.open }}
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

/** What a row and a source button do. */
interface PluginActions extends PluginInstallPanelOpener {
  view: OpenPlugin;
}

interface PluginsListProps {
  query: PluginListQuery;
  view: PluginListView;
  response: CapabilityPluginListResponse;
  filters: PluginFilterState;
  actions: PluginActions;
}

/** The answered list: search and filter, the lines about what couldn't be read, then the two sections. */
function PluginsList({ query, view, response, filters, actions }: PluginsListProps) {
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
  return (
    // Focus comes back here once a plugin whose panel was open is uninstalled and its row is gone.
    <div id={PLUGINS_LIST_ID} tabIndex={-1} className="space-y-4 focus:outline-none">
      <div ref={filtersRegion}>
        <PluginsSearchBar
          all={all}
          filters={filters}
          trusts={trusts}
          folders={response.folderSourcesAllowed}
          onSource={actions.openSource}
        />
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
        actions={actions}
        onClear={clearFilters}
      />
    </div>
  );
}

/**
 * The search box with the source buttons beside it, and the "Where it comes from" filter when both labels are present.
 * The box and its buttons stay with an empty list: they are where a first plugin is added from.
 */
function PluginsSearchBar({
  all,
  filters,
  trusts,
  folders,
  onSource,
}: {
  all: readonly CapabilityPluginListItem[];
  filters: PluginFilterState;
  /** The chosen labels that still have a plugin. */
  trusts: string[];
  folders: boolean;
  onSource: (kind: PluginSourceFormKind) => void;
}) {
  const trustOptions = pluginTrustOptions(all);
  const sourceButtons = (
    <>
      <Button onClick={() => onSource("git")}>Install from Git</Button>
      {folders ? <Button onClick={() => onSource("folder")}>Add from folder</Button> : null}
    </>
  );
  return (
    <div className="space-y-3">
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
  );
}

interface PluginSectionsProps {
  response: CapabilityPluginListResponse;
  /** The installed plugins the search and filter leave. */
  installed: readonly CapabilityPluginListItem[];
  /** The built-in plugins the search and filter leave. */
  builtIn: readonly CapabilityPluginListItem[];
  actions: PluginActions;
  onClear: () => void;
}

/**
 * "Installed", then "Built in". With nothing installed, the empty state stands in for Installed and names only the
 * places this install offers. A section the search empties is hidden; when it empties both, one no-match state shows.
 */
function PluginSections({ response, installed, builtIn, actions, onClear }: PluginSectionsProps) {
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
        <PluginSection title="Installed" shown={installed} total={response.installed.length} actions={actions} />
      ) : null}
      {builtIn.length > 0 ? (
        <PluginSection title="Built in" shown={builtIn} total={response.builtIn.length} actions={actions} />
      ) : null}
    </>
  );
}

function PluginSection({
  title,
  shown,
  total,
  actions,
}: {
  title: string;
  shown: readonly CapabilityPluginListItem[];
  total: number;
  actions: PluginActions;
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
          <PluginRow
            key={item.pluginId}
            item={item}
            onInstall={actions.install}
            onContinue={actions.resume}
            onView={actions.view}
          />
        ))}
      </ul>
    </Section>
  );
}
