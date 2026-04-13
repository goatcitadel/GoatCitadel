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
  const activeLabel = ITEMS.find((item) => item.id === activeTab)?.label ?? "Overview";
  const operatorFocus =
    activeTab === "herd-live"
      ? "Watch live herd posture and intervene while work is running."
      : activeTab === "herd-lab"
        ? "Use the lab when you need a controlled room for structured experimentation."
        : activeTab === "skills"
          ? "Tighten reusable behavior before you add more agents."
          : "Keep the roster, rooms, and skill system aligned.";

  return (
    <TuneHubLayout
      title="Agents"
      subtitle="Roster posture, special herd rooms, and reusable skills should feel like one control surface instead of separate products."
      summaries={[
        { label: "Current lane", value: activeLabel, note: "The active agent-control surface", tone: "accent" },
        {
          label: "Special rooms",
          value: "Contained",
          note: "Herd Live and Herd Lab stay memorable without becoming the default chrome",
        },
        { label: "Operator focus", value: "Herd + skills", note: operatorFocus },
      ]}
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
