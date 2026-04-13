import { EmbeddedPageChromeProvider } from "../components/EmbeddedPageChrome";
import { TuneHubLayout } from "../components/TuneHubLayout";
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
  const activeLabel = ITEMS.find((item) => item.id === activeTab)?.label ?? "Overview";
  const postureSummary =
    activeTab === "channels"
      ? "Inbound and outbound communication routes are being tuned."
      : activeTab === "mcp"
        ? "Tool connectors and MCP reach define what agents can touch."
        : "Review connector posture before expanding runtime reach.";

  return (
    <TuneHubLayout
      title="Integrations"
      subtitle="Connections, transport hooks, and MCP reach stay framed as operator decisions instead of a connector catalog."
      summaries={[
        { label: "Current lane", value: activeLabel, note: "The active integration decision", tone: "accent" },
        {
          label: "Reach posture",
          value: activeTab === "mcp" ? "Tool reach" : "Connection reach",
          note: postureSummary,
        },
        {
          label: "Risk cue",
          value: "External effects",
          note: "Changes here alter what the gateway can call, route, or expose",
        },
      ]}
      guideTitle="What this controls"
      guideBody="Use Integrations to decide how Mission Control talks to the outside world, not just which panels are configured."
      tabItems={ITEMS}
      activeTab={activeTab}
      onTabChange={(value) => onTabChange(value as IntegrationsTab)}
      tabAriaLabel="Integrations sections"
    >
      <EmbeddedPageChromeProvider>
        {activeTab === "mcp" ? (
          <McpPage />
        ) : activeTab === "channels" ? (
          <ChannelSetupPage />
        ) : (
          <IntegrationsPage view="overview" />
        )}
      </EmbeddedPageChromeProvider>
    </TuneHubLayout>
  );
}
