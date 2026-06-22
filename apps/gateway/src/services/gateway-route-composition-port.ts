import type { Storage } from "@goatcitadel/storage";
import type { ToolPolicyEngine } from "@goatcitadel/policy-engine";
import type { MeshService } from "@goatcitadel/mesh-core";
import type { GatewayRuntimeConfig } from "../config.js";
import type { GatewayRouteServiceDependencies } from "./gateway-route-services.js";
import type { CommsHost } from "./comms-service.js";
import type { IntegrationChannelPort as IntegrationChannelServicePort } from "./integration-channel-service.js";
import type * as chatSessionService from "./chat-session-service.js";
import type * as chatToolArtifactService from "./chat-tool-artifact-service.js";
import type * as chatMessageRouteRuntime from "./chat-message-route-runtime.js";
import type * as mcpServerAdminService from "./mcp-server-admin-service.js";
import type { GatewayMcpOAuthService } from "./gateway-mcp-oauth-service.js";
import type * as onboardingStateService from "./onboarding-state-service.js";
import type * as settingsAuthService from "./settings-auth-service.js";
import type { GatewayDevDiagnosticsService } from "../dev-diagnostics/service.js";
import type { AddonsService } from "./addons-service.js";
import type { AddonSlotService } from "./addon-slot-service.js";
import type { ApprovalEffectsService } from "./approval-resolution-effects-service.js";
import type { ApprovalRuntimeService } from "./approval-runtime-service.js";
import type { AssemblyService } from "./assembly-service.js";
import type { BackupRetentionService } from "./backup-retention-service.js";
import type { CapabilityPackService } from "./capability-pack-service.js";
import type { CapabilitySystemService } from "./capability-system-service.js";
import type { ChatProjectService } from "./chat-project-service.js";
import type { ChatProactiveService } from "./chat-proactive-service.js";
import type { ChatSteerService } from "./chat-steer-service.js";
import type { ChatTurnRuntimeService } from "./chat-turn-runtime-service.js";
import type { CronAutomationService } from "./gateway/cron-automation-service.js";
import type { DatabaseCutoverService } from "./database-cutover-service.js";
import type { DiscordRuntimeService } from "./discord-runtime-service.js";
import type { DurableOperatorService } from "./durable-operator-service.js";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import type { GuidanceService } from "./guidance-service.js";
import type { HooksService } from "./hooks-service.js";
import type { ImprovementService } from "./improvement-service.js";
import type { AutonomyControlService } from "./autonomy-control-service.js";
import type { LlamaCppRuntimeService } from "./llama-cpp-runtime-service.js";
import type { LlmService } from "./llm-service.js";
import type { MediaVoiceService } from "./media-voice-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";
import type { NpuSidecarService } from "./npu-sidecar-service.js";
import type { ObsidianVaultService } from "./obsidian-vault-service.js";
import type { OperatorSummaryCache } from "./gateway/operator-summary-cache.js";
import type { PersonalityCatalogService } from "./channel-personalities.js";
import type { PromptPackService } from "./prompt-pack-service.js";
import type { RealtimeEventService } from "./realtime-event-service.js";
import type { ResearchService } from "./research-service.js";
import type { RuntimeLifecycleReadService } from "./runtime-lifecycle-read-service.js";
import type { SecretStoreService } from "./secret-store-service.js";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";
import type { ToolInvocationCoordinatorService } from "./tool-invocation-coordinator-service.js";
import type { ChannelSetupRecentTestCacheEntry } from "./channel-setup-test-cache.js";

type RouteDependencyMethod<
  TDomain extends keyof GatewayRouteServiceDependencies,
  TMethod extends keyof GatewayRouteServiceDependencies[TDomain],
> = GatewayRouteServiceDependencies[TDomain][TMethod];

export interface GatewayRouteCompositionPort {
  readonly addonsService: AddonsService;
  readonly addonSlotService: AddonSlotService;
  readonly approvalEffectsService: ApprovalEffectsService;
  readonly approvalRuntime: ApprovalRuntimeService;
  readonly assemblyService: AssemblyService;
  readonly backupRetentionService: BackupRetentionService;
  readonly capabilityPackService: CapabilityPackService;
  readonly capabilitySystemService: CapabilitySystemService;
  readonly chatProactiveService: ChatProactiveService;
  readonly chatProjectService: ChatProjectService;
  readonly chatMessageRouteRuntimeHost: chatMessageRouteRuntime.ChatMessageRouteRuntimeHost;
  readonly chatTurnRuntime: ChatTurnRuntimeService;
  readonly steerService: ChatSteerService;
  readonly config: GatewayRuntimeConfig;
  readonly cronAutomationService: CronAutomationService;
  readonly databaseCutoverService: DatabaseCutoverService;
  readonly devDiagnostics: GatewayDevDiagnosticsService;
  readonly discordRuntimeService: DiscordRuntimeService;
  readonly durableOperatorService: DurableOperatorService;
  readonly evidenceEnvelopeService: EvidenceEnvelopeService;
  readonly guidanceService: GuidanceService;
  readonly hooksService: HooksService;
  readonly improvementService: ImprovementService;
  readonly autonomyControlService: AutonomyControlService;
  readonly llamaCppRuntime: LlamaCppRuntimeService;
  readonly llmService: LlmService;
  readonly mediaVoiceService: MediaVoiceService;
  get memoryLifecycleService(): MemoryLifecycleService;
  readonly meshService: MeshService;
  readonly mutationIdempotencyStore: MutationIdempotencyStore;
  readonly npuSidecar: NpuSidecarService;
  readonly obsidianVaultService: ObsidianVaultService;
  readonly onboardingStateHost: onboardingStateService.OnboardingStateHost;
  readonly operatorSummaryCache: OperatorSummaryCache;
  readonly personalityCatalogService: PersonalityCatalogService;
  readonly policyEngine: ToolPolicyEngine;
  readonly promptPackService: PromptPackService;
  readonly realtimeEventService: RealtimeEventService;
  readonly recentChannelSetupTests: Map<string, ChannelSetupRecentTestCacheEntry>;
  readonly researchService: ResearchService;
  readonly runtimeLifecycleReadService: RuntimeLifecycleReadService;
  readonly secretStore?: SecretStoreService;
  readonly storage: Storage;
  readonly taskLifecycleService: TaskLifecycleService;
  readonly toolInvocationCoordinator: ToolInvocationCoordinatorService;
  acceptChatDelegation: RouteDependencyMethod<"chatDelegate", "acceptChatDelegation">;
  approvePhase: RouteDependencyMethod<"orchestration", "approvePhase">;
  cancelOrchestrationRun: RouteDependencyMethod<"orchestration", "cancelOrchestrationRun">;
  assertDeploymentProfileUpdate: settingsAuthService.SettingsRuntimeDependencies["assertDeploymentProfileUpdate"];
  assertFirecrawlRuntimeUpdate: settingsAuthService.SettingsRuntimeDependencies["assertFirecrawlRuntimeUpdate"];
  buildApprovalRealtimeLinks: settingsAuthService.SettingsAuthRuntimeDependencies["buildApprovalRealtimeLinks"];
  bulkSetSkillState: RouteDependencyMethod<"skills", "bulkSetSkillState">;
  cancelLatestActiveChatTurnForSession: RouteDependencyMethod<
    "integrationWebhooks",
    "cancelLatestActiveChatTurnForSession"
  >;
  clearChatTurnWriteLease: chatSessionService.ChatSessionDependencies["clearChatTurnWriteLease"];
  commsActivity: RouteDependencyMethod<"comms", "commsActivity">;
  commsReply: RouteDependencyMethod<"comms", "commsReply">;
  commsSend: RouteDependencyMethod<"comms", "commsSend">;
  createApproval: RouteDependencyMethod<"devVerification", "createApproval">;
  listCuratorStatus: RouteDependencyMethod<"curator", "listCuratorStatus">;
  archiveCuratorSkill: RouteDependencyMethod<"curator", "archiveCuratorSkill">;
  pruneCuratorSkill: RouteDependencyMethod<"curator", "pruneCuratorSkill">;
  listCuratorArchived: RouteDependencyMethod<"curator", "listCuratorArchived">;
  runCurator: RouteDependencyMethod<"curator", "runCurator">;
  createChatCompletion: RouteDependencyMethod<"llm", "createChatCompletion">;
  createChatCompletionStream: RouteDependencyMethod<"devVerification", "createChatCompletionStream">;
  createChatSession: RouteDependencyMethod<"chatSessions", "createChatSession">;
  createChatSessionSpecialistCandidate: RouteDependencyMethod<
    "chatSupport",
    "specialists"
  >["createChatSessionSpecialistCandidate"];
  createOrchestrationPlan: RouteDependencyMethod<"orchestration", "createOrchestrationPlan">;
  enqueueApprovalResolutionEffects: settingsAuthService.SettingsAuthRuntimeDependencies["enqueueApprovalResolutionEffects"];
  ensureChatSessionModelDefaults: chatSessionService.ChatSessionDependencies["ensureChatSessionModelDefaults"];
  ensureChatSessionRuntimeGrants: chatSessionService.ChatSessionDependencies["ensureChatSessionRuntimeGrants"];
  fetchWithDiagnosticsTimeout: IntegrationChannelServicePort["fetchWithDiagnosticsTimeout"];
  getChatSessionPrefs: RouteDependencyMethod<"chatSupport", "prefs">["getChatSessionPrefs"];
  getRun: RouteDependencyMethod<"orchestration", "getRun">;
  getRunTrace: RouteDependencyMethod<"orchestration", "getRunTrace">;
  getSession: chatSessionService.ChatSessionDependencies["getSession"];
  getSessionSummary: RouteDependencyMethod<"sessionsList", "getSessionSummary">;
  getSkillActivationPolicy: RouteDependencyMethod<"skills", "getSkillActivationPolicy">;
  getTranscript: RouteDependencyMethod<"runtimeLifecycle", "getTranscript">;
  hasRunningTurn(sessionId: string): boolean;
  hydrateChatPrefsWithAutonomy: chatSessionService.ChatSessionDependencies["hydrateChatPrefsWithAutonomy"];
  ingestChannelMessage: RouteDependencyMethod<"integrationWebhooks", "ingestChannelMessage">;
  ingestEvent: RouteDependencyMethod<"gatewayEvents", "ingestEvent">;
  installSkillImport: RouteDependencyMethod<"skills", "installSkillImport">;
  invokeAndUnwrap: CommsHost["invokeAndUnwrap"];
  invokeTool: RouteDependencyMethod<"toolsInvoke", "invokeTool">;
  isConnectionUrlAllowlisted: IntegrationChannelServicePort["isConnectionUrlAllowlisted"];
  isFeatureEnabled: RouteDependencyMethod<"toolsInvoke", "isFeatureEnabled">;
  activatePermissionProfile: RouteDependencyMethod<"tools", "activatePermissionProfile">;
  archivePermissionProfile: RouteDependencyMethod<"tools", "archivePermissionProfile">;
  createLocalOperatorOverride: RouteDependencyMethod<"tools", "createLocalOperatorOverride">;
  createPermissionProfile: RouteDependencyMethod<"tools", "createPermissionProfile">;
  evaluateToolAccess: RouteDependencyMethod<"tools", "evaluateToolAccess">;
  listActiveLocalOperatorOverrides: RouteDependencyMethod<"tools", "listActiveLocalOperatorOverrides">;
  listPermissionProfiles: RouteDependencyMethod<"tools", "listPermissionProfiles">;
  resolveToolPolicyContext: RouteDependencyMethod<"tools", "resolveToolPolicyContext">;
  revokeLocalOperatorOverride: RouteDependencyMethod<"tools", "revokeLocalOperatorOverride">;
  updatePermissionProfile: RouteDependencyMethod<"tools", "updatePermissionProfile">;
  listChannelDeliveryRuntime: RouteDependencyMethod<"comms", "listChannelDeliveryRuntime">;
  listChatMessages: RouteDependencyMethod<"chatMessages", "listChatMessages">;
  listMcpServers: RouteDependencyMethod<"mcp", "listMcpServers">;
  listMcpTemplates: RouteDependencyMethod<"mcp", "listMcpTemplates">;
  listMcpTools: RouteDependencyMethod<"mcp", "listMcpTools">;
  listRunCheckpoints: RouteDependencyMethod<"orchestration", "listRunCheckpoints">;
  listSessionTimeline: RouteDependencyMethod<"runtimeLifecycle", "listSessionTimeline">;
  listSkillImportHistory: RouteDependencyMethod<"skills", "listSkillImportHistory">;
  listSkillSources: RouteDependencyMethod<"skills", "listSkillSources">;
  listSkills: RouteDependencyMethod<"skills", "listSkills">;
  listSkillExportTargets: RouteDependencyMethod<"skills", "listSkillExportTargets">;
  lookupSkillSources: RouteDependencyMethod<"skills", "lookupSkillSources">;
  packageSkillExport: RouteDependencyMethod<"skills", "packageSkillExport">;
  previewSkillExport: RouteDependencyMethod<"skills", "previewSkillExport">;
  normalizeWorkspaceId: chatSessionService.ChatSessionDependencies["normalizeWorkspaceId"];
  parseChatCommand: RouteDependencyMethod<"chatSupport", "commands">["parseChatCommand"];
  patchMcpServerState: mcpServerAdminService.McpServerAdminHost["patchMcpServerState"];
  mcpOAuth: Pick<GatewayMcpOAuthService, "exchangeAuthorizationCode">;
  patchSessionAutonomyPrefs: chatSessionService.ChatSessionDependencies["patchSessionAutonomyPrefs"];
  persistAssistantConfig: settingsAuthService.SettingsRuntimeDependencies["persistAssistantConfig"];
  persistBudgetsConfig: settingsAuthService.SettingsRuntimeDependencies["persistBudgetsConfig"];
  persistLlmConfig: settingsAuthService.SettingsRuntimeDependencies["persistLlmConfig"];
  persistToolPolicyConfig: settingsAuthService.SettingsRuntimeDependencies["persistToolPolicyConfig"];
  publishRealtime: RouteDependencyMethod<"devVerification", "publishRealtime">;
  readConnectionConfigValue: IntegrationChannelServicePort["readConnectionConfigValue"];
  readDiscordPairings: IntegrationChannelServicePort["readDiscordPairings"];
  readFeatureFlags: settingsAuthService.SettingsRuntimeDependencies["readFeatureFlags"];
  readMcpAuthState: mcpServerAdminService.McpServerAdminHost["readMcpAuthState"];
  readMcpServers: mcpServerAdminService.McpServerAdminHost["readMcpServers"];
  readMcpTools: mcpServerAdminService.McpServerAdminHost["readMcpTools"];
  recordDevDiagnostic(input: Parameters<GatewayDevDiagnosticsService["record"]>[0]): void;
  reloadSkills: RouteDependencyMethod<"skills", "reloadSkills">;
  requireChatSession: chatToolArtifactService.ChatToolArtifactHost["requireChatSession"];
  requireFeatureEnabled: IntegrationChannelServicePort["requireFeatureEnabled"];
  requireMcpServer: mcpServerAdminService.McpServerAdminHost["requireMcpServer"];
  resolveApproval: settingsAuthService.SettingsAuthRuntimeDependencies["resolveApproval"];
  resolveApprovalWithRemoteToken: RouteDependencyMethod<"integrationWebhooks", "resolveApprovalWithRemoteToken">;
  resolveApprovalWithRemoteTokenId: RouteDependencyMethod<"integrationWebhooks", "resolveApprovalWithRemoteTokenId">;
  resolveConnectedMcpTools: mcpServerAdminService.McpServerAdminHost["resolveConnectedMcpTools"];
  resolveConnectionSecret: IntegrationChannelServicePort["resolveConnectionSecret"];
  resolveGatewayInstallToken: RouteDependencyMethod<"authAdmin", "resolveGatewayInstallToken">;
  resolveSkillActivation: RouteDependencyMethod<"skills", "resolveSkillActivation">;
  respondToExistingChatMessage: RouteDependencyMethod<"integrationWebhooks", "respondToExistingChatMessage">;
  runChatDelegation: RouteDependencyMethod<"chatDelegate", "runChatDelegation">;
  runChatDelegationStream: RouteDependencyMethod<"chatDelegate", "runChatDelegationStream">;
  runChatResearch: RouteDependencyMethod<"chatSupport", "research">["runChatResearch"];
  runDatabaseCutover: RouteDependencyMethod<"authAdmin", "runDatabaseCutover">;
  runOrchestrationPlan: RouteDependencyMethod<"orchestration", "runOrchestrationPlan">;
  setChatSessionBinding: RouteDependencyMethod<"chatSessions", "setChatSessionBinding">;
  setSkillState: RouteDependencyMethod<"skills", "setSkillState">;
  suggestChatDelegation: RouteDependencyMethod<"chatDelegate", "suggestChatDelegation">;
  syncDiscordRuntime: IntegrationChannelServicePort["syncDiscordRuntime"];
  updateChatSessionPrefs: RouteDependencyMethod<"chatSupport", "prefs">["updateChatSessionPrefs"];
  updateFeatureFlags: settingsAuthService.SettingsRuntimeDependencies["updateFeatureFlags"];
  updateSkillActivationPolicy: RouteDependencyMethod<"skills", "updateSkillActivationPolicy">;
  validateSkillImport: RouteDependencyMethod<"skills", "validateSkillImport">;
  verifyBackup: RouteDependencyMethod<"authAdmin", "verifyBackup">;
  verifyDatabaseCutover: RouteDependencyMethod<"authAdmin", "verifyDatabaseCutover">;
  writeDiscordPairings: IntegrationChannelServicePort["writeDiscordPairings"];
  writeMcpAuthState: mcpServerAdminService.McpServerAdminHost["writeMcpAuthState"];
  writeMcpServers: mcpServerAdminService.McpServerAdminHost["writeMcpServers"];
  writeMcpTools: mcpServerAdminService.McpServerAdminHost["writeMcpTools"];
}

export type GatewayRouteCompositionPrivateDependencies = Pick<
  GatewayRouteCompositionPort,
  | "addonsService"
  | "addonSlotService"
  | "approvalRuntime"
  | "assemblyService"
  | "backupRetentionService"
  | "capabilityPackService"
  | "capabilitySystemService"
  | "chatMessageRouteRuntimeHost"
  | "chatProjectService"
  | "chatTurnRuntime"
  | "databaseCutoverService"
  | "devDiagnostics"
  | "durableOperatorService"
  | "evidenceEnvelopeService"
  | "guidanceService"
  | "improvementService"
  | "autonomyControlService"
  | "mediaVoiceService"
  | "obsidianVaultService"
  | "onboardingStateHost"
  | "promptPackService"
  | "realtimeEventService"
  | "researchService"
  | "runtimeLifecycleReadService"
  | "taskLifecycleService"
  | "toolInvocationCoordinator"
>;

export type GatewayRouteCompositionHost = Omit<
  GatewayRouteCompositionPort,
  keyof GatewayRouteCompositionPrivateDependencies
>;

export function createGatewayRouteCompositionPort(
  gateway: GatewayRouteCompositionHost,
  privateDependencies: GatewayRouteCompositionPrivateDependencies,
): GatewayRouteCompositionPort {
  return {
    addonsService: privateDependencies.addonsService,
    addonSlotService: privateDependencies.addonSlotService,
    approvalRuntime: privateDependencies.approvalRuntime,
    assemblyService: privateDependencies.assemblyService,
    backupRetentionService: privateDependencies.backupRetentionService,
    capabilityPackService: privateDependencies.capabilityPackService,
    capabilitySystemService: privateDependencies.capabilitySystemService,
    chatMessageRouteRuntimeHost: privateDependencies.chatMessageRouteRuntimeHost,
    chatProjectService: privateDependencies.chatProjectService,
    chatTurnRuntime: privateDependencies.chatTurnRuntime,
    databaseCutoverService: privateDependencies.databaseCutoverService,
    devDiagnostics: privateDependencies.devDiagnostics,
    durableOperatorService: privateDependencies.durableOperatorService,
    evidenceEnvelopeService: privateDependencies.evidenceEnvelopeService,
    guidanceService: privateDependencies.guidanceService,
    improvementService: privateDependencies.improvementService,
    autonomyControlService: privateDependencies.autonomyControlService,
    mediaVoiceService: privateDependencies.mediaVoiceService,
    obsidianVaultService: privateDependencies.obsidianVaultService,
    onboardingStateHost: privateDependencies.onboardingStateHost,
    promptPackService: privateDependencies.promptPackService,
    realtimeEventService: privateDependencies.realtimeEventService,
    researchService: privateDependencies.researchService,
    runtimeLifecycleReadService: privateDependencies.runtimeLifecycleReadService,
    taskLifecycleService: privateDependencies.taskLifecycleService,
    toolInvocationCoordinator: privateDependencies.toolInvocationCoordinator,
    approvalEffectsService: gateway.approvalEffectsService,
    chatProactiveService: gateway.chatProactiveService,
    get config() {
      return gateway.config;
    },
    cronAutomationService: gateway.cronAutomationService,
    discordRuntimeService: gateway.discordRuntimeService,
    hooksService: gateway.hooksService,
    llamaCppRuntime: gateway.llamaCppRuntime,
    llmService: gateway.llmService,
    memoryLifecycleService: gateway.memoryLifecycleService,
    meshService: gateway.meshService,
    mutationIdempotencyStore: gateway.mutationIdempotencyStore,
    npuSidecar: gateway.npuSidecar,
    operatorSummaryCache: gateway.operatorSummaryCache,
    personalityCatalogService: gateway.personalityCatalogService,
    policyEngine: gateway.policyEngine,
    recentChannelSetupTests: gateway.recentChannelSetupTests,
    steerService: gateway.steerService,
    storage: gateway.storage,
    acceptChatDelegation: gateway.acceptChatDelegation.bind(gateway),
    approvePhase: gateway.approvePhase.bind(gateway),
    cancelOrchestrationRun: gateway.cancelOrchestrationRun.bind(gateway),
    assertDeploymentProfileUpdate: gateway.assertDeploymentProfileUpdate.bind(gateway),
    assertFirecrawlRuntimeUpdate: gateway.assertFirecrawlRuntimeUpdate.bind(gateway),
    buildApprovalRealtimeLinks: gateway.buildApprovalRealtimeLinks.bind(gateway),
    bulkSetSkillState: gateway.bulkSetSkillState.bind(gateway),
    cancelLatestActiveChatTurnForSession: gateway.cancelLatestActiveChatTurnForSession.bind(gateway),
    clearChatTurnWriteLease: gateway.clearChatTurnWriteLease.bind(gateway),
    commsActivity: gateway.commsActivity.bind(gateway),
    commsReply: gateway.commsReply.bind(gateway),
    commsSend: gateway.commsSend.bind(gateway),
    createApproval: gateway.createApproval.bind(gateway),
    listCuratorStatus: gateway.listCuratorStatus.bind(gateway),
    archiveCuratorSkill: gateway.archiveCuratorSkill.bind(gateway),
    pruneCuratorSkill: gateway.pruneCuratorSkill.bind(gateway),
    listCuratorArchived: gateway.listCuratorArchived.bind(gateway),
    runCurator: gateway.runCurator.bind(gateway),
    createChatCompletion: gateway.createChatCompletion.bind(gateway),
    createChatCompletionStream: gateway.createChatCompletionStream.bind(gateway),
    createChatSession: gateway.createChatSession.bind(gateway),
    createChatSessionSpecialistCandidate: gateway.createChatSessionSpecialistCandidate.bind(gateway),
    createOrchestrationPlan: gateway.createOrchestrationPlan.bind(gateway),
    enqueueApprovalResolutionEffects: gateway.enqueueApprovalResolutionEffects.bind(gateway),
    ensureChatSessionModelDefaults: gateway.ensureChatSessionModelDefaults.bind(gateway),
    ensureChatSessionRuntimeGrants: gateway.ensureChatSessionRuntimeGrants.bind(gateway),
    fetchWithDiagnosticsTimeout: gateway.fetchWithDiagnosticsTimeout.bind(gateway),
    getChatSessionPrefs: gateway.getChatSessionPrefs.bind(gateway),
    getRun: gateway.getRun.bind(gateway),
    getRunTrace: gateway.getRunTrace.bind(gateway),
    getSession: gateway.getSession.bind(gateway),
    getSessionSummary: gateway.getSessionSummary.bind(gateway),
    getSkillActivationPolicy: gateway.getSkillActivationPolicy.bind(gateway),
    getTranscript: gateway.getTranscript.bind(gateway),
    hasRunningTurn: gateway.hasRunningTurn.bind(gateway),
    hydrateChatPrefsWithAutonomy: gateway.hydrateChatPrefsWithAutonomy.bind(gateway),
    ingestChannelMessage: gateway.ingestChannelMessage.bind(gateway),
    ingestEvent: gateway.ingestEvent.bind(gateway),
    installSkillImport: gateway.installSkillImport.bind(gateway),
    invokeAndUnwrap: gateway.invokeAndUnwrap.bind(gateway),
    invokeTool: gateway.invokeTool.bind(gateway),
    isConnectionUrlAllowlisted: gateway.isConnectionUrlAllowlisted.bind(gateway),
    isFeatureEnabled: gateway.isFeatureEnabled.bind(gateway),
    activatePermissionProfile: gateway.activatePermissionProfile.bind(gateway),
    archivePermissionProfile: gateway.archivePermissionProfile.bind(gateway),
    createLocalOperatorOverride: gateway.createLocalOperatorOverride.bind(gateway),
    createPermissionProfile: gateway.createPermissionProfile.bind(gateway),
    evaluateToolAccess: gateway.evaluateToolAccess.bind(gateway),
    listActiveLocalOperatorOverrides: gateway.listActiveLocalOperatorOverrides.bind(gateway),
    listPermissionProfiles: gateway.listPermissionProfiles.bind(gateway),
    resolveToolPolicyContext: gateway.resolveToolPolicyContext.bind(gateway),
    revokeLocalOperatorOverride: gateway.revokeLocalOperatorOverride.bind(gateway),
    updatePermissionProfile: gateway.updatePermissionProfile.bind(gateway),
    listChannelDeliveryRuntime: gateway.listChannelDeliveryRuntime.bind(gateway),
    listChatMessages: gateway.listChatMessages.bind(gateway),
    listMcpServers: gateway.listMcpServers.bind(gateway),
    listMcpTemplates: gateway.listMcpTemplates.bind(gateway),
    listMcpTools: gateway.listMcpTools.bind(gateway),
    listRunCheckpoints: gateway.listRunCheckpoints.bind(gateway),
    listSessionTimeline: gateway.listSessionTimeline.bind(gateway),
    listSkillImportHistory: gateway.listSkillImportHistory.bind(gateway),
    listSkillSources: gateway.listSkillSources.bind(gateway),
    listSkills: gateway.listSkills.bind(gateway),
    listSkillExportTargets: gateway.listSkillExportTargets.bind(gateway),
    lookupSkillSources: gateway.lookupSkillSources.bind(gateway),
    packageSkillExport: gateway.packageSkillExport.bind(gateway),
    previewSkillExport: gateway.previewSkillExport.bind(gateway),
    normalizeWorkspaceId: gateway.normalizeWorkspaceId.bind(gateway),
    parseChatCommand: gateway.parseChatCommand.bind(gateway),
    patchMcpServerState: gateway.patchMcpServerState.bind(gateway),
    mcpOAuth: gateway.mcpOAuth,
    patchSessionAutonomyPrefs: gateway.patchSessionAutonomyPrefs.bind(gateway),
    persistAssistantConfig: gateway.persistAssistantConfig.bind(gateway),
    persistBudgetsConfig: gateway.persistBudgetsConfig.bind(gateway),
    persistLlmConfig: gateway.persistLlmConfig.bind(gateway),
    persistToolPolicyConfig: gateway.persistToolPolicyConfig.bind(gateway),
    publishRealtime: gateway.publishRealtime.bind(gateway),
    readConnectionConfigValue: gateway.readConnectionConfigValue.bind(gateway),
    readDiscordPairings: gateway.readDiscordPairings.bind(gateway),
    readFeatureFlags: gateway.readFeatureFlags.bind(gateway),
    readMcpAuthState: gateway.readMcpAuthState.bind(gateway),
    readMcpServers: gateway.readMcpServers.bind(gateway),
    readMcpTools: gateway.readMcpTools.bind(gateway),
    recordDevDiagnostic: gateway.recordDevDiagnostic.bind(gateway),
    reloadSkills: gateway.reloadSkills.bind(gateway),
    requireChatSession: gateway.requireChatSession.bind(gateway),
    requireFeatureEnabled: gateway.requireFeatureEnabled.bind(gateway),
    requireMcpServer: gateway.requireMcpServer.bind(gateway),
    resolveApproval: gateway.resolveApproval.bind(gateway),
    resolveApprovalWithRemoteToken: gateway.resolveApprovalWithRemoteToken.bind(gateway),
    resolveApprovalWithRemoteTokenId: gateway.resolveApprovalWithRemoteTokenId.bind(gateway),
    resolveConnectedMcpTools: gateway.resolveConnectedMcpTools.bind(gateway),
    resolveConnectionSecret: gateway.resolveConnectionSecret.bind(gateway),
    resolveGatewayInstallToken: gateway.resolveGatewayInstallToken.bind(gateway),
    resolveSkillActivation: gateway.resolveSkillActivation.bind(gateway),
    respondToExistingChatMessage: gateway.respondToExistingChatMessage.bind(gateway),
    runChatDelegation: gateway.runChatDelegation.bind(gateway),
    runChatDelegationStream: gateway.runChatDelegationStream.bind(gateway),
    runChatResearch: gateway.runChatResearch.bind(gateway),
    runDatabaseCutover: gateway.runDatabaseCutover.bind(gateway),
    runOrchestrationPlan: gateway.runOrchestrationPlan.bind(gateway),
    setChatSessionBinding: gateway.setChatSessionBinding.bind(gateway),
    setSkillState: gateway.setSkillState.bind(gateway),
    suggestChatDelegation: gateway.suggestChatDelegation.bind(gateway),
    syncDiscordRuntime: gateway.syncDiscordRuntime.bind(gateway),
    updateChatSessionPrefs: gateway.updateChatSessionPrefs.bind(gateway),
    updateFeatureFlags: gateway.updateFeatureFlags.bind(gateway),
    updateSkillActivationPolicy: gateway.updateSkillActivationPolicy.bind(gateway),
    validateSkillImport: gateway.validateSkillImport.bind(gateway),
    verifyBackup: gateway.verifyBackup.bind(gateway),
    verifyDatabaseCutover: gateway.verifyDatabaseCutover.bind(gateway),
    writeDiscordPairings: gateway.writeDiscordPairings.bind(gateway),
    writeMcpAuthState: gateway.writeMcpAuthState.bind(gateway),
    writeMcpServers: gateway.writeMcpServers.bind(gateway),
    writeMcpTools: gateway.writeMcpTools.bind(gateway),
  };
}

export type RouteDependencyDomain<TKey extends keyof GatewayRouteServiceDependencies> = Pick<
  GatewayRouteServiceDependencies,
  TKey
>;
