import { CHAT_VIEWPORTS } from "./ux-budget-measurements.mjs";
import { runCockpitChatBranchProof } from "./cockpit-chat-branch-proof.mjs";
import { runCockpitProviderCatalogProof } from "./cockpit-provider-catalog-proof.mjs";
import { runCockpitProviderConnectionProof } from "./cockpit-provider-connection-proof.mjs";
import { runCockpitWorkHistoryProof } from "./cockpit-work-history-proof.mjs";
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
import { runCockpitShellControlsProof } from "./cockpit-shell-controls-proof.mjs";
import { runCockpitLongListsProof } from "./cockpit-long-lists-proof.mjs";

export async function runUxBudgetOwnerExtensions(environment) {
  const { context, browser, stack, fixture, stub, deps } = environment;
  await runCockpitChatBranchProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitProviderCatalogProof({
    context,
    browser,
    stack,
    fixture,
    providerId: stub.providerId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitProviderConnectionProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitWorkHistoryProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitWorkArtifactProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });

  await runCockpitLibraryLinkProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitLibraryPolicyProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitWorkContextProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitWorkLineageProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitApprovalModeProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitHealthRuntimeProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitDeviceAccessProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitPersonalityProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitWorkspacesProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitCitadelDirectoryProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitMcpRegistrationProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitProviderManagementProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitIntegrationConnectionsProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitManagedRuntimeProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitMcpServersProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitLibraryResourcesProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitChatThreadActionsProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
    providerStub: stub,
  });
  await runCockpitChatArtifactEditProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitAppearanceProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitPermissionProfileProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitSystemQualityProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitSettingsTabsProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitTrustPolicyProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitLocalAiProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitMcpEditorProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitToolGrantsProof({
    context,
    browser,
    stack,
    citadelId: fixture.citadelId,
    viewports: CHAT_VIEWPORTS,
    deps,
  });
  await runCockpitShellControlsProof({ context, browser, stack, citadelId: fixture.citadelId, viewports: CHAT_VIEWPORTS, deps });
  await runCockpitLongListsProof({ context, browser, stack, citadelId: fixture.citadelId, viewports: CHAT_VIEWPORTS, deps });
}
