import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { PageTabs } from "../components/PageTabs";
import { SectionTitle } from "../components/SectionTitle";
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
    <section className="space-page stack-lg">
      <SectionTitle
        title="Agents"
        subtitle="Manage your roster, inspect the herd, and tune reusable skills."
      />
      <PageTabs items={ITEMS} activeId={activeTab} onSelect={(value) => onTabChange(value as AgentsTab)} />
      <EmbeddedPageChromeProvider>
        {activeTab === "overview" ? <AgentsPage /> : null}
        {activeTab === "herd-live" ? <OfficePage onOpenLab={() => onTabChange("herd-lab")} /> : null}
        {activeTab === "herd-lab" ? <OfficeLabPage onOpenImmersive={() => onTabChange("herd-live")} /> : null}
        {activeTab === "skills" ? <SkillsPage /> : null}
      </EmbeddedPageChromeProvider>
    </section>
  );
}
