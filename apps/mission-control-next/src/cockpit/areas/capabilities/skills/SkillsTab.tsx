import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { skillListQuery } from "../../../data/capability-skills-query";
import { CHECKING_FOR_CHANGES, lastVersionNote, recordView } from "../../../data/record-view";
import { Button } from "../../../ui/Button";
import { EmptyState } from "../../../ui/EmptyState";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import { Section } from "../../../ui/Section";
import { CapabilitySearch } from "../CapabilitySearch";
import { CategoryFilter } from "../CategoryFilter";
import { NoticeLine } from "../NoticeLine";
import { SkillRow } from "./SkillRow";
import { filterSkills, skillCategoryOptions, skillOriginOptions, skillSearchSuggestion } from "./skill-view";
import { useSkillUsage } from "./use-skill-usage";

/** The candidate skills waiting for review, in Library. */
const CANDIDATE_SKILLS_HREF = "/library?type=candidate_skill";

/** What View does until the skill panel is added in the next change: nothing to open yet. */
const NO_PANEL_YET = (): void => undefined;

/**
 * The Skills tab: every installed skill with its category, where it came from, how often the AI used it in the last
 * year, why it can or can't be used, and an on/off switch. The tab only lists and words what the Gateway returned; it
 * never decides whether a skill is usable, left out of the workspace or reviewed. Search and the two sets of buttons
 * narrow the list. Its list read stays enabled for as long as the tab is mounted, because the switches read the list
 * again through it after a change.
 */
export function SkillsTab() {
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  // The same cache entry the switches read again, so a skill reads the same everywhere it shows.
  const query = useQuery(skillListQuery(workspaceId));
  // The loaded list stays while it is read again, and beside a failed recheck.
  const view = recordView(query);
  const counts = useSkillUsage();
  const [search, setSearch] = useState("");
  const [chosenCategories, setChosenCategories] = useState<string[]>([]);
  const [chosenOrigins, setChosenOrigins] = useState<string[]>([]);
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
          Skills couldn't load.{query.error ? ` ${describeApiError(query.error).summary}` : ""}
        </p>
        <Button size="sm" loading={query.isFetching} loadingLabel="Retrying…" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const { items, candidatesWaiting = 0 } = response;
  const categoryOptions = skillCategoryOptions(items);
  const originOptions = skillOriginOptions(items);
  // A chosen button that no longer has a skill is dropped, so nothing filters the list without showing a button.
  const categories = chosenCategories.filter((id) => categoryOptions.some((option) => option.id === id));
  const origins = chosenOrigins.filter((id) => originOptions.some((option) => option.id === id));
  const shown = filterSkills(items, { query: search, categories, origins });
  const lastVersion = lastVersionNote(view);
  const clearFilters = () => {
    setSearch("");
    setChosenCategories([]);
    setChosenOrigins([]);
    // The button that was pressed is about to leave, so focus goes to the search box.
    filtersRegion.current?.querySelector("input")?.focus();
  };
  const retryList = (
    <Button size="sm" loading={query.isFetching} loadingLabel="Retrying…" onClick={() => void query.refetch()}>
      Retry
    </Button>
  );

  return (
    <div className="space-y-4">
      {items.length > 0 ? (
        <div ref={filtersRegion} className="space-y-3">
          <CapabilitySearch
            tabLabel="Skills"
            value={search}
            onChange={setSearch}
            placeholder={skillSearchSuggestion(items)}
          />
          {categoryOptions.length >= 2 ? (
            <CategoryFilter
              label="Categories"
              options={categoryOptions}
              selected={categories}
              onChange={setChosenCategories}
            />
          ) : null}
          {originOptions.length >= 2 ? (
            <CategoryFilter
              label="Where it came from"
              options={originOptions}
              selected={origins}
              onChange={setChosenOrigins}
              // There are four origins at most; none of them goes under a "+N" button.
              visibleCount={originOptions.length}
            />
          ) : null}
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
            {retryList}
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
              <SkillRow key={item.skillId} item={item} uses={counts.usesFor(item.skillId)} onView={NO_PANEL_YET} />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
