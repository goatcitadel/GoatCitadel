import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";
import { fetchCitadelCapabilities } from "@goatcitadel/mission-control-shared/api/client";
import { type SettingsSectionProps, SettingsGrid } from "../SettingsShared";
import { CapabilityScopePanel } from "./CapabilityScopePanel";

export function CitadelCapabilitiesSection({ activeCitadelId }: SettingsSectionProps) {
  const citadelId = activeCitadelId ?? DEFAULT_CITADEL_ID;
  return (
    <SettingsGrid>
      <CapabilityScopePanel
        scopeKind="citadel"
        scopeId={citadelId}
        resourceType="skill"
        title="Skills"
        fetchScope={fetchCitadelCapabilities}
      />
      <CapabilityScopePanel
        scopeKind="citadel"
        scopeId={citadelId}
        resourceType="integration"
        title="Plugins"
        fetchScope={fetchCitadelCapabilities}
      />
      <CapabilityScopePanel
        scopeKind="citadel"
        scopeId={citadelId}
        resourceType="mcp_server"
        title="MCP"
        fetchScope={fetchCitadelCapabilities}
      />
    </SettingsGrid>
  );
}
