import { preloadable } from "../../app/preloadable";

export const FirstRunArea = preloadable(async () => ({ default: (await import("./FirstRunArea")).FirstRunArea }));
export const FirstRunStatus = preloadable(async () => ({ default: (await import("./FirstRunStatus")).FirstRunStatus }));
export const AppearanceSettings = preloadable(async () => ({
  default: (await import("./AppearanceSettings")).AppearanceSettings,
}));
export const DeviceAccessSettings = preloadable(async () => ({
  default: (await import("./DeviceAccessSettings")).DeviceAccessSettings,
}));
export const PersonalitySettings = preloadable(async () => ({
  default: (await import("./PersonalitySettings")).PersonalitySettings,
}));
export const WorkspaceSettings = preloadable(async () => ({
  default: (await import("./WorkspaceSettings")).WorkspaceSettings,
}));
export const IntegrationConnectionsSettings = preloadable(async () => ({
  default: (await import("./IntegrationConnectionsSettings")).IntegrationConnectionsSettings,
}));
export const ManagedRuntimeSettings = preloadable(async () => ({
  default: (await import("./ManagedRuntimeSettings")).ManagedRuntimeSettings,
}));
export const McpServersSettings = preloadable(async () => ({
  default: (await import("./McpServersSettings")).McpServersSettings,
}));
export const BudgetModeControl = preloadable(async () => ({
  default: (await import("./BudgetModeControl")).BudgetModeControl,
}));
export const ApprovalModeControl = preloadable(async () => ({
  default: (await import("./ApprovalModeControl")).ApprovalModeControl,
}));
export const SettingsApprovalSkipControl = preloadable(async () => ({
  default: (await import("./SettingsApprovalSkipControl")).SettingsApprovalSkipControl,
}));
export const FilesystemWriteRootsControl = preloadable(async () => ({
  default: (await import("./FilesystemWriteRootsControl")).FilesystemWriteRootsControl,
}));
export const ModelsSettings = preloadable(async () => ({ default: (await import("./ModelsSettings")).ModelsSettings }));
export const WebSearchSettings = preloadable(async () => ({
  default: (await import("./WebSearchSettings")).WebSearchSettings,
}));
export const ClaudeCliToolBridgeControl = preloadable(async () => ({
  default: (await import("./ClaudeCliToolBridgeControl")).ClaudeCliToolBridgeControl,
}));
export const ClaudeCliWarmContinuationControl = preloadable(async () => ({
  default: (await import("./ClaudeCliWarmContinuationControl")).ClaudeCliWarmContinuationControl,
}));
export const BrowserErrandsControl = preloadable(async () => ({
  default: (await import("./BrowserErrandsControl")).BrowserErrandsControl,
}));
export const ChatThinkingStreamControl = preloadable(async () => ({
  default: (await import("./ChatThinkingStreamControl")).ChatThinkingStreamControl,
}));
export const ToolGrantSettings = preloadable(async () => ({
  default: (await import("./ToolGrantSettings")).ToolGrantSettings,
}));
export const SafetyCatalogSummary = preloadable(async () => ({
  default: (await import("./SafetyCatalogSummary")).SafetyCatalogSummary,
}));
export const PermissionProfileSettings = preloadable(async () => ({
  default: (await import("./PermissionProfileSettings")).PermissionProfileSettings,
}));
export const TrustPolicySettings = preloadable(async () => ({
  default: (await import("./TrustPolicySettings")).TrustPolicySettings,
}));
export const LocalAiSettings = preloadable(async () => ({
  default: (await import("./LocalAiSettings")).LocalAiSettings,
}));
export const CitadelBlueprintSettings = preloadable(async () => ({
  default: (await import("./CitadelBlueprintSettings")).CitadelBlueprintSettings,
}));
export const ChannelsSettings = preloadable(async () => ({
  default: (await import("./ChannelsSettings")).ChannelsSettings,
}));
export const PublicWebAddressSettings = preloadable(async () => ({
  default: (await import("./PublicWebAddressSettings")).PublicWebAddressSettings,
}));
export const CitadelOverviewSettings = preloadable(async () => ({
  default: (await import("./CitadelOverviewSettings")).CitadelOverviewSettings,
}));
export const CitadelMasonSettings = preloadable(async () => ({
  default: (await import("./CitadelMasonSettings")).CitadelMasonSettings,
}));
export const CitadelWardsSettings = preloadable(async () => ({
  default: (await import("./CitadelWardsSettings")).CitadelWardsSettings,
}));
export const CitadelCouncilSettings = preloadable(async () => ({
  default: (await import("./CitadelCouncilSettings")).CitadelCouncilSettings,
}));
export const CitadelVaultSettings = preloadable(async () => ({
  default: (await import("./CitadelVaultSettings")).CitadelVaultSettings,
}));
export const DaemonDiagnostics = preloadable(async () => ({
  default: (await import("./DaemonDiagnostics")).DaemonDiagnostics,
}));
export const VoiceRuntimeSettings = preloadable(async () => ({
  default: (await import("./VoiceRuntimeSettings")).VoiceRuntimeSettings,
}));
export const LlamaSetupSettings = preloadable(async () => ({
  default: (await import("./LlamaSetupSettings")).LlamaSetupSettings,
}));
export const CapabilityScopesSettings = preloadable(async () => ({
  default: (await import("./CapabilityScopesSettings")).CapabilityScopesSettings,
}));
export const HooksSettings = preloadable(async () => ({ default: (await import("./HooksSettings")).HooksSettings }));
export const PortablePacksSettings = preloadable(async () => ({
  default: (await import("./PortablePacksSettings")).PortablePacksSettings,
}));

const SECTION_CONTROLS: Record<string, readonly { preload: () => Promise<void> }[]> = {
  onboarding: [FirstRunStatus],
  general: [AppearanceSettings],
  personalities: [PersonalitySettings],
  access: [DeviceAccessSettings],
  workspaces: [WorkspaceSettings],
  "citadel-blueprint": [CitadelBlueprintSettings],
  "citadel-overview": [CitadelOverviewSettings],
  citadel: [CitadelMasonSettings],
  "citadel-wards": [CitadelWardsSettings],
  "citadel-council": [CitadelCouncilSettings],
  "citadel-vault": [CitadelVaultSettings],
  "citadel-capabilities": [CapabilityScopesSettings],
  "workspace-capabilities": [CapabilityScopesSettings],
  integrations: [IntegrationConnectionsSettings],
  channels: [PublicWebAddressSettings, ChannelsSettings],
  mcp: [McpServersSettings],
  "web-search": [WebSearchSettings],
  addons: [PortablePacksSettings],
  runtime: [ManagedRuntimeSettings, DaemonDiagnostics, VoiceRuntimeSettings],
  providers: [ModelsSettings, ChatThinkingStreamControl, ClaudeCliToolBridgeControl, ClaudeCliWarmContinuationControl],
  "local-ai": [LlamaSetupSettings, LocalAiSettings],
  permissions: [PermissionProfileSettings],
  hooks: [HooksSettings],
  tools: [
    ApprovalModeControl,
    SettingsApprovalSkipControl,
    BrowserErrandsControl,
    FilesystemWriteRootsControl,
    ToolGrantSettings,
    SafetyCatalogSummary,
  ],
  budget: [BudgetModeControl],
  "trust-policy": [TrustPolicySettings],
};

export function preloadSettingsSection(section: string): void {
  for (const control of SECTION_CONTROLS[section] ?? []) void control.preload();
}
