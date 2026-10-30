import { useId } from "react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { CONNECTOR_SETUP_PATH } from "../../../app/routes";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { NativeOwnerLink } from "../../../ui/NativeOwnerLink";
import {
  IntegrationConnectionsSettings,
  McpServersSettings,
  WebSearchSettings,
} from "../../settings/settings-controls";
import { buildConnectorSetupPage, type SettingsIndexEntry } from "../../settings/settings-index";
import {
  SettingsSectionTabs,
  selectedSettingsSection,
  useSettingsSectionHash,
} from "../../settings/SettingsSectionTabs";
import { CONNECTORS_HREF } from "./connector-links";

const PAGE = buildConnectorSetupPage();

function SectionControls({ section, workspaceId }: { section: string; workspaceId: string }) {
  switch (section) {
    case "mcp":
      return <McpServersSettings workspaceId={workspaceId} />;
    case "integrations":
      return <IntegrationConnectionsSettings workspaceId={workspaceId} />;
    case "web-search":
      return <WebSearchSettings />;
    default:
      return null;
  }
}

/**
 * Capabilities › Connectors › Advanced setup: the full editors behind the Connectors list, for MCP servers, integration
 * connections and web search. They moved here unchanged from the retired Settings › Connections. A provider's sign-in
 * returns here (`#mcp-oauth-return&…`, `#google-oauth-return&…`), and the fragment opens the section that hands it back.
 */
export function ConnectorSetupPage() {
  const { search, navigate } = useCockpitRoute();
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const hash = useSettingsSectionHash();
  const selected = selectedSettingsSection(PAGE, undefined, hash);
  const headingId = useId();
  const openSection = (entry: SettingsIndexEntry) => navigate(`${CONNECTOR_SETUP_PATH}${search}#${entry.anchor}`);
  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={headingId} className="font-display text-lg font-semibold text-fg">
            Advanced setup
          </h2>
          <p className="mt-0.5 text-sm text-fg-secondary">
            Every setting behind the Connectors list: MCP servers, integration connections and web search.
          </p>
        </div>
        <NativeOwnerLink href={CONNECTORS_HREF} scope={activeWorkspaceId} className="text-sm">
          Back to Connectors
        </NativeOwnerLink>
      </div>
      {/* Another workspace or Citadel is another set of saved connections: its editors start afresh. */}
      <div key={JSON.stringify([activeCitadelId, activeWorkspaceId])} className="min-w-0">
        <SettingsSectionTabs page={PAGE} value={selected} onChange={openSection}>
          {(entry) => <SectionControls section={entry.section} workspaceId={activeWorkspaceId ?? ""} />}
        </SettingsSectionTabs>
      </div>
    </section>
  );
}
