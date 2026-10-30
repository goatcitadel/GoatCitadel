import { useRef, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { CapabilitySkillItem, CapabilitySkillsResponse } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordView } from "../../../data/record-view";
import { Button } from "../../../ui/Button";
import { EmptyState } from "../../../ui/EmptyState";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { Section } from "../../../ui/Section";
import { NoticeLine } from "../NoticeLine";
import { SkillRow } from "./SkillRow";
import { SkillsFilterBar } from "./SkillsFilterBar";
import { filterSkills, skillCategoryOptions, skillOriginOptions, skillSearchSuggestion } from "./skill-view";
import type { SkillFilterState } from "./use-skill-filters";
import type { SkillUsage } from "./use-skill-usage";

/** The candidate skills waiting for review, in Library. */
const CANDIDATE_SKILLS_HREF = "/library?type=candidate_skill";

const NO_SKILLS: readonly CapabilitySkillItem[] = [];

export interface InstalledViewProps {
  /** The tab's read of the installed list, which the switches and the open panel read again through. */
  query: UseQueryResult<CapabilitySkillsResponse>;
  /** The tab's read of the use counts. */
  counts: SkillUsage;
  /** The tab's search and buttons, kept when the view changes. */
  filters: SkillFilterState;
  /** Opens a skill's panel. */
  onView: (skillId: string) => void;
  /** The tab's own buttons beside the search box. */
  searchActions?: ReactNode;
}

/**
 * The Installed view: every installed skill with its category, where it came from, how often the AI used it in the last
 * year, why it can or can't be used, and an on/off switch. The view only lists and words what the Gateway returned; it
 * never decides whether a skill is usable, left out of the workspace or reviewed. Search and the two sets of buttons
 * narrow the list. The search box shows while the list loads or fails to load, and only this view tells that story:
 * Discover doesn't depend on the installed list.
 */
export function InstalledView({ query, counts, filters, onView, searchActions }: InstalledViewProps) {
  // The loaded list stays while it is read again, and beside a failed recheck.
  const view = recordView(query);
  const response = view.record;
  const filtersRegion = useRef<HTMLDivElement>(null);
  const items = response?.items ?? NO_SKILLS;
  const categoryOptions = skillCategoryOptions(items);
  const originOptions = skillOriginOptions(items);
  // A chosen button that no longer has a skill is dropped, so nothing filters the list without showing a button.
  const categories = filters.categories.filter((id) => categoryOptions.some((option) => option.id === id));
  const origins = filters.origins.filter((id) => originOptions.some((option) => option.id === id));
  const shown = filterSkills(items, { query: filters.search, categories, origins });
  const clearFilters = () => {
    filters.clearAll();
    // The button that was pressed is about to leave, so focus goes to the search box.
    filtersRegion.current?.querySelector("input")?.focus();
  };
  const retryButton = (
    <Button size="sm" loading={query.isFetching} loadingLabel="Retrying…" onClick={() => void query.refetch()}>
      Retry
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
      sourceOptions={originOptions}
      sources={origins}
      onSources={filters.setOrigins}
      // There are four origins at most; none of them goes under a "+N" button.
      sourceVisibleCount={originOptions.length}
      actions={searchActions}
    />
  );

  if (!response) {
    // Retrying clears the error while the first read runs again, so a read that has failed before keeps this view
    // (and the Retry button, with its focus) until it answers.
    const failed = view.phase === "error" || (query.isFetching && query.errorUpdateCount > 0);
    return (
      <div className="space-y-4">
        {bar}
        {failed ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-fg">
              Skills couldn't load.{query.error ? ` ${describeApiError(query.error).summary}` : ""}
            </p>
            {retryButton}
          </div>
        ) : (
          <p className="text-sm text-fg-muted">{CHECKING_FOR_CHANGES}</p>
        )}
      </div>
    );
  }

  const { candidatesWaiting = 0 } = response;
  const lastVersion = lastVersionNote(view);
  return (
    <div className="space-y-4">
      {bar}
      {lastVersion ? (
        <NoticeLine>
          {query.error ? `${describeApiError(query.error).summary} ` : ""}
          {lastVersion}
        </NoticeLine>
      ) : null}
      {response.issues.map((issue, index) => (
        <NoticeLine key={`${index}:${issue}`}>{issue}</NoticeLine>
      ))}
      {candidatesWaiting > 0 ? (
        // The count is for the whole install, not this workspace, so the line doesn't name a workspace.
        <NoticeLine>
          <NativeOwnerLink href={CANDIDATE_SKILLS_HREF} scope="candidate_skill">
            {`${plural(candidatesWaiting, "candidate skill")} waiting for review in Library`}
          </NativeOwnerLink>
        </NoticeLine>
      ) : null}
      {counts.oldCountsNote ? <NoticeLine>{counts.oldCountsNote}</NoticeLine> : null}
      {counts.unavailable ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <NoticeLine>Use counts can't be read right now.</NoticeLine>
          <Button size="sm" loading={counts.retrying} loadingLabel="Trying…" onClick={counts.retry}>
            Try again
          </Button>
        </div>
      ) : null}
      {view.phase === "checking" ? <p className="text-sm text-fg-muted">{CHECKING_FOR_CHANGES}</p> : null}
      {items.length === 0 ? (
        response.issues.length > 0 ? (
          // The lines above say what couldn't be read. An empty list beside them is a failed read, not an empty one.
          <div className="space-y-2">
            <p className="text-sm text-fg">Couldn't load any skills right now.</p>
            {retryButton}
          </div>
        ) : (
          <EmptyState
            title="No skills installed yet"
            description="Skills GoatCitadel's AI can use will show up here once they're installed."
          />
        )
      ) : shown.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="Try a different search, or clear the filters to see every skill."
          action={<Button onClick={clearFilters}>Clear filters</Button>}
        />
      ) : (
        <Section
          title="Installed"
          description={
            shown.length === items.length
              ? plural(items.length, "skill")
              : `${shown.length.toLocaleString()} of ${plural(items.length, "skill")}`
          }
          actions={
            counts.usage ? (
              <Button size="sm" loading={counts.refreshing} loadingLabel="Refreshing…" onClick={counts.refresh}>
                Refresh counts
              </Button>
            ) : undefined
          }
        >
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {shown.map((item) => (
              <SkillRow key={item.skillId} item={item} uses={counts.usesFor(item.skillId)} onView={onView} />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
