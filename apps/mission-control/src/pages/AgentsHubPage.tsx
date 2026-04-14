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
  const operatorNote =
    activeTab === "skills"
      ? "Keep reusable behavior visible without forcing skill catalog chrome above the work."
      : activeTab === "herd-lab"
        ? "Lab mode should feel experimental but still structured."
        : activeTab === "herd-live"
          ? "Live rooms should foreground current posture, not onboarding copy."
          : "Overview stays focused on roster posture and availability.";

  return (
    <TuneHubLayout
      title="Agents"
      subtitle="Roster posture, special herd rooms, and reusable skills should feel like one control surface instead of separate products."
      summaries={[
        { label: "Current lane", value: activeLabel, note: "Active agent space", tone: "accent" },
        {
          label: "Roster posture",
          value: activeTab === "skills" ? "Behavior shaping" : "Agent availability",
          note: operatorNote,
        },
        {
          label: "Operator focus",
          value:
            activeTab === "skills"
              ? "Reusable skills"
              : activeTab === "herd-lab"
                ? "Experiment safely"
                : "Watch the roster",
          note: "Agent controls should stay compact and inspectable.",
        },
      ]}
      summaryMode="posture"
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
