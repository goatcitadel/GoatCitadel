import { ShieldCheck } from "lucide-react";
import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";
import {
  fetchCitadelCapabilities,
  resetCitadelCapabilities,
  updateCitadelCapabilities,
} from "@goatcitadel/mission-control-shared/api/client";
import { type SettingsSectionProps, SettingsGrid, SettingsPageFrame } from "../SettingsShared";
import { CapabilityScopePanel } from "./CapabilityScopePanel";

export function CitadelCapabilitiesSection({ activeCitadelId }: SettingsSectionProps) {
  const citadelId = activeCitadelId ?? DEFAULT_CITADEL_ID;
  return (
    <SettingsPageFrame
      icon={ShieldCheck}
      kicker="Settings"
      title="Citadel capabilities"
      description="Govern which skills, plugins, and MCP servers exist in this Citadel. Workspaces inherit this set by default."
    >
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
    </SettingsPageFrame>
  );
}
