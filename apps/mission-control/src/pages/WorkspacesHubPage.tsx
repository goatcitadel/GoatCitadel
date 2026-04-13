import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { TuneHubLayout } from "../components/TuneHubLayout";
import { AddonsPage } from "./AddonsPage";
import { WorkspacesPage } from "./WorkspacesPage";

export type WorkspacesTab = "workspaces" | "addons";

interface WorkspacesHubPageProps {
  activeTab: WorkspacesTab;
  activeWorkspaceId: string;
  onWorkspaceChange: (workspaceId: string) => void;
  onTabChange: (tab: WorkspacesTab) => void;
}

const ITEMS: Array<{ id: WorkspacesTab; label: string }> = [
  { id: "workspaces", label: "Workspaces" },
  { id: "addons", label: "Add-ons" },
];

export function WorkspacesHubPage({
  activeTab,
  activeWorkspaceId,
  onWorkspaceChange,
  onTabChange,
}: WorkspacesHubPageProps) {
  const activeLabel = ITEMS.find((item) => item.id === activeTab)?.label ?? "Workspaces";

  return (
    <TuneHubLayout
      title="Workspaces"
      subtitle="Workspace lifecycle, operating context, and optional extensions should read like environment control, not account management."
      summaries={[
        { label: "Current lane", value: activeLabel, note: "The active workspace decision", tone: "accent" },
        { label: "Selected workspace", value: activeWorkspaceId, note: "Current workspace scope for Tune" },
        {
          label: "Operator focus",
          value: activeTab === "addons" ? "Optional extensions" : "Workspace posture",
          note:
            activeTab === "addons"
              ? "Review what should extend the runtime"
              : "Set the workspace context before you broaden tooling",
        },
      ]}
      guideTitle="What this controls"
      guideBody="Use Workspaces to shape where Mission Control is operating before you start changing runtime, models, or integrations."
      tabItems={ITEMS}
      activeTab={activeTab}
      onTabChange={(value) => onTabChange(value as WorkspacesTab)}
      tabAriaLabel="Workspace control sections"
    >
      <EmbeddedPageChromeProvider>
        {activeTab === "addons" ? (
          <AddonsPage />
        ) : (
          <WorkspacesPage activeWorkspaceId={activeWorkspaceId} onWorkspaceChange={onWorkspaceChange} />
        )}
      </EmbeddedPageChromeProvider>
    </TuneHubLayout>
  );
}
