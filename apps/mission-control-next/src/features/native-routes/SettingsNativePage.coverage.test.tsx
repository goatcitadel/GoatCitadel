import { demoFixture } from "./settings/demo-bootstrap.test-support";
import { __resetOnboardingAttemptsForTests } from "./settings/onboarding-completion-state";
import { __resetDemoReceiptsForTests } from "./settings/demo-bootstrap-state";
import { __resetAuthAttemptsForTests } from "./settings/gateway-auth-state";
import { __resetVoiceAttemptsForTests } from "./settings/voice-runtime-state";
import { selectedVoiceRuntime, voiceRuntimeFixture } from "./settings/voice-runtime.test-support";
import { __resetToolGrantActionsForTests } from "./settings/use-tool-grant-actions";
import { __resetSettingsChangesForTests } from "./settings/use-settings-change";
import { __resetChannelMutationStateForTests } from "./settings/sections/channel-setup-state";
import { __resetProviderMutationStateForTests } from "./settings/sections/provider-mutation-state";
import { __resetManagedRuntimeUncertaintyForTests } from "./settings/managed-runtime-state";
import { __resetMcpServerMutationsForTests } from "./settings/mcp-server-mutation";
import { __resetPackAttemptsForTests } from "./settings/sections/pack-mutation-state";
import { __resetDeviceAccessRevocationsForTests } from "./settings/use-device-access-revocation";
import { DetailInspector } from "../../components/DetailInspector";
import { __resetSessionViewStateForTests } from "../../hooks/use-session-view-state";
import { DraftLeaveDialog } from "./library/DraftLeaveDialog";
import { __resetSessionDraftsForTests } from "./library/session-drafts";
import { __resetWorkspaceAttemptsForTests } from "./settings/workspace-editor-state";
import { __resetIntegrationConnectionMutationsForTests } from "./settings/integration-connection-mutation";
import { act, create as createRenderer, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsNativePage } from "./SettingsNativePage";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { GCModal } from "@goatcitadel/mission-control-shared/components/ui/GCModal";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { __resetFormDirtyRegistryForTests, hasDirtySections } from "./library/use-form-dirty";
import { UiPreferencesProvider } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import type { CapabilityPackManifest, CapabilityPackPreview, WorkspaceCreateInput, WorkspaceUpdateInput, WorkspaceRecord } from "@goatcitadel/contracts";

const mountedSettingsRenderers: ReactTestRenderer[] = [];
function create(...args: Parameters<typeof createRenderer>): ReactTestRenderer {
  const renderer = createRenderer(...args);
  mountedSettingsRenderers.push(renderer);
  return renderer;
}
beforeAll(async () => {
  // These suites exercise loaded editors; browser/bundle lanes cover lazy loading.
  await Promise.all(Object.values(import.meta.glob("./settings/sections/*Section.tsx")).map((load) => load()));
});
afterEach(async () => {
  await act(async () => {
    for (const renderer of mountedSettingsRenderers.splice(0)) renderer.unmount();
  });
});

const settingsMocks = vi.hoisted(() => {
  const fn = (value: unknown = {}) => vi.fn(async () => value);
  return {
    archiveWorkspace: vi.fn<typeof import("@goatcitadel/mission-control-shared/api/client").archiveWorkspace>(),
    archiveCitadel: fn(),
    archivePermissionProfile: fn(),
    activatePermissionProfile: fn(),
    bootstrapDemo: fn(),
    bootstrapOnboarding: vi.fn<(input: import("@goatcitadel/contracts").OnboardingBootstrapInput) => Promise<unknown>>(),
    createExternalSideEffectReplayAuditRun: fn(),
    completeOnboarding: fn(),
    connectMcpServer: fn(),
    connectReviewedMcpServer: vi.fn(async (_id: string, _review: { expectedRevision: string; expectedConnectionRevision: string | null }): Promise<Record<string, unknown>> => ({})),
    disconnectReviewedMcpServer: vi.fn(async (_id: string, _review: { expectedRevision: string; expectedConnectionRevision: string | null }): Promise<Record<string, unknown>> => ({})),
    createChangePlan: vi.fn(async (input: any) => ({
      schemaVersion: 1,
      planId: "plan-oauth-1",
      origin: {
        surface: input.surface ?? "settings",
        workspaceId: input.workspaceId ?? "default",
        actorId: "operator-test",
      },
      kind: input.request?.kind ?? "provider_connection",
      scope: "provider",
      phase: "intent",
      status: input.request?.credentialAction === "remove_oauth" ? "awaiting_confirmation" : "awaiting_input",
      revision: 1,
      adapter: { adapterId: "provider-connection", version: 3 },
      request: input.request,
      target: { ownerId: "provider_connection", resourceId: input.request?.providerId ?? "openai-codex" },
      title: "Connect provider",
      summary: "Use the dedicated plan-bound credential owner.",
      impact: "The credential remains outside Chat and model context.",
      risk: "safe",
      requiredAction:
        input.request?.credentialAction === "remove_oauth"
          ? {
              kind: "confirmation",
              actionId: "confirm-oauth",
              actionNonce: "confirmation-nonce-123456",
              purpose: "apply",
              title: "Confirm disconnect",
              confirmationText: "Disconnect OAuth.",
            }
          : {
              kind: "oauth",
              actionId: "oauth-action",
              actionNonce: "oauth-action-nonce-123456",
              targetId: input.request?.providerId ?? "openai-codex",
              title: "Authorize provider",
            },
      approvalRefs: [],
      evidenceRefs: [],
      rollbackRefs: [],
      links: [],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z",
    })),
    createChannelSetupDraft: vi.fn<(...args: Parameters<typeof import("@goatcitadel/mission-control-shared/api/client").createChannelSetupDraft>) => Promise<unknown>>(),
    createIntegrationConnection: vi.fn<(...args: Parameters<typeof import("@goatcitadel/mission-control-shared/api/client").createIntegrationConnection>) => Promise<unknown>>(),
    createNotificationRule: fn(),
    createNotificationTarget: fn(),
    createLocalOperatorOverride: fn(),
    createMcpServer: vi.fn<(input: import("@goatcitadel/contracts").McpServerCreateInput) => Promise<unknown>>(async () => ({})),
    createPersonality: fn(),
    createPermissionProfile: fn(),
    createToolGrant: vi.fn(async (input: Omit<import("@goatcitadel/contracts").ToolGrantCreateInput, "createdBy">) => ({ ...input })),
    createWorkspace: vi.fn<(input: WorkspaceCreateInput) => Promise<unknown>>(),
    createCitadel: fn(),
    deleteIntegrationConnection: vi.fn<(...args: Parameters<typeof import("@goatcitadel/mission-control-shared/api/client").deleteIntegrationConnection>) => Promise<unknown>>(),
    deleteMcpServer: vi.fn<(serverId: string, expectedRevision: string) => Promise<unknown>>(async () => ({})),
    deleteOpenAICodexOAuthCredential: fn(),
    deletePersonality: fn(),
    deleteProviderSecret: fn(),
    disableAddon: fn(),
    disconnectMcpServer: fn(),
    enableAddon: fn(),
    exportCapabilityPack: fn(),
    discoverTelegramTargets: fn(),
    fetchAddonStatus: fn(),
    fetchAddonsCatalog: fn(),
    fetchActiveLocalOperatorOverrides: fn(),
    fetchAgenticRuns: fn(),
    fetchAutonomousActivationGrants: fn(),
    fetchCapabilityPackPreview: fn(),
    fetchCapabilityPacks: fn(),
    fetchStagedCapabilityPacks: fn(),
    fetchLocalCapabilityPackPreview: fn(),
    fetchChannelSetupDefinitions: fn(),
    fetchChannelSetupDrafts: fn(),
    fetchChannelSetupDraft: vi.fn<(...args: Parameters<typeof import("@goatcitadel/mission-control-shared/api/client").fetchChannelSetupDraft>) => Promise<unknown>>(),
    fetchChannelRuntimeStatus: fn(),
    fetchAgenticChannelDeliveries: fn({ deliveries: [] }),
    fetchChangePlans: fn({ items: [] }),
    fetchDaemonStatus: fn(),
    fetchDemoState: fn(),
    fetchChatProjects: fn(),
    fetchChatSessions: fn(),
    fetchTask: vi.fn<(taskId: string) => Promise<unknown>>(),
    fetchEffectivePermissionProfile: fn(),
    fetchEvidenceEnvelopes: fn(),
    fetchExternalConnectorServices: fn(),
    fetchExternalSideEffectRuns: fn(),
    fetchDeviceAccessGrants: vi.fn<typeof import("@goatcitadel/mission-control-shared/api/client").fetchDeviceAccessGrants>(),
    fetchGoogleMeetPrerequisiteStatus: fn(),
    fetchGoogleMeetSessions: fn(),
    fetchInstalledAddons: fn(),
    fetchIntegrationCatalog: fn(),
    fetchIntegrationConnectionDiagnostics: fn(),
    fetchIntegrationConnections: vi.fn(),
    fetchIntegrationConnection: vi.fn(),
    fetchIntegrationFormSchema: fn(),
    fetchIntegrationPlugins: fn(),
    fetchNotificationDeliveries: fn({ items: [] }),
    fetchNotificationRules: fn({ items: [] }),
    fetchNotificationTargets: fn({ items: [] }),
    fetchLlmConfig: fn(),
    fetchChangePlan: fn(),
    submitChangePlanProviderSecret: fn(),
    fetchLlmProviderAdvice: fn(),
    fetchLlamaCppModels: fn(),
    fetchLocalAiReadiness: fn(),
    fetchMcpElicitations: fn({ items: [] }),
    fetchMcpRemotePreview: fn(),
    fetchMcpServerModeManifest: fn(),
    fetchMcpServers: vi.fn(async (): Promise<{ items?: Array<Record<string, unknown>> }> => ({ items: [] })),
    fetchMcpServer: vi.fn(async (_id: string): Promise<Record<string, unknown>> => ({})),
    fetchMcpTemplates: fn(),
    fetchMcpTools: fn(),
    fetchMeshReadiness: fn({ status: "ready", blockers: [] }),
    fetchNpuModels: fn(),
    fetchOnboardingState: fn(),
    fetchOpenAICodexOAuthStatus: fn(),
    fetchPersonalities: fn(),
    fetchPermissionProfiles: fn(),
    fetchProviderSecretStatus: fn(),
    fetchSettings: fn(),
    fetchSlackOAuthStatus: fn(),
    fetchToolCatalog: fn(),
    fetchToolGrants: fn(),
    fetchVoiceRuntimeStatus: fn(),
    fetchWorkspaces: fn(),
    finalizeChannelSetupDraft: fn(),
    getCachedModelProbe: vi.fn(),
    installAddon: fn(),
    installCapabilityPack: fn(),
    installLocalCapabilityPack: fn(),
    installVoiceRuntime: fn(),
    isApiRequestError: vi.fn(
      (error: unknown) => error instanceof Error && error.name === "ApiRequestError" && "status" in error,
    ),
    invokeIntegrationConnectionAction: fn(),
    launchAddon: fn(),
    listCitadels: fn(),
    materializeStagedCapabilityPack: fn(),
    loadModelsForProvider: fn(["gpt-5.4-mini"]),
    patchSettings: vi.fn<(input: Record<string, any>) => Promise<any>>(async () => ({})),
    patchGatewayAuthSettings: vi.fn<(input: Record<string, any>) => Promise<any>>(async (input) => ({
      revision: input.expectedRevision + 1,
      mode: input.mode,
      allowLoopbackBypass: input.allowLoopbackBypass,
      tokenConfigured: Boolean(input.token),
      basicConfigured: Boolean(input.basicPassword),
    })),
    pollOpenAICodexOAuthDeviceFlow: fn(),
    pollChangePlanProviderOAuth: vi.fn(async () => await settingsMocks.pollOpenAICodexOAuthDeviceFlow()),
    completeChangePlanProviderOAuth: vi.fn(async () => ({
      schemaVersion: 1,
      planId: "plan-oauth-1",
      origin: { surface: "settings", workspaceId: "default", actorId: "operator-test" },
      kind: "provider_connection",
      scope: "provider",
      phase: "authorization",
      status: "awaiting_confirmation",
      revision: 2,
      adapter: { adapterId: "provider-connection", version: 3 },
      request: settingsMocks.createChangePlan.mock.calls.at(-1)?.[0].request ?? { kind: "provider_connection", providerId: "openai-codex" },
      target: { ownerId: "provider_connection", resourceId: "openai-codex" },
      title: "Connect OpenAI Codex",
      summary: "The OAuth credential is staged and awaits exact promotion.",
      impact: "Promotes the plan-bound credential.",
      risk: "safe",
      requiredAction: {
        kind: "confirmation",
        actionId: "confirm-oauth",
        actionNonce: "confirmation-nonce-123456",
        purpose: "apply",
        title: "Confirm connection",
        confirmationText: "Promote OAuth.",
      },
      approvalRefs: [],
      evidenceRefs: ["oauth:staged"],
      rollbackRefs: [],
      links: [],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:01:00.000Z",
    })),
    refreshLlamaCppRuntime: fn(),
    refreshNpuRuntime: fn(),
    reloadProviderCatalog: fn(),
    resolveGatewayInstallToken: fn(),
    restartDaemon: fn(),
    restoreWorkspace: vi.fn<typeof import("@goatcitadel/mission-control-shared/api/client").restoreWorkspace>(),
    restoreCitadel: fn(),
    revokeAutonomousActivationGrant: fn(),
    revokeDeviceAccessGrant: vi.fn<typeof import("@goatcitadel/mission-control-shared/api/client").revokeDeviceAccessGrant>(),
    revokeLocalOperatorOverride: fn(),
    revokeToolGrant: vi.fn(async (grantId: string) => ({ grantId })),
    runMcpServerHealthCheck: fn(),
    respondMcpElicitation: fn(),
    saveProviderSecret: fn(),
    sendTestNotification: fn({ event: {}, deliveries: [], status: "no_targets" }),
    selectVoiceRuntimeModel: fn(),
    setDefaultPersonality: fn(),
    startDaemon: fn(),
    startLlamaCppRuntime: fn(),
    startLocalAiDownload: fn(),
    startLocalAiServe: fn(),
    startMcpOAuth: fn(),
    startNpuRuntime: fn(),
    startOpenAICodexOAuthDeviceFlow: fn(),
    startChangePlanProviderOAuth: vi.fn(async () => await settingsMocks.startOpenAICodexOAuthDeviceFlow()),
    startSlackOAuth: fn(),
    stageExternalConnectorAction: fn(),
    stopAddon: fn(),
    stopDaemon: fn(),
    stopLlamaCppRuntime: fn(),
    stopNpuRuntime: fn(),
    testChannelSetupDraft: vi.fn<(...args: Parameters<typeof import("@goatcitadel/mission-control-shared/api/client").testChannelSetupDraft>) => Promise<unknown>>(),
    uninstallAddon: fn(),
    updateAddon: fn(),
    updateChannelSetupDraft: vi.fn<(...args: Parameters<typeof import("@goatcitadel/mission-control-shared/api/client").updateChannelSetupDraft>) => Promise<unknown>>(),
    updateExternalConnectorActionReviewState: fn(),
    updateExternalConnectorServiceReviewState: fn(),
    updateIntegrationConnection: vi.fn<(...args: Parameters<typeof import("@goatcitadel/mission-control-shared/api/client").updateIntegrationConnection>) => Promise<unknown>>(),
    updateNotificationRule: fn(),
    updateNotificationTarget: fn(),
    updateMcpServer: vi.fn(
      async (_id: string, _input: Record<string, unknown>): Promise<Record<string, unknown>> => ({}),
    ),
    updatePersonality: fn(),
    updatePermissionProfile: fn(),
    updateWorkspace: vi.fn<(workspaceId: string, input: WorkspaceUpdateInput & { expectedRevision: number }) => Promise<unknown>>(),
    updateCitadel: fn(),
    validateChannelSetupDraft: vi.fn<(...args: Parameters<typeof import("@goatcitadel/mission-control-shared/api/client").validateChannelSetupDraft>) => Promise<unknown>>(),
    providerModelCatalog: {
      config: {
        revision: 31,
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
        providers: [],
        providerConfigs: [],
      },
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-5.4-mini",
          apiStyle: "openai-responses",
          models: ["gpt-5.4-mini"],
          hasApiKey: true,
          apiKeySource: "keychain",
          modelProbeState: "ready",
        },
      ],
    },
  };
});

vi.mock("@goatcitadel/mission-control-shared/api/tasks", async (importOriginal) => ({
  ...await importOriginal<object>(), fetchTask: settingsMocks.fetchTask,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  archiveWorkspace: settingsMocks.archiveWorkspace,
  archiveCitadel: settingsMocks.archiveCitadel,
  archivePermissionProfile: settingsMocks.archivePermissionProfile,
  activatePermissionProfile: settingsMocks.activatePermissionProfile,
  bootstrapDemo: settingsMocks.bootstrapDemo,
  bootstrapOnboarding: settingsMocks.bootstrapOnboarding,
  completeOnboarding: settingsMocks.completeOnboarding,
  connectMcpServer: settingsMocks.connectMcpServer,
  connectReviewedMcpServer: settingsMocks.connectReviewedMcpServer,
  disconnectReviewedMcpServer: settingsMocks.disconnectReviewedMcpServer,
  createChangePlan: settingsMocks.createChangePlan,
  createChannelSetupDraft: settingsMocks.createChannelSetupDraft,
  createExternalSideEffectReplayAuditRun: settingsMocks.createExternalSideEffectReplayAuditRun,
  createIntegrationConnection: settingsMocks.createIntegrationConnection,
  createNotificationRule: settingsMocks.createNotificationRule,
  createNotificationTarget: settingsMocks.createNotificationTarget,
  createLocalOperatorOverride: settingsMocks.createLocalOperatorOverride,
  createMcpServer: settingsMocks.createMcpServer,
  createPersonality: settingsMocks.createPersonality,
  createPermissionProfile: settingsMocks.createPermissionProfile,
  getGatewayApiBaseUrl: () => "http://verification-gateway",
  createToolGrant: settingsMocks.createToolGrant,
  createWorkspace: settingsMocks.createWorkspace,
  createCitadel: settingsMocks.createCitadel,
  deleteIntegrationConnection: settingsMocks.deleteIntegrationConnection,
  deleteMcpServer: settingsMocks.deleteMcpServer,
  deleteOpenAICodexOAuthCredential: settingsMocks.deleteOpenAICodexOAuthCredential,
  deletePersonality: settingsMocks.deletePersonality,
  deleteProviderSecret: settingsMocks.deleteProviderSecret,
  disableAddon: settingsMocks.disableAddon,
  disconnectMcpServer: settingsMocks.disconnectMcpServer,
  enableAddon: settingsMocks.enableAddon,
  exportCapabilityPack: settingsMocks.exportCapabilityPack,
  discoverTelegramTargets: settingsMocks.discoverTelegramTargets,
  fetchAddonStatus: settingsMocks.fetchAddonStatus,
  fetchAddonsCatalog: settingsMocks.fetchAddonsCatalog,
  fetchActiveLocalOperatorOverrides: settingsMocks.fetchActiveLocalOperatorOverrides,
  fetchAgenticRuns: settingsMocks.fetchAgenticRuns,
  fetchAutonomousActivationGrants: settingsMocks.fetchAutonomousActivationGrants,
  fetchCapabilityPackPreview: settingsMocks.fetchCapabilityPackPreview,
  fetchCapabilityPacks: settingsMocks.fetchCapabilityPacks,
  fetchStagedCapabilityPacks: settingsMocks.fetchStagedCapabilityPacks,
  fetchLocalCapabilityPackPreview: settingsMocks.fetchLocalCapabilityPackPreview,
  fetchChannelSetupDefinitions: settingsMocks.fetchChannelSetupDefinitions,
  fetchChannelSetupDrafts: settingsMocks.fetchChannelSetupDrafts,
  fetchChannelSetupDraft: settingsMocks.fetchChannelSetupDraft,
  fetchChannelRuntimeStatus: settingsMocks.fetchChannelRuntimeStatus,
  fetchAgenticChannelDeliveries: settingsMocks.fetchAgenticChannelDeliveries,
  fetchChangePlans: settingsMocks.fetchChangePlans,
  fetchDaemonStatus: settingsMocks.fetchDaemonStatus,
  fetchDemoState: settingsMocks.fetchDemoState,
  fetchChatProjects: settingsMocks.fetchChatProjects,
  fetchChatSessions: settingsMocks.fetchChatSessions,
  fetchTask: settingsMocks.fetchTask,
  fetchEffectivePermissionProfile: settingsMocks.fetchEffectivePermissionProfile,
  fetchEvidenceEnvelopes: settingsMocks.fetchEvidenceEnvelopes,
  fetchExternalConnectorServices: settingsMocks.fetchExternalConnectorServices,
  fetchExternalSideEffectRuns: settingsMocks.fetchExternalSideEffectRuns,
  fetchDeviceAccessGrants: settingsMocks.fetchDeviceAccessGrants,
  fetchGoogleMeetPrerequisiteStatus: settingsMocks.fetchGoogleMeetPrerequisiteStatus,
  fetchGoogleMeetSessions: settingsMocks.fetchGoogleMeetSessions,
  fetchInstalledAddons: settingsMocks.fetchInstalledAddons,
  fetchIntegrationCatalog: settingsMocks.fetchIntegrationCatalog,
  fetchIntegrationConnectionDiagnostics: settingsMocks.fetchIntegrationConnectionDiagnostics,
  fetchIntegrationConnections: settingsMocks.fetchIntegrationConnections,
  fetchIntegrationConnection: settingsMocks.fetchIntegrationConnection,
  fetchIntegrationFormSchema: settingsMocks.fetchIntegrationFormSchema,
  fetchIntegrationPlugins: settingsMocks.fetchIntegrationPlugins,
  fetchNotificationDeliveries: settingsMocks.fetchNotificationDeliveries,
  fetchNotificationRules: settingsMocks.fetchNotificationRules,
  fetchNotificationTargets: settingsMocks.fetchNotificationTargets,
  fetchLlmConfig: settingsMocks.fetchLlmConfig,
  fetchChangePlan: settingsMocks.fetchChangePlan,
  submitChangePlanProviderSecret: settingsMocks.submitChangePlanProviderSecret,
  fetchLlmProviderAdvice: settingsMocks.fetchLlmProviderAdvice,
  fetchLlamaCppModels: settingsMocks.fetchLlamaCppModels,
  fetchMcpElicitations: settingsMocks.fetchMcpElicitations,
  fetchMcpRemotePreview: settingsMocks.fetchMcpRemotePreview,
  fetchMcpServerModeManifest: settingsMocks.fetchMcpServerModeManifest,
  fetchMcpServers: async () => {
    const result = await settingsMocks.fetchMcpServers();
    return {
      ...result,
      items: result.items?.map((server: Record<string, unknown>) => ({
        ...server,
        revision: server.revision ?? "a".repeat(64),
      })),
    };
  },
  fetchMcpServer: settingsMocks.fetchMcpServer,
  fetchMcpTemplates: settingsMocks.fetchMcpTemplates,
  fetchMcpTools: settingsMocks.fetchMcpTools,
  fetchMeshReadiness: settingsMocks.fetchMeshReadiness,
  fetchNpuModels: settingsMocks.fetchNpuModels,
  fetchOnboardingState: settingsMocks.fetchOnboardingState,
  fetchOpenAICodexOAuthStatus: settingsMocks.fetchOpenAICodexOAuthStatus,
  fetchPersonalities: settingsMocks.fetchPersonalities,
  fetchPermissionProfiles: settingsMocks.fetchPermissionProfiles,
  fetchProviderSecretStatus: settingsMocks.fetchProviderSecretStatus,
  fetchSettings: settingsMocks.fetchSettings,
  fetchSlackOAuthStatus: settingsMocks.fetchSlackOAuthStatus,
  fetchToolCatalog: settingsMocks.fetchToolCatalog,
  fetchToolGrants: settingsMocks.fetchToolGrants,
  fetchVoiceRuntimeStatus: settingsMocks.fetchVoiceRuntimeStatus,
  fetchWorkspaces: settingsMocks.fetchWorkspaces,
  listCitadels: settingsMocks.listCitadels,
  finalizeChannelSetupDraft: settingsMocks.finalizeChannelSetupDraft,
  installAddon: settingsMocks.installAddon,
  installCapabilityPack: settingsMocks.installCapabilityPack,
  installLocalCapabilityPack: settingsMocks.installLocalCapabilityPack,
  installVoiceRuntime: settingsMocks.installVoiceRuntime,
  isApiRequestError: settingsMocks.isApiRequestError,
  invokeIntegrationConnectionAction: settingsMocks.invokeIntegrationConnectionAction,
  launchAddon: settingsMocks.launchAddon,
  materializeStagedCapabilityPack: settingsMocks.materializeStagedCapabilityPack,
  patchSettings: settingsMocks.patchSettings,
  patchGatewayAuthSettings: settingsMocks.patchGatewayAuthSettings,
  pollOpenAICodexOAuthDeviceFlow: settingsMocks.pollOpenAICodexOAuthDeviceFlow,
  pollChangePlanProviderOAuth: settingsMocks.pollChangePlanProviderOAuth,
  completeChangePlanProviderOAuth: settingsMocks.completeChangePlanProviderOAuth,
  refreshLlamaCppRuntime: settingsMocks.refreshLlamaCppRuntime,
  refreshNpuRuntime: settingsMocks.refreshNpuRuntime,
  resolveGatewayInstallToken: settingsMocks.resolveGatewayInstallToken,
  restartDaemon: settingsMocks.restartDaemon,
  restoreWorkspace: settingsMocks.restoreWorkspace,
  restoreCitadel: settingsMocks.restoreCitadel,
  revokeAutonomousActivationGrant: settingsMocks.revokeAutonomousActivationGrant,
  revokeDeviceAccessGrant: settingsMocks.revokeDeviceAccessGrant,
  revokeLocalOperatorOverride: settingsMocks.revokeLocalOperatorOverride,
  revokeToolGrant: settingsMocks.revokeToolGrant,
  runMcpServerHealthCheck: settingsMocks.runMcpServerHealthCheck,
  respondMcpElicitation: settingsMocks.respondMcpElicitation,
  saveProviderSecret: settingsMocks.saveProviderSecret,
  sendTestNotification: settingsMocks.sendTestNotification,
  selectVoiceRuntimeModel: settingsMocks.selectVoiceRuntimeModel,
  setDefaultPersonality: settingsMocks.setDefaultPersonality,
  startDaemon: settingsMocks.startDaemon,
  startLlamaCppRuntime: settingsMocks.startLlamaCppRuntime,
  startMcpOAuth: settingsMocks.startMcpOAuth,
  startNpuRuntime: settingsMocks.startNpuRuntime,
  startOpenAICodexOAuthDeviceFlow: settingsMocks.startOpenAICodexOAuthDeviceFlow,
  startChangePlanProviderOAuth: settingsMocks.startChangePlanProviderOAuth,
  startSlackOAuth: settingsMocks.startSlackOAuth,
  stageExternalConnectorAction: settingsMocks.stageExternalConnectorAction,
  stopAddon: settingsMocks.stopAddon,
  stopDaemon: settingsMocks.stopDaemon,
  stopLlamaCppRuntime: settingsMocks.stopLlamaCppRuntime,
  stopNpuRuntime: settingsMocks.stopNpuRuntime,
  testChannelSetupDraft: settingsMocks.testChannelSetupDraft,
  uninstallAddon: settingsMocks.uninstallAddon,
  updateAddon: settingsMocks.updateAddon,
  updateChannelSetupDraft: settingsMocks.updateChannelSetupDraft,
  updateExternalConnectorActionReviewState: settingsMocks.updateExternalConnectorActionReviewState,
  updateExternalConnectorServiceReviewState: settingsMocks.updateExternalConnectorServiceReviewState,
  updateIntegrationConnection: settingsMocks.updateIntegrationConnection,
  updateNotificationRule: settingsMocks.updateNotificationRule,
  updateNotificationTarget: settingsMocks.updateNotificationTarget,
  updateMcpServer: settingsMocks.updateMcpServer,
  updatePersonality: settingsMocks.updatePersonality,
  updatePermissionProfile: settingsMocks.updatePermissionProfile,
  updateWorkspace: settingsMocks.updateWorkspace,
  updateCitadel: settingsMocks.updateCitadel,
  validateChannelSetupDraft: settingsMocks.validateChannelSetupDraft,
}));

vi.mock("@goatcitadel/mission-control-shared/api/local-ai", () => ({
  fetchLocalAiReadiness: settingsMocks.fetchLocalAiReadiness,
  startLocalAiDownload: settingsMocks.startLocalAiDownload,
  startLocalAiServe: settingsMocks.startLocalAiServe,
}));

vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog")>()),
  useProviderModelCatalog: () => ({
    config: settingsMocks.providerModelCatalog.config,
    providers: settingsMocks.providerModelCatalog.providers,
    loading: false,
    error: null,
    loadModelsForProvider: settingsMocks.loadModelsForProvider,
    getCachedModelProbe: settingsMocks.getCachedModelProbe,
    reload: settingsMocks.reloadProviderCatalog,
  }),
}));

const settings = {
  revision: 29,
  budgetMode: "balanced",
  networkAllowlist: ["api.openai.com"],
  features: {
    connectorDiagnosticsV1Enabled: true,
  },
  auth: {
    mode: "token",
    allowLoopbackBypass: false,
    tokenConfigured: true,
    basicConfigured: false,
  },
  toolApprovalMode: "approve_risky",
  llm: {
    activeProviderId: "openai",
    activeModel: "gpt-5.4-mini",
    providers: [{ providerId: "openai", label: "OpenAI", hasApiKey: true }],
    providerConfigs: [],
  },
  llamaCpp: {
    enabled: true,
    autoStart: true,
    managementMode: "managed",
    baseUrl: "http://127.0.0.1:8080/v1",
    command: "llama-server",
    modelsRootPath: "F:/models",
    modelPath: "F:/models/llama-3.gguf",
    alias: "llama-3",
    status: {
      desiredState: "running",
      processState: "running",
      healthy: true,
      activeModelId: "llama-3",
      commandSource: "settings",
      command: "llama-server",
      modelPath: "F:/models/llama-3.gguf",
      leaseDiagnostics: {
        state: "active",
        activeLeaseCount: 2,
        ownership: "owned",
        purposes: [{ purpose: "chat_completion", count: 2 }],
        persistentDemand: { manual: false, api: true, autostart: false },
        evidence: {
          lastProbe: { at: "2026-04-22T00:00:00.000Z", healthy: true },
          lastExit: { at: "2026-04-21T23:50:00.000Z", unexpected: false, code: 0 },
          lastRestart: { at: "2026-04-21T23:51:00.000Z", outcome: "ready" },
        },
      },
    },
  },
  npu: {
    enabled: true,
    autoStart: false,
    sidecarUrl: "http://127.0.0.1:39110",
    status: {
      desiredState: "running",
      processState: "running",
      healthy: true,
      backend: "directml",
      activeModelId: "npu-small",
    },
  },
};

const workspaces: WorkspaceRecord[] = [
  {
    workspaceId: "default",
    citadelId: "personal",
    revision: 11,
    name: "Default",
    slug: "default",
    description: "Primary workspace",
    lifecycleStatus: "active",
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-23T00:00:00.000Z",
  },
  {
    workspaceId: "archive-1",
    citadelId: "personal",
    revision: 13,
    name: "Archive",
    slug: "archive",
    description: "Archived workspace",
    lifecycleStatus: "archived",
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-23T00:00:00.000Z",
  },
];

function mockSuccessfulProviderSaves() {
  settingsMocks.fetchSettings.mockImplementation(async () => ({ ...settings, revision: settingsMocks.providerModelCatalog.config.revision }));
  settingsMocks.patchSettings.mockImplementation(async (input: any) => {
    const updated = { ...settings, revision: input.expectedRevision + 1, llm: { ...settings.llm, ...input.llm } };
    if (input.llm?.upsertProvider)
      settingsMocks.fetchLlmConfig.mockResolvedValue({
        ...settingsMocks.providerModelCatalog.config,
        revision: updated.revision,
        providerConfigs: [input.llm.upsertProvider],
      });
    return updated;
  });
}
function setupResponses() {
  settingsMocks.providerModelCatalog.config = {
    revision: 31,
    activeProviderId: "openai",
    activeModel: "gpt-5.4-mini",
    providers: [],
    providerConfigs: [],
  };
  settingsMocks.providerModelCatalog.providers = [
    {
      providerId: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5.4-mini",
      apiStyle: "openai-responses",
      models: ["gpt-5.4-mini"],
      hasApiKey: true,
      apiKeySource: "keychain",
      modelProbeState: "ready",
    },
  ];
  settingsMocks.fetchSettings.mockResolvedValue(settings);
  settingsMocks.fetchWorkspaces.mockResolvedValue({ items: workspaces });
  settingsMocks.listCitadels.mockResolvedValue({
    items: [
      {
        citadelId: "personal",
        slug: "personal",
        revision: "a".repeat(64),
        name: "Personal",
        kind: "personal",
        description: "Personal operating world",
        lifecycleStatus: "active",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      {
        citadelId: "company",
        slug: "company",
        revision: "b".repeat(64),
        name: "Company",
        kind: "company",
        description: "Company operating world",
        lifecycleStatus: "active",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
    ],
  });
  settingsMocks.createWorkspace.mockImplementation(async (input) => ({ ...workspaces[0], ...input, workspaceId: "created", revision: 1 }));
  settingsMocks.updateWorkspace.mockImplementation(async (_id, input) => ({ ...workspaces[0], ...input, revision: input.expectedRevision + 1 }));
  settingsMocks.archiveWorkspace.mockResolvedValue({ ...workspaces[0]!, lifecycleStatus: "archived" });
  settingsMocks.restoreWorkspace.mockResolvedValue({ ...workspaces[1]!, lifecycleStatus: "active" });
  settingsMocks.createCitadel.mockResolvedValue({
    citadelId: "created-citadel",
    revision: "c".repeat(64),
    slug: "created-citadel",
    name: "Created Citadel",
    kind: "custom",
    lifecycleStatus: "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  });
  settingsMocks.updateCitadel.mockResolvedValue({
    citadelId: "company",
    revision: "c".repeat(64),
    slug: "company",
    name: "Company updated",
    kind: "company",
    lifecycleStatus: "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  });
  settingsMocks.archiveCitadel.mockResolvedValue({
    citadelId: "company",
    revision: "c".repeat(64),
    lifecycleStatus: "archived",
  });
  settingsMocks.restoreCitadel.mockResolvedValue({
    citadelId: "company",
    revision: "d".repeat(64),
    lifecycleStatus: "active",
  });
  settingsMocks.fetchIntegrationCatalog.mockResolvedValue({
    items: [
      {
        catalogId: "github",
        key: "github",
        label: "GitHub",
        description: "GitHub issues and pulls",
        kind: "service",
        capabilities: ["issues"],
        authMethods: ["token"],
        operatorActions: [
          {
            actionId: "sync-issues",
            label: "Sync issues",
            description: "Queue an issue sync",
            capability: "issues.sync",
          },
        ],
      },
      {
        catalogId: "channel.telegram",
        key: "telegram",
        label: "Telegram",
        description: "Telegram channel",
        kind: "channel",
        capabilities: ["messages"],
        authMethods: ["bot_token"],
      },
    ],
  });
  settingsMocks.fetchIntegrationConnections.mockImplementation(async (kind?: string) => ({
    items:
      kind === "channel"
        ? [
            {
              connectionId: "channel-1",
              catalogId: "channel.telegram",
              key: "telegram",
              label: "Telegram ops",
              kind: "channel",
              enabled: true,
              status: "connected",
              config: {},
              createdAt: "2026-04-24T12:00:00.000Z",
              updatedAt: "2026-04-24T12:00:00.000Z",
            },
          ]
        : [
            {
              connectionId: "conn-1",
              revision: "a".repeat(64),
              catalogId: "github",
              key: "github",
              label: "GitHub",
              kind: "service",
              enabled: true,
              status: "connected",
              config: { tokenEnv: "GITHUB_TOKEN" },
              createdAt: "2026-04-24T12:00:00.000Z",
              updatedAt: "2026-04-24T12:00:00.000Z",
            },
          ],
  }));
  settingsMocks.fetchIntegrationFormSchema.mockResolvedValue({
    catalogId: "github",
    title: "GitHub setup",
    fields: [{ key: "tokenEnv", label: "Token environment variable", type: "text", defaultValue: "GITHUB_TOKEN" }],
  });
  settingsMocks.updateIntegrationConnection.mockResolvedValue({
    connectionId: "conn-1",
    revision: "b".repeat(64),
    catalogId: "github",
    key: "github",
    label: "GitHub ops",
    kind: "service",
    enabled: false,
    status: "paused",
    config: { tokenEnv: "GH_DETAIL" },
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:30:00.000Z",
  });
  settingsMocks.deleteIntegrationConnection.mockResolvedValue({ ok: true });
  settingsMocks.fetchIntegrationConnectionDiagnostics.mockResolvedValue({
    status: "ok",
    checks: [{ key: "token", status: "ok", message: "Token resolved" }],
    recommendedNextAction: "Keep monitoring.",
  });
  settingsMocks.invokeIntegrationConnectionAction.mockResolvedValue({ message: "Synced issues." });
  settingsMocks.fetchIntegrationPlugins.mockResolvedValue({ items: [] });
  settingsMocks.fetchExternalConnectorServices.mockResolvedValue({ items: [] });
  settingsMocks.createExternalSideEffectReplayAuditRun.mockResolvedValue({ runId: "external-run-1" });
  settingsMocks.stageExternalConnectorAction.mockResolvedValue({ status: "staged", approvalRequired: true });
  settingsMocks.updateExternalConnectorActionReviewState.mockResolvedValue({ ok: true });
  settingsMocks.updateExternalConnectorServiceReviewState.mockResolvedValue({ ok: true });
  settingsMocks.fetchExternalSideEffectRuns.mockResolvedValue({ items: [] });
  settingsMocks.fetchLlmProviderAdvice.mockResolvedValue({
    recommendations: [],
    activeProviderId: "openai",
    activeModel: "gpt-5.4-mini",
  });
  settingsMocks.fetchEffectivePermissionProfile.mockResolvedValue({ items: [] });
  settingsMocks.fetchPermissionProfiles.mockResolvedValue({ items: [] });
  settingsMocks.fetchActiveLocalOperatorOverrides.mockResolvedValue({ items: [] });
  settingsMocks.fetchAutonomousActivationGrants.mockResolvedValue({ items: [] });
  settingsMocks.createPermissionProfile.mockResolvedValue({ profileId: "profile-created" });
  settingsMocks.updatePermissionProfile.mockResolvedValue({ profileId: "profile-1" });
  settingsMocks.activatePermissionProfile.mockResolvedValue({ active: true });
  settingsMocks.archivePermissionProfile.mockResolvedValue({ profileId: "profile-1", lifecycleStatus: "archived" });
  settingsMocks.createLocalOperatorOverride.mockResolvedValue({ overrideId: "override-1" });
  settingsMocks.revokeLocalOperatorOverride.mockResolvedValue({ revoked: true });
  settingsMocks.revokeAutonomousActivationGrant.mockResolvedValue({ revoked: true });
  settingsMocks.startMcpOAuth.mockResolvedValue({ authorizationUrl: "https://oauth.example/start" });
  settingsMocks.fetchGoogleMeetPrerequisiteStatus.mockResolvedValue({
    ready: true,
    state: "ready",
    provider: "openai-realtime",
    checkedAt: "2026-04-24T12:00:00.000Z",
    authProfile: {
      available: true,
      source: "configured",
      accountRef: "operator@example.com",
    },
    prerequisites: [],
  });
  settingsMocks.fetchGoogleMeetSessions.mockResolvedValue([
    {
      sessionId: "meet-1",
      displayName: "Weekly",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      provider: "openai-realtime",
      state: "ready",
      transcript: [{ speaker: "operator", text: "Hello", atMs: 0 }],
      updatedAt: "2026-04-24T12:00:00.000Z",
    },
  ]);
  settingsMocks.fetchDaemonStatus.mockResolvedValue({
    running: true,
    pid: 1234,
    uptimeSeconds: 60,
    host: "localhost",
    state: "running",
    supported: true,
    controllable: true,
  });
  settingsMocks.fetchLlamaCppModels.mockResolvedValue({
    degraded: false,
    items: [
      {
        modelId: "llama-3",
        filePath: "F:/models/llama-3.gguf",
        relativePath: "llama-3.gguf",
        sizeBytes: 1024,
        modifiedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
  });
  settingsMocks.fetchNpuModels.mockResolvedValue({ items: [{ modelId: "npu-small", label: "NPU Small" }] });
  let voiceOwner = voiceRuntimeFixture();
  settingsMocks.fetchVoiceRuntimeStatus.mockImplementation(async () => structuredClone(voiceOwner));
  settingsMocks.startDaemon.mockResolvedValue({ ok: true });
  settingsMocks.stopDaemon.mockResolvedValue({ ok: true });
  settingsMocks.restartDaemon.mockResolvedValue({ ok: true });
  settingsMocks.startLlamaCppRuntime.mockResolvedValue({ ok: true });
  settingsMocks.stopLlamaCppRuntime.mockResolvedValue({ ok: true });
  settingsMocks.refreshLlamaCppRuntime.mockResolvedValue({ ok: true });
  settingsMocks.startNpuRuntime.mockResolvedValue({ ok: true });
  settingsMocks.stopNpuRuntime.mockResolvedValue({ ok: true });
  settingsMocks.refreshNpuRuntime.mockResolvedValue({ ok: true });
  settingsMocks.installVoiceRuntime.mockImplementation(async () => {
    voiceOwner = selectedVoiceRuntime(voiceOwner, "base");
    return structuredClone(voiceOwner);
  });
  settingsMocks.selectVoiceRuntimeModel.mockImplementation(async () => {
    voiceOwner = selectedVoiceRuntime(voiceOwner, "small");
    return structuredClone(voiceOwner);
  });
  settingsMocks.fetchOnboardingState.mockResolvedValue({
    completed: false,
    checklist: [
      { id: "llm", label: "Provider configured", status: "needs_input", detail: "Select a provider." },
      { id: "runtime", label: "Runtime ready", status: "complete", detail: "Gateway is reachable." },
      { id: "auth", label: "Auth posture", status: "optional", detail: "Local only." },
    ],
    settings: {
      revision: settings.revision,
      toolApprovalMode: "approve_risky",
      budgetMode: "balanced",
      networkAllowlist: ["api.openai.com"],
      auth: settings.auth,
      llm: {
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
        providers: [{ providerId: "openai", label: "OpenAI", hasApiKey: true }],
      },
      mesh: {
        enabled: false,
        mode: "lan",
        nodeId: "",
        mdns: true,
        staticPeers: [],
        requireMtls: false,
        tailnetEnabled: false,
      },
    },
  });
  settingsMocks.fetchAgenticRuns.mockResolvedValue({ items: [] });
  settingsMocks.fetchEvidenceEnvelopes.mockResolvedValue({ items: [] });
  settingsMocks.fetchMcpServers.mockResolvedValue({
    items: [
      {
        serverId: "srv-1",
        label: "Approval Inbox",
        transport: "http",
        url: "goatcitadel://approval-inbox",
        authType: "none",
        enabled: true,
        status: "connected",
        category: "system",
        trustTier: "trusted",
        costTier: "free",
        policy: {
          requireFirstToolApproval: true,
          redactionMode: "basic",
          allowedToolPatterns: [],
          blockedToolPatterns: [],
        },
        createdAt: "2026-04-24T12:00:00.000Z",
        updatedAt: "2026-04-24T12:00:00.000Z",
      },
    ],
  });
  settingsMocks.fetchMcpTemplates.mockResolvedValue({ items: [] });
  settingsMocks.fetchMcpServer.mockImplementation(async (id: string) => {
    const result = await settingsMocks.fetchMcpServers();
    const server = result.items?.find((item: Record<string, unknown>) => item.serverId === id);
    return { ...server, revision: server?.revision ?? "a".repeat(64) };
  });
  settingsMocks.updateMcpServer.mockImplementation(async (id: string, input: Record<string, unknown>) => {
    const current = await settingsMocks.fetchMcpServer(id);
    return { ...current, ...input, revision: "b".repeat(64) };
  });
  settingsMocks.deleteMcpServer.mockResolvedValue({ deleted: true });
  settingsMocks.fetchMcpElicitations.mockResolvedValue({ items: [] });
  settingsMocks.fetchMcpRemotePreview.mockResolvedValue({
    generatedAt: "2026-05-30T00:00:00.000Z",
    readOnly: true,
    mutationSemantics: "none",
    experimentalRemoteRecordsAllowed: false,
    runtimeSupport: "internal_approval_inbox_only",
    summary: {
      remoteServers: 0,
      remoteTemplates: 0,
      runtimeSupported: 0,
      blocked: 0,
      configuredOnly: 0,
      notCallable: 0,
      experimentalRecords: 0,
      quarantined: 0,
      needsAuth: 0,
    },
    items: [],
  });
  settingsMocks.fetchMcpServerModeManifest.mockResolvedValue({
    generatedAt: "2026-05-31T00:00:00.000Z",
    readOnly: true,
    mutationSemantics: "none",
    status: "preview",
    protocol: "mcp",
    runtimeSupport: "stdio_proxy",
    server: {
      name: "goatcitadel",
      label: "GoatCitadel governed capability export",
      version: "1.0.0",
      transport: "stdio",
    },
    launch: {
      supported: true,
      command: "goatcitadel",
      args: ["mcp-server"],
      reason: "Preview only",
    },
    runtime: {
      callPreview: {
        supported: true,
        endpoint: "/api/v1/mcp/server-mode/call",
        requiresGatewayAuth: true,
        readOnlyOnly: true,
        requiredCallContext: ["agentId", "sessionId"],
      },
      stdio: {
        supported: true,
        command: "goatcitadel",
        args: ["mcp-server"],
        requiresGatewayAuth: true,
        gatewayEndpoint: "/api/v1/mcp/server-mode/manifest",
        reason: "Gateway-backed stdio proxy.",
      },
    },
    summary: {
      inspectableCapabilities: 1,
      gatewayCallableCapabilities: 1,
      exportedToolDescriptors: 1,
      blockedDescriptors: 0,
    },
    tools: [],
    governance: [],
    limitations: ["Preview only"],
    evidence: {
      catalogScope: "callable",
      catalogSnapshot: [],
    },
  });
  settingsMocks.fetchMcpTools.mockResolvedValue({ items: [] });
  settingsMocks.fetchChannelSetupDefinitions.mockResolvedValue({
    items: [
      {
        catalog: {
          catalogId: "channel.slack",
          key: "slack",
          label: "Slack",
          description: "Slack workspace",
        },
        wizard: {
          difficulty: "guided",
          estimatedMinutes: 4,
          steps: [
            {
              id: "slack-values",
              kind: "field-collection",
              title: "Configure Slack",
              fields: [
                {
                  key: "channelId",
                  label: "Channel",
                  type: "text",
                  required: false,
                  explanation: "Target channel",
                },
              ],
            },
          ],
        },
        adapter: { adapterVersion: "fixture", secretFieldKeys: ["botToken"] },
        validation: { levels: ["config"] },
        testing: { levels: ["send"] },
      },
      {
        catalog: {
          catalogId: "channel.telegram",
          key: "telegram",
          label: "Telegram",
          description: "Telegram bot",
        },
        wizard: {
          difficulty: "guided",
          estimatedMinutes: 3,
          steps: [
            {
              id: "telegram-values",
              kind: "field-collection",
              title: "Configure Telegram",
              fields: [
                {
                  key: "botTokenEnv",
                  label: "Token env",
                  type: "text",
                  required: false,
                  explanation: "Bot token",
                },
              ],
            },
          ],
        },
        adapter: { adapterVersion: "fixture", secretFieldKeys: ["botToken"] },
        validation: { levels: ["config"] },
        testing: { levels: ["send"] },
      },
    ],
  });
  let channelOwner = {
    draftId: "draft-1", revision: 1, catalogId: "channel.telegram", label: "Telegram setup", enabled: true,
    lifecycleMode: "create", draft: { botTokenEnv: "TELEGRAM_TOKEN", setupCode: "SETUP" } as Record<string, unknown>,
    secretState: {}, contentVersion: "fixture", adapterVersion: "fixture", validationVersion: "fixture", testVersion: "fixture",
    createdAt: "2026-04-24T12:00:00.000Z", updatedAt: "2026-04-24T12:00:00.000Z",
  };
  settingsMocks.fetchChannelSetupDrafts.mockImplementation(async () => ({ items: [channelOwner] }));
  settingsMocks.fetchChannelSetupDraft.mockImplementation(async () => channelOwner);
  settingsMocks.createChannelSetupDraft.mockImplementation(async (input: { catalogId: string; connectionId?: string; lifecycleMode?: string }) => ({
    ...channelOwner, draftId: "draft-2", revision: 1, catalogId: input.catalogId, connectionId: input.connectionId,
    lifecycleMode: input.lifecycleMode ?? "create", draft: {},
  }));
  settingsMocks.discoverTelegramTargets.mockResolvedValue({
    items: [{ id: "chat-1", label: "Ops Chat", chatId: "123", kind: "group" }],
  });
  settingsMocks.updateChannelSetupDraft.mockImplementation(async (_id: string, input: { expectedRevision: number; label?: string; enabled?: boolean; draft?: Record<string, unknown> }) => {
    channelOwner = { ...channelOwner, revision: input.expectedRevision + 1, label: input.label ?? channelOwner.label,
      enabled: input.enabled ?? channelOwner.enabled, draft: input.draft ?? channelOwner.draft };
    return channelOwner;
  });
  settingsMocks.validateChannelSetupDraft.mockImplementation(async (_id: string, revision: number) => {
    channelOwner = { ...channelOwner, revision: revision + 1 };
    return { draftId: channelOwner.draftId, draftRevision: channelOwner.revision, status: "ok", levels: ["semantic"], issues: [], checkedAt: "2026-04-24T12:06:00.000Z" };
  });
  settingsMocks.testChannelSetupDraft.mockImplementation(async (_id: string, revision: number) => {
    channelOwner = { ...channelOwner, revision: revision + 2 };
    return { draftId: channelOwner.draftId, draftRevision: channelOwner.revision, status: "warn", levels: ["live-send"],
      issues: [{ key: "dry-run", level: "warn", message: "Dry run only" }], checkedAt: "2026-04-24T12:07:00.000Z", recommendedNextAction: "Review target." };
  });
  settingsMocks.finalizeChannelSetupDraft.mockResolvedValue({
    connection: { label: "Telegram ops" },
  });
  settingsMocks.fetchToolCatalog.mockResolvedValue({
    items: [
      {
        toolName: "shell.run",
        category: "filesystem",
        description: "Run a bounded shell command",
        pack: "core",
        riskLevel: "medium",
      },
    ],
  });
  settingsMocks.fetchToolGrants.mockResolvedValue({
    items: [
      {
        grantId: "grant-1",
        toolPattern: "shell.*",
        decision: "allow",
        scope: "workspace",
        scopeRef: "default",
        grantType: "persistent",
        createdBy: "operator",
        createdAt: "2026-04-24T12:00:00.000Z",
      },
    ],
  });
  const grantRecords = (toolGrantRecordsFixture());
  settingsMocks.fetchToolGrants.mockImplementation(async () => ({ items: structuredClone(grantRecords) }));
  settingsMocks.createToolGrant.mockImplementation(async (input: Omit<import("@goatcitadel/contracts").ToolGrantCreateInput, "createdBy">) => {
    const saved = { ...input, grantType: input.grantType ?? "persistent", scopeRef: input.scope === "global" ? "global" : String(input.scopeRef ?? ""), grantId: "grant-2", createdBy: "operator", createdAt: "2026-09-30T15:00:00.000Z" };
    grantRecords.push(saved); return structuredClone(saved);
  });
  settingsMocks.revokeToolGrant.mockImplementation(async (grantId: string) => {
    const grant = grantRecords.find((item) => item.grantId === grantId);
    if (grant) { grant.revokedAt = "2026-09-30T15:01:00.000Z"; grant.revokedBy = "operator"; }
    return { revoked: Boolean(grant), grantId, revokedBy: "operator" };
  });
  settingsMocks.fetchDeviceAccessGrants.mockResolvedValue({
    items: [
      {
        grantId: "device-1",
        requestId: "request-1",
        actorId: "operator",
        deviceLabel: "Android phone",
        deviceType: "mobile",
        principalPurpose: "general_companion",
        platform: "Android",
        grantedBy: "operator",
        metadata: { origin: "companion" },
        createdAt: "2026-05-02T18:00:00.000Z",
      },
    ],
  });
  settingsMocks.resolveGatewayInstallToken.mockResolvedValue({ token: "install-token", source: "generated" });
  settingsMocks.revokeDeviceAccessGrant.mockImplementation(async (grantId) => {
    const grant = (await settingsMocks.fetchDeviceAccessGrants()).items.find((item) => item.grantId === grantId);
    if (!grant) throw new Error("Unknown fixture device grant");
    return { grant: { ...grant, revokedAt: "2026-09-30T12:00:00.000Z" } };
  });
  settingsMocks.fetchAddonsCatalog.mockResolvedValue({
    items: [
      {
        addonId: "pixel-office",
        label: "Pixel Office",
        description: "Workspace visualizer",
        category: "visual",
        trustTier: "trusted",
        owner: "goatcitadel",
        runtimeType: "web",
        webEntryMode: "iframe",
        launchUrl: "http://localhost:9000",
        installCommands: [{ command: "pnpm", args: ["install"], note: "Install assets" }],
      },
    ],
  });
  settingsMocks.fetchInstalledAddons.mockResolvedValue({
    items: [{ addonId: "pixel-office", runtimeStatus: "running", installedAt: "2026-04-24T12:00:00.000Z" }],
  });
  settingsMocks.fetchAddonStatus.mockResolvedValue({
    addonId: "pixel-office",
    status: "running",
    healthChecks: [{ key: "http", status: "ok", message: "Serving" }],
  });
  settingsMocks.installAddon.mockResolvedValue({ ok: true });
  settingsMocks.updateAddon.mockResolvedValue({ ok: true });
  settingsMocks.enableAddon.mockResolvedValue({ ok: true });
  settingsMocks.disableAddon.mockResolvedValue({ ok: true });
  settingsMocks.launchAddon.mockResolvedValue({ ok: true });
  settingsMocks.stopAddon.mockResolvedValue({ ok: true });
  settingsMocks.uninstallAddon.mockResolvedValue({ ok: true });
  settingsMocks.fetchCapabilityPacks.mockResolvedValue({
    items: [
      {
        packId: "operator-pack",
        name: "Operator Pack",
        version: "1.0.0",
        description: "Adds operator-facing capabilities",
        trustTier: "trusted",
        tags: ["ops"],
        assets: [
          {
            id: "skill-1",
            label: "Skill 1",
            kind: "skill",
            runtimeSupport: "available",
            installMode: "review_required",
          },
        ],
        provenance: { source: "bundled", publisher: "GoatCitadel" },
      },
    ],
  });
  settingsMocks.fetchStagedCapabilityPacks.mockResolvedValue({
    items: [
      {
        packId: "operator-pack",
        name: "Operator Pack",
        version: "1.0.0",
        trustTier: "trusted",
        source: "bundled",
        actorId: "operator",
        stagedAt: "2026-05-31T00:00:00.000Z",
        status: "staged_for_review",
        reviewRequired: true,
        stagedAssets: [{ kind: "skill", assetId: "skill-1", reason: "Review required", outcome: "review_required" }],
        evidenceEnvelopeId: "env-pack",
      },
    ],
  });
  settingsMocks.fetchCapabilityPackPreview.mockResolvedValue({
    manifest: {
      packId: "operator-pack",
      trustTier: "trusted",
      name: "Operator Pack",
      installWarnings: ["Review before install."],
      provenance: { source: "bundled" },
    },
    reviewRequired: true,
    policyChanges: { redactionMode: "basic" },
    unsupportedAssets: [],
    installPlan: [{ kind: "skill", assetId: "skill-1", reason: "Adds workflow", outcome: "stage" }],
  });
  settingsMocks.fetchLocalCapabilityPackPreview.mockResolvedValue({
    manifest: {
      packId: "local-pack",
      name: "Local Pack",
      trustTier: "community",
      installWarnings: ["Review local assets."],
      provenance: { source: "local_file" },
    },
    reviewRequired: true,
    policyChanges: { redactionMode: "strict" },
    unsupportedAssets: [],
    installPlan: [{ kind: "addon", assetId: "addon:local", reason: "Review required", outcome: "review_required" }],
  });
  settingsMocks.installCapabilityPack.mockResolvedValue({ ok: true });
  settingsMocks.materializeStagedCapabilityPack.mockResolvedValue({
    packId: "operator-pack",
    actorId: "operator",
    materializedAt: "2026-05-31T00:02:00.000Z",
    status: "materialization_recorded",
    sourceEvidenceEnvelopeId: "env-pack",
    evidenceEnvelopeId: "env-materialized",
    assets: [{ assetId: "skill-1", kind: "skill", requested: true, outcome: "review_recorded" }],
    limitations: ["evidence only"],
  });
  settingsMocks.exportCapabilityPack.mockResolvedValue({
    exportedAt: "2026-05-31T00:00:00.000Z",
    readOnly: true,
    mutationSemantics: "none",
    manifest: {
      packId: "operator-pack",
      name: "Operator Pack",
      version: "1.0.0",
      description: "Adds operator-facing capabilities",
      trustTier: "trusted",
      tags: ["ops"],
      assets: [],
      policyDefaults: {
        requireFirstUseApproval: true,
        memoryWriteAuthority: "operator_controlled",
        redactionMode: "strict",
        autoRunEnabled: false,
      },
      provenance: { source: "bundled", publisher: "goatcitadel" },
      installWarnings: [],
    },
    evidence: { source: "staged_evidence", evidenceEnvelopeId: "env-pack" },
    limitations: ["read-only"],
  });
  settingsMocks.installLocalCapabilityPack.mockResolvedValue({
    preview: {
      manifest: {
        packId: "local-pack",
        name: "Local Pack",
        trustTier: "community",
        installWarnings: ["Review local assets."],
        provenance: { source: "local_file" },
      },
      reviewRequired: true,
      policyChanges: { redactionMode: "strict" },
      unsupportedAssets: [],
      installPlan: [{ kind: "addon", assetId: "addon:local", reason: "Review required", outcome: "review_required" }],
    },
  });
  const demo = demoFixture();
  let demoState = demo.empty;
  settingsMocks.fetchDemoState.mockImplementation(async () => structuredClone(demoState));
  settingsMocks.bootstrapDemo.mockImplementation(async () => {
    demoState = demo.state;
    return structuredClone(demo.receipt);
  });
  settingsMocks.fetchChatProjects.mockResolvedValue({ items: [demo.project] });
  settingsMocks.fetchChatSessions.mockResolvedValue({ items: [demo.session] });
  settingsMocks.fetchTask.mockImplementation(async (id) => demo.tasks.find(task => task.taskId === id));
  settingsMocks.fetchProviderSecretStatus.mockResolvedValue({ hasSecret: false, source: "missing" });
  settingsMocks.saveProviderSecret.mockResolvedValue({
    providerId: "openai",
    revision: 32,
    hasSecret: true,
    source: "keychain",
  });
  settingsMocks.deleteProviderSecret.mockResolvedValue({
    providerId: "openai",
    revision: 32,
    hasSecret: false,
    source: "none",
  });
  settingsMocks.fetchOpenAICodexOAuthStatus.mockResolvedValue({ connected: false, requiresReauth: false });
  settingsMocks.startOpenAICodexOAuthDeviceFlow.mockResolvedValue({
    providerId: "openai-codex",
    flowId: "flow-1",
    verificationUrl: "https://auth.openai.com/activate",
    userCode: "ABCD-EFGH",
    expiresAt: "2026-05-15T12:05:00.000Z",
    pollAfterMs: 5000,
  });
  settingsMocks.pollOpenAICodexOAuthDeviceFlow.mockResolvedValue({ status: "pending", retryAfterMs: 5000 });
  settingsMocks.deleteOpenAICodexOAuthCredential.mockResolvedValue({ connected: false, requiresReauth: false });
}

function installBrowser() {
  const open = vi.fn();
  const navigationEvents = new EventTarget();
  vi.stubGlobal("open", open);
  vi.stubGlobal("window", {
    location: new URL("http://localhost/settings/general?shell=classic"),
    addEventListener: navigationEvents.addEventListener.bind(navigationEvents),
    removeEventListener: navigationEvents.removeEventListener.bind(navigationEvents),
    dispatchEvent: navigationEvents.dispatchEvent.bind(navigationEvents),
    confirm: vi.fn(() => true),
    open,
    setTimeout,
    clearTimeout,
  });
}

function renderPage(section: string, extras: Record<string, unknown> = {}, withUiPreferences = false) {
  const page = (
    <SettingsNativePage
      route={{ area: "settings", section, theme: "ops" } as any}
      activeCitadelId="personal"
      activeCitadelName="Personal"
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      navigate={vi.fn()}
      setActiveCitadelId={vi.fn()}
      setActiveWorkspaceId={vi.fn()}
      {...extras}
    />
  );
  return create(withUiPreferences ? <UiPreferencesProvider>{page}</UiPreferencesProvider> : page);
}

async function mount(section: string, extras: Record<string, unknown> = {}, withUiPreferences = false) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = renderPage(section, extras, withUiPreferences);
  });
  await flush();
  return renderer;
}

async function flush() {
  await act(async () => {
    await vi.dynamicImportSettled();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      return collectText(child as ReactTestInstance);
    })
    .join(" ");
}

function findButton(root: ReactTestInstance, label: string) {
  const match = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!match) {
    throw new Error(`Missing button ${label}`);
  }
  return match;
}

function buttons(root: ReactTestInstance, label: string) {
  return root.findAll((node) => node.type === "button" && collectText(node).includes(label));
}

function findExactButton(root: ReactTestInstance, label: string) {
  const match = root.findAll((node) => node.type === "button" && collectText(node).trim() === label)[0];
  if (!match) {
    throw new Error(`Missing exact button ${label}`);
  }
  return match;
}

async function click(button: ReactTestInstance) {
  await act(async () => {
    button.props.onClick();
  });
  await flush();
}

async function change(node: ReactTestInstance, value: string, checked?: boolean) {
  await act(async () => {
    const target = { value, checked: checked ?? false };
    node.props.onChange({ target, currentTarget: target });
  });
  await flush();
}

function revisionConflict(
  expectedRevision: number,
  currentRevision: number,
  path = "/api/v1/settings",
  method = "PATCH",
  code = "WRITE_CONFLICT",
) {
  return new ApiRequestError("stale settings", {
    kind: "http",
    method,
    path,
    status: 409,
    body: { code, details: { expectedRevision, currentRevision } },
  });
}

const resetSettingsMocks = Object.values(settingsMocks).flatMap((mock) => {
  if (!vi.isMockFunction(mock)) return [];
  const implementation = mock.getMockImplementation();
  return [
    () => {
      mock.mockReset();
      if (implementation) mock.mockImplementation(implementation);
    },
  ];
});

beforeEach(() => {
  __resetOnboardingAttemptsForTests();
  __resetDemoReceiptsForTests();
  __resetIntegrationConnectionMutationsForTests();
  __resetWorkspaceAttemptsForTests();
  __resetToolGrantActionsForTests();
  __resetDeviceAccessRevocationsForTests();
  __resetSettingsChangesForTests();
  __resetAuthAttemptsForTests();
  __resetVoiceAttemptsForTests();
  __resetProviderMutationStateForTests();
  __resetChannelMutationStateForTests();
  __resetManagedRuntimeUncertaintyForTests();
  __resetMcpServerMutationsForTests();
  __resetPackAttemptsForTests();
  vi.clearAllMocks();
  for (const resetMock of resetSettingsMocks) resetMock();
  __resetSessionDraftsForTests();
  __resetSessionViewStateForTests();
  vi.unstubAllGlobals();
  installBrowser();
  setupResponses();
  settingsMocks.fetchLlmConfig.mockImplementation(async () => settingsMocks.providerModelCatalog.config);
});

afterEach(() => {
  __resetFormDirtyRegistryForTests();
});

describe("SettingsNativePage broad native sections", () => {
  it("shows unsupported desktop notification permission separately from the saved preference", async () => {
    const page = await mount("general");
    expect(collectText(page.root)).toContain("Unsupported");
    expect(collectText(page.root)).toMatch(/Saved preference:\s+Off/);
    expect(findButton(page.root, "Send test notification").props.disabled).toBe(true);
  });

  it("keeps notification permission prompts user initiated and enables a test only when granted", async () => {
    const notificationConstructor = vi.fn(function MockNotification() {});
    const requestPermission = vi.fn(async () => {
      Object.assign(notificationConstructor, { permission: "granted" });
      return "granted" as NotificationPermission;
    });
    Object.assign(notificationConstructor, { permission: "default", requestPermission });
    Object.assign(window as any, { Notification: notificationConstructor });
    const page = await mount("general", {}, true);
    const desktopPreference = page.root.findByProps({
      "aria-label": "Use system notifications when permission is granted",
    });

    await change(desktopPreference, "", true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(collectText(page.root)).toMatch(/Saved preference:\s+On/);
    await click(findButton(page.root, "Allow notifications"));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(collectText(page.root)).toContain("Granted");
    const sendTest = findButton(page.root, "Send test notification");
    expect(sendTest.props.disabled).toBe(false);
    await click(sendTest);
    expect(notificationConstructor).toHaveBeenCalledWith("GoatCitadel test notification", {
      body: "System notifications are working in this host.",
    });
    expect(collectText(page.root)).toContain("Test notification requested. Check your host's notification area.");
  });

  it("reports blocked notification permission without retrying an explicit denial", async () => {
    const requestPermission = vi.fn(async () => "denied" as NotificationPermission);
    const notificationConstructor = vi.fn(function MockNotification() {});
    Object.assign(notificationConstructor, { permission: "denied", requestPermission });
    Object.assign(window as any, { Notification: notificationConstructor });
    const page = await mount("general");
    expect(collectText(page.root)).toContain("Blocked");
    expect(findButton(page.root, "Send test notification").props.disabled).toBe(true);
    await click(findButton(page.root, "Re-check permission"));
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("retains a Citadel draft on conflict and submits only after explicit review of the winner", async () => {
    const initial = {
      citadelId: "personal",
      name: "Personal",
      slug: "personal",
      kind: "personal",
      lifecycleStatus: "active",
      description: "Original description",
      revision: "a".repeat(64),
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    };
    const winner = { ...initial, name: "Remote Citadel", description: "Peer description", revision: "b".repeat(64) };
    settingsMocks.listCitadels.mockResolvedValue({ items: [initial] });
    const page = await mount("workspaces");
    await click(findButton(page.root, "Citadel manager"));
    await click(findButton(page.root, "Personal"));
    await click(findButton(page.root, "Edit Citadel"));
    await change(page.root.findByProps({ value: "Personal" }), "Local Citadel draft");
    await change(page.root.findByProps({ value: "Original description" }), "");
    settingsMocks.updateCitadel.mockRejectedValueOnce(
      new ApiRequestError("Citadel changed", {
        kind: "http",
        method: "PATCH",
        path: "/api/v1/citadels/personal",
        status: 409,
        body: { code: "WRITE_CONFLICT", details: { reason: "CITADEL_RECORD_REVISION_CONFLICT" } },
      }),
    );
    settingsMocks.listCitadels.mockResolvedValue({ items: [winner] });
    await click(findButton(page.root, "Save Citadel"));
    expect(settingsMocks.updateCitadel).not.toHaveBeenCalled();
    expect(page.root.findByProps({ value: "Local Citadel draft" })).toBeTruthy();
    expect(collectText(page.root)).toContain("Peer description");
    expect(findButton(page.root, "Save Citadel").props.disabled).toBe(true);
    await click(findButton(page.root, "Save Citadel"));
    expect(settingsMocks.updateCitadel).not.toHaveBeenCalled();
    await click(findButton(page.root, "Apply draft to current Citadel"));
    settingsMocks.updateCitadel.mockReset();
    const savedWinner = { ...winner, name: "Local Citadel draft", description: "", revision: "c".repeat(64), updatedAt: "2026-09-30T01:00:00.000Z" };
    settingsMocks.updateCitadel.mockImplementationOnce(async () => {
      settingsMocks.listCitadels.mockResolvedValue({ items: [savedWinner] });
      return savedWinner;
    });
    await click(findButton(page.root, "Save Citadel"));
    expect(settingsMocks.updateCitadel).toHaveBeenNthCalledWith(
      1,
      "personal",
      expect.objectContaining({ expectedRevision: winner.revision, description: "" }),
    );
  });

  it("keeps a rejected Citadel review latched when the reload still returns the rejected token", async () => {
    const page = await mount("workspaces");
    await click(findButton(page.root, "Citadel manager"));
    await click(findButton(page.root, "Personal"));
    await click(findButton(page.root, "Edit Citadel"));
    await change(page.root.findByProps({ value: "Personal" }), "Retained local draft");
    settingsMocks.updateCitadel.mockRejectedValueOnce(
      new ApiRequestError("Citadel changed", {
        kind: "http",
        method: "PATCH",
        path: "/api/v1/citadels/personal",
        status: 409,
        body: { code: "WRITE_CONFLICT", details: { reason: "CITADEL_RECORD_REVISION_CONFLICT" } },
      }),
    );
    await click(findButton(page.root, "Save Citadel"));
    expect(findButton(page.root, "Apply draft to current Citadel").props.disabled).toBe(true);
    expect(findButton(page.root, "Save Citadel").props.disabled).toBe(true);
    settingsMocks.listCitadels.mockResolvedValueOnce({
      items: [
        {
          citadelId: "personal",
          name: "Reviewed peer",
          slug: "personal",
          kind: "personal",
          lifecycleStatus: "active",
          revision: "e".repeat(64),
          createdAt: "2026-09-30T00:00:00.000Z",
          updatedAt: "2026-09-30T00:00:00.000Z",
        },
      ],
    });
    await click(findButton(page.root, "Reload latest Citadel"));
    expect(page.root.findByProps({ value: "Retained local draft" })).toBeTruthy();
    expect(findButton(page.root, "Apply draft to current Citadel").props.disabled).toBe(false);
    expect(findButton(page.root, "Save Citadel").props.disabled).toBe(true);
  });

  it("retains typing made while a Citadel save is in flight and uses the returned revision next", async () => {
    const initial = {
      citadelId: "personal",
      name: "Personal",
      slug: "personal",
      kind: "personal",
      lifecycleStatus: "active",
      revision: "a".repeat(64),
      createdAt: "2026-09-30T00:00:00.000Z",
      updatedAt: "2026-09-30T00:00:00.000Z",
    };
    settingsMocks.listCitadels.mockResolvedValue({ items: [initial] });
    const page = await mount("workspaces");
    await click(findButton(page.root, "Citadel manager"));
    await click(findButton(page.root, "Personal"));
    await click(findButton(page.root, "Edit Citadel"));
    await change(page.root.findByProps({ value: "Personal" }), "Submitted draft");
    let resolveSave!: (value: typeof initial) => void;
    settingsMocks.updateCitadel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    await click(findButton(page.root, "Save Citadel"));
    await change(page.root.findByProps({ value: "Submitted draft" }), "Newer typing");
    const acknowledged = { ...initial, name: "Submitted draft", revision: "b".repeat(64), updatedAt: "2026-09-30T01:00:00.000Z" };
    settingsMocks.listCitadels.mockResolvedValue({ items: [acknowledged] });
    await act(async () => {
      resolveSave(acknowledged);
    });
    await flush();
    expect(page.root.findByProps({ value: "Newer typing" })).toBeTruthy();
    expect(findButton(page.root, "Save Citadel").props.disabled).toBe(false);
    const nextAcknowledged = { ...acknowledged, name: "Newer typing", revision: "c".repeat(64), updatedAt: "2026-09-30T02:00:00.000Z" };
    settingsMocks.updateCitadel.mockImplementationOnce(async () => {
      settingsMocks.listCitadels.mockResolvedValue({ items: [nextAcknowledged] });
      return nextAcknowledged;
    });
    await click(findButton(page.root, "Save Citadel"));
    expect(settingsMocks.updateCitadel).toHaveBeenNthCalledWith(
      2,
      "personal",
      expect.objectContaining({ expectedRevision: acknowledged.revision, name: "Newer typing" }),
    );
  });

  it("does not mistake a duplicate Citadel slug for a stale review", async () => {
    const page = await mount("workspaces");
    await click(findButton(page.root, "Citadel manager"));
    await click(findButton(page.root, "Personal"));
    await click(findButton(page.root, "Edit Citadel"));
    await change(
      page.root.findAll((node) => node.type === "input" && node.props.value === "personal")[0]!,
      "taken-slug",
    );
    settingsMocks.updateCitadel.mockRejectedValueOnce(
      new ApiRequestError("Slug already in use", {
        kind: "http",
        method: "PATCH",
        path: "/api/v1/citadels/personal",
        status: 409,
        body: { code: "ALREADY_EXISTS" },
      }),
    );
    await click(findButton(page.root, "Save Citadel"));
    expect(findButton(page.root, "Save Citadel").props.disabled).toBe(false);
    expect(collectText(page.root)).not.toContain("Apply draft to current Citadel");
    expect(page.root.findByProps({ value: "taken-slug" })).toBeTruthy();
  });

  it("preserves a workspace draft, reloads the current revision, and retries after a 409", async () => {
    const page = await mount("workspaces");
    await click(findButton(page.root, "Default"));
    await click(findButton(page.root, "Edit workspace"));
    const nameInput = page.root.findByProps({ value: "Default" });
    await change(nameInput, "Local workspace draft");

    const staleError = new ApiRequestError("stale workspace", {
      kind: "http",
      method: "PATCH",
      path: "/api/v1/workspaces/default",
      status: 409,
      body: { code: "WRITE_CONFLICT", details: { resourceKind: "workspace", resourceId: "default", expectedRevision: 11, currentRevision: 12 } },
    });
    settingsMocks.updateWorkspace.mockRejectedValueOnce(staleError).mockResolvedValueOnce({
      ...workspaces[0],
      revision: 13,
      name: "Local workspace draft",
    });
    settingsMocks.fetchWorkspaces.mockResolvedValueOnce({ items: workspaces }).mockResolvedValue({
      items: [{ ...workspaces[0], revision: 12, name: "Remote workspace update" }, workspaces[1]],
    });

    await click(findButton(page.root, "Save changes"));

    expect(settingsMocks.updateWorkspace).toHaveBeenNthCalledWith(1, "default", {
      expectedRevision: 11,
      name: "Local workspace draft",
      description: "Primary workspace",
      slug: "default",
    });
    expect(settingsMocks.fetchWorkspaces).toHaveBeenCalledTimes(3);
    expect(collectText(page.root)).toContain("Your draft is preserved. Review the current revision");
    expect(
      page.root.findAll((node) => node.type === "input" && node.props.value === "Local workspace draft"),
    ).toHaveLength(1);

    expect(findButton(page.root, "Save changes").props.disabled).toBe(true);
    await click(findButton(page.root, "Apply draft to current workspace"));
    await click(findButton(page.root, "Save changes"));
    expect(settingsMocks.updateWorkspace).toHaveBeenNthCalledWith(2, "default", {
      expectedRevision: 12,
      name: "Local workspace draft",
      description: "Primary workspace",
      slug: "default",
    });
  });

  it("saves a cleared workspace description and shows the empty summary after Gateway confirmation", async () => {
    const page = await mount("workspaces");
    await click(findButton(page.root, "Default"));
    await click(findButton(page.root, "Edit workspace"));
    const description = page.root.findAllByType("textarea").find((node) => node.props.value === "Primary workspace")!;
    await change(description, "   ");

    const clearedWorkspace = { ...workspaces[0], description: "", revision: 12 };
    settingsMocks.updateWorkspace.mockResolvedValueOnce(clearedWorkspace);
    settingsMocks.fetchWorkspaces.mockResolvedValueOnce({ items: workspaces }).mockResolvedValue({ items: [clearedWorkspace, workspaces[1]] });
    await click(findButton(page.root, "Save changes"));

    expect(settingsMocks.updateWorkspace).toHaveBeenCalledWith("default", {
      expectedRevision: 11,
      name: "Default",
      description: "",
      slug: "default",
    });
    expect(collectText(page.root)).toContain("Description cleared.");
    await click(findButton(page.root, "Close editor"));
    await click(findButton(page.root, "Default"));
    expect(collectText(page.root)).toContain("No description");
  });

  it("preserves the public access draft after exact stale rejection and requires a fresh credential for retry", async () => {
    let authOwner = { ...settings, revision: 41 };
    settingsMocks.fetchSettings.mockImplementation(async () => authOwner);
    settingsMocks.patchGatewayAuthSettings.mockImplementationOnce(async () => {
      authOwner = { ...authOwner, revision: 42, auth: { ...authOwner.auth, allowLoopbackBypass: true } };
      throw revisionConflict(41, 42, "/api/v1/auth/settings", "PATCH", "STATE_CONFLICT");
    }).mockImplementationOnce(async (input: any) => {
      authOwner = { ...authOwner, revision: 43, auth: { ...authOwner.auth, allowLoopbackBypass: input.allowLoopbackBypass } };
      return { ...authOwner.auth, revision: 43 };
    });
    const access = await mount("access");
    await click(findButton(access.root, "Configure access"));
    await change(access.root.findByProps({ placeholder: "New credential (only when replacing)" }), "local-token");
    await click(findButton(access.root, "Save access settings"));
    expect(settingsMocks.patchGatewayAuthSettings).not.toHaveBeenCalled();
    await act(async () => { access.root.findAllByType(ConfirmModal).find(modal => modal.props.title === "Apply Gateway authentication changes?")!.props.onConfirm(); }); await flush();
    expect(settingsMocks.patchGatewayAuthSettings).toHaveBeenNthCalledWith(1, { expectedRevision: 41, mode: "token", allowLoopbackBypass: false, token: "local-token" });
    expect(access.root.findByProps({ placeholder: "New credential (only when replacing)" }).props.value).toBe("");
    expect(collectText(access.root)).toContain("Your public draft is preserved");
    await click(findButton(access.root, "Apply draft to current access"));
    expect(findButton(access.root, "Save access settings").props.disabled).toBe(true);
    await change(access.root.findByProps({ placeholder: "New credential (only when replacing)" }), "local-token");
    await click(findButton(access.root, "Save access settings"));
    await act(async () => { access.root.findAllByType(ConfirmModal).find(modal => modal.props.title === "Apply Gateway authentication changes?")!.props.onConfirm(); }); await flush();
    expect(settingsMocks.patchGatewayAuthSettings).toHaveBeenNthCalledWith(2, { expectedRevision: 42, mode: "token", allowLoopbackBypass: false, token: "local-token" });
  });

  it("preserves the budget draft and retries with the refreshed settings revision after a 409", async () => {
    settingsMocks.fetchSettings
      .mockResolvedValueOnce({ ...settings, revision: 51, budgetMode: "balanced" })
      .mockResolvedValueOnce({ ...settings, revision: 52, budgetMode: "power" });
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(51, 52)).mockResolvedValueOnce({});

    const budget = await mount("budget");
    const mode = budget.root.findByType("select");
    await change(mode, "saver");
    await click(findButton(budget.root, "Save budget mode"));

    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 51,
      budgetMode: "saver",
    });
    expect(settingsMocks.fetchSettings).toHaveBeenCalledTimes(2);
    expect(budget.root.findByType("select").props.value).toBe("saver");
    expect(collectText(budget.root)).toContain("Your draft is preserved");

    await click(findButton(budget.root, "Apply draft to current budget"));
    await click(findButton(budget.root, "Save budget mode"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 52,
      budgetMode: "saver",
    });
  });

  it("preserves the tool approval draft and retries with the refreshed settings revision after a 409", async () => {
    settingsMocks.fetchSettings
      .mockResolvedValueOnce({ ...settings, revision: 61, toolApprovalMode: "approve_risky" })
      .mockResolvedValueOnce({ ...settings, revision: 62, toolApprovalMode: "approve_all" });
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(61, 62)).mockResolvedValueOnce({});

    const tools = await mount("tools");
    const approvalMode = tools.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("Skip normal prompts"))!;
    await change(approvalMode, "bypass");
    await click(findButton(tools.root, "Save mode"));

    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 61,
      toolApprovalMode: "bypass",
    });
    expect(settingsMocks.fetchSettings).toHaveBeenCalledTimes(2);
    expect(
      tools.root.findAllByType("select").find((select) => collectText(select).includes("Skip normal prompts"))?.props
        .value,
    ).toBe("bypass");
    expect(collectText(tools.root)).toContain("approval-mode draft is preserved");

    await click(findButton(tools.root, "Apply draft to current prompt mode"));
    await click(findButton(tools.root, "Save mode"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 62,
      toolApprovalMode: "bypass",
    });
  });

  it("preserves onboarding defaults and retries against the refreshed runtime revision after a 409", async () => {
    let runtime = { ...settings, revision: 71, networkAllowlist: ["api.old.example"] };
    let onboardingBase = {
      completed: false, checklist: [],
      settings: { revision: runtime.revision, toolApprovalMode: "approve_risky", budgetMode: "balanced",
        networkAllowlist: ["api.old.example"], auth: settings.auth, llm: settings.llm,
        mesh: { enabled: false, mode: "lan", nodeId: "", mdns: true, staticPeers: [], requireMtls: false } },
    };
    settingsMocks.fetchOnboardingState.mockImplementation(async () => structuredClone(onboardingBase));
    settingsMocks.fetchSettings.mockImplementation(async () => structuredClone(runtime));
    settingsMocks.bootstrapOnboarding.mockImplementationOnce(async () => {
      runtime = { ...runtime, revision: 72, budgetMode: "power", networkAllowlist: ["api.remote.example"] };
      onboardingBase = { ...onboardingBase, settings: { ...onboardingBase.settings, revision: runtime.revision, budgetMode: runtime.budgetMode, networkAllowlist: runtime.networkAllowlist } };
      throw revisionConflict(71, 72, "/api/v1/onboarding/bootstrap", "POST", "STATE_CONFLICT");
    }).mockImplementationOnce(async input => {
      runtime = { ...runtime, revision: 73, budgetMode: input.budgetMode!, networkAllowlist: input.networkAllowlist!, toolApprovalMode: input.toolApprovalMode! };
      onboardingBase = { ...onboardingBase, settings: { ...onboardingBase.settings, revision: runtime.revision, budgetMode: runtime.budgetMode, networkAllowlist: runtime.networkAllowlist, toolApprovalMode: runtime.toolApprovalMode } };
      return { state: structuredClone(onboardingBase), appliedAt: "2026-09-30T00:00:00.000Z" };
    });

    const onboarding = await mount("onboarding");
    await click(findButton(onboarding.root, "First-run defaults"));
    const budgetMode = onboarding.root.findAllByType("select").find((select) => select.props.value === "balanced")!;
    const allowlist = onboarding.root.findByProps({ placeholder: "example.com, api.example.com" });
    await change(budgetMode, "saver");
    await change(allowlist, "local.example, api.local.example");
    await click(findButton(onboarding.root, "Review defaults"));
    await act(async () => { const review = onboarding.root.findAllByType(GCModal).find(modal => modal.props.title === "Apply first-run defaults")!; expect(review.props.open, collectText(onboarding.root)).toBe(true); await review.props.onConfirm(); }); await flush();

    expect(settingsMocks.bootstrapOnboarding).toHaveBeenNthCalledWith(1, {
      expectedRevision: 71,
      toolApprovalMode: "approve_risky",
      budgetMode: "saver",
      networkAllowlist: ["local.example", "api.local.example"],
      auth: { allowLoopbackBypass: false },
    });
    await click(findButton(onboarding.root, "Refresh defaults"));
    expect(onboarding.root.findAllByType("select").find((select) => select.props.value === "saver")).toBeTruthy();
    expect(onboarding.root.findByProps({ placeholder: "example.com, api.example.com" }).props.value).toBe(
      "local.example, api.local.example",
    );
    expect(collectText(onboarding.root)).toContain("Your input is preserved");
    expect(findButton(onboarding.root, "Review defaults").props.disabled).toBe(true);
    await click(findButton(onboarding.root, "Apply draft to current defaults"));

    await click(findButton(onboarding.root, "Review defaults"));
    await act(async () => { const review = onboarding.root.findAllByType(GCModal).find(modal => modal.props.title === "Apply first-run defaults")!; expect(review.props.open, collectText(onboarding.root)).toBe(true); await review.props.onConfirm(); }); await flush();
    expect(settingsMocks.bootstrapOnboarding).toHaveBeenNthCalledWith(2, {
      expectedRevision: 72,
      toolApprovalMode: "approve_risky",
      budgetMode: "saver",
      networkAllowlist: ["local.example", "api.local.example"],
      auth: { allowLoopbackBypass: false },
    });
  });

  it("keeps preference defaults independent of optional setup reads", async () => {
    const general = await mount("general");
    expect(collectText(general.root)).toContain("Display density");
    expect(settingsMocks.fetchSettings).not.toHaveBeenCalled();
    expect(settingsMocks.fetchToolCatalog).not.toHaveBeenCalled();
    await act(async () => {
      general.root
        .findByProps({ id: "general-setup-status", open: false })
        .props.onToggle({ currentTarget: { open: true } });
      await flush();
    });
    expect(settingsMocks.fetchSettings).toHaveBeenCalledTimes(1);
    expect(settingsMocks.fetchToolCatalog).toHaveBeenCalledTimes(1);
  });

  it("does not start llama.cpp while its configuration Change Plan is awaiting approval", async () => {
    settingsMocks.patchSettings.mockResolvedValueOnce({
      revision: 29,
      changePlanReceipt: {
        planId: "plan-runtime-pending",
        revision: 2,
        risk: "caution",
        status: "awaiting_approval",
        summary: "Configuration needs approval.",
      },
    });
    const runtime = await mount("runtime");
    expect(settingsMocks.fetchLlamaCppModels).not.toHaveBeenCalled();
    await click(findButton(runtime.root, "Configure llama.cpp"));
    expect(settingsMocks.fetchLlamaCppModels).toHaveBeenCalledTimes(1);
    await change(runtime.root.findByProps({ value: "llama-3" }), "pending-llama-alias");
    await click(findButton(runtime.root, "Start"));
    expect(settingsMocks.patchSettings).not.toHaveBeenCalled();
    await act(async () => runtime.root.findByType(ConfirmModal).props.onConfirm());
    expect(settingsMocks.patchSettings).toHaveBeenCalledTimes(1);
    expect(settingsMocks.startLlamaCppRuntime).not.toHaveBeenCalled();
    expect(runtime.root.findByProps({ value: "pending-llama-alias" })).toBeTruthy();
    expect(collectText(runtime.root)).toContain("Configuration needs approval.");
    expect(hasDirtySections()).toBe(true);
  });

  it("preserves the llama.cpp draft and retries with the refreshed settings revision after a 409", async () => {
    settingsMocks.fetchSettings.mockResolvedValueOnce({ ...settings, revision: 81 }).mockResolvedValueOnce({ ...settings, revision: 81 }).mockResolvedValue({
      ...settings,
      revision: 82,
      llamaCpp: { ...settings.llamaCpp, alias: "remote-llama-alias" },
    });
    settingsMocks.patchSettings.mockRejectedValueOnce(new ApiRequestError("stale runtime settings", {
      kind: "http", method: "PATCH", path: "/api/v1/settings", status: 409,
      body: { code: "STATE_CONFLICT", details: { expectedRevision: 81, currentRevision: 82 } },
    })).mockResolvedValueOnce({ ...settings, revision: 83, llamaCpp: { ...settings.llamaCpp, alias: "local-llama-alias" } });

    const runtime = await mount("runtime");
    await click(findButton(runtime.root, "Configure llama.cpp"));
    const alias = runtime.root.findByProps({ value: "llama-3" });
    await change(alias, "local-llama-alias");
    await click(buttons(runtime.root, "Save")[0]!);
    await act(async () => runtime.root.findByType(ConfirmModal).props.onConfirm());

    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 81,
      llamaCpp: expect.objectContaining({ alias: "local-llama-alias" }),
    });
    expect(settingsMocks.fetchSettings).toHaveBeenCalledTimes(3);
    expect(runtime.root.findByProps({ value: "local-llama-alias" })).toBeTruthy();
    expect(collectText(runtime.root)).toContain("llama.cpp draft is preserved");

    await click(findButton(runtime.root, "Apply draft to current runtime"));
    await click(buttons(runtime.root, "Save")[0]!);
    await act(async () => runtime.root.findByType(ConfirmModal).props.onConfirm());
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 82,
      llamaCpp: expect.objectContaining({ alias: "local-llama-alias" }),
    });
  });

  it("renders compact llama.cpp lease truth and handles older Gateway status", async () => {
    const runtime = await mount("runtime");
    await click(findButton(runtime.root, "Configure llama.cpp"));
    const text = collectText(runtime.root);

    expect(text).toContain("Lifecycle");
    expect(text).toContain("Active leases");
    expect(text).toContain("Chat completion ×2");
    expect(text).toContain("Persistent demand");
    expect(text).toContain("Api");
    expect(text).toContain("Latest probe");
    expect(text).toContain("Latest process exit");
    expect(text).toContain("Latest restart");
    expect(runtime.root.findByProps({ "aria-label": "llama.cpp lease lifecycle" }).props).toMatchObject({
      role: "group",
      "aria-live": "polite",
    });
    runtime.unmount();

    const { leaseDiagnostics, ...legacyStatus } = settings.llamaCpp.status;
    expect(leaseDiagnostics).toBeDefined();
    settingsMocks.fetchSettings.mockResolvedValueOnce({
      ...settings,
      llamaCpp: { ...settings.llamaCpp, status: legacyStatus },
    });
    const legacyRuntime = await mount("runtime");
    await click(findButton(legacyRuntime.root, "Configure llama.cpp"));
    expect(collectText(legacyRuntime.root)).toContain(
      "Lease lifecycle diagnostics are unavailable from this Gateway version.",
    );
    expect(
      legacyRuntime.root.findAll((node) => node.props.role === "status" && collectText(node).includes("unavailable")),
    ).toHaveLength(1);
  });

  it("reloads retired NPU state and retries normalization with the refreshed revision after a 409", async () => {
    settingsMocks.fetchSettings.mockResolvedValueOnce({ ...settings, revision: 83 }).mockResolvedValueOnce({
      ...settings,
      revision: 84,
      npu: { ...settings.npu, sidecarUrl: "http://127.0.0.1:49220" },
    });
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(83, 84)).mockResolvedValueOnce({});

    const runtime = await mount("runtime");
    await click(findButton(runtime.root, "Legacy acceleration"));
    await click(findButton(runtime.root, "Normalize"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 83,
      npu: { enabled: false, autoStart: false, sidecarUrl: "http://127.0.0.1:39110" },
    });
    expect(collectText(runtime.root)).toContain("Current NPU settings were reloaded");

    await click(findButton(runtime.root, "Normalize"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 84,
      npu: { enabled: false, autoStart: false, sidecarUrl: "http://127.0.0.1:49220" },
    });
  });

  it("keeps llama.cpp template aliases out of new Chat routing choices", async () => {
    settingsMocks.providerModelCatalog.providers = [
      ...settingsMocks.providerModelCatalog.providers,
      {
        providerId: "llamacpp",
        label: "llama.cpp",
        baseUrl: "http://127.0.0.1:8080/v1",
        defaultModel: "template-alias",
        apiStyle: "openai-chat-completions",
        models: ["template-alias"],
        hasApiKey: false,
        apiKeySource: "none",
        modelProbeState: "fallback",
        modelProbeSource: "error_fallback",
        modelRefreshStatus: "stale",
      } as (typeof settingsMocks.providerModelCatalog.providers)[number],
    ];
    const providers = await mount("providers");
    await openProviderPanel(providers, "routing");
    const routingProvider = providers.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("llama.cpp"))!;
    await change(routingProvider, "llamacpp");
    expect(collectText(providers.root)).toContain("Check llama.cpp endpoint in Get started");
    expect(findButton(providers.root, "Save routing").props.disabled).toBe(true);
    expect(settingsMocks.patchSettings).not.toHaveBeenCalled();
  });

  it("preserves only the provider routing draft and retries with the refreshed config revision after a 409", async () => {
    settingsMocks.providerModelCatalog.config = {
      ...settingsMocks.providerModelCatalog.config,
      revision: 91,
    };
    settingsMocks.providerModelCatalog.providers = [
      ...settingsMocks.providerModelCatalog.providers,
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        defaultModel: "claude-sonnet-5",
        apiStyle: "anthropic-messages",
        models: ["claude-sonnet-5"],
        hasApiKey: true,
        apiKeySource: "env",
        modelProbeState: "ready",
      },
    ];
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(91, 92, "/api/v1/settings", "PATCH", "STATE_CONFLICT")).mockResolvedValueOnce({});
    settingsMocks.reloadProviderCatalog.mockImplementationOnce(async () => {
      settingsMocks.providerModelCatalog.config = {
        ...settingsMocks.providerModelCatalog.config,
        revision: 92,
        activeProviderId: "openai",
        activeModel: "gpt-remote",
      };
      settingsMocks.providerModelCatalog.providers = settingsMocks.providerModelCatalog.providers.map((provider) =>
        provider.providerId === "anthropic" ? { ...provider, label: "Remote Anthropic" } : provider,
      );
    });

    const providers = await mount("providers");
    await openProviderPanel(providers, "routing");
    const routingProvider = providers.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("Anthropic"))!;
    await change(routingProvider, "anthropic");
    await click(findButton(providers.root, "Save routing"));

    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(1, {
      expectedRevision: 91,
      llm: { activeProviderId: "anthropic", activeModel: "claude-sonnet-5" },
    });
    expect(routingProvider.props.value).toBe("anthropic");
    expect(collectText(providers.root)).toContain("Remote Anthropic");
    expect(collectText(providers.root)).toContain("routing draft is preserved");
    await click(findButton(providers.root, "Apply routing draft to current settings"));

    await click(findButton(providers.root, "Save routing"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(2, {
      expectedRevision: 92,
      llm: { activeProviderId: "anthropic", activeModel: "claude-sonnet-5" },
    });
  });

  it("preserves only the provider editor draft and retries with the refreshed config revision after a 409", async () => {
    settingsMocks.providerModelCatalog.config = {
      ...settingsMocks.providerModelCatalog.config,
      revision: 93,
    };
    settingsMocks.providerModelCatalog.providers = [
      ...settingsMocks.providerModelCatalog.providers,
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        defaultModel: "claude-sonnet-5",
        apiStyle: "anthropic-messages",
        models: ["claude-sonnet-5"],
        hasApiKey: true,
        apiKeySource: "env",
        modelProbeState: "ready",
      },
    ];
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(93, 94, "/api/v1/settings", "PATCH", "STATE_CONFLICT")).mockResolvedValueOnce({});
    settingsMocks.reloadProviderCatalog.mockImplementationOnce(async () => {
      settingsMocks.providerModelCatalog.config = {
        ...settingsMocks.providerModelCatalog.config,
        revision: 94,
        activeProviderId: "anthropic",
        activeModel: "claude-sonnet-5",
      };
    });

    const providers = await mount("providers");
    await openProviderPanel(providers, "editor");
    const providerLabel = providers.root.findByProps({ placeholder: "OpenAI-compatible" });
    await change(providerLabel, "Local OpenAI draft");
    await click(findButton(providers.root, "Save provider"));

    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedRevision: 93,
        llm: { upsertProvider: expect.objectContaining({ providerId: "openai", label: "Local OpenAI draft" }) },
      }),
    );
    expect(providerLabel.props.value).toBe("Local OpenAI draft");
    expect(providerLabel.props.value).toBe("Local OpenAI draft");
    expect(collectText(providers.root)).toContain("provider draft is preserved");
    await click(findButton(providers.root, "Apply draft to current settings"));

    await click(findButton(providers.root, "Save provider"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedRevision: 94,
        llm: { upsertProvider: expect.objectContaining({ providerId: "openai", label: "Local OpenAI draft" }) },
      }),
    );
  });

  it("reloads provider state and retries ChatGPT setup with the refreshed config revision after a 409", async () => {
    settingsMocks.providerModelCatalog.config = {
      ...settingsMocks.providerModelCatalog.config,
      revision: 95,
    };
    settingsMocks.patchSettings.mockRejectedValueOnce(revisionConflict(95, 96, "/api/v1/settings", "PATCH", "STATE_CONFLICT")).mockResolvedValueOnce({});
    settingsMocks.reloadProviderCatalog.mockImplementationOnce(async () => {
      settingsMocks.providerModelCatalog.config = {
        ...settingsMocks.providerModelCatalog.config,
        revision: 96,
      };
    });

    const providers = await mount("providers");
    await openProviderPanel(providers, "oauth");
    await click(findButton(providers.root, "Add provider and continue"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        expectedRevision: 95,
        llm: { upsertProvider: expect.objectContaining({ providerId: "openai-codex" }) },
      }),
    );
    expect(collectText(providers.root)).toContain("add ChatGPT setup again");

    await click(findButton(providers.root, "Add provider and continue"));
    expect(settingsMocks.patchSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedRevision: 96,
        llm: { upsertProvider: expect.objectContaining({ providerId: "openai-codex" }) },
      }),
    );
  });

  it("covers settings fallback stats and route action tails without silently falling through", async () => {
    settingsMocks.fetchSettings.mockRejectedValueOnce(new Error("settings offline"));
    const navigate = vi.fn();
    const general = await mount("general", { navigate });
    await act(async () => {
      general.root
        .findByProps({ id: "general-setup-status", open: false })
        .props.onToggle({ currentTarget: { open: true } });
      await flush();
    });

    const generalText = collectText(general.root);
    expect(generalText).toContain("Some data could not load");
    expect(generalText).toContain("settings offline");
    expect(generalText).toContain("unknown");
    expect(generalText).toContain("n/a");
    expect(generalText).toContain("No active provider");

    const quickRouteButtons = buttons(general.root, "Open").filter((node) => collectText(node).trim() === "Open");
    expect(quickRouteButtons).toHaveLength(17);
    for (const button of quickRouteButtons) {
      await click(button);
    }
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "onboarding", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "budget", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "personalities", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "runtime", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "workspaces", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "integrations", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "channels", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "mcp", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "tools", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "permissions", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "addons", theme: "ops" });

    navigate.mockClear();
    const budget = await mount("budget", { navigate });
    await click(buttons(budget.root, "Open")[0]!);
    await click(buttons(budget.root, "Open")[1]!);
    expect(navigate).toHaveBeenCalledWith({ area: "ops", section: "costs", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });
    expect(collectText(budget.root)).toContain("Budget mode");
    expect(collectText(budget.root)).toContain("Cost evidence");

    navigate.mockClear();
    const unknown = await mount("missing-section", { navigate });
    await click(buttons(unknown.root, "Open")[0]!);
    await click(buttons(unknown.root, "Open")[1]!);
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "general", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });
  });

  it("renders general, access, onboarding demo, runtime, workspace, channel, tool, and add-on flows", async () => {
    const generalNavigate = vi.fn();
    const general = await mount("general", { navigate: generalNavigate });
    await act(async () => {
      general.root
        .findByProps({ id: "general-setup-status", open: false })
        .props.onToggle({ currentTarget: { open: true } });
      await flush();
    });
    expect(collectText(general.root)).toContain("Mission Control posture");
    expect(collectText(general.root)).toContain(
      "Configured and enabled posture for providers, MCP servers, integrations, and identity at a glance.",
    );
    expect(collectText(general.root)).not.toContain("Live status of providers");
    expect(collectText(general.root)).toContain("Quick routes");
    await click(findExactButton(general.root, "Open"));
    expect(generalNavigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });

    const priorSettingsRead = settingsMocks.fetchSettings.getMockImplementation()!;
    let authOwner = { ...settings };
    settingsMocks.fetchSettings.mockImplementation(async () => authOwner);
    settingsMocks.patchGatewayAuthSettings.mockImplementation(async (input: any) => {
      authOwner = { ...authOwner, revision: authOwner.revision + 1, auth: { ...authOwner.auth, mode: input.mode, allowLoopbackBypass: input.allowLoopbackBypass } };
      return { ...authOwner.auth, revision: authOwner.revision };
    });
    settingsMocks.resolveGatewayInstallToken.mockResolvedValue({ token: "install-token", source: "generated", persistedToEnv: false, warnings: [] });
    const access = await mount("access");
    await click(findButton(access.root, "Configure access"));
    expect(collectText(access.root)).toContain("Gateway access");
    expect(collectText(access.root)).toContain("Desktop/mobile continuity");
    expect(collectText(access.root)).toContain("Mobile approval path");
    await change(access.root.findByProps({ placeholder: "New credential (only when replacing)" }), "new-token");
    await click(findButton(access.root, "Save access settings"));
    await act(async () => { access.root.findAllByType(ConfirmModal).find(modal => modal.props.title === "Apply Gateway authentication changes?")!.props.onConfirm(); }); await flush();
    expect(settingsMocks.patchGatewayAuthSettings).toHaveBeenCalledWith({ expectedRevision: 29, mode: "token", allowLoopbackBypass: false, token: "new-token" });
    await click(findButton(access.root, "Generate install token"));
    await act(async () => { access.root.findAllByType(ConfirmModal).find(modal => modal.props.title === "Resolve Gateway install token?")!.props.onConfirm(); }); await flush();
    expect(access.root.findByProps({ readOnly: true, type: "text" }).props.value).toBe("install-token");
    settingsMocks.fetchSettings.mockImplementation(priorSettingsRead);
    await click(findButton(access.root, "Revoke"));
    const revokeModal = access.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Revoke device access?");
    await act(async () => {
      await revokeModal?.props.onConfirm();
    });
    expect(settingsMocks.revokeDeviceAccessGrant).toHaveBeenCalledWith("device-1");

    const setActiveWorkspaceId = vi.fn();
    const onboardingNavigate = vi.fn();
    const setActiveCitadelId = vi.fn();
    const demo = demoFixture();
    settingsMocks.fetchWorkspaces.mockResolvedValue({ items: [demo.workspace] });
    const onboarding = await mount("onboarding", { navigate: onboardingNavigate, setActiveWorkspaceId, setActiveCitadelId });
    expect(collectText(onboarding.root)).toContain("Start Here");
    await click(findButton(onboarding.root, "Try a safe demo"));
    await click(findButton(onboarding.root, "Review demo preparation"));
    await act(async () => { const review = onboarding.root.findAllByType(GCModal).find(modal => modal.props.title === "Prepare local demo")!; expect(review.props.open, collectText(onboarding.root)).toBe(true); await review.props.onConfirm(); }); await flush();
    expect(settingsMocks.bootstrapDemo).toHaveBeenCalledTimes(1);
    expect(onboardingNavigate).not.toHaveBeenCalled();
    await click(findButton(onboarding.root, "Open recorded demo"));
    expect(setActiveWorkspaceId).toHaveBeenCalledWith(demo.workspace.workspaceId);
    expect(setActiveCitadelId).toHaveBeenCalledWith(demo.workspace.citadelId);
    expect(onboardingNavigate).toHaveBeenCalledWith({ area: "chat", sessionId: demo.session.sessionId, projectId: demo.project.projectId, theme: "ops" });

    const runtime = await mount("runtime");
    expect(collectText(runtime.root)).toContain("Runtime posture");
    await click(findButton(runtime.root, "Gateway controls"));
    await click(buttons(runtime.root, "Start")[0]!);
    await click(buttons(runtime.root, "Stop")[0]!);
    await click(findButton(runtime.root, "Restart"));
    expect(settingsMocks.startDaemon).toHaveBeenCalledTimes(1);
    expect(settingsMocks.stopDaemon).toHaveBeenCalledTimes(1);
    expect(settingsMocks.restartDaemon).toHaveBeenCalledTimes(1);

    await click(findButton(runtime.root, "Configure llama.cpp"));
    await change(runtime.root.findByProps({ value: "http://127.0.0.1:8080/v1" }), "http://127.0.0.1:9090/v1");
    expect(runtime.root.findByProps({ value: "llama-server" }).props.readOnly).toBe(true);
    expect(runtime.root.findByProps({ value: "F:/models" }).props.readOnly).toBe(true);
    expect(runtime.root.findByProps({ value: "F:/models/llama-3.gguf" }).props.readOnly).toBe(true);
    await change(runtime.root.findByProps({ value: "llama-3" }), "llama-custom");
    const runtimeCheckboxes = runtime.root.findAll((node) => node.type === "input" && node.props.type === "checkbox");
    await change(runtimeCheckboxes[0]!, "", false);
    await change(runtimeCheckboxes[1]!, "", false);
    settingsMocks.patchSettings.mockImplementationOnce(async (input) => ({
      ...((await settingsMocks.fetchSettings()) as object),
      revision: input.expectedRevision + 1,
      llamaCpp: { ...settings.llamaCpp, ...input.llamaCpp },
    }));
    await click(buttons(runtime.root, "Save")[0]!);
    await act(async () => runtime.root.findByType(ConfirmModal).props.onConfirm());
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 29,
      llamaCpp: {
        enabled: false,
        autoStart: false,
        baseUrl: "http://127.0.0.1:9090/v1",
        alias: "llama-custom",
      },
    });
    await click(buttons(runtime.root, "Start")[0]!);
    await click(buttons(runtime.root, "Stop")[0]!);
    await click(buttons(runtime.root, "Refresh")[0]!);
    expect(settingsMocks.startLlamaCppRuntime).toHaveBeenCalledTimes(1);
    expect(settingsMocks.stopLlamaCppRuntime).toHaveBeenCalledTimes(1);
    expect(settingsMocks.refreshLlamaCppRuntime).toHaveBeenCalledTimes(1);

    // NPU sidecar support is retired from the shipped 1.0 runtime, so the
    // "Local acceleration" panel no longer exposes a sidecar URL field,
    // enable/auto-start toggles, or start/stop controls. It only normalizes the
    // retired settings (forcing disabled, preserving the recorded sidecar URL)
    // and refreshes status.
    await click(findButton(runtime.root, "Legacy acceleration"));
    await click(findButton(runtime.root, "Normalize"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 29,
      npu: {
        enabled: false,
        autoStart: false,
        sidecarUrl: "http://127.0.0.1:39110",
      },
    });
    await click(buttons(runtime.root, "Refresh")[0]!);
    expect(settingsMocks.refreshNpuRuntime).toHaveBeenCalledTimes(1);

    await click(findButton(runtime.root, "Voice setup"));
    await click(findButton(runtime.root, "Install starter model"));
    expect(settingsMocks.installVoiceRuntime).not.toHaveBeenCalled();
    await act(async () => runtime.root.findAllByType(ConfirmModal).find(modal => modal.props.title === "Change the local voice runtime?")!.props.onConfirm()); await flush();
    await click(findButton(runtime.root, "Use Small multilingual"));
    await act(async () => runtime.root.findAllByType(ConfirmModal).find(modal => modal.props.title === "Change the local voice runtime?")!.props.onConfirm()); await flush();
    expect(settingsMocks.installVoiceRuntime).toHaveBeenCalledWith({ modelId: "base", activate: true });
    expect(settingsMocks.selectVoiceRuntimeModel).toHaveBeenCalledWith("small");

    const workspaceSetter = vi.fn();
    let lifecycleRows = [...workspaces, { ...workspaces[0]!, workspaceId: "review-archive", name: "Review workspace", slug: "review-workspace" }];
    settingsMocks.fetchWorkspaces.mockImplementation(async () => ({ items: lifecycleRows, citadelId: "personal" }));
    settingsMocks.archiveWorkspace.mockImplementation(async (id, revision) => {
      const before = lifecycleRows.find(item => item.workspaceId === id)!;
      expect(before.revision).toBe(revision);
      const after = { ...before, revision: revision + 1, lifecycleStatus: "archived" as const, archivedAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" };
      lifecycleRows = lifecycleRows.map(item => item.workspaceId === id ? after : item);
      return after;
    });
    settingsMocks.restoreWorkspace.mockImplementation(async (id, revision) => {
      const before = lifecycleRows.find(item => item.workspaceId === id)!;
      expect(before.revision).toBe(revision);
      const after = { ...before, revision: revision + 1, lifecycleStatus: "active" as const, updatedAt: "2026-09-30T01:00:00.000Z" };
      lifecycleRows = lifecycleRows.map(item => item.workspaceId === id ? after : item);
      return after;
    });
    const workspacesPage = await mount("workspaces", { setActiveWorkspaceId: workspaceSetter });
    expect(collectText(workspacesPage.root)).toContain("Workspace directory");
    expect(workspacesPage.root.findByProps({ "aria-label": "Archived workspaces" })).toBeTruthy();
    expect(workspacesPage.root.findAllByType("textarea")).toHaveLength(0);
    await click(findButton(workspacesPage.root, "Default"));
    await click(findButton(workspacesPage.root, "Edit workspace"));
    await change(workspacesPage.root.findByProps({ value: "Default" }), "Default edited");
    await change(workspacesPage.root.findByProps({ value: "default" }), "default-edited");
    await change(
      workspacesPage.root.findByProps({ value: "Primary workspace" }),
      "Updated default workspace description",
    );
    await click(findButton(workspacesPage.root, "Save changes"));
    expect(settingsMocks.updateWorkspace).toHaveBeenCalledWith("default", {
      expectedRevision: 11,
      name: "Default edited",
      slug: "default-edited",
      description: "Updated default workspace description",
    });
    await click(findButton(workspacesPage.root, "Close editor"));
    await click(findButton(workspacesPage.root, "Default"));
    await click(workspacesPage.root.findByProps({ "aria-label": "Make active workspace Default" }));
    expect(workspaceSetter).toHaveBeenCalledWith("default");
    await click(findButton(workspacesPage.root, "Default"));
    expect(workspacesPage.root.findByProps({ "aria-label": "Archive workspace Default" }).props.disabled).toBe(true);
    await click(findButton(workspacesPage.root, "Review workspace"));
    await click(workspacesPage.root.findByProps({ "aria-label": "Archive workspace Review workspace" }));
    const archiveModal = workspacesPage.root.findByType(ConfirmModal);
    expect(archiveModal.props.open).toBe(true);
    expect(archiveModal.props.confirmLabel).toBe("Confirm archive workspace");
    await act(async () => archiveModal.props.onCancel());
    expect(settingsMocks.archiveWorkspace).not.toHaveBeenCalled();
    await click(workspacesPage.root.findByProps({ "aria-label": "Archive workspace Review workspace" }));
    await act(async () => workspacesPage.root.findByType(ConfirmModal).props.onConfirm());
    await flush();
    expect(settingsMocks.archiveWorkspace).toHaveBeenCalledWith("review-archive", 11);
    await click(workspacesPage.root.findByProps({ "aria-label": "Archived workspaces" }));
    await click(
      workspacesPage.root.findAllByType("button").find((node) => collectText(node).includes("Archived workspace"))!,
    );
    await click(workspacesPage.root.findByProps({ "aria-label": "Restore workspace Archive" }));
    expect(settingsMocks.restoreWorkspace).not.toHaveBeenCalled();
    await act(async () => workspacesPage.root.findByType(ConfirmModal).props.onConfirm());
    expect(settingsMocks.restoreWorkspace).toHaveBeenCalledWith("archive-1", 13);
    await click(findButton(workspacesPage.root, "New workspace"));
    await change(workspacesPage.root.findByProps({ "aria-label": "New workspace name" }), "Created workspace");
    await change(workspacesPage.root.findAllByType("input")[1]!, "created-workspace");
    await change(workspacesPage.root.findByType("textarea"), "Created workspace description");
    await click(findButton(workspacesPage.root, "Create workspace"));
    expect(settingsMocks.createWorkspace).toHaveBeenCalledWith({
      citadelId: "personal",
      name: "Created workspace",
      slug: "created-workspace",
      description: "Created workspace description",
    });

    const channels = await mount("channels");
    expect(collectText(channels.root)).toContain("Channel connections");
    await click(findButton(channels.root, "Connect channel"));
    await click(findExactButton(channels.root, "Use"));
    await change(
      channels.root.findAllByType("select").find((select) => collectText(select).includes("Telegram"))!,
      "channel.telegram",
    );
    await click(findButton(channels.root, "Back to list"));
    await click(findButton(channels.root, "Telegram setup"));
    await change(channels.root.findByProps({ value: "Telegram setup" }), "Telegram production");
    await change(channels.root.findAllByType("input").find((input) => input.props.type === "checkbox")!, "", false);
    await click(findButton(channels.root, "Advanced JSON"));
    await change(
      channels.root.findByType("textarea"),
      '{\n  "botTokenEnv": "TELEGRAM_TOKEN",\n  "setupCode": "SETUP2"\n}',
    );
    await click(findButton(channels.root, "Guided setup"));
    await click(findButton(channels.root, "Detect Telegram chats"));
    expect(settingsMocks.discoverTelegramTargets).toHaveBeenCalledWith({
      botToken: undefined,
      botTokenEnv: "TELEGRAM_TOKEN",
      setupCode: "SETUP2",
    });
    await click(findButton(channels.root, "Advanced JSON"));
    await click(findButton(channels.root, "Save draft"));
    await click(findButton(channels.root, "Advanced JSON"));
    await click(findButton(channels.root, "Validate"));
    await click(findButton(channels.root, "Advanced JSON"));
    await click(findButton(channels.root, "Run live test"));
    expect(settingsMocks.updateChannelSetupDraft).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({
        enabled: false,
        label: "Telegram production",
        draft: expect.objectContaining({ setupCode: "SETUP2" }),
      }),
    );
    expect(settingsMocks.validateChannelSetupDraft).toHaveBeenCalledWith("draft-1", 2);
    expect(settingsMocks.testChannelSetupDraft).toHaveBeenCalledWith("draft-1", 4);
    expect(settingsMocks.finalizeChannelSetupDraft).not.toHaveBeenCalled();

    const tools = await mount("tools");
    expect(collectText(tools.root)).toContain("Tool catalog");
    await change(
      tools.root.findAllByType("select").find((select) => select.props.value === "approve_risky")!,
      "bypass",
    );
    await click(findButton(tools.root, "Save mode"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 29,
      toolApprovalMode: "bypass",
    });
    await change(tools.root.findByProps({ placeholder: "Search tool name, category, or description" }), "shell");
    await click(findButton(tools.root, "shell.run"));
    await click(findButton(tools.root, "Create tool grant"));
    await change(tools.root.findAllByType("input").find((input) => input.props.value === "shell.run")!, "shell.exec");
    await change(tools.root.findAllByType("select").find((select) => select.props.value === "allow")!, "deny");
    await change(tools.root.findAllByType("select").find((select) => select.props.value === "workspace")!, "session");
    await change(
      tools.root
        .findAllByType("input")
        .find(
          (input) =>
            input.props.className === "mc-next-settings-input" && input.props.value === "" && !input.props.disabled,
        )!,
      "session-1",
    );

    await click(findButton(tools.root, "Create grant"));
    await act(async () => {
      await tools.root
        .findAllByType(ConfirmModal)
        .find((modal) => modal.props.open && modal.props.title === "Confirm tool grant")!
        .props.onConfirm();
      await flush();
    });
    expect(settingsMocks.createToolGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        toolPattern: "shell.exec",
        decision: "deny",
        scope: "session",
        scopeRef: "session-1",
        grantType: "persistent",
      }),
    );
    await click(findButton(tools.root, "All grants"));
    await click(findButton(tools.root, "Revoke"));
    const toolRevokeModal = tools.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Revoke tool grant?");
    await act(async () => {
      await toolRevokeModal?.props.onConfirm();
    });
    expect(settingsMocks.revokeToolGrant).toHaveBeenCalledWith("grant-1");

    // The real route mounts one settings owner at a time. Retire earlier
    // journey renderers so their dirty registries cannot block Add-ons tabs.
    await act(async () => {
      for (const renderer of mountedSettingsRenderers.splice(0)) renderer.unmount();
    });
    const arena = {
      addonId: "arena", label: "Arena",
      description: "Optional AI gladiator arena add-on for match play, commentary, and fun agent battles.",
      owner: "spurnout", repoUrl: "https://github.com/spurnout/goatcitadel-arena",
      sameOwnerAsGoatCitadel: true, trustTier: "restricted", category: "fun_optional",
      runtimeType: "separate_repo_app", webEntryMode: "external_local_url",
      requiresSeparateRepoDownload: true,
      installCommands: [
        { command: "git", args: ["init", "<install-dir>"] },
        { command: "git", args: ["-C", "<install-dir>", "fetch", "--depth", "1", "--no-tags", "https://github.com/spurnout/goatcitadel-arena", "afce1692c9504aee816423fbb0dcb6bd24496053"] },
        { command: "git", args: ["-C", "<install-dir>", "checkout", "--detach", "afce1692c9504aee816423fbb0dcb6bd24496053"] },
        { command: "corepack", args: ["pnpm", "install", "--frozen-lockfile"] },
        { command: "corepack", args: ["pnpm", "-r", "run", "build"] },
      ],
      healthChecks: [{ key: "provenance", status: "warn", message: "Separate repository owned by the same publisher." }],
    } satisfies import("@goatcitadel/contracts").AddonCatalogEntry;
    settingsMocks.fetchAddonsCatalog.mockResolvedValue({ items: [arena] });
    settingsMocks.fetchInstalledAddons.mockResolvedValue({ items: [] });
    settingsMocks.fetchAddonStatus.mockResolvedValue({ addon: arena, status: "not_installed", healthChecks: arena.healthChecks });
    const addons = await mount("addons");
    await flush();
    expect(collectText(addons.root)).toContain("1.0 add-on posture");
    expect(collectText(addons.root)).toContain("Experimental local extensions");
    expect(collectText(addons.root)).toContain("Local-only boundary");
    expect(collectText(addons.root)).toContain("Add-on catalog");
    expect(settingsMocks.fetchCapabilityPacks).not.toHaveBeenCalled();
    expect(collectText(addons.root)).toContain("Arena");
    await click(findButton(addons.root, "Inspect"));
    expect(findButton(addons.root, "Launch").props.disabled).toBe(true);
    expect(findButton(addons.root, "Update").props.disabled).toBe(true);
    await click(findButton(addons.root, "Install"));
    const installReview = addons.root.findAllByType(ConfirmModal)
      .find((modal) => modal.props.open && modal.props.title === "Review add-on install");
    expect(installReview).toBeDefined();
    expect(installReview?.props.message).toContain(arena.repoUrl);
    expect(installReview?.props.message).toContain("starts disabled");
    expect(installReview?.props.message).toContain("download and build repository code on this computer");
    for (const command of arena.installCommands) {
      expect(installReview?.props.message).toContain([command.command, ...command.args].join(" "));
    }
    await act(async () => { installReview?.props.onCancel(); await flush(); });
    expect(addons.root.findAllByType(ConfirmModal).some((modal) => modal.props.open)).toBe(false);
    for (const mutation of [settingsMocks.installAddon, settingsMocks.updateAddon, settingsMocks.enableAddon,
      settingsMocks.disableAddon, settingsMocks.launchAddon, settingsMocks.stopAddon, settingsMocks.uninstallAddon]) {
      expect(mutation).not.toHaveBeenCalled();
    }
    await click(findButton(addons.root, "Capability packs"));
    expect(settingsMocks.fetchCapabilityPacks).toHaveBeenCalled();
    expect(collectText(addons.root)).toContain("Operator Pack");
    expect(collectText(addons.root)).toContain("No capability is installed, enabled, connected or invoked by staging.");
    await click(findButton(addons.root, "Add-ons"));
    expect(collectText(addons.root)).toContain("Add-on catalog");
    expect(settingsMocks.installCapabilityPack).not.toHaveBeenCalled();
    expect(settingsMocks.materializeStagedCapabilityPack).not.toHaveBeenCalled();
    expect(settingsMocks.installLocalCapabilityPack).not.toHaveBeenCalled();
  });

  it("renders gateway auth credential-plan warnings on the access page", async () => {
    settingsMocks.fetchSettings.mockResolvedValueOnce({
      ...settings,
      auth: {
        ...settings.auth,
        plan: {
          mode: "token",
          warnings: ["Gateway auth mode is token, but no token is configured."],
          token: { configured: false, source: "none" },
          basicUsername: { configured: false, source: "none" },
          basicPassword: { configured: false, source: "none" },
        },
      },
    });

    const access = await mount("access");
    await click(findButton(access.root, "Configure access"));

    expect(collectText(access.root)).toContain("Gateway auth mode is token, but no token is configured.");
  });

  it("covers integration detail actions and native load warnings", async () => {
    const original = (await settingsMocks.fetchIntegrationConnections()).items[0];
    const ownedConnections = new Map([[original.connectionId, original]]);
    settingsMocks.fetchIntegrationConnections.mockImplementation(async () => ({ items: [...ownedConnections.values()] }));
    settingsMocks.fetchIntegrationConnection.mockImplementation(async (id: string) => {
      const found = ownedConnections.get(id);
      if (!found) throw new ApiRequestError("Not found", { kind: "http", method: "GET", path: `/api/v1/integrations/connections/${id}`, status: 404, body: { code: "ENTITY_NOT_FOUND" } });
      return found;
    });
    settingsMocks.createIntegrationConnection.mockImplementation(async (input) => {
      const created = { ...original, ...input, connectionId: "conn-created", label: input.label ?? "GitHub", revision: "c".repeat(64) };
      ownedConnections.set(created.connectionId, created); return created;
    });
    settingsMocks.updateIntegrationConnection.mockImplementation(async (id, input) => {
      const updated = { ...ownedConnections.get(id), ...input, revision: "b".repeat(64) };
      delete updated.expectedRevision; ownedConnections.set(id, updated); return updated;
    });
    settingsMocks.deleteIntegrationConnection.mockImplementation(async (id) => { ownedConnections.delete(id); return { deleted: true }; });
    settingsMocks.fetchIntegrationConnectionDiagnostics.mockResolvedValue({ connectorType: "integration_connection", connectorId: "conn-1", status: "ok", checkedAt: "2026-04-24T12:30:00.000Z", checks: [] });
    settingsMocks.invokeIntegrationConnectionAction.mockResolvedValue({ connectionId: "conn-1", catalogId: "github", actionId: "sync-issues", status: "executed", message: "Synced issues.", checkedAt: "2026-04-24T12:30:00.000Z" });
    const integrations = await mount("integrations");
    expect(collectText(integrations.root)).toContain("GitHub");
    await click(findButton(integrations.root, "Add integration"));
    await change(
      integrations.root.findAllByType("select").find((select) => collectText(select).includes("GitHub"))!,
      "github",
    );
    await change(integrations.root.findByProps({ placeholder: "Optional connection label" }), "GitHub custom");
    await click(findButton(integrations.root, "Advanced JSON"));
    await change(integrations.root.findByType("textarea"), '{\n  "tokenEnv": "GH_JSON"\n}');
    await click(findButton(integrations.root, "Create connection"));
    expect(settingsMocks.createIntegrationConnection).toHaveBeenCalledWith({
      catalogId: "github",
      label: "GitHub custom",
      enabled: true,
      config: { tokenEnv: "GH_JSON" },
    });
    await act(async () => integrations.root.findAllByType(DetailInspector).find((panel) => panel.props.open)!.props.onClose());
    await flush();
    await click(findButton(integrations.root, "GitHub"));
    await click(findButton(integrations.root, "Edit connection"));
    await change(
      integrations.root.findAllByType("input").find((input) => input.props.value === "GitHub")!,
      "GitHub ops",
    );
    await change(
      integrations.root.findAllByType("select").find((select) => select.props.value === "connected")!,
      "paused",
    );
    await change(integrations.root.findByProps({ "aria-label": "Integration connection enabled" }), "", false);
    await click(findButton(integrations.root, "Advanced JSON"));
    await change(integrations.root.findByType("textarea"), '{\n  "tokenEnv": "GH_DETAIL"\n}');
    await click(findButton(integrations.root, "Save changes"));
    expect(settingsMocks.updateIntegrationConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({
        label: "GitHub ops",
        status: "paused",
        enabled: false,
        config: { tokenEnv: "GH_DETAIL" },
      }),
    );
    expect(hasDirtySections()).toBe(false);
    await click(findButton(integrations.root, "Close editor"));
    await click(findButton(integrations.root, "GitHub ops"));
    expect(findButton(integrations.root, "Run diagnostics").props.disabled).toBe(false);
    await click(findButton(integrations.root, "Run diagnostics"));
    expect(settingsMocks.fetchIntegrationConnectionDiagnostics).toHaveBeenCalledWith("conn-1");
    expect(collectText(integrations.root)).toContain("Gateway diagnostics received");

    await click(findExactButton(integrations.root, "Run"));
    expect(settingsMocks.invokeIntegrationConnectionAction).not.toHaveBeenCalled();
    await act(async () => integrations.root.findAllByType(ConfirmModal).find((modal) => modal.props.title === "Run reviewed integration action?")!.props.onConfirm());
    await flush();
    expect(settingsMocks.invokeIntegrationConnectionAction).toHaveBeenCalledWith("conn-1", "sync-issues", {});
    await click(findButton(integrations.root, "Delete"));
    let deleteConnectionModal = integrations.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Delete integration connection?");
    expect(deleteConnectionModal?.props.open).toBe(true);
    await act(async () => {
      deleteConnectionModal?.props.onCancel();
    });
    expect(settingsMocks.deleteIntegrationConnection).not.toHaveBeenCalled();
    await click(findButton(integrations.root, "Delete"));
    deleteConnectionModal = integrations.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Delete integration connection?");
    await act(async () => {
      await deleteConnectionModal?.props.onConfirm();
    });
    await flush();
    expect(settingsMocks.deleteIntegrationConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );

    settingsMocks.fetchMcpServers.mockRejectedValueOnce(new Error("mcp offline"));
    const general = await mount("general");
    await act(async () => {
      general.root
        .findByProps({ id: "general-setup-status", open: false })
        .props.onToggle({ currentTarget: { open: true } });
      await flush();
    });
    expect(collectText(general.root)).toContain("Some data could not load");
    expect(collectText(general.root)).toContain("mcp offline");
    await click(findButton(general.root, "Retry"));
    expect(settingsMocks.fetchMcpServers).toHaveBeenCalled();
  });

  it("explains and disables integration diagnostics when the runtime capability is off", async () => {
    settingsMocks.fetchIntegrationCatalog.mockResolvedValueOnce({
      items: [
        {
          catalogId: "github",
          key: "github",
          label: "GitHub",
          description: "GitHub issues and pulls",
          kind: "service",
          capabilities: ["issues"],
          authMethods: ["token"],
          operatorActions: [],
        },
      ],
    });
    settingsMocks.fetchSettings.mockResolvedValueOnce({
      ...settings,
      features: {
        ...settings.features,
        connectorDiagnosticsV1Enabled: false,
      },
    });

    const integrations = await mount("integrations");
    await click(findButton(integrations.root, "GitHub"));

    expect(findButton(integrations.root, "Run diagnostics").props.disabled).toBe(true);
    const text = collectText(integrations.root);
    expect(text).toContain("Connector diagnostics are not enabled in Runtime settings.");
    expect(text).toContain("diagnostics remain unavailable until enabled in Runtime settings");
    expect(text).not.toContain("Save changes and run diagnostics here");
    expect(settingsMocks.fetchIntegrationConnectionDiagnostics).not.toHaveBeenCalled();
  });

  it("retains run-diagnostics guidance for an enabled integration without operator actions", async () => {
    settingsMocks.fetchIntegrationCatalog.mockResolvedValueOnce({
      items: [
        {
          catalogId: "github",
          key: "github",
          label: "GitHub",
          description: "GitHub issues and pulls",
          kind: "service",
          capabilities: ["issues"],
          authMethods: ["token"],
          operatorActions: [],
        },
      ],
    });

    const integrations = await mount("integrations");
    await click(findButton(integrations.root, "GitHub"));

    expect(findButton(integrations.root, "Run diagnostics").props.disabled).toBe(false);
    expect(collectText(integrations.root)).toContain("Save changes and run diagnostics here");
  });

  it("withholds unconfirmed defaults and malformed demo receipts while retaining navigation", async () => {
    settingsMocks.bootstrapOnboarding.mockRejectedValueOnce(new Error("defaults failed"));
    settingsMocks.completeOnboarding.mockRejectedValueOnce(new Error("complete failed"));
    settingsMocks.bootstrapDemo.mockResolvedValueOnce({
      status: "partial",
      notes: [],
      workspace: null,
      sessions: [{ sessionId: "code-demo", mode: "code" }],
    });

    const navigate = vi.fn();
    const setActiveWorkspaceId = vi.fn();
    const onboarding = await mount("onboarding", { navigate, setActiveWorkspaceId });

    await click(findButton(onboarding.root, "First-run defaults"));
    const selects = onboarding.root.findAllByType("select");
    const selectWithOption = (value: string) =>
      selects.find((select) => select.findAllByType("option").some((option) => option.props.value === value));
    await change(selectWithOption("bypass")!, "bypass");
    await change(selectWithOption("power")!, "power");
    await change(
      onboarding.root.findByProps({ placeholder: "example.com, api.example.com" }),
      "api.example.com, localhost",
    );
    await click(findButton(onboarding.root, "Review defaults"));
    await act(async () => { const review = onboarding.root.findAllByType(GCModal).find(modal => modal.props.title === "Apply first-run defaults")!; expect(review.props.open).toBe(true); await review.props.onConfirm(); }); await flush();
    expect(settingsMocks.bootstrapOnboarding).toHaveBeenCalledWith({
      expectedRevision: 29,
      toolApprovalMode: "bypass",
      budgetMode: "power",
      networkAllowlist: ["api.example.com", "localhost"],
      auth: {
        allowLoopbackBypass: false,
      },
    });
    expect(collectText(onboarding.root)).toContain("Defaults outcome is unconfirmed");
    expect(findButton(onboarding.root, "Mark complete").props.disabled).toBe(true);
    expect(settingsMocks.completeOnboarding).not.toHaveBeenCalled();

    await click(findButton(onboarding.root, "Back to list"));
    await act(async () =>
      onboarding.root
        .findAllByType(DraftLeaveDialog)
        .find((node) => node.props.open)!
        .props.onContinue(),
    );
    await click(findButton(onboarding.root, "Verification evidence"));
    await click(findButton(onboarding.root, "Configure"));
    await click(findButton(onboarding.root, "Start demo/local"));
    await click(findButton(onboarding.root, "Open Chat"));
    await click(findButton(onboarding.root, "Inspect proof"));
    await click(findButton(onboarding.root, "Access"));
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "providers", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "onboarding", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "chat", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "library", section: "artifacts", theme: "ops" });
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "access", theme: "ops" });

    await click(findButton(onboarding.root, "Back to list"));
    await click(findButton(onboarding.root, "Try a safe demo"));
    await click(findButton(onboarding.root, "Review demo preparation"));
    await act(async () => { const review = onboarding.root.findAllByType(GCModal).find(modal => modal.props.title === "Prepare local demo")!; expect(review.props.open).toBe(true); await review.props.onConfirm(); }); await flush();
    expect(settingsMocks.bootstrapDemo).toHaveBeenCalledTimes(1);
    expect(setActiveWorkspaceId).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith({ area: "chat", sessionId: "code-demo", theme: "ops" });
    expect(collectText(onboarding.root)).toContain("Demo preparation is unconfirmed");

    await click(findButton(onboarding.root, "Refresh demo state"));
    expect(collectText(onboarding.root)).toContain("Start Here");
  });

  it("disables Gateway daemon controls when the daemon status is read-only", async () => {
    settingsMocks.fetchDaemonStatus.mockResolvedValueOnce({
      running: false,
      pid: 0,
      uptimeSeconds: 0,
      host: "localhost",
      state: "stopped",
      supported: true,
      controllable: false,
      controlMessage: "Managed outside Mission Control.",
    });

    const runtime = await mount("runtime");
    await click(findButton(runtime.root, "Gateway controls"));

    expect(collectText(runtime.root)).toContain("Read-only");
    expect(collectText(runtime.root)).toContain("Managed outside Mission Control.");
    expect(buttons(runtime.root, "Start")[0]!.props.disabled).toBe(true);
    expect(buttons(runtime.root, "Stop")[0]!.props.disabled).toBe(true);
    expect(findButton(runtime.root, "Restart").props.disabled).toBe(true);
    expect(settingsMocks.startDaemon).not.toHaveBeenCalled();
    expect(settingsMocks.stopDaemon).not.toHaveBeenCalled();
    expect(settingsMocks.restartDaemon).not.toHaveBeenCalled();
  });

  it("covers demo load, ready, and bootstrap error branches", async () => {
    settingsMocks.fetchDemoState.mockResolvedValue(demoFixture().state);
    settingsMocks.bootstrapDemo.mockReset();
    settingsMocks.bootstrapDemo.mockRejectedValueOnce(new Error("demo bootstrap failed"));
    const navigate = vi.fn();
    const setActiveWorkspaceId = vi.fn();
    const readyDemo = await mount("onboarding", { navigate, setActiveWorkspaceId });
    await click(findButton(readyDemo.root, "Try a safe demo"));
    expect(collectText(readyDemo.root)).toContain("reusing or restoring");
    expect(collectText(readyDemo.root)).toContain("Open recorded demo");
    await click(findButton(readyDemo.root, "Review demo preparation"));
    await act(async () => { const review = readyDemo.root.findAllByType(GCModal).find(modal => modal.props.title === "Prepare local demo")!; expect(review.props.open).toBe(true); await review.props.onConfirm(); }); await flush();
    expect(collectText(readyDemo.root)).toContain("Demo preparation is unconfirmed");
    expect(navigate).not.toHaveBeenCalled();
    settingsMocks.fetchDemoState.mockReset();
    settingsMocks.fetchDemoState.mockRejectedValueOnce(new Error("demo state offline"));
    const failedDemo = await mount("onboarding", { navigate, setActiveWorkspaceId });
    await click(findButton(failedDemo.root, "Try a safe demo"));
    await flush();
    expect(collectText(failedDemo.root)).toContain("Demo preparation is unconfirmed");
    expect(collectText(failedDemo.root)).toContain("Not checked");
    settingsMocks.fetchDemoState.mockResolvedValue(demoFixture().empty);
    await click(findButton(failedDemo.root, "Refresh demo state"));
    expect(collectText(failedDemo.root)).toContain("not started");
  });

  it("covers MCP create, edit, runtime actions, diagnostics, and delete branches", async () => {
    const createdServer = {
      serverId: "srv-created",
      label: "Template stdio",
      transport: "stdio",
      command: "npx template-server",
      authType: "none",
      enabled: true,
      status: "connected",
      category: "development",
      trustTier: "trusted",
      costTier: "free",
      policy: {
        requireFirstToolApproval: true,
        redactionMode: "basic",
        allowedToolPatterns: [],
        blockedToolPatterns: [],
      },
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z",
    };
    settingsMocks.fetchMcpServers.mockResolvedValue({
      items: [
        {
          serverId: "srv-1",
          label: "Approval Inbox",
          transport: "http",
          url: "https://mcp.example.test/mcp",
          authType: "none",
          enabled: true,
          status: "connected",
          category: "system",
          trustTier: "trusted",
          costTier: "free",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
        {
          serverId: "srv-stdio",
          label: "Local Research",
          transport: "stdio",
          command: "node research.js",
          authType: "none",
          enabled: true,
          status: "disconnected",
          category: "research",
          trustTier: "trusted",
          costTier: "free",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
      ],
    });
    settingsMocks.fetchMcpTemplates.mockResolvedValue({
      items: [
        {
          templateId: "stdio-template",
          label: "Template stdio",
          description: "Local template",
          transport: "stdio",
          command: "npx template-server",
          args: ["--read-only", "fixture"],
          authType: "none",
          category: "development",
          trustTier: "trusted",
          costTier: "free",
          enabledByDefault: true,
          installed: false,
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
        },
        {
          templateId: "http-template",
          label: "Template URL",
          description: "Remote template",
          transport: "http",
          url: "https://mcp.example.test/sse",
          authType: "none",
          category: "research",
          trustTier: "trusted",
          costTier: "free",
          enabledByDefault: false,
          installed: false,
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
        },
      ],
    });
    settingsMocks.fetchMcpTools.mockResolvedValue({
      items: [{ toolName: "approval.inspect", description: "Inspect pending approvals" }],
    });
    let mcpRecords: Array<Record<string, unknown>> = ((await settingsMocks.fetchMcpServers()).items ?? []).map(server => ({ ...server, revision: "a".repeat(64) }));
    let savedRevision = 2;
    settingsMocks.fetchMcpServers.mockImplementation(async () => ({ items: structuredClone(mcpRecords) }));
    settingsMocks.fetchMcpServer.mockImplementation(async id => {
      const current = mcpRecords.find(server => server.serverId === id);
      if (!current) throw new ApiRequestError("MCP server not found", { kind: "http", method: "GET", path: `/api/v1/mcp/servers/${id}`, status: 404, body: { code: "ENTITY_NOT_FOUND" } });
      return structuredClone(current);
    });
    settingsMocks.createMcpServer.mockImplementationOnce(async (input) => {
      const created = { ...createdServer, ...input, status: "disconnected", revision: "c".repeat(64) };
      mcpRecords.push(created); return structuredClone(created);
    });
    settingsMocks.updateMcpServer.mockImplementation(async (id: string, input: Record<string, unknown>) => {
      const before = mcpRecords.find(server => server.serverId === id)!;
      expect(input.expectedRevision).toBe(before.revision);
      const { expectedRevision: _review, ...fields } = input;
      const saved = { ...before, ...fields, status: "disconnected", revision: (++savedRevision).toString(16).padStart(64, "0") };
      mcpRecords = mcpRecords.map(server => server.serverId === id ? saved : server); return structuredClone(saved);
    });
    for (const [action, mock] of [["connect", settingsMocks.connectReviewedMcpServer], ["disconnect", settingsMocks.disconnectReviewedMcpServer]] as const) {
      mock.mockImplementation(async (id, reviewed) => {
        const before = mcpRecords.find(server => server.serverId === id)!;
        expect(reviewed).toEqual({ expectedRevision: before.revision, expectedConnectionRevision: before.connectionRevision ?? null });
        const server = { ...before, status: action === "connect" ? "connected" : "disconnected", connectionRevision: (++savedRevision).toString(16).padStart(64, "0") };
        mcpRecords = mcpRecords.map(item => item.serverId === id ? server : item);
        return { version: 1, action, reviewed, server: structuredClone(server) };
      });
    }
    settingsMocks.deleteMcpServer.mockImplementation(async (id: string, expectedRevision: string) => {
      expect(expectedRevision).toBe(mcpRecords.find(server => server.serverId === id)?.revision);
      mcpRecords = mcpRecords.filter(server => server.serverId !== id); return { deleted: true };
    });
    settingsMocks.runMcpServerHealthCheck.mockResolvedValueOnce({
      connectorType: "mcp_server", connectorId: "srv-1", checkedAt: "2026-09-30T00:00:00Z",
      status: "ok",
      checks: [{ key: "status", status: "pass", message: "Saved connection state checked." }],
      recommendedNextAction: "Ready.",
    });

    const navigate = vi.fn();
    const mcp = await mount("mcp", { navigate });
    await click(findButton(mcp.root, "Add server"));
    await click(findButton(mcp.root, "Create MCP server"));
    expect(collectText(mcp.root)).toContain("Server label is required.");

    await click(buttons(mcp.root, "Use")[1]!);
    await change(mcp.root.findByProps({ value: "https://mcp.example.test/sse" }), "https://mcp.example.test/updated");
    await click(buttons(mcp.root, "Use")[0]!);
    await change(mcp.root.findByProps({ value: "Template stdio" }), "Manual Template");
    await change(mcp.root.findByProps({ value: "npx template-server" }), "npx template-server --stdio");
    await change(mcp.root.findAllByType("input").find((input) => input.props.type === "checkbox")!, "", false);
    await click(findButton(mcp.root, "Create MCP server"));
    expect(settingsMocks.createMcpServer).toHaveBeenCalledWith({
      label: "Manual Template",
      transport: "stdio",
      command: "npx template-server --stdio",
      args: ["--read-only", "fixture"],
      url: undefined,
      enabled: false,
      authType: "none",
      oauth: undefined,
      category: "development",
      trustTier: "trusted",
      costTier: "free",
      policy: { requireFirstToolApproval: true, redactionMode: "basic", allowedToolPatterns: [], blockedToolPatterns: [], allowedEnvKeys: [], notes: undefined },
    });
    expect(settingsMocks.fetchMcpServer).toHaveBeenCalledWith("srv-created");
    expect(collectText(mcp.root)).toContain("MCP server Manual Template registered and saved configuration confirmed.");

    await act(async () => mcp.root.findByType(DetailInspector).props.onClose());
    await click(findButton(mcp.root, "Local Research"));
    await click(findButton(mcp.root, "Edit server"));
    await change(mcp.root.findByProps({ value: "node research.js" }), "node research-updated.js");
    await click(findButton(mcp.root, "Save changes"));
    expect(settingsMocks.updateMcpServer).toHaveBeenCalledWith(
      "srv-stdio",
      expect.objectContaining({ command: "node research-updated.js" }),
    );

    await click(findButton(mcp.root, "Back to list"));
    await click(findButton(mcp.root, "Approval Inbox"));
    await click(findButton(mcp.root, "Edit server"));
    const editLabelInput = mcp.root.findAllByType("input").find((input) => input.props.value === "Approval Inbox");
    expect(editLabelInput).toBeTruthy();
    await change(editLabelInput!, "Approval Inbox Renamed");
    await change(
      mcp.root.findByProps({ value: "https://mcp.example.test/mcp" }),
      "https://mcp.example.test/updated",
    );
    const categorySelect = mcp.root.findAllByType("select")[0]!;
    await change(categorySelect, "automation");
    await change(
      mcp.root.findByProps({ "aria-label": "MCP server enabled" }),
      "",
      false,
    );
    await click(findButton(mcp.root, "Save changes"));
    expect(settingsMocks.updateMcpServer).toHaveBeenCalledWith(
      "srv-1",
      expect.objectContaining({
        label: "Approval Inbox Renamed",
        category: "automation",
        url: "https://mcp.example.test/updated",
        enabled: false,
      }),
    );

    await click(findButton(mcp.root, "Back to list"));
    await click(findButton(mcp.root, "Approval Inbox Renamed"));
    expect(findButton(mcp.root, "Review connection").props.disabled).toBe(true);
    await click(findButton(mcp.root, "Edit server"));
    await change(mcp.root.findByProps({ "aria-label": "MCP server enabled" }), "", true);
    await click(findButton(mcp.root, "Save changes"));
    await click(findButton(mcp.root, "Back to list"));
    await click(findButton(mcp.root, "Approval Inbox Renamed"));
    await click(findButton(mcp.root, "Review connection"));
    await click(findButton(mcp.root, "Cancel connection review"));
    expect(settingsMocks.connectReviewedMcpServer).not.toHaveBeenCalled();
    await click(findButton(mcp.root, "Review connection"));
    await click(findButton(mcp.root, "Connect reviewed server"));
    await click(findButton(mcp.root, "Review disconnect"));
    await click(findButton(mcp.root, "Disconnect reviewed server"));
    await click(findButton(mcp.root, "Configuration report"));
    await click(findButton(mcp.root, "Record configuration check"));
    expect(settingsMocks.connectReviewedMcpServer).toHaveBeenCalledOnce();
    expect(settingsMocks.disconnectReviewedMcpServer).toHaveBeenCalledOnce();
    expect(settingsMocks.connectMcpServer).not.toHaveBeenCalled();
    expect(settingsMocks.disconnectMcpServer).not.toHaveBeenCalled();
    expect(settingsMocks.runMcpServerHealthCheck).toHaveBeenCalledWith("srv-1");
    await click(findButton(mcp.root, "Tools"));
    expect(collectText(mcp.root)).toContain("Inspect pending approvals");
    await click(findButton(mcp.root, "Diagnostics"));
    expect(collectText(mcp.root)).toContain("Ready.");

    await click(findButton(mcp.root, "Connection"));
    await click(findButton(mcp.root, "Manage tool grants"));
    expect(navigate).toHaveBeenCalledWith({ area: "settings", section: "tools", theme: "ops" });

    await click(findButton(mcp.root, "Delete"));
    let mcpDeleteModal = mcp.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Delete MCP server?");
    expect(mcpDeleteModal?.props.open).toBe(true);
    await act(async () => {
      mcpDeleteModal?.props.onCancel();
    });
    expect(settingsMocks.deleteMcpServer).not.toHaveBeenCalled();
    expect(collectText(mcp.root)).not.toContain("MCP server Approval Inbox Renamed deleted and absence confirmed.");
    await click(findButton(mcp.root, "Delete"));
    mcpDeleteModal = mcp.root.findAllByType(ConfirmModal).find((modal) => modal.props.title === "Delete MCP server?");
    await act(async () => {
      await mcpDeleteModal?.props.onConfirm();
    });
    await flush();
    expect(settingsMocks.deleteMcpServer).toHaveBeenCalledWith("srv-1", "5".padStart(64, "0"));
    expect(collectText(mcp.root)).toContain("MCP server Approval Inbox Renamed deleted and absence confirmed.");
  });

  it("guards dirty provider selection, preserves edits on cancel, and stays silent after save", async () => {
    mockSuccessfulProviderSaves();
    settingsMocks.providerModelCatalog.providers = [
      ...settingsMocks.providerModelCatalog.providers,
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        defaultModel: "claude-sonnet-5",
        apiStyle: "anthropic-messages",
        models: ["claude-sonnet-5"],
        hasApiKey: true,
        apiKeySource: "env",
        modelProbeState: "ready",
      },
    ];
    const providers = await mount("providers");
    await openProviderPanel(providers, "editor");
    const providerLabel = providers.root.findByProps({ placeholder: "OpenAI-compatible" });
    await change(providerLabel, "OpenAI dirty");
    expect(hasDirtySections()).toBe(true);

    await click(findButton(providers.root, "Back to list"));
    const leaveDialog = providers.root.findAllByType(DraftLeaveDialog).find((dialog) => dialog.props.open)!;
    expect(leaveDialog).toBeDefined();
    await act(async () => {
      leaveDialog.props.onCancel();
    });
    expect(providers.root.findByProps({ placeholder: "OpenAI-compatible" }).props.value).toBe("OpenAI dirty");
    await click(findButton(providers.root, "Back to list"));
    await act(async () => {
      providers.root
        .findAllByType(DraftLeaveDialog)
        .find((dialog) => dialog.props.open)!
        .props.onDiscard();
    });
    await click(findButton(providers.root, "Anthropic"));
    await click(findButton(providers.root, "Edit connection"));
    expect(providers.root.findByProps({ placeholder: "OpenAI-compatible" }).props.value).toBe("Anthropic");
    await change(providers.root.findByProps({ placeholder: "OpenAI-compatible" }), "Anthropic saved");
    await click(findButton(providers.root, "Save provider"));
    await click(findButton(providers.root, "OpenAI"));
    expect(providers.root.findAllByType(DraftLeaveDialog).some((dialog) => dialog.props.open)).toBe(false);
  });

  it("preserves a failed integration edit through refresh and requires explicit revision review", async () => {
    settingsMocks.fetchIntegrationConnection.mockImplementation(async (connectionId: string) => {
      const current = await settingsMocks.fetchIntegrationConnections();
      return current.items.find((item: { connectionId: string }) => item.connectionId === connectionId);
    });
    const page = await mount("integrations");
    await click(findButton(page.root, "GitHub"));
    await click(findButton(page.root, "Edit connection"));
    await change(page.root.findByProps({ value: "GitHub" }), "Retained integration draft");
    settingsMocks.updateIntegrationConnection.mockRejectedValueOnce(new ApiRequestError("Connection changed", {
      kind: "http", method: "PATCH", path: "/api/v1/integrations/connections/conn-1", status: 409,
      body: {code:"WRITE_CONFLICT",details:{reason:"INTEGRATION_CONNECTION_REVISION_CONFLICT"}},
    }));
    await click(findButton(page.root, "Save changes"));
    expect(page.root.findByProps({ value: "Retained integration draft" })).toBeTruthy();
    expect(collectText(page.root)).toContain("connection changed");
    await click(findButton(page.root, "Close editor"));
    await act(async () =>
      page.root
        .findAllByType(DraftLeaveDialog)
        .find((node) => node.props.open)!
        .props.onContinue(),
    );
    settingsMocks.fetchIntegrationConnections.mockResolvedValueOnce({
      items: [
        {
          connectionId: "conn-1",
          revision: "b".repeat(64),
          catalogId: "github",
          key: "github",
          label: "Remote GitHub",
          kind: "service",
          enabled: true,
          status: "connected",
          config: { tokenEnv: "REMOTE_TOKEN" },
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-25T12:00:00.000Z",
        },
      ],
    });
    await click(findButton(page.root, "Refresh"));
    await click(findButton(page.root, "Remote GitHub"));
    await click(findButton(page.root, "Edit connection"));
    expect(page.root.findByProps({ value: "Retained integration draft" })).toBeTruthy();
    expect(findButton(page.root, "Save changes").props.disabled).toBe(true);
    expect(collectText(page.root)).toContain("Current saved connection");
    await click(findButton(page.root, "Use current connection review"));
    await click(findButton(page.root, "Save changes"));
    expect(settingsMocks.updateIntegrationConnection).toHaveBeenLastCalledWith(
      "conn-1",
      expect.objectContaining({ label: "Retained integration draft", config: { tokenEnv: "GITHUB_TOKEN" } }),
    );
  });

  it("guards dirty integration detail selection and preserves the selected draft on cancel", async () => {
    settingsMocks.fetchIntegrationConnections.mockImplementation(async (kind?: string) => ({
      items:
        kind === "channel"
          ? []
          : [
              {
                connectionId: "conn-1",
                revision: "a".repeat(64),
                catalogId: "github",
                key: "github",
                label: "GitHub",
                kind: "service",
                enabled: true,
                status: "connected",
                config: { tokenEnv: "GITHUB_TOKEN" },
                createdAt: "2026-04-24T12:00:00.000Z",
                updatedAt: "2026-04-24T12:00:00.000Z",
              },
              {
                connectionId: "conn-2",
                catalogId: "linear",
                key: "linear",
                label: "Linear ops",
                kind: "service",
                enabled: true,
                status: "connected",
                config: { tokenEnv: "LINEAR_TOKEN" },
                createdAt: "2026-04-24T12:00:00.000Z",
                updatedAt: "2026-04-24T12:00:00.000Z",
              },
            ],
    }));
    const integrations = await mount("integrations");
    await click(findButton(integrations.root, "GitHub"));
    await click(findButton(integrations.root, "Edit connection"));
    await change(integrations.root.findByProps({ value: "GitHub" }), "GitHub draft");
    expect(hasDirtySections()).toBe(true);
    await click(findButton(integrations.root, "Close editor"));
    let dialog = integrations.root.findAllByType(DraftLeaveDialog).find((node) => node.props.open)!;
    expect(dialog.props.open).toBe(true);
    await act(async () => dialog.props.onCancel());
    expect(integrations.root.findByProps({ value: "GitHub draft" })).toBeTruthy();
    await click(findButton(integrations.root, "Close editor"));
    dialog = integrations.root.findAllByType(DraftLeaveDialog).find((node) => node.props.open)!;
    await act(async () => dialog.props.onContinue());
    await click(findButton(integrations.root, "Linear ops"));
    await click(findButton(integrations.root, "Edit connection"));
    expect(integrations.root.findByProps({ value: "Linear ops" })).toBeTruthy();
    await click(findButton(integrations.root, "Close editor"));
    await click(findButton(integrations.root, "GitHub"));
    await click(findButton(integrations.root, "Edit connection"));
    expect(integrations.root.findByProps({ value: "GitHub draft" })).toBeTruthy();
  });

  it("guards a dirty new-integration draft before changing its catalog", async () => {
    settingsMocks.fetchIntegrationCatalog.mockResolvedValueOnce({
      items: [
        {
          catalogId: "github",
          key: "github",
          label: "GitHub",
          description: "GitHub issues and pulls",
          kind: "service",
          capabilities: ["issues"],
          authMethods: ["token"],
        },
        {
          catalogId: "linear",
          key: "linear",
          label: "Linear",
          description: "Linear issues",
          kind: "service",
          capabilities: ["issues"],
          authMethods: ["token"],
        },
      ],
    });
    const integrations = await mount("integrations");
    await click(findButton(integrations.root, "Add integration"));
    await change(integrations.root.findByProps({ placeholder: "Optional connection label" }), "Draft connection");

    const catalogSelect = integrations.root.findAllByType("select").find((select) => select.props.value === "github")!;
    await change(catalogSelect, "linear");
    let discardModal = integrations.root.findAllByType(DraftLeaveDialog).find((modal) => modal.props.open);
    expect(discardModal?.props.open).toBe(true);
    await act(async () => {
      discardModal?.props.onCancel();
    });
    expect(integrations.root.findByProps({ placeholder: "Optional connection label" }).props.value).toBe(
      "Draft connection",
    );
    expect(catalogSelect.props.value).toBe("github");

    await change(catalogSelect, "linear");
    discardModal = integrations.root.findAllByType(DraftLeaveDialog).find((modal) => modal.props.open);
    await act(async () => {
      discardModal?.props.onContinue();
    });
    await flush();
    expect(integrations.root.findByProps({ placeholder: "Optional connection label" }).props.value).toBe("");
    expect(integrations.root.findAllByType("select").find((select) => select.props.value === "linear")).toBeTruthy();
  });

  it("guards dirty permission-profile selection and restores only after confirmed discard", async () => {
    settingsMocks.fetchPermissionProfiles.mockResolvedValueOnce({
      items: [
        {
          profileId: "profile-1",
          label: "Release captain",
          description: "Release workflow",
          builtin: false,
          status: "active",
          scope: "workspace",
          scopeRef: "default",
          approvalMode: "approve_risky",
          toolPatterns: ["git.*"],
          allow: ["git.status"],
          deny: ["git.push"],
          readAccessMode: "roots_only",
          defaultForSurfaces: ["chat"],
          createdBy: "operator",
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
        {
          profileId: "profile-2",
          label: "Research reviewer",
          description: "Research workflow",
          builtin: false,
          status: "active",
          scope: "workspace",
          scopeRef: "default",
          approvalMode: "approve_all",
          toolPatterns: ["browser.*"],
          allow: ["browser.search"],
          deny: [],
          readAccessMode: "roots_only",
          defaultForSurfaces: ["chat"],
          createdBy: "operator",
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
      ],
    });
    const permissions = await mount("permissions");
    await click(findButton(permissions.root, "Release captain"));
    await click(findButton(permissions.root, "Edit profile"));
    await change(permissions.root.findByProps({ "aria-label": "Edit profile name" }), "Release captain draft");
    expect(hasDirtySections()).toBe(true);

    await click(findButton(permissions.root, "Research reviewer"));
    let discardModal = permissions.root.findAllByType(DraftLeaveDialog).find((modal) => modal.props.open);
    expect(discardModal?.props.open).toBe(true);
    await act(async () => {
      discardModal?.props.onCancel();
    });
    expect(permissions.root.findByProps({ value: "Release captain draft" })).toBeTruthy();

    await click(findButton(permissions.root, "Research reviewer"));
    discardModal = permissions.root.findAllByType(DraftLeaveDialog).find((modal) => modal.props.open);
    await act(async () => {
      discardModal?.props.onDiscard();
    });
    await flush();
    await click(findButton(permissions.root, "Edit profile"));
    expect(permissions.root.findByProps({ value: "Research reviewer" })).toBeTruthy();
  });

  it("ignores stale portable previews and retains the exact draft after failed staging", async () => {
    const page = await mount("addons");
    await click(findButton(page.root, "Capability packs"));
    await click(findButton(page.root, "Import pack"));
    const manifest = (packId: string): CapabilityPackManifest => ({
      packId, name: `${packId} preview`, version: "1.0.0", description: "Portable evidence fixture",
      trustTier: "community", tags: [], installWarnings: [],
      provenance: { source: "local_file", publisher: "Verification" },
      policyDefaults: { requireFirstUseApproval: true, autoRunEnabled: false, memoryWriteAuthority: "operator_controlled", redactionMode: "strict" },
      assets: [{ id: "local-skill", label: "Local skill", kind: "skill", runtimeSupport: "available", installMode: "review_required" }],
    });
    const preview = (value: CapabilityPackManifest): CapabilityPackPreview => ({
      manifest: value, reviewRequired: true, policyChanges: value.policyDefaults, unsupportedAssets: [],
      installPlan: [{ kind: "skill", assetId: "local-skill", reason: "Review required", outcome: "review_required" }],
    });
    const firstManifest = manifest("first"), secondManifest = manifest("second");
    settingsMocks.fetchLocalCapabilityPackPreview.mockResolvedValue(preview(secondManifest));
    let resolvePreview!: (value: unknown) => void;
    settingsMocks.fetchLocalCapabilityPackPreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    );
    const first = JSON.stringify(firstManifest);
    const second = JSON.stringify(secondManifest);
    await change(page.root.findByType("textarea"), first);
    await click(findButton(page.root, "Preview local pack"));
    await change(page.root.findByType("textarea"), second);
    await act(async () => resolvePreview(preview(firstManifest)));
    await flush();
    expect(collectText(page.root)).not.toContain("first preview");
    expect(page.root.findAllByType("button").filter(button => collectText(button) === "Review pack staging")).toHaveLength(0);
    expect(settingsMocks.installLocalCapabilityPack).not.toHaveBeenCalled();
    await click(findButton(page.root, "Preview local pack"));
    settingsMocks.installLocalCapabilityPack.mockRejectedValueOnce(new Error("Staging unavailable"));
    await click(findButton(page.root, "Review pack staging"));
    expect(settingsMocks.installLocalCapabilityPack).not.toHaveBeenCalled();
    await act(async () => { page.root.findAllByType(ConfirmModal).find(modal => modal.props.open)!.props.onConfirm(); });
    await flush();
    expect(settingsMocks.installLocalCapabilityPack).toHaveBeenCalledWith(secondManifest, { actorId: "operator" });
    expect(page.root.findByType("textarea").props.value).toBe(second);
    expect(collectText(page.root)).toContain("Staging unavailable");
    expect(collectText(page.root)).toContain("Pack action outcome is unconfirmed");
    await click(findButton(page.root, "Back to list"));
    await act(async () =>
      page.root
        .findAllByType(DraftLeaveDialog)
        .find((node) => node.props.open)!
        .props.onContinue(),
    );
    expect(collectText(findButton(page.root, "Import pack"))).toMatch(/Import pack\s+· Unsaved/);
    await click(findButton(page.root, "Import pack"));
    expect(page.root.findByType("textarea").props.value).toBe(second);
    await click(findButton(page.root, "Preview local pack"));
    expect(findButton(page.root, "Review pack staging").props.disabled).toBe(true);
    expect(settingsMocks.installLocalCapabilityPack).toHaveBeenCalledTimes(1);
  });

  it("registers Runtime and Add-ons editor drafts with the global navigation guard", async () => {
    const runtime = await mount("runtime");
    await click(findButton(runtime.root, "Configure llama.cpp"));
    await change(runtime.root.findByProps({ value: "http://127.0.0.1:8080/v1" }), "http://127.0.0.1:9090/v1");
    expect(hasDirtySections()).toBe(true);
    runtime.unmount();
    __resetFormDirtyRegistryForTests();

    const addons = await mount("addons");
    await click(findButton(addons.root, "Capability packs"));
    await click(findButton(addons.root, "Import pack"));
    await change(addons.root.findByType("textarea"), '{"packId":"draft-pack"}');
    expect(hasDirtySections()).toBe(true);
  });

  it("defers specialist MCP reads and retains an edit through refresh and failed saves", async () => {
    const editable = await settingsMocks.fetchMcpServers();
    settingsMocks.fetchMcpServers.mockResolvedValue({ items: editable.items?.map(item => ({ ...item, url: "https://mcp.example.test/mcp" })) });
    const page = await mount("mcp");
    expect(settingsMocks.fetchMcpTemplates).not.toHaveBeenCalled();
    expect(settingsMocks.fetchMcpServerModeManifest).not.toHaveBeenCalled();
    expect(settingsMocks.fetchMcpTools).not.toHaveBeenCalled();
    await click(findButton(page.root, "Approval Inbox"));
    await click(findButton(page.root, "Edit server"));
    await change(page.root.findByProps({ "aria-label": "MCP server label" }), "Retained local label");
    await click(findButton(page.root, "Back to list"));
    await act(async () =>
      page.root
        .findAllByType(DraftLeaveDialog)
        .find((node) => node.props.open)!
        .props.onContinue(),
    );
    const snapshot = (await settingsMocks.fetchMcpServers()) as { items: Array<Record<string, unknown>> };
    settingsMocks.fetchMcpServers.mockResolvedValue({
      items: snapshot.items.map((item: any) => ({
        ...item,
        configurationRevision: 2,
        revision: "b".repeat(64),
        label: "Server changed elsewhere",
      })),
    });
    await click(findButton(page.root, "Refresh"));
    await click(findButton(page.root, "Server changed elsewhere"));
    await click(findButton(page.root, "Edit server"));
    expect(page.root.findByProps({ "aria-label": "MCP server label" }).props.value).toBe("Retained local label");
    expect(findButton(page.root, "Save changes").props.disabled).toBe(true);
    expect(settingsMocks.updateMcpServer).not.toHaveBeenCalled();
    await click(findButton(page.root, "Use current server review"));
    settingsMocks.updateMcpServer.mockRejectedValueOnce(new Error("MCP save unavailable"));
    await click(findButton(page.root, "Save changes"));
    expect(collectText(page.root)).toContain("MCP save outcome is unconfirmed");
    expect(page.root.findByProps({ "aria-label": "MCP server label" }).props.value).toBe("Retained local label");
  });

  it("guards dirty MCP server selection and resets only after confirmed discard", async () => {
    settingsMocks.fetchMcpServers.mockResolvedValue({
      items: [
        {
          serverId: "srv-1",
          label: "Approval Inbox",
          transport: "http",
          url: "goatcitadel://approval-inbox",
          authType: "none",
          enabled: true,
          status: "connected",
          category: "system",
          trustTier: "trusted",
          costTier: "free",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
        {
          serverId: "srv-stdio",
          label: "Local Research",
          transport: "stdio",
          command: "node research.js",
          authType: "none",
          enabled: true,
          status: "disconnected",
          category: "research",
          trustTier: "trusted",
          costTier: "free",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
      ],
    });
    const mcp = await mount("mcp");
    await click(findButton(mcp.root, "Approval Inbox"));
    await click(findButton(mcp.root, "Edit server"));
    await change(mcp.root.findByProps({ "aria-label": "MCP server label" }), "Approval Inbox draft");
    await click(findButton(mcp.root, "Back to list"));
    let dialog = mcp.root.findAllByType(DraftLeaveDialog).find((node) => node.props.open)!;
    await act(async () => dialog.props.onCancel());
    expect(mcp.root.findByProps({ value: "Approval Inbox draft" })).toBeTruthy();
    await click(findButton(mcp.root, "Back to list"));
    dialog = mcp.root.findAllByType(DraftLeaveDialog).find((node) => node.props.open)!;
    await act(async () => dialog.props.onContinue());
    await click(findButton(mcp.root, "Local Research"));
    await click(findButton(mcp.root, "Edit server"));
    expect(mcp.root.findByProps({ "aria-label": "MCP server label" }).props.value).toBe("Local Research");
    await click(findButton(mcp.root, "Back to list"));
    await click(findButton(mcp.root, "Approval Inbox"));
    await click(findButton(mcp.root, "Edit server"));
    expect(mcp.root.findByProps({ "aria-label": "MCP server label" }).props.value).toBe("Approval Inbox draft");
    await click(findButton(mcp.root, "Back to list"));
    dialog = mcp.root.findAllByType(DraftLeaveDialog).find((node) => node.props.open)!;
    await act(async () => dialog.props.onDiscard());
    await click(findButton(mcp.root, "Approval Inbox"));
    await click(findButton(mcp.root, "Edit server"));
    expect(mcp.root.findByProps({ "aria-label": "MCP server label" }).props.value).toBe("Approval Inbox");
  });

  it("guards both Citadel and workspace editor selection without discarding on cancel", async () => {
    const page = await mount("workspaces");
    await click(findButton(page.root, "Citadel manager"));
    await click(findButton(page.root, "Personal"));
    await click(findButton(page.root, "Edit Citadel"));
    await change(page.root.findByProps({ value: "Personal" }), "Personal draft");
    expect(hasDirtySections()).toBe(true);
    await click(findButton(page.root, "Close editor"));
    expect(page.root.findAllByType(DraftLeaveDialog).find((node) => node.props.open)!.props.open).toBe(true);
    await act(async () =>
      page.root
        .findAllByType(DraftLeaveDialog)
        .find((node) => node.props.open)!
        .props.onCancel(),
    );
    expect(page.root.findByProps({ value: "Personal draft" })).toBeTruthy();
    await click(findButton(page.root, "Close editor"));
    await act(async () =>
      page.root
        .findAllByType(DraftLeaveDialog)
        .find((node) => node.props.open)!
        .props.onContinue(),
    );
    await click(findButton(page.root, "Company"));
    await click(findButton(page.root, "Edit Citadel"));
    expect(page.root.findByProps({ value: "Company" })).toBeTruthy();
    await click(findButton(page.root, "Close editor"));
    await click(findButton(page.root, "Personal"));
    await click(findButton(page.root, "Edit Citadel"));
    expect(page.root.findByProps({ value: "Personal draft" })).toBeTruthy();
    await click(findButton(page.root, "Close editor"));
    await act(async () =>
      page.root
        .findAllByType(DraftLeaveDialog)
        .find((node) => node.props.open)!
        .props.onDiscard(),
    );
    await click(findExactButton(page.root, "Workspaces"));
    await click(findButton(page.root, "Default"));
    await click(findButton(page.root, "Edit workspace"));
    await change(page.root.findByProps({ value: "Default" }), "Default draft");
    await click(findButton(page.root, "Close editor"));
    await act(async () =>
      page.root
        .findAllByType(DraftLeaveDialog)
        .find((node) => node.props.open)!
        .props.onCancel(),
    );
    expect(page.root.findByProps({ value: "Default draft" })).toBeTruthy();
    await click(findButton(page.root, "Close editor"));
    await act(async () =>
      page.root
        .findAllByType(DraftLeaveDialog)
        .find((node) => node.props.open)!
        .props.onContinue(),
    );
    await click(page.root.findAllByType("button").find((node) => collectText(node).includes("Archived workspace"))!);
    await click(findButton(page.root, "Edit workspace"));
    expect(page.root.findByProps({ value: "Archive" })).toBeTruthy();
    await click(findButton(page.root, "Close editor"));
    await click(findButton(page.root, "Default"));
    await click(findButton(page.root, "Edit workspace"));
    expect(page.root.findByProps({ value: "Default draft" })).toBeTruthy();
  });

  it("covers channel draft selection warnings and Slack OAuth polling branches", async () => {
    settingsMocks.fetchChannelSetupDefinitions.mockResolvedValueOnce({ items: [] });
    const emptyChannels = await mount("channels");
    await click(findButton(emptyChannels.root, "Connect channel"));
    const emptyChannelSelect = emptyChannels.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("No channel definitions available"))!;
    const emptyCreateButton = findButton(emptyChannels.root, "Start guided setup");
    expect(emptyChannelSelect.props.value).toBe("");
    expect(emptyChannelSelect.props.disabled).toBe(true);
    expect(emptyCreateButton.props.disabled).toBe(true);
    await click(emptyCreateButton);
    expect(collectText(emptyChannels.root)).toContain("Choose a channel definition first.");
    expect(settingsMocks.createChannelSetupDraft).not.toHaveBeenCalled();

    const channels = await mount("channels");
    await click(findButton(channels.root, "Connect channel"));
    const populatedChannelSelect = channels.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("Choose a channel definition"))!;
    const populatedCreateButton = findButton(channels.root, "Start Slack setup");
    expect(populatedChannelSelect.props.value).toBe("channel.slack");
    expect(populatedChannelSelect.props.disabled).toBe(false);
    expect(populatedCreateButton.props.disabled).toBe(false);
    await click(populatedCreateButton);
    expect(settingsMocks.createChannelSetupDraft).toHaveBeenCalledWith({ catalogId: "channel.slack" });

    settingsMocks.fetchSlackOAuthStatus.mockResolvedValueOnce({
      configured: false,
      mode: "self_owned",
      scopes: [],
      missing: [],
      connections: [],
    });
    const unconfiguredSlack = await mount("channels");
    await click(findButton(unconfiguredSlack.root, "Connect channel"));
    await click(findButton(unconfiguredSlack.root, "Connect Slack"));
    expect(collectText(unconfiguredSlack.root)).toContain(
      "Slack OAuth needs configuration first: missing OAuth settings.",
    );

    vi.useFakeTimers();
    installBrowser();
    settingsMocks.createChannelSetupDraft.mockClear();
    settingsMocks.startSlackOAuth.mockResolvedValueOnce({
      authorizationUrl: "https://slack.com/oauth/v2/authorize?state=loop24",
      state: "loop24",
      configured: true,
      mode: "self_owned",
      scopes: ["chat:write"],
    });
    settingsMocks.fetchSlackOAuthStatus
      .mockResolvedValueOnce({
        configured: true,
        mode: "self_owned",
        scopes: ["chat:write"],
        missing: [],
        connections: [
          {
            connection: {
              connectionId: "slack-old",
              config: { oauthConnectedAt: "2026-05-14T00:00:00.000Z" },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        configured: true,
        mode: "self_owned",
        scopes: ["chat:write"],
        missing: [],
        connections: [
          {
            connection: {
              connectionId: "slack-new",
              config: { oauthConnectedAt: "2026-05-15T00:00:00.000Z" },
            },
          },
        ],
      });
    settingsMocks.createChannelSetupDraft.mockResolvedValueOnce({
      draftId: "draft-slack",
      revision: 1,
      connectionId: "slack-new",
      catalogId: "channel.slack",
      enabled: true,
      draft: {},
      lifecycleMode: "edit",
      updatedAt: "2026-05-15T00:00:00.000Z",
    });

    try {
      const configuredSlack = await mount("channels");
      await click(findButton(configuredSlack.root, "Connect channel"));
      await click(findButton(configuredSlack.root, "Connect Slack"));
      expect(window.open).toHaveBeenCalledWith(
        "https://slack.com/oauth/v2/authorize?state=loop24",
        "_blank",
        "noopener,noreferrer",
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await flush();
      expect(settingsMocks.createChannelSetupDraft).not.toHaveBeenCalled();
      expect(collectText(configuredSlack.root)).toContain("Slack connection evidence changed.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("covers integration catalog list selection and selected Slack draft connect branches", async () => {
    settingsMocks.fetchIntegrationCatalog.mockResolvedValueOnce({
      items: [
        {
          catalogId: "github",
          key: "github",
          label: "GitHub",
          description: "GitHub issues and pulls",
          kind: "service",
          capabilities: ["issues"],
          authMethods: ["token"],
          operatorActions: [],
        },
        {
          catalogId: "linear",
          key: "linear",
          label: "Linear",
          description: "Linear issues",
          kind: "service",
          capabilities: ["issues"],
          authMethods: ["token"],
          operatorActions: [],
        },
      ],
    });
    settingsMocks.fetchIntegrationConnections.mockResolvedValueOnce({ items: [] });
    const integrations = await mount("integrations");
    await click(findButton(integrations.root, "Add integration"));
    await click(findExactButton(integrations.root, "Use"));
    expect(collectText(integrations.root)).toContain("GitHub");

    settingsMocks.fetchChannelSetupDrafts.mockResolvedValueOnce({
      items: [
        {
          draftId: "draft-slack-selected",
          catalogId: "channel.slack",
          label: "Slack setup",
          enabled: true,
          lifecycleMode: "create",
          draft: {},
          createdAt: "2026-04-24T12:00:00.000Z",
          updatedAt: "2026-04-24T12:00:00.000Z",
        },
      ],
    });
    settingsMocks.fetchSlackOAuthStatus.mockResolvedValueOnce({
      configured: false,
      mode: "self_owned",
      scopes: [],
      missing: [],
      connections: [],
    });
    const slackDraft = await mount("channels");
    await click(findButton(slackDraft.root, "Slack setup"));
    const slackConnectButtons = buttons(slackDraft.root, "Connect Slack");
    expect(slackConnectButtons.length).toBe(1);
    await click(slackConnectButtons.at(-1)!);
    expect(collectText(slackDraft.root)).toContain("Slack OAuth needs configuration first: missing OAuth settings.");
  });

  it("covers provider editor, secret, model probe, and ChatGPT OAuth setup branches", async () => {
    mockSuccessfulProviderSaves();
    settingsMocks.getCachedModelProbe.mockReturnValueOnce({
      state: "fallback",
      source: "error_fallback",
      warning: "catalog timeout",
    });
    settingsMocks.loadModelsForProvider.mockResolvedValueOnce(["gpt-5.4-mini"]);
    settingsMocks.providerModelCatalog.providers = [
      ...settingsMocks.providerModelCatalog.providers,
      {
        providerId: "anthropic",
        label: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        defaultModel: "claude-opus-5",
        apiStyle: "anthropic-messages",
        models: ["claude-opus-5", "claude-sonnet-5"],
        hasApiKey: true,
        apiKeySource: "env",
        modelProbeState: "ready",
      },
    ];

    const providers = await mount("providers");
    await openProviderPanel(providers, "routing");
    const routingProviderSelect = providers.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("Anthropic"));
    expect(routingProviderSelect).toBeTruthy();
    await change(routingProviderSelect!, "anthropic");
    const routingModelSelect = providers.root
      .findAllByType("select")
      .find((select) => collectText(select).includes("claude-sonnet-5"));
    expect(routingModelSelect).toBeTruthy();
    await change(routingModelSelect!, "claude-sonnet-5");
    expect(collectText(providers.root)).toContain("Anthropic");

    const providerListItem = providers.root
      .findAll((node) => node.type === "button" && typeof node.props.className === "string" && node.props.className.includes("mc-next-settings-selectable"))
      .find((button) => button.findAllByType("strong").some((label) => collectText(label) === "OpenAI"));
    expect(providerListItem).toBeTruthy();
    // Save the staged routing before inspecting another provider.

    await click(findButton(providers.root, "Save routing"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 31,
      llm: {
        activeProviderId: "anthropic",
        activeModel: "claude-sonnet-5",
      },
    });

    await openProviderPanel(providers, "trust");
    await click(findButton(providers.root, "Save secret"));
    expect(collectText(providers.root)).toContain("Enter a provider secret before saving.");
    await change(providers.root.findByProps({ placeholder: "Paste a new API key to save" }), " sk-live ");
    await click(findButton(providers.root, "Save secret"));
    expect(settingsMocks.saveProviderSecret).toHaveBeenCalledWith("openai", "sk-live", 31);

    await click(findButton(providers.root, "Delete secret"));
    let secretModal = providers.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Delete provider secret?");
    expect(secretModal?.props.open).toBe(true);
    await act(async () => {
      secretModal?.props.onCancel();
    });
    expect(settingsMocks.deleteProviderSecret).not.toHaveBeenCalled();
    await click(findButton(providers.root, "Delete secret"));
    secretModal = providers.root
      .findAllByType(ConfirmModal)
      .find((modal) => modal.props.title === "Delete provider secret?");
    await act(async () => {
      await secretModal?.props.onConfirm();
    });
    await flush();
    expect(settingsMocks.deleteProviderSecret).toHaveBeenCalledWith("openai", 31);

    await click(findButton(providers.root, "Refresh models"));
    expect(collectText(providers.root)).toContain("live discovery failed: catalog timeout");

    await click(findButton(providers.root, "Custom provider"));
    await click(findButton(providers.root, "Probe from editor"));

    const inputs = providers.root.findAllByType("input");
    await change(inputs.find((input) => input.props.placeholder === "openai-compatible")!, " local-openai ");
    await change(inputs.find((input) => input.props.placeholder === "OpenAI-compatible")!, " Local OpenAI ");
    await change(
      inputs.find((input) => input.props.placeholder === "https://llm.example.test/v1")!,
      " http://127.0.0.1:11434/v1 ",
    );
    await change(
      providers.root.findAllByType("select").find((select) => collectText(select).includes("OpenAI Chat Completions"))!,
      "openai-chat-completions",
    );
    await change(inputs.find((input) => input.props.placeholder === "gpt-5.4-mini")!, " llama3 ");
    await change(inputs.find((input) => input.props.placeholder === "OPENAI_API_KEY")!, " LOCAL_KEY ");
    await click(findButton(providers.root, "Save provider"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 31,
      llm: {
        upsertProvider: expect.objectContaining({
          providerId: "local-openai",
          label: "Local OpenAI",
          baseUrl: "http://127.0.0.1:11434/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "llama3",
          apiKeyEnv: "LOCAL_KEY",
        }),
      },
    });
    await openProviderPanel(providers, "editor");
    await click(findButton(providers.root, "Reload selected"));
    await click(findButton(providers.root, "Back to list"));
    await openProviderPanel(providers, "oauth");
    settingsMocks.fetchLlmConfig.mockResolvedValueOnce(settingsMocks.providerModelCatalog.config);

    await click(findButton(providers.root, "Add provider and continue"));
    expect(settingsMocks.patchSettings).toHaveBeenCalledWith({
      expectedRevision: 31,
      llm: {
        upsertProvider: expect.objectContaining({
          providerId: "openai-codex",
          authMode: "codex-oauth",
        }),
      },
    });
  });

  it("covers connected Codex OAuth provider controls and manual polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    installBrowser();
    settingsMocks.providerModelCatalog.providers = [
      {
        providerId: "openai-codex",
        label: "OpenAI Codex",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        defaultModel: "gpt-5-codex",
        apiStyle: "openai-codex-responses",
        models: ["gpt-5-codex"],
        hasApiKey: false,
        apiKeySource: "none",
        modelProbeState: "fallback",
      },
    ];
    settingsMocks.providerModelCatalog.config = {
      revision: 31,
      activeProviderId: "openai-codex",
      activeModel: "gpt-5-codex",
      providers: [],
      providerConfigs: [],
    };
    settingsMocks.fetchOpenAICodexOAuthStatus.mockResolvedValue({
      providerId: "openai-codex", available: true,
      connected: true,
      requiresReauth: false,
      accountLabel: "operator@example.com",
    });
    settingsMocks.startOpenAICodexOAuthDeviceFlow
      .mockResolvedValueOnce({
        providerId: "openai-codex",
        flowId: "flow-2",
        verificationUrl: "https://auth.openai.com/activate",
        userCode: "WXYZ-1234",
        expiresAt: "2026-05-15T12:05:00.000Z",
        pollAfterMs: 5000,
      })
      .mockResolvedValueOnce({
        providerId: "openai-codex",
        flowId: "flow-3",
        verificationUrl: "https://auth.openai.com/activate",
        userCode: "NEWC-1234",
        expiresAt: "2026-05-15T12:06:00.000Z",
        pollAfterMs: 5000,
      });
    settingsMocks.pollOpenAICodexOAuthDeviceFlow
      .mockResolvedValueOnce({ providerId: "openai-codex", flowId: "flow-2", status: "pending", retryAfterMs: 5000 })
      .mockResolvedValueOnce({ providerId: "openai-codex", flowId: "flow-3", status: "pending", retryAfterMs: 5000 })
      .mockResolvedValueOnce({ providerId: "openai-codex", flowId: "flow-3", status: "connected" });

    try {
      const providers = await mount("providers");
      await openProviderPanel(providers, "oauth");
      expect(collectText(providers.root)).toContain(
        "Done. ChatGPT OAuth is connected as operator@example.com, and OpenAI Codex is active for Chat.",
      );

      await click(findButton(providers.root, "ChatGPT setup"));
      expect(collectText(providers.root)).toContain("OpenAI Codex");

      await click(findButton(providers.root, "Reconnect ChatGPT"));
      await flush();
      expect(window.open).toHaveBeenCalledWith("https://auth.openai.com/activate", "_blank", "noopener,noreferrer");
      expect(providers.root.findAllByType("input").some((input) => input.props.value === "WXYZ-1234")).toBe(true);

      await click(findButton(providers.root, "Open OpenAI page"));
      expect(window.open).toHaveBeenCalledTimes(2);
      await click(findButton(providers.root, "Reopen login"));
      expect(providers.root.findAllByType("input").some((input) => input.props.value === "NEWC-1234")).toBe(true);
      await click(findButton(providers.root, "I approved, check now"));
      expect(settingsMocks.pollChangePlanProviderOAuth).toHaveBeenLastCalledWith(
        "plan-oauth-1",
        { workspaceId: "default" },
        expect.objectContaining({
          expectedRevision: 1,
          actionId: "oauth-action",
          actionNonce: "oauth-action-nonce-123456",
          flowId: "flow-3",
        }),
      );
      expect(settingsMocks.completeChangePlanProviderOAuth).toHaveBeenCalledTimes(1);
      expect(collectText(providers.root)).toContain("OpenAI approved the login");

      await click(findButton(providers.root, "Advanced details"));
      expect(collectText(providers.root)).toContain("Connection & diagnostics");

      await openProviderPanel(providers, "oauth");
      await click(findButton(providers.root, "Disconnect"));
      expect(settingsMocks.createChangePlan).toHaveBeenLastCalledWith({
        workspaceId: "default",
        surface: "settings",
        request: { kind: "provider_connection", providerId: "openai-codex", credentialAction: "remove_oauth" },
      });
      expect(settingsMocks.deleteOpenAICodexOAuthCredential).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SettingsNativePage partial gateway responses", () => {
  // Well-formed-but-partial gateway responses: a stub gateway can return
  // HTTP 200 with {} (or a ready-flags-only payload) for any settings
  // endpoint, so nested blocks the response contracts declare required may
  // be absent at runtime. nativeLoad only falls back on rejected fetches and
  // useAsyncLoad only catches thrown loads, so a 200 with an empty body
  // reaches render as truthy-but-empty data.

  it("keeps the runtime voice card defensive when the voice runtime status omits installed models and catalog", async () => {
    settingsMocks.fetchVoiceRuntimeStatus.mockResolvedValue({
      provider: "whisper.cpp",
      source: "managed",
      readiness: "ready",
      binaryReady: true,
      ffmpegReady: true,
    });

    const runtime = await mount("runtime");
    await click(findButton(runtime.root, "Voice setup"));

    const text = collectText(runtime.root);
    expect(text.replace(/\s+/g, " ")).toContain("Runtime readiness: Unavailable");
    expect(text).toContain("No voice models were reported by the catalog owner.");
    expect(buttons(runtime.root, "Activate first installed")).toHaveLength(0);

    expect(findButton(runtime.root, "Install starter model").props.disabled).toBe(true);
    await click(findButton(runtime.root, "Install starter model"));
    expect(settingsMocks.installVoiceRuntime).not.toHaveBeenCalled();
  });

  it("renders the local AI section when the readiness payload is empty", async () => {
    settingsMocks.fetchLocalAiReadiness.mockResolvedValue({});

    const localAi = await mount("local-ai");

    expect(collectText(localAi.root)).toContain("Hardware readiness");
    expect(collectText(localAi.root)).toContain("Unknown");
    await click(findButton(localAi.root, "Jobs and endpoints"));
    expect(collectText(localAi.root)).toContain("Serve jobs");
    expect(collectText(localAi.root)).toContain("Local AI readiness is incomplete");
    expect(collectText(localAi.root)).not.toContain("No Local AI job endpoint is registered here");

    await click(findButton(localAi.root, "Refresh readiness"));
    expect(settingsMocks.fetchLocalAiReadiness).toHaveBeenCalledTimes(2);
  });

  it("distinguishes a detected runtime from a registered Local AI endpoint", async () => {
    settingsMocks.fetchLocalAiReadiness.mockResolvedValue({
      hardware: {
        checkedAt: "2026-07-29T00:00:00.000Z",
        os: { platform: "win32", arch: "x64" },
        cpu: { logicalCores: 8 },
        memory: { totalBytes: 16 * 1024 * 1024 * 1024 },
        gpu: [],
        disk: {},
        runtimes: [
          {
            backend: "ollama",
            detected: true,
            command: "ollama.exe",
            platformSupport: "native",
          },
        ],
      },
      catalog: [],
      recommendations: [],
      downloads: [],
      serveJobs: [],
      endpoints: [],
    });

    const localAi = await mount("local-ai");

    expect(collectText(localAi.root)).toContain(
      "No Local AI job endpoint is registered here. Runtime detection does not prove llama.cpp Chat works; test it in Get started.",
    );
  });

  it("renders the general section when the settings payload is empty", async () => {
    settingsMocks.fetchSettings.mockResolvedValue({});

    const general = await mount("general");
    await act(async () => {
      general.root
        .findByProps({ id: "general-setup-status", open: false })
        .props.onToggle({ currentTarget: { open: true } });
      await flush();
    });

    const text = collectText(general.root);
    expect(text).toContain("Mission Control posture");
    expect(text).toContain("No active provider");
    expect(text).toContain("unknown");
  });

  it("renders the onboarding demo card when the demo state payload is empty", async () => {
    settingsMocks.fetchDemoState.mockResolvedValue({});

    const onboarding = await mount("onboarding");

    await click(findButton(onboarding.root, "Try a safe demo"));
    const text = collectText(onboarding.root);
    expect(text).toContain("Start Here");
    expect(text).toContain("Not checked");
  });

  it("renders the personalities section when the personalities payload is empty", async () => {
    settingsMocks.fetchPersonalities.mockResolvedValue({});

    const personalities = await mount("personalities");

    expect(collectText(personalities.root)).toContain("Personality catalog");
  });

  it("renders the workspaces section when workspace and citadel payloads are empty", async () => {
    settingsMocks.fetchWorkspaces.mockResolvedValue({});
    settingsMocks.listCitadels.mockResolvedValue({});

    const workspaces = await mount("workspaces");

    const text = collectText(workspaces.root);
    expect(text).toContain("Citadel manager");
    expect(text).toContain("Workspace directory");
  });

  it("renders the channels section when definitions and drafts payloads are empty", async () => {
    settingsMocks.fetchChannelSetupDefinitions.mockResolvedValue({});
    settingsMocks.fetchChannelSetupDrafts.mockResolvedValue({});

    const channels = await mount("channels");

    expect(collectText(channels.root)).toContain("Channel connections");
    await click(findButton(channels.root, "Connect channel"));
    expect(collectText(channels.root)).toContain("No channel definitions available");
    expect(findButton(channels.root, "Start guided setup").props.disabled).toBe(true);
  });

  it("renders the MCP section when server, preview, server-mode, and elicitation payloads are empty", async () => {
    settingsMocks.fetchMcpServers.mockResolvedValue({});
    settingsMocks.fetchMcpRemotePreview.mockResolvedValue({});
    settingsMocks.fetchMcpServerModeManifest.mockResolvedValue({});
    settingsMocks.fetchMcpElicitations.mockResolvedValue({});

    const mcp = await mount("mcp");

    expect(collectText(mcp.root)).toContain("MCP servers");
  });

  it("renders the permissions section when the profiles payload is empty", async () => {
    settingsMocks.fetchPermissionProfiles.mockResolvedValue({});

    const permissions = await mount("permissions");

    expect(collectText(permissions.root)).toContain("Permission profiles");
  });

  it("renders the add-ons section when catalog and pack payloads are empty", async () => {
    settingsMocks.fetchAddonsCatalog.mockResolvedValue({});
    settingsMocks.fetchInstalledAddons.mockResolvedValue({});
    settingsMocks.fetchCapabilityPacks.mockResolvedValue({});
    settingsMocks.fetchStagedCapabilityPacks.mockResolvedValue({});

    const addons = await mount("addons");

    expect(collectText(addons.root)).toContain("Add-on catalog");
  });

  it("keeps provider advice defensive when the advice payload is empty", async () => {
    settingsMocks.fetchLlmProviderAdvice.mockResolvedValue({});

    const providers = await mount("providers");
    await openProviderPanel(providers, "advice");
    await click(findButton(providers.root, "Load advice"));

    const text = collectText(providers.root);
    expect(text).toContain("Provider advice");
    expect(text).toContain("Provider advice is advisory only.");
  });

  it("renders the general posture counts when workspace, integration, MCP, tool, and add-on payloads are empty", async () => {
    settingsMocks.fetchWorkspaces.mockResolvedValue({});
    settingsMocks.fetchIntegrationConnections.mockResolvedValue({});
    settingsMocks.fetchMcpServers.mockResolvedValue({});
    settingsMocks.fetchToolCatalog.mockResolvedValue({});
    settingsMocks.fetchInstalledAddons.mockResolvedValue({});

    const general = await mount("general");
    await act(async () => {
      general.root
        .findByProps({ id: "general-setup-status", open: false })
        .props.onToggle({ currentTarget: { open: true } });
      await flush();
    });

    const text = collectText(general.root);
    expect(text).toContain("Mission Control posture");
    expect(text).toContain("Contexts available to switch or edit");
    expect(text).toContain("0 configured");
  });

  it("renders the access section when the device grant payload is empty", async () => {
    settingsMocks.fetchDeviceAccessGrants.mockResolvedValue({} as Awaited<ReturnType<typeof settingsMocks.fetchDeviceAccessGrants>>);

    const access = await mount("access");
    await click(findButton(access.root, "Configure access"));

    const text = collectText(access.root);
    expect(text).toContain("Approved devices");
    expect(text).toContain("No device grants found.");
  });

  it("renders the access section when the settings payload is empty", async () => {
    settingsMocks.fetchSettings.mockResolvedValue({});

    const access = await mount("access");
    await click(findButton(access.root, "Configure access"));

    const text = collectText(access.root);
    expect(text).toContain("Gateway access");
    expect(text).toContain("Current posture");
    expect(text).toContain("Desktop/mobile continuity");
    expect(text).toContain("unknown");
    expect(text).toContain("Missing");
  });

  it("renders the runtime posture when llama.cpp and NPU model payloads are empty", async () => {
    settingsMocks.fetchLlamaCppModels.mockResolvedValue({});
    settingsMocks.fetchNpuModels.mockResolvedValue({});

    const runtime = await mount("runtime");
    await click(findButton(runtime.root, "Configure llama.cpp"));

    expect(collectText(runtime.root)).toContain("Command and model paths are read-only here");
  });

  it("renders the runtime section when the settings payload is empty", async () => {
    settingsMocks.fetchSettings.mockResolvedValue({});

    const runtime = await mount("runtime");
    await click(findButton(runtime.root, "Configure llama.cpp"));

    const text = collectText(runtime.root);
    expect(text).toContain("Runtime posture");
    expect(text).toContain("llama.cpp runtime");
    await click(findButton(runtime.root, "Legacy acceleration"));
    expect(collectText(runtime.root)).toContain("Local acceleration");
    expect(text).toContain("unknown");
    expect(settingsMocks.fetchNpuModels).not.toHaveBeenCalled();
  });

  it("skips NPU model discovery without error-bannering when npu settings omit status", async () => {
    settingsMocks.fetchSettings.mockResolvedValue({
      npu: { enabled: true, autoStart: false, sidecarUrl: "http://127.0.0.1:39110" },
    });

    const runtime = await mount("runtime");
    await click(findButton(runtime.root, "Legacy acceleration"));

    const text = collectText(runtime.root);
    expect(text).toContain("Runtime posture");
    expect(text).toContain("Local acceleration");
    expect(settingsMocks.fetchNpuModels).not.toHaveBeenCalled();
  });

  it("renders the integrations section with inert fallbacks when every integration payload is empty", async () => {
    settingsMocks.fetchIntegrationCatalog.mockResolvedValue({});
    settingsMocks.fetchIntegrationConnections.mockResolvedValue({});
    settingsMocks.fetchIntegrationPlugins.mockResolvedValue({});
    settingsMocks.fetchGoogleMeetPrerequisiteStatus.mockResolvedValue({});
    settingsMocks.fetchGoogleMeetSessions.mockResolvedValue({});
    settingsMocks.fetchExternalSideEffectRuns.mockResolvedValue({});
    settingsMocks.fetchExternalConnectorServices.mockResolvedValue({});

    const integrations = await mount("integrations");

    const text = collectText(integrations.root);
    expect(text).toContain("Connected integrations");
    expect(text).toContain("No integration connections yet.");
    await click(findButton(integrations.root, "Plugin trust"));
    expect(collectText(integrations.root)).toContain("No integration plugins installed.");
    await click(findButton(integrations.root, "Google Meet"));
    expect(collectText(integrations.root)).toContain("Google Meet voice");
    expect(collectText(integrations.root)).toContain("No Google Meet sessions recorded.");
  });

  it("renders the permissions grant panels when override and autonomy grant payloads are empty", async () => {
    settingsMocks.fetchActiveLocalOperatorOverrides.mockResolvedValue({});
    settingsMocks.fetchAutonomousActivationGrants.mockResolvedValue({});

    const permissions = await mount("permissions");

    const text = collectText(permissions.root);
    expect(text).toContain("Autonomous activation grants");
    expect(text).toContain("No autonomous activation grants recorded.");
  });

  it("renders the tools section when tool catalog and grant payloads are empty", async () => {
    settingsMocks.fetchToolCatalog.mockResolvedValue({});
    settingsMocks.fetchToolGrants.mockResolvedValue({});

    const tools = await mount("tools");

    await click(findButton(tools.root, "All grants"));
    const text = collectText(tools.root);
    expect(text).toContain("Tool catalog");
    expect(text).toContain("No tool grants created yet.");
  });

  it("renders the onboarding section when the onboarding payload is empty", async () => {
    settingsMocks.fetchOnboardingState.mockResolvedValue({});

    const onboarding = await mount("onboarding");

    await click(findButton(onboarding.root, "Verification evidence"));
    let text = collectText(onboarding.root);
    await click(findButton(onboarding.root, "Back to list"));
    await click(findButton(onboarding.root, "First-run defaults"));
    text += collectText(onboarding.root);
    expect(text).toContain("First trusted outcome");
    expect(text).toContain("Setup Center");
    expect(text).toContain("Provider smoke evidence");
    expect(text).toContain("First-run setup");
    expect(text).toContain("Apply first-run defaults");
    expect(text).toContain("Choose an active provider before sending cloud-backed work.");
    expect(text).toContain("Unset");
  });

  it("renders the onboarding section when agentic run and evidence payloads are empty", async () => {
    settingsMocks.fetchAgenticRuns.mockResolvedValue({});
    settingsMocks.fetchEvidenceEnvelopes.mockResolvedValue({});

    const onboarding = await mount("onboarding");

    await click(findButton(onboarding.root, "Verification evidence"));
    const text = collectText(onboarding.root);
    expect(text).toContain("First trusted outcome");
    expect(text).toContain("First-run setup");
    expect(text).toContain("No proof artifact or trace is recorded yet.");
  });

  it("renders the remote profile readiness card when the setup readiness payload is partial", async () => {
    settingsMocks.fetchOnboardingState.mockResolvedValue({ setupReadiness: {} });

    const onboarding = await mount("onboarding");

    await click(findButton(onboarding.root, "Verification evidence"));
    const text = collectText(onboarding.root);
    expect(text).toContain("Remote profile readiness");
    expect(text).toContain("unknown");
  });
});

async function openProviderPanel(
  renderer: ReactTestRenderer,
  view: "trust" | "oauth" | "editor" | "routing" | "advice" | "models",
) {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  if (view === "trust" || view === "editor") {
    await act(async () => {
      renderer.root
        .findAll((node) => node.type === "button" && node.props.className?.includes("mc-next-settings-selectable"))[0]
        ?.props.onClick();
    });
    if (view === "editor")
      await act(async () => {
        findButton(renderer.root, "Edit connection").props.onClick();
      });
  } else {
    const label = {
      oauth: "ChatGPT setup",
      routing: "Default routing",
      advice: "Provider advice",
      models: "Browse models",
    }[view];
    await act(async () => {
      findButton(renderer.root, label).props.onClick();
    });
  }
  await act(async () => {
    await Promise.resolve();
  });
}

function toolGrantRecordsFixture(): Array<import("@goatcitadel/contracts").ToolGrantRecord> {
  return [{ grantId: "grant-1", toolPattern: "shell.*", decision: "allow", scope: "workspace", scopeRef: "default", grantType: "persistent", createdBy: "operator", createdAt: "2026-04-24T12:00:00.000Z" }];
}
