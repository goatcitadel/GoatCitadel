import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { TuneHubLayout } from "../components/TuneHubLayout";
import type { AgentsTab } from "../content/page-registry";
import { AgentsPage } from "./AgentsPage";
import { OfficeLabPage } from "./OfficeLabPage";
import { OfficePage } from "./OfficePage";
import { SkillsPage } from "./SkillsPage";

interface AgentsHubPageProps {
  activeTab: AgentsTab;
  onTabChange: (tab: AgentsTab) => void;
}

const ITEMS: Array<{ id: AgentsTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "herd-live", label: "Herd Live" },
  { id: "herd-lab", label: "Herd Lab" },
  { id: "skills", label: "Skills" },
];

export function AgentsHubPage({ activeTab, onTabChange }: AgentsHubPageProps) {
  return (
    <TuneHubLayout
      title="Agents"
      subtitle="Roster posture, special herd rooms, and reusable skills should feel like one control surface instead of separate products."
      guideTitle="What this controls"
      guideBody="Use Agents to decide who is available, which room you are operating in, and how reusable behavior is shaped before work starts."
      tabItems={ITEMS}
      activeTab={activeTab}
      onTabChange={(value) => onTabChange(value as AgentsTab)}
      tabAriaLabel="Agent control sections"
    >
      <EmbeddedPageChromeProvider>
        {activeTab === "overview" ? <AgentsPage /> : null}
        {activeTab === "herd-live" ? <OfficePage onOpenLab={() => onTabChange("herd-lab")} /> : null}
        {activeTab === "herd-lab" ? <OfficeLabPage onOpenImmersive={() => onTabChange("herd-live")} /> : null}
        {activeTab === "skills" ? <SkillsPage /> : null}
      </EmbeddedPageChromeProvider>
    </TuneHubLayout>
  );
}
