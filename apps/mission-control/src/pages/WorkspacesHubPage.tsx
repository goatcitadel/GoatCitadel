import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { PageTabs } from "../components/PageTabs";
import { SectionTitle } from "../components/SectionTitle";
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
    <section className="space-page stack-lg">
      <SectionTitle
        title="Workspaces"
        subtitle="Workspace lifecycle, guidance, and optional runtime extensions share one Tune surface."
      />
      <PageTabs items={ITEMS} activeId={activeTab} onSelect={(value) => onTabChange(value as WorkspacesTab)} />
      <EmbeddedPageChromeProvider>
        {activeTab === "addons" ? <AddonsPage /> : <WorkspacesPage activeWorkspaceId={activeWorkspaceId} onWorkspaceChange={onWorkspaceChange} />}
      </EmbeddedPageChromeProvider>
    </section>
  );
}
