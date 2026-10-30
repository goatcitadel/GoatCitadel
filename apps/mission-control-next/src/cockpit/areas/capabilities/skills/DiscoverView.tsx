import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CapabilitySkillDiscoverItem } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { skillDiscoverQuery } from "../../../data/capability-skills-query";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordView } from "../../../data/record-view";
import { Button } from "../../../ui/Button";
import { EmptyState } from "../../../ui/EmptyState";
import { Section } from "../../../ui/Section";
import { NoticeLine } from "../NoticeLine";
import { DiscoverRow } from "./DiscoverRow";
import { discoverProviderOptions, filterDiscoverItems, unavailableProvidersLine } from "./discover-view";
import { skillCategoryOptions, skillSearchSuggestion } from "./skill-view";
import { SkillsFilterBar } from "./SkillsFilterBar";
import type { SkillFilterState } from "./use-skill-filters";
import { useSettledTerm } from "./use-settled-term";

export interface DiscoverViewProps {
  workspaceId: string;
  /** The tab's search and buttons, kept when the view changes. */
  filters: SkillFilterState;
  /** The install panel opens from these two; the view only says which source was chosen. */
  onInstall: (item: CapabilitySkillDiscoverItem) => void;
  onContinue: (item: CapabilitySkillDiscoverItem) => void;
  /** Opens the installed skill's panel. The name is for a skill the installed list doesn't hold. */
  onViewInstalled: (skillId: string, name: string) => void;
}

const NO_ITEMS: readonly CapabilitySkillDiscoverItem[] = [];

/**
 * The Discover view: GoatCitadel's own packs and the curated skills before any search, and what the Gateway finds on the
 * skill sites once two characters have been typed and the typing has paused. It only lists and words what the Gateway
 * returned: the Gateway says whether a source can be installed, is installed or is between steps, and the view never
 * merges lists or works a state out. The buttons narrow the list in the browser. A search that failed shows its error
 * and Try again, and never says nothing matched.
 */
export function DiscoverView({ workspaceId, filters, onInstall, onContinue, onViewInstalled }: DiscoverViewProps) {
  const term = useSettledTerm(filters.search);
  const query = useQuery(skillDiscoverQuery(workspaceId, term));
  const view = recordView(query);
  const response = view.record;
  const filtersRegion = useRef<HTMLDivElement>(null);
  const items = response?.items ?? NO_ITEMS;
  const categoryOptions = skillCategoryOptions(items);
  const providerOptions = discoverProviderOptions(items);
  // A chosen button that no longer has a skill is dropped, so nothing filters the list without showing a button.
  const categories = filters.categories.filter((id) => categoryOptions.some((option) => option.id === id));
  const providers = filters.providers.filter((id) => providerOptions.some((option) => option.id === id));
  const shown = filterDiscoverItems(items, { categories, providers });
  const focusSearch = () => filtersRegion.current?.querySelector("input")?.focus();
  const retry = (
    <Button size="sm" loading={query.isFetching} loadingLabel="Trying…" onClick={() => void query.refetch()}>
      Try again
    </Button>
  );
  const bar = (
    <SkillsFilterBar
      regionRef={filtersRegion}
      placeholder={skillSearchSuggestion(items)}
      search={filters.search}
      onSearch={filters.setSearch}
      categoryOptions={categoryOptions}
      categories={categories}
      onCategories={filters.setCategories}
      sourceOptions={providerOptions}
      sources={providers}
      onSources={filters.setProviders}
    />
  );

  if (!response) {
    // Retrying clears the error while the read runs again, so a read that has failed before keeps this view (and the
    // Try again button, with its focus) until it answers.
    const failed = view.phase === "error" || (query.isFetching && query.errorUpdateCount > 0);
    return (
      <div className="space-y-4">
        {bar}
        {failed ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-fg">
              {term ? "The search didn't finish." : "Skills to install couldn't load."}
              {query.error ? ` ${describeApiError(query.error).summary}` : ""}
            </p>
            {retry}
          </div>
        ) : (
          <p className="text-sm text-fg-muted">{term ? "Searching…" : CHECKING_FOR_CHANGES}</p>
        )}
      </div>
    );
  }

  const lastVersion = lastVersionNote(view);
  const unavailable = unavailableProvidersLine(response.unavailableProviders);
  // Nothing found while a site couldn't be searched is not "no match": the site that was down may have had one. The
  // response doesn't say how many sites were asked, so any site that couldn't be searched makes an empty answer open.
  const inconclusive = items.length === 0 && unavailable !== undefined;
  return (
    <div className="space-y-4">
      {bar}
      {lastVersion ? (
        <NoticeLine>
          {query.error ? `${describeApiError(query.error).summary} ` : ""}
          {lastVersion}
        </NoticeLine>
      ) : null}
      {unavailable && !inconclusive ? <NoticeLine>{unavailable}</NoticeLine> : null}
      {view.phase === "checking" ? <p className="text-sm text-fg-muted">{CHECKING_FOR_CHANGES}</p> : null}
      {inconclusive ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <NoticeLine>{unavailable}</NoticeLine>
          {retry}
        </div>
      ) : items.length === 0 ? (
        term ? (
          <EmptyState
            title={`No skills match ${term}`}
            description="Try different words, or clear the search to see what GoatCitadel offers."
            action={
              <Button
                onClick={() => {
                  filters.setSearch("");
                  focusSearch();
                }}
              >
                Clear search
              </Button>
            }
          />
        ) : (
          <EmptyState title="Nothing to install yet" description="Search to look for skills on skill sites." />
        )
      ) : shown.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="Try different buttons, or clear them to see everything found."
          action={
            <Button
              onClick={() => {
                filters.clearButtons();
                focusSearch();
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <Section
          title={term ? "Search results" : "Suggested skills"}
          description={
            shown.length === items.length
              ? plural(items.length, "skill")
              : `${shown.length.toLocaleString()} of ${plural(items.length, "skill")}`
          }
        >
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {shown.map((item) => (
              <DiscoverRow
                key={item.id}
                item={item}
                onInstall={onInstall}
                onContinue={onContinue}
                onView={onViewInstalled}
              />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
