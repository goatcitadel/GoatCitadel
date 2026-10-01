import { runCockpitProviderConnectionProof } from "./cockpit-provider-connection-proof.mjs";
import { runCockpitWorkArtifactProof } from "./cockpit-work-artifact-proof.mjs";
import { runCockpitLibraryLinkProof } from "./cockpit-library-link-proof.mjs";
import { runCockpitLibraryPolicyProof } from "./cockpit-library-policy-proof.mjs";
import { runCockpitWorkContextProof } from "./cockpit-work-context-proof.mjs";
import { runCockpitWorkLineageProof } from "./cockpit-work-lineage-proof.mjs";
import { runCockpitApprovalModeProof } from "./cockpit-approval-mode-proof.mjs";
import { runCockpitHealthRuntimeProof } from "./cockpit-health-runtime-proof.mjs";
import { runCockpitDeviceAccessProof } from "./cockpit-device-access-proof.mjs";
import { runCockpitPersonalityProof } from "./cockpit-personality-proof.mjs";
import { runCockpitWorkspacesProof } from "./cockpit-workspaces-proof.mjs";
import { runCockpitIntegrationConnectionsProof } from "./cockpit-integration-connections-proof.mjs";
import { runCockpitManagedRuntimeProof } from "./cockpit-managed-runtime-proof.mjs";
import { runCockpitMcpServersProof } from "./cockpit-mcp-servers-proof.mjs";
import { runCockpitLibraryResourcesProof } from "./cockpit-library-resources-proof.mjs";
import { runCockpitChatThreadActionsProof } from "./cockpit-chat-thread-actions-proof.mjs";
import { runCockpitChatArtifactEditProof } from "./cockpit-chat-artifact-edit-proof.mjs";
import { runCockpitAppearanceProof } from "./cockpit-appearance-proof.mjs";
import { runCockpitPermissionProfileProof } from "./cockpit-permission-profile-proof.mjs";
import { runCockpitSystemQualityProof } from "./cockpit-system-quality-proof.mjs";
import { runCockpitSettingsTabsProof } from "./cockpit-settings-tabs-proof.mjs";
import { runCockpitTrustPolicyProof } from "./cockpit-trust-policy-proof.mjs";
import { runCockpitLocalAiProof } from "./cockpit-local-ai-proof.mjs";
import { runCockpitMcpEditorProof } from "./cockpit-mcp-editor-proof.mjs";
import { runCockpitToolGrantsProof } from "./cockpit-tool-grants-proof.mjs";
import { runCockpitMcpRegistrationProof } from "./cockpit-mcp-registration-proof.mjs";
import { runCockpitCitadelDirectoryProof } from "./cockpit-citadel-directory-proof.mjs";
import { runCockpitProviderManagementProof } from "./cockpit-provider-management-proof.mjs";
import { runCockpitCitadelBlueprintProof } from "./cockpit-citadel-blueprint-proof.mjs";
import { runCockpitMcpPolicyRequestsProof } from "./cockpit-mcp-policy-requests-proof.mjs";
import { runCockpitGatewayAuthProof } from "./cockpit-gateway-auth-proof.mjs";
import { runCockpitChannelsProof } from "./cockpit-channels-proof.mjs";
import { runCockpitRuntimeControlsProof } from "./cockpit-runtime-controls-proof.mjs";
import { runCockpitMcpConnectionProof } from "./cockpit-mcp-connection-proof.mjs";
import { runCockpitLlamaSetupProof } from "./cockpit-llama-setup-proof.mjs";
import { runCockpitCitadelOverviewProof } from "./cockpit-citadel-overview-proof.mjs";
import { runCockpitIntegrationManagementProof } from "./cockpit-integration-management-proof.mjs";
import { runCockpitMcpOAuthProof } from "./cockpit-mcp-oauth-proof.mjs";
import { runCockpitCitadelMasonProof } from "./cockpit-citadel-mason-proof.mjs";
import { runCockpitCitadelWardsProof } from "./cockpit-citadel-wards-proof.mjs";
import { runCockpitCitadelCouncilProof } from "./cockpit-citadel-council-proof.mjs";
import { runCockpitCitadelVaultProof } from "./cockpit-citadel-vault-proof.mjs";
import { runCockpitNotificationRoutingProof } from "./cockpit-notification-routing-proof.mjs";
import { runCockpitIntegrationMeetProof } from "./cockpit-integration-meet-proof.mjs";
import { runCockpitHooksProof } from "./cockpit-hooks-proof.mjs";
import { runCockpitCapabilityScopesProof } from "./cockpit-capability-scopes-proof.mjs";
import { runCockpitAddonsProof } from "./cockpit-addons-proof.mjs";
import { runCockpitPortablePacksProof } from "./cockpit-portable-packs-proof.mjs";
import { runCockpitScheduleLifecycleProof } from "./cockpit-schedule-lifecycle-proof.mjs";
import { runCockpitTaskLifecycleProof } from "./cockpit-task-lifecycle-proof.mjs";
import { runCockpitMcpModePreviewsProof } from "./cockpit-mcp-mode-previews-proof.mjs";
import { runCockpitFirstRunAdvancedProof } from "./cockpit-first-run-advanced-proof.mjs";
import { runCockpitChatBackgroundActiveProof } from "./cockpit-chat-background-active-proof.mjs";
import { runCockpitPermissionManagementProof } from "./cockpit-permission-management-proof.mjs";
import { runCockpitCommandPaletteProof } from "./cockpit-command-palette-proof.mjs";
import { runCockpitInboxViewedProof } from "./cockpit-inbox-viewed-proof.mjs";
import { runCockpitShellControlsProof } from "./cockpit-shell-controls-proof.mjs";
import { runCockpitLongListsProof } from "./cockpit-long-lists-proof.mjs";

const OWNER_PROOFS = {
  "command-palette": runCockpitCommandPaletteProof,
  "inbox-viewed": runCockpitInboxViewedProof,
  hooks: runCockpitHooksProof,
  "capability-scopes": runCockpitCapabilityScopesProof,
  addons: runCockpitAddonsProof,
  "portable-packs": runCockpitPortablePacksProof,
  "schedule-lifecycle": runCockpitScheduleLifecycleProof,
  "task-lifecycle": runCockpitTaskLifecycleProof,
  "mcp-mode-previews": runCockpitMcpModePreviewsProof,
  "first-run-advanced": runCockpitFirstRunAdvancedProof,
  "chat-background-active": runCockpitChatBackgroundActiveProof,
  "permission-management": runCockpitPermissionManagementProof,
  "integration-meet": runCockpitIntegrationMeetProof,
  "notification-routing": runCockpitNotificationRoutingProof,
  "citadel-vault": runCockpitCitadelVaultProof,
  "citadel-council": runCockpitCitadelCouncilProof,
  "citadel-wards": runCockpitCitadelWardsProof,
  "mcp-oauth": runCockpitMcpOAuthProof,
  "citadel-mason": runCockpitCitadelMasonProof,
  "integration-management": runCockpitIntegrationManagementProof,
  "citadel-overview": runCockpitCitadelOverviewProof,
  "runtime-controls": runCockpitRuntimeControlsProof,
  "mcp-connection": runCockpitMcpConnectionProof,
  "llama-setup": runCockpitLlamaSetupProof,
  channels: runCockpitChannelsProof,
  "gateway-auth": runCockpitGatewayAuthProof,
  "citadel-blueprint": runCockpitCitadelBlueprintProof,
  "mcp-policy-requests": runCockpitMcpPolicyRequestsProof,
  "provider-connection": runCockpitProviderConnectionProof,
  "work-artifact": runCockpitWorkArtifactProof,
  "library-links": runCockpitLibraryLinkProof,
  "library-policy": runCockpitLibraryPolicyProof,
  "work-context": runCockpitWorkContextProof,
  "work-lineage": runCockpitWorkLineageProof,
  "approval-mode": runCockpitApprovalModeProof,
  "health-runtime": runCockpitHealthRuntimeProof,
  "device-access": runCockpitDeviceAccessProof,
  personality: runCockpitPersonalityProof,
  workspaces: runCockpitWorkspacesProof,
  "integration-connections": runCockpitIntegrationConnectionsProof,
  "managed-runtime": runCockpitManagedRuntimeProof,
  "mcp-servers": runCockpitMcpServersProof,
  "library-resources": runCockpitLibraryResourcesProof,
  "chat-thread-actions": runCockpitChatThreadActionsProof,
  "chat-artifact-edit": runCockpitChatArtifactEditProof,
  appearance: runCockpitAppearanceProof,
  "permission-profile": runCockpitPermissionProfileProof,
  "system-quality": runCockpitSystemQualityProof,
  "settings-tabs": runCockpitSettingsTabsProof,
  "trust-policy": runCockpitTrustPolicyProof,
  "local-ai": runCockpitLocalAiProof,
  "mcp-editor": runCockpitMcpEditorProof,
  "tool-grants": runCockpitToolGrantsProof,
  "mcp-registration": runCockpitMcpRegistrationProof,
  "citadel-directory": runCockpitCitadelDirectoryProof,
  "provider-management": runCockpitProviderManagementProof,
  "shell-controls": runCockpitShellControlsProof,
  "long-lists": runCockpitLongListsProof,
};

export function selectCockpitOwnerProofs(names) {
  if (names === undefined) return Object.values(OWNER_PROOFS);
  if (
    !Array.isArray(names) ||
    !names.length ||
    names.some((name) => typeof name !== "string" || !Object.hasOwn(OWNER_PROOFS, name))
  ) {
    throw new Error(`Choose one or more cockpit owner proofs: ${Object.keys(OWNER_PROOFS).join(", ")}`);
  }
  return [...new Set(names)].map((name) => OWNER_PROOFS[name]);
}
