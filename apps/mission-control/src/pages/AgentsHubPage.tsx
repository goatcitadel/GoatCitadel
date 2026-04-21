import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { ConfigureHubLayout } from "../components/ConfigureHubLayout";
import type { AgentsTab } from "../content/page-registry";
import { AgentsPage } from "./AgentsPage";
import { AgentsBoardPage } from "./AgentsBoardPage";
import { AgentsCatalogPage } from "./AgentsCatalogPage";
import { SkillsPage } from "./SkillsPage";

interface AgentsHubPageProps {
  activeTab: AgentsTab;
  workspaceId?: string;
  sessionId?: string;
  onTabChange: (tab: AgentsTab) => void;
}

const ITEMS: Array<{ id: AgentsTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "board", label: "Board" },
  { id: "skills", label: "Skills" },
  { id: "catalog", label: "Catalog" },
];

export function AgentsHubPage({ activeTab, workspaceId, sessionId, onTabChange }: AgentsHubPageProps) {
  const activeLabel = ITEMS.find((item) => item.id === activeTab)?.label ?? "Overview";
  const operatorNote =
    activeTab === "skills"
      ? "Keep reusable behavior visible without forcing skill catalog chrome above the work."
      : activeTab === "catalog"
        ? "Imported specialists stay searchable and inspectable until the operator activates them for a session."
        : activeTab === "board"
          ? "The board should make workload and trace state legible at a glance."
          : "Overview stays focused on roster posture and availability.";

  return (
    <ConfigureHubLayout
      className={activeTab === "board" ? "agents-hub-layout-board" : undefined}
      title="Agents"
      subtitle="Roster, board visibility, and reusable skills in one control surface."
      summaries={[
        { label: "Current lane", value: activeLabel, note: "Active agent space", tone: "accent" },
        {
          label: "Roster posture",
          value:
            activeTab === "skills"
              ? "Behavior shaping"
              : activeTab === "catalog"
                ? "Dormant specialists"
                : "Agent availability",
          note: operatorNote,
        },
        {
          label: "Operator focus",
          value:
            activeTab === "skills"
              ? "Reusable skills"
              : activeTab === "catalog"
                ? "Dormant imports"
                : activeTab === "board"
                  ? "Review the board"
                  : "Review the roster",
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
        {activeTab === "board" ? <AgentsBoardPage /> : null}
        {activeTab === "skills" ? <SkillsPage /> : null}
        {activeTab === "catalog" ? <AgentsCatalogPage workspaceId={workspaceId} sessionId={sessionId} /> : null}
      </EmbeddedPageChromeProvider>
    </ConfigureHubLayout>
  );
}
