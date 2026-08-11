import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";
import {
  fetchCitadelCapabilities,
  resetCitadelCapabilities,
  updateCitadelCapabilities,
} from "@goatcitadel/mission-control-shared/api/client";
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
        updateScope={updateCitadelCapabilities}
        resetScope={resetCitadelCapabilities}
      />
      <CapabilityScopePanel
        scopeKind="citadel"
        scopeId={citadelId}
        resourceType="integration"
        title="Plugins"
        fetchScope={fetchCitadelCapabilities}
        updateScope={updateCitadelCapabilities}
        resetScope={resetCitadelCapabilities}
      />
      <CapabilityScopePanel
        scopeKind="citadel"
        scopeId={citadelId}
        resourceType="mcp_server"
        title="MCP"
        fetchScope={fetchCitadelCapabilities}
        updateScope={updateCitadelCapabilities}
        resetScope={resetCitadelCapabilities}
      />
    </SettingsGrid>
  );
}
