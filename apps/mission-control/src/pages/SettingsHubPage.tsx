import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { PageTabs } from "../components/PageTabs";
import { SectionTitle } from "../components/SectionTitle";
import type { SettingsTab } from "../content/page-registry";
import { AddonsPage } from "./AddonsPage";
import { LlamaCppPage } from "./LlamaCppPage";
import { MeshPage } from "./MeshPage";
import { NpuPage } from "./NpuPage";
import { OnboardingPage } from "./OnboardingPage";
import { SettingsPage } from "./SettingsPage";
import { WorkspacesPage } from "./WorkspacesPage";

interface SettingsHubPageProps {
  activeTab: SettingsTab;
  activeWorkspaceId: string;
  onWorkspaceChange: (workspaceId: string) => void;
  onTabChange: (tab: SettingsTab) => void;
  onOnboardingCompleted?: () => void;
}

const ITEMS: Array<{ id: SettingsTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "access", label: "Access" },
  { id: "budget", label: "Budget" },
  { id: "runtime", label: "Runtime" },
  { id: "workspaces", label: "Workspaces" },
  { id: "addons", label: "Add-ons" },
  { id: "onboarding", label: "Onboarding" },
];

export function SettingsHubPage({
  activeTab,
  activeWorkspaceId,
  onWorkspaceChange,
  onTabChange,
  onOnboardingCompleted,
}: SettingsHubPageProps) {
  const rendersSettingsPage =
    activeTab === "general" || activeTab === "providers" || activeTab === "access" || activeTab === "budget";

  return (
    <section className="space-page settings-hub">
      <SectionTitle
        title="Settings"
        subtitle="Defaults, provider access, and workspace setup live here. Runtime-heavy controls stay grouped under Runtime."
      />
      <div className="settings-hub-grid">
        <PageTabs
          items={ITEMS}
          activeId={activeTab}
          onSelect={(value) => onTabChange(value as SettingsTab)}
          vertical
          className="settings-hub-nav"
        />
        <div className="settings-hub-content">
          <EmbeddedPageChromeProvider>
            {rendersSettingsPage ? <SettingsPage activeTab={activeTab} /> : null}
            {activeTab === "runtime" ? (
              <div className="stack-lg">
                <SettingsPage activeTab={activeTab} />
                <MeshPage />
                <LlamaCppPage />
                <NpuPage />
              </div>
            ) : null}
            {activeTab === "workspaces" ? (
              <WorkspacesPage activeWorkspaceId={activeWorkspaceId} onWorkspaceChange={onWorkspaceChange} />
            ) : null}
            {activeTab === "addons" ? <AddonsPage /> : null}
            {activeTab === "onboarding" ? <OnboardingPage onCompleted={onOnboardingCompleted} /> : null}
          </EmbeddedPageChromeProvider>
        </div>
      </div>
    </section>
  );
}
