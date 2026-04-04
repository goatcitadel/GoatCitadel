import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { PageTabs } from "../components/PageTabs";
import { SectionTitle } from "../components/SectionTitle";
import type { IntegrationsTab } from "../content/page-registry";
import { ChannelSetupPage } from "./ChannelSetupPage";
import { IntegrationsPage } from "./IntegrationsPage";
import { McpPage } from "./McpPage";

interface IntegrationsHubPageProps {
  activeTab: IntegrationsTab;
  onTabChange: (tab: IntegrationsTab) => void;
}

const ITEMS: Array<{ id: IntegrationsTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "channels", label: "Channels" },
  { id: "mcp", label: "MCP" },
];

export function IntegrationsHubPage({ activeTab, onTabChange }: IntegrationsHubPageProps) {
  return (
    <section className="space-page stack-lg">
      <SectionTitle
        title="Integrations"
        subtitle="Connections, provider hooks, and MCP servers belong in one setup surface."
      />
      <PageTabs items={ITEMS} activeId={activeTab} onSelect={(value) => onTabChange(value as IntegrationsTab)} />
      <EmbeddedPageChromeProvider>
        {activeTab === "mcp"
          ? <McpPage />
          : activeTab === "channels"
            ? <ChannelSetupPage />
            : <IntegrationsPage view="overview" />}
      </EmbeddedPageChromeProvider>
    </section>
  );
}
