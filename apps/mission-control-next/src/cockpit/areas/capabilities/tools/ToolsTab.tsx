import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { toolListQuery } from "../../../data/capability-tools-query";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordView } from "../../../data/record-view";
import { Button } from "../../../ui/Button";
import { EmptyState } from "../../../ui/EmptyState";
import { Section } from "../../../ui/Section";
import { CapabilitySearch } from "../CapabilitySearch";
import { NoticeLine } from "../NoticeLine";
import { MostUsedRow } from "./MostUsedRow";
import { ToolGroupRow } from "./ToolGroupRow";
import { filterToolGroups, presentMostUsed, toolSearchSuggestion } from "./tool-view";
import { useToolGroupPanel } from "./use-tool-group-panel";
import { useToolUsage } from "./use-tool-usage";

/**
 * The Tools tab: every built-in tool group with its risk, its tool count, how often the AI called it in the last
 * year, what other rules block, and an on/off switch. A row of four cards (Most used, or Essentials before four groups
 * have been called) sits above the list. The tab only lists and words what the Gateway returned; it never works out a
 * risk, a block or the most used groups itself. The View button of a row or card opens that group's panel in the
 * inspector (`?item=group:<id>` in the address).
 */
export function ToolsTab() {
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  // The same cache entry the switches write to, so a group reads the same everywhere it shows.
  const query = useQuery(toolListQuery(workspaceId));
  // The loaded list stays while it is read again, and beside a failed recheck.
  const view = recordView(query);
  const counts = useToolUsage();
  const panel = useToolGroupPanel(view.record?.groups);
  const [search, setSearch] = useState("");
  const searchRegion = useRef<HTMLDivElement>(null);

  const response = view.record;
  if (!response) {
    // Retrying clears the error while the first read runs again, so a read that has failed before keeps this view
    // (and the Retry button, with its focus) until it answers.
    const failed = view.phase === "error" || (query.isFetching && query.errorUpdateCount > 0);
    if (!failed) return <p className="text-sm text-fg-muted">{CHECKING_FOR_CHANGES}</p>;
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-fg">
          Tool groups couldn't load.{query.error ? ` ${describeApiError(query.error).summary}` : ""}
        </p>
        <Button size="sm" loading={query.isFetching} loadingLabel="Retrying…" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const { groups, settingsRevision } = response;
  const searching = search.trim().length > 0;
  const shown = filterToolGroups(groups, search);
  const mostUsed = presentMostUsed(groups, counts.usage);
  const lastVersion = lastVersionNote(view);
  const clearSearch = () => {
    setSearch("");
    // The button that was pressed is about to leave, so focus goes to the search box.
    searchRegion.current?.querySelector("input")?.focus();
  };

  return (
    <div className="space-y-4">
      {groups.length > 0 ? (
        <div ref={searchRegion}>
          <CapabilitySearch
            tabLabel="Tools"
            value={search}
            onChange={setSearch}
            placeholder={toolSearchSuggestion(mostUsed.groups)}
          />
        </div>
      ) : null}
      {lastVersion ? (
        <NoticeLine>
          {query.error ? `${describeApiError(query.error).summary} ` : ""}
          {lastVersion}
        </NoticeLine>
      ) : null}
      {response.issues.map((issue, index) => (
        <NoticeLine key={`${index}:${issue}`}>{issue}</NoticeLine>
      ))}
      {counts.oldCountsNote ? <NoticeLine>{counts.oldCountsNote}</NoticeLine> : null}
      {counts.unavailable ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <NoticeLine>Call counts can't be read right now.</NoticeLine>
          <Button size="sm" loading={counts.retrying} loadingLabel="Trying…" onClick={counts.retry}>
            Try again
          </Button>
        </div>
      ) : null}
      {view.phase === "checking" ? <p className="text-sm text-fg-muted">{CHECKING_FOR_CHANGES}</p> : null}
      {groups.length === 0 ? (
        // The notes above say what couldn't be read. An empty list beside them is a failed read, not an empty one.
        <div className="space-y-2">
          <p className="text-sm text-fg">Couldn't load any tool groups right now.</p>
          <Button size="sm" loading={query.isFetching} loadingLabel="Retrying…" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="Try a different search, or clear it to see every tool group."
          action={<Button onClick={clearSearch}>Clear search</Button>}
        />
      ) : (
        <>
          {searching || mostUsed.groups.length === 0 ? null : (
            <MostUsedRow
              heading={mostUsed.heading}
              groups={mostUsed.groups}
              callsFor={counts.callsFor}
              settingsRevision={settingsRevision}
              onOpen={panel.open}
            />
          )}
          <Section
            title="All tools"
            actions={
              counts.usage ? (
                <Button size="sm" loading={counts.refreshing} loadingLabel="Refreshing…" onClick={counts.refresh}>
                  Refresh counts
                </Button>
              ) : undefined
            }
          >
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {shown.map((group) => (
                <ToolGroupRow
                  key={group.groupId}
                  group={group}
                  calls={counts.callsFor(group)}
                  settingsRevision={settingsRevision}
                  onOpen={panel.open}
                />
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}
