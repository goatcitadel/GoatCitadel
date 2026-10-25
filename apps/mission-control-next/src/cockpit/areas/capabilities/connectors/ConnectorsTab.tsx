import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { fetchCapabilityConnectors } from "@goatcitadel/mission-control-shared/api/capability-connectors";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordView } from "../../../data/record-view";
import { queryKeys } from "../../../data/query-keys";
import { Button } from "../../../ui/Button";
import { EmptyState } from "../../../ui/EmptyState";
import { Section } from "../../../ui/Section";
import { CapabilitySearch } from "../CapabilitySearch";
import { CategoryFilter } from "../CategoryFilter";
import { ConnectorRow } from "./ConnectorRow";
import { connectorCategoryLabel, connectorCategoryOptions, filterConnectors, groupConnectors } from "./connector-view";
import { useConnectorPanel } from "./use-connector-panel";

// The custom server form belongs to Settings and is large; it loads only when someone asks to add their own.
const McpServerCreate = lazy(async () => ({
  default: (await import("../../settings/McpServerCreate")).McpServerCreate,
}));

/** The search suggestion when nothing is connected yet. */
const FALLBACK_SUGGESTION = "automation";

/** One plain line of caution above the list: a source that failed, or a recheck that did. Not announced. */
function NoticeLine({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-fg-secondary">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-waiting" />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

/**
 * The Connectors tab: every app the AI can use, in the Gateway's own groups (Connected, On this device, Available,
 * Turned off), with search and category buttons. The tab only lists and filters what the Gateway returned. A row's
 * button opens that connector's panel in the inspector (`?item=` in the address), and "Add your own" opens the custom
 * server form.
 */
export function ConnectorsTab() {
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.capabilityConnectors(workspaceId),
    queryFn: ({ signal }) => fetchCapabilityConnectors(workspaceId, { signal }),
  });
  // The loaded list stays while it is read again, and beside a failed recheck.
  const view = recordView(query);
  const panel = useConnectorPanel(view.record?.items);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [chosenCategories, setChosenCategories] = useState<string[]>([]);
  const filtersRegion = useRef<HTMLDivElement>(null);

  const response = view.record;
  if (!response) {
    // Retrying clears the error while the first read runs again, so a read that has failed before keeps this view
    // (and the Retry button, with its focus) until it answers.
    const failed = view.phase === "error" || (query.isFetching && query.errorUpdateCount > 0);
    if (!failed) return <p className="text-sm text-fg-muted">{CHECKING_FOR_CHANGES}</p>;
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-fg">
          Connectors couldn't load.{query.error ? ` ${describeApiError(query.error).summary}` : ""}
        </p>
        <Button size="sm" loading={query.isFetching} loadingLabel="Retrying…" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const items = response.items;
  const options = connectorCategoryOptions(items);
  // A chosen category that no longer has rows is dropped, so nothing filters the list without showing a button.
  const categories = chosenCategories.filter((id) => options.some((option) => option.id === id));
  const shown = filterConnectors(items, { query: search, categories });
  const groups = groupConnectors(shown);
  const firstConnected = items.find((entry) => entry.state === "connected");
  const suggestion = firstConnected ? connectorCategoryLabel(firstConnected.category) : FALLBACK_SUGGESTION;
  const lastVersion = lastVersionNote(view);

  const addYourOwn = <Button onClick={() => setAdding(true)}>Add your own</Button>;
  const clearFilters = () => {
    setSearch("");
    setChosenCategories([]);
    // The button that was pressed is about to leave, so focus goes to the search box.
    filtersRegion.current?.querySelector("input")?.focus();
  };

  return (
    <div className="space-y-4">
      {items.length > 0 ? (
        <div ref={filtersRegion} className="space-y-3">
          <CapabilitySearch
            tabLabel="Connectors"
            value={search}
            onChange={setSearch}
            placeholder={`Try "${suggestion}"`}
            actions={addYourOwn}
          />
          {options.length >= 2 ? (
            <CategoryFilter options={options} selected={categories} onChange={setChosenCategories} />
          ) : null}
        </div>
      ) : null}
      {lastVersion ? (
        <NoticeLine>
          {query.error ? `${describeApiError(query.error).summary} ` : ""}
          {lastVersion}
        </NoticeLine>
      ) : null}
      {response.issues.map((issue) => (
        <NoticeLine key={`${issue.source}:${issue.message}`}>{issue.message}</NoticeLine>
      ))}
      {view.phase === "checking" ? <p className="text-sm text-fg-muted">{CHECKING_FOR_CHANGES}</p> : null}
      {items.length === 0 ? (
        response.issues.length > 0 ? (
          // The lines above say which source failed. An empty list beside them is a failed read, not an empty one.
          <div className="space-y-2">
            <p className="text-sm text-fg">Couldn't load any connectors right now.</p>
            <Button size="sm" loading={query.isFetching} loadingLabel="Retrying…" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <EmptyState
            title="No connectors yet"
            description="Apps GoatCitadel's AI can use will show up here as they become available."
            action={addYourOwn}
          />
        )
      ) : groups.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="Try a different search, or clear the filters to see every connector."
          action={<Button onClick={clearFilters}>Clear filters</Button>}
        />
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <Section key={group.group} title={`${group.label} ${group.items.length}`}>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.items.map((entry) => (
                  <ConnectorRow key={entry.id} item={entry} onOpen={panel.open} />
                ))}
              </ul>
            </Section>
          ))}
        </div>
      )}
      {adding ? (
        <Suspense fallback={null}>
          <McpServerCreate
            workspaceId={workspaceId}
            onClose={() => {
              setAdding(false);
              // A server saved in the form shows up in the list.
              void client.invalidateQueries({ queryKey: queryKeys.capabilityConnectors(workspaceId) });
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
