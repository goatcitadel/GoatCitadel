import { PageTabs } from "../components/PageTabs";
import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { ActivityPage } from "./ActivityPage";
import { CronPage } from "./CronPage";
import { ImprovementPage } from "./ImprovementPage";
import { SessionsPage } from "./SessionsPage";

export type TimelineTab = "activity" | "sessions" | "scheduler" | "improvement";

interface TimelinePageProps {
  activeTab: TimelineTab;
  workspaceId?: string;
  showTechnicalDetails?: boolean;
  onTabChange: (tab: TimelineTab) => void;
}

const ITEMS: Array<{ id: TimelineTab; label: string }> = [
  { id: "activity", label: "Live feed" },
  { id: "sessions", label: "Sessions" },
  { id: "scheduler", label: "Scheduler" },
  { id: "improvement", label: "Improvement" },
];

export function TimelinePage({
  activeTab,
  workspaceId,
  showTechnicalDetails: _showTechnicalDetails,
  onTabChange,
}: TimelinePageProps) {
  return (
    <section className="space-page stack-lg">
      <PageTabs
        items={ITEMS}
        activeId={activeTab}
        tier="section"
        ariaLabel="Timeline focus"
        onSelect={(value) => onTabChange(value as TimelineTab)}
      />
      <EmbeddedPageChromeProvider>
        {activeTab === "activity" ? <ActivityPage /> : null}
        {activeTab === "sessions" ? <SessionsPage /> : null}
        {activeTab === "scheduler" ? <CronPage /> : null}
        {activeTab === "improvement" ? <ImprovementPage workspaceId={workspaceId} /> : null}
      </EmbeddedPageChromeProvider>
    </section>
  );
}
