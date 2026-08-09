import {
  fetchWorkspaceCapabilities,
  resetWorkspaceCapabilities,
  updateWorkspaceCapabilities,
} from "@goatcitadel/mission-control-shared/api/client";
import { type SettingsSectionProps, SettingsGrid } from "../SettingsShared";
import { CapabilityScopePanel } from "./CapabilityScopePanel";

export function WorkspaceCapabilitiesSection({ activeWorkspaceId, route, navigate }: SettingsSectionProps) {
  return (
    <>
      <SettingsGrid>
        <CapabilityScopePanel
          scopeKind="workspace"
          scopeId={activeWorkspaceId}
          resourceType="skill"
          title="Skills"
          fetchScope={fetchWorkspaceCapabilities}
          updateScope={updateWorkspaceCapabilities}
          resetScope={resetWorkspaceCapabilities}
        />
        <CapabilityScopePanel
          scopeKind="workspace"
          scopeId={activeWorkspaceId}
          resourceType="integration"
          title="Plugins"
          fetchScope={fetchWorkspaceCapabilities}
          updateScope={updateWorkspaceCapabilities}
          resetScope={resetWorkspaceCapabilities}
        />
        <CapabilityScopePanel
          scopeKind="workspace"
          scopeId={activeWorkspaceId}
          resourceType="mcp_server"
          title="MCP"
          fetchScope={fetchWorkspaceCapabilities}
          updateScope={updateWorkspaceCapabilities}
          resetScope={resetWorkspaceCapabilities}
        />
      </SettingsGrid>
      <p className="mc-next-settings-field-note">
        Need a capability that isn't listed?{" "}
        <button
          type="button"
          className="mc-next-settings-link"
          onClick={() => navigate({ area: "settings", section: "citadel-capabilities", theme: route.theme })}
        >
          Grant it at the Citadel.
        </button>
      </p>
    </>
  );
}
