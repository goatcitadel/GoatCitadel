import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { PageTabs } from "../components/PageTabs";
import { SectionTitle } from "../components/SectionTitle";
import type { ActivityTab } from "../content/page-registry";
import { ActivityPage } from "./ActivityPage";
import { CronPage } from "./CronPage";
import { ImprovementPage } from "./ImprovementPage";

interface ActivityHubPageProps {
  activeTab: ActivityTab;
  workspaceId?: string;
  onTabChange: (tab: ActivityTab) => void;
}

const ITEMS: Array<{ id: ActivityTab; label: string }> = [
  { id: "activity", label: "Live feed" },
  { id: "scheduler", label: "Scheduler" },
  { id: "improvement", label: "Improvement" },
];

export function ActivityHubPage({ activeTab, workspaceId, onTabChange }: ActivityHubPageProps) {
  return (
    <section className="space-page stack-lg">
      <SectionTitle
        title="Activity"
        subtitle="Realtime events, scheduler health, and improvement signals live together here."
      />
      <PageTabs items={ITEMS} activeId={activeTab} onSelect={(value) => onTabChange(value as ActivityTab)} />
      <EmbeddedPageChromeProvider>
        {activeTab === "scheduler" ? <CronPage /> : null}
        {activeTab === "improvement" ? <ImprovementPage workspaceId={workspaceId} /> : null}
        {activeTab === "activity" ? <ActivityPage /> : null}
      </EmbeddedPageChromeProvider>
    </section>
  );
}
