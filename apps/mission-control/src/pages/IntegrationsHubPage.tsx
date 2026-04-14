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
  const postureNote =
    activeTab === "channels"
      ? "Keep delivery testing and runtime evidence beside the channel setup, not buried below it."
      : activeTab === "mcp"
        ? "MCP should read like operator infrastructure with status and grants close at hand."
        : "Overview keeps the catalog, connection posture, and operator actions in one lane.";

  return (
    <TuneHubLayout
      title="Integrations"
      subtitle="Connections, transport hooks, and MCP reach stay framed as operator decisions instead of a connector catalog."
      summaries={[
        { label: "Active lane", value: activeLabel, note: "Current operator section", tone: "accent" },
        {
          label: "Default posture",
          value: activeTab === "mcp" ? "Infrastructure first" : "Setup beside evidence",
          note: postureNote,
        },
        {
          label: "Operator focus",
          value:
            activeTab === "channels"
              ? "Delivery validation"
              : activeTab === "mcp"
                ? "Runtime reach"
                : "Connection posture",
          note: "Keep external reach deliberate and inspectable.",
        },
      ]}
      summaryMode="posture"
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
