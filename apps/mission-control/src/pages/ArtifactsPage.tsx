import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { PageTabs } from "../components/PageTabs";
import { SectionTitle } from "../components/SectionTitle";
import type { ArtifactsTab } from "../content/page-registry";
import { FilesPage } from "./FilesPage";
import { MemoryPage } from "./MemoryPage";

interface ArtifactsPageProps {
  activeTab: ArtifactsTab;
  workspaceId?: string;
  onTabChange: (tab: ArtifactsTab) => void;
}

const ITEMS: Array<{ id: ArtifactsTab; label: string }> = [
  { id: "memory", label: "Memory" },
  { id: "files", label: "Files" },
];

export function ArtifactsPage({ activeTab, workspaceId, onTabChange }: ArtifactsPageProps) {
  return (
    <section className="space-page stack-lg">
      <SectionTitle
        eyebrow="Observe"
        title="Artifacts"
        subtitle="Workspace memory and file trails share one operational browser."
      />
      <PageTabs items={ITEMS} activeId={activeTab} onSelect={(value) => onTabChange(value as ArtifactsTab)} />
      <EmbeddedPageChromeProvider>
        {activeTab === "files" ? <FilesPage workspaceId={workspaceId} /> : <MemoryPage workspaceId={workspaceId} />}
      </EmbeddedPageChromeProvider>
    </section>
  );
}
