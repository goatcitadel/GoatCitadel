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
  return (
    <TuneHubLayout
      title="Workspaces"
      subtitle="Workspace lifecycle, operating context, and optional extensions should read like environment control, not account management."
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
