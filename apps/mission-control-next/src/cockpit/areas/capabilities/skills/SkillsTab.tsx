import { useQuery } from "@tanstack/react-query";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { skillListQuery } from "../../../data/capability-skills-query";
import { recordView } from "../../../data/record-view";
import { Button } from "../../../ui/Button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../ui/Tabs";
import { DiscoverView } from "./DiscoverView";
import { InstalledView } from "./InstalledView";
import { skillsHref, skillsViewFromSearch } from "./skill-links";
import { useSkillFilters } from "./use-skill-filters";
import { useSkillInstallPanel } from "./use-skill-install-panel";
import { useSkillPanel } from "./use-skill-panel";
import { useSkillUsage } from "./use-skill-usage";

/** The two segments read as one pill; the active one lifts onto the raised surface. */
const SEGMENT_LIST = "w-fit gap-0.5 rounded-lg border-b-0 bg-sunken p-0.5";
const SEGMENT = "min-h-8 rounded-md border-b-0 px-3 py-1 data-[state=active]:bg-raised";
const SEGMENT_PANEL = "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent";

/**
 * The Skills tab: the skills installed, and the skills on offer to install, as two views of one tab (Installed, the
 * default, and Discover, which `?view=discover` opens). Search and the category buttons are shared between them. The
 * tab only lists and words what the Gateway returned; it never decides whether a skill is usable, reviewed, installed
 * or installable.
 *
 * The tab, not a view, keeps the installed list read and the use counts read for as long as it is mounted, because the
 * switches and the open panel read the list again through it after a change, and a panel opened from Discover needs the
 * same list. The tab also owns the panels, so a skill's panel or an install panel opens from either view and closing it
 * returns to the view it was opened from. "Import from Git", beside the shared search, opens the install panel with an
 * address field; Discover's Install and Continue open it for a source the Gateway offers.
 */
export function SkillsTab() {
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const { search: address, navigate } = useCockpitRoute();
  const view = skillsViewFromSearch(address);
  const filters = useSkillFilters();
  // The same cache entry the switches read again, so a skill reads the same everywhere it shows.
  const query = useQuery(skillListQuery(workspaceId));
  const counts = useSkillUsage();
  const panel = useSkillPanel(recordView(query).record?.items, filters.setSearch);
  const installs = useSkillInstallPanel(panel.open);
  const importFromGit = <Button onClick={installs.importFromGit}>Import from Git</Button>;

  return (
    <Tabs
      value={view}
      onValueChange={(next) => navigate(skillsHref(next === "discover" ? "discover" : "installed"))}
      // A segment changes the address, so it waits for Enter or a press rather than following the arrow keys.
      activationMode="manual"
      className="space-y-4"
    >
      <TabsList aria-label="Skills view" className={SEGMENT_LIST}>
        <TabsTrigger value="installed" className={SEGMENT}>
          Installed
        </TabsTrigger>
        <TabsTrigger value="discover" className={SEGMENT}>
          Discover
        </TabsTrigger>
      </TabsList>
      <TabsContent value="installed" className={SEGMENT_PANEL}>
        <InstalledView
          query={query}
          counts={counts}
          filters={filters}
          onView={panel.open}
          searchActions={importFromGit}
        />
      </TabsContent>
      <TabsContent value="discover" className={SEGMENT_PANEL}>
        <DiscoverView
          workspaceId={workspaceId}
          filters={filters}
          onInstall={installs.install}
          onContinue={installs.resume}
          onViewInstalled={panel.open}
          searchActions={importFromGit}
        />
      </TabsContent>
    </Tabs>
  );
}
