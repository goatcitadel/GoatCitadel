/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  IntegrationCatalogEntry,
  IntegrationKind,
  McpInvokeRequest,
  McpServerCreateInput,
  McpServerPolicy,
  McpServerUpdateInput,
} from "@goatcitadel/contracts";
import { NotFoundError } from "@goatcitadel/contracts";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
import { deleteProviderApiKeyWithFallback, persistProviderApiKeyWithFallback } from "./provider-secret-persistence.js";
import { createAddonsRoutePort } from "./addons-route-service.js";
import { createAgentsRoutePort } from "./agents-route-service.js";
import { createChannelSetupRoutePort } from "./channel-setup-route-service.js";
import { createCommsRoutePort } from "./comms-route-service.js";
import { createCostsRoutePort } from "./costs-route-service.js";
import { createCronRoutePort } from "./cron-route-service.js";
import { createDashboardRoutePort } from "./dashboard-route-service.js";
import { createFilesRoutePort } from "./files-route-service.js";
import { createHooksRoutePort } from "./hooks-route-service.js";
import { createIntegrationRoutePort } from "./integration-route-service.js";
import { createIntegrationWebhookRoutePort } from "./integration-webhook-route-service.js";
import { createLlamaCppRoutePort } from "./llama-cpp-route-service.js";
import { createMeshRoutePort } from "./mesh-route-service.js";
import { createNpuRoutePort } from "./npu-route-service.js";
import { createObsidianRoutePort } from "./obsidian-route-service.js";
import { createSessionsListRoutePort } from "./sessions-list-route-service.js";
import { createWorkspacesRoutePort } from "./workspaces-route-service.js";
import {
  createGatewayRouteServices,
  type GatewayRouteServiceDependencies,
  type GatewayRouteServices,
} from "./gateway-route-services.js";
import {
  INTEGRATION_CATALOG,
  getIntegrationFormSchema,
  resolveIntegrationCatalogMaturity,
  resolveIntegrationCatalogRuntimeAvailability,
} from "./integration-catalog.js";
import { invokeIntegrationConnectionAction as invokeIntegrationConnectionActionImpl } from "./integration-action-service.js";
import {
  IntegrationChannelService,
  type IntegrationChannelPort as IntegrationChannelServicePort,
} from "./integration-channel-service.js";
import { IntegrationDiagnosticsService } from "./integration-diagnostics-service.js";
import { KnowledgeFacadeService } from "./memory-facade-service.js";
import { SkillEvaluationService } from "./skill-evaluation-service.js";
import { WorkflowRecipeService } from "./workflow-recipe-service.js";
import * as channelSetupService from "./channel-setup-service.js";
import * as chatAttachmentService from "./chat-attachment-service.js";
import * as chatCommandService from "./chat-command-service.js";
import * as chatGeneratedArtifactService from "./chat-generated-artifact-service.js";
import * as chatMessageRouteRuntime from "./chat-message-route-runtime.js";
import * as chatSessionService from "./chat-session-service.js";
import * as chatThreadKnowledgeService from "./chat-thread-knowledge-service.js";
import * as chatToolArtifactService from "./chat-tool-artifact-service.js";
import * as chatWorkbenchService from "./chat-workbench-service.js";
import * as connectorDiagnosticsHelpers from "./connector-diagnostics-helpers.js";
import { buildGatewayConnectorRecords, filterConnectorRecords } from "./connector-registry.js";
import * as mcpDiagnosticsService from "./mcp-diagnostics-service.js";
import * as mcpServerAdminService from "./mcp-server-admin-service.js";
import * as onboardingStateService from "./onboarding-state-service.js";
import * as settingsAuthService from "./settings-auth-service.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { CommsHost } from "./comms-service.js";
import {
  commsCalendarCreate as commsCalendarCreateImpl,
  commsCalendarList as commsCalendarListImpl,
  commsGmailRead as commsGmailReadImpl,
  commsGmailSend as commsGmailSendImpl,
  commsReact as commsReactImpl,
  commsReply as commsReplyImpl,
  commsSend as commsSendImpl,
  commsTyping as commsTypingImpl,
  commsUnsend as commsUnsendImpl,
} from "./comms-service.js";

export type GatewayRouteCompositionSource = any;

const DEFAULT_WORKSPACE_ID = "default";

export function composeGatewayRouteServices(gateway: GatewayRouteCompositionSource): GatewayRouteServices {
  const agents = createAgentsRoutePort({
    storage: gateway.storage,
    normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    getSession: (sessionId) => gateway.getSession(sessionId),
    getChatSessionPrefs: (sessionId) => gateway.getChatSessionPrefs(sessionId),
    createChatSessionSpecialistCandidate: (sessionId, input) =>
      gateway.createChatSessionSpecialistCandidate(sessionId, input),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload ?? {}),
  });
  const workspaces = createWorkspacesRoutePort({
    storage: gateway.storage,
    normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload ?? {}),
    listGlobalGuidance: () => gateway.listGlobalGuidance(),
    listWorkspaceGuidance: (workspaceId) => gateway.listWorkspaceGuidance(workspaceId),
    updateGlobalGuidance: (docType, content) => gateway.updateGlobalGuidance(docType, content),
    updateWorkspaceGuidance: (workspaceId, docType, content) =>
      gateway.updateWorkspaceGuidance(workspaceId, docType, content),
  });
  const integrationDiagnostics = createIntegrationDiagnosticsServiceForGateway(gateway);
  const integrationChannel = createIntegrationChannelServiceForGateway(gateway, integrationDiagnostics);
  const channelSetupDeps: channelSetupService.ChannelSetupHost = {
    storage: gateway.storage,
    recentChannelSetupTests: gateway.recentChannelSetupTests,
    buildIntegrationConnectionChecks: (connection) =>
      integrationDiagnostics.buildIntegrationConnectionChecks(connection),
    createIntegrationConnection: (input) => integrationChannel.createIntegrationConnection(input),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    recordDevDiagnostic: (input) => gateway.recordDevDiagnostic(input),
    runIntegrationConnectionLiveChecks: (connection, options) =>
      integrationDiagnostics.runIntegrationConnectionLiveChecks(connection, options),
    updateIntegrationConnection: (connectionId, patch) =>
      integrationChannel.updateIntegrationConnection(connectionId, patch),
  };
  const channelSetup = createChannelSetupRoutePort({
    createChannelSetupDraft: (input) => channelSetupService.createChannelSetupDraft(channelSetupDeps, input),
    createChannelSetupRepairDraft: (connectionId) =>
      channelSetupService.createChannelSetupRepairDraft(channelSetupDeps, connectionId),
    createChannelSetupRotateSecretDraft: (connectionId) =>
      channelSetupService.createChannelSetupRotateSecretDraft(channelSetupDeps, connectionId),
    finalizeChannelSetupDraft: (draftId) => channelSetupService.finalizeChannelSetupDraft(channelSetupDeps, draftId),
    getChannelSetupDefinition: (catalogId) =>
      channelSetupService.getChannelSetupDefinition(channelSetupDeps, catalogId),
    listChannelSetupDefinitions: () => channelSetupService.listChannelSetupDefinitions(channelSetupDeps),
    listChannelSetupDrafts: (options) => channelSetupService.listChannelSetupDrafts(channelSetupDeps, options),
    retestChannelConnection: (connectionId) =>
      channelSetupService.retestChannelConnection(channelSetupDeps, connectionId),
    testChannelSetupDraft: (draftId) => channelSetupService.testChannelSetupDraft(channelSetupDeps, draftId),
    updateChannelSetupDraft: (draftId, input) =>
      channelSetupService.updateChannelSetupDraft(channelSetupDeps, draftId, input),
    validateChannelSetupDraft: (draftId) => channelSetupService.validateChannelSetupDraft(channelSetupDeps, draftId),
  });
  const commsDeps = createCommsHostForGateway(gateway, integrationChannel);
  const comms = createCommsRoutePort({
    commsCalendarCreate: (input) => commsCalendarCreateImpl(commsDeps, input),
    commsCalendarList: (input) => commsCalendarListImpl(commsDeps, input),
    commsGmailRead: (input) => commsGmailReadImpl(commsDeps, input),
    commsGmailSend: (input) => commsGmailSendImpl(commsDeps, input),
    commsReact: (input) => commsReactImpl(commsDeps, input),
    commsReply: (input) => commsReplyImpl(commsDeps, input),
    commsSend: (input) => commsSendImpl(commsDeps, input),
    commsTyping: (input) => commsTypingImpl(commsDeps, input),
    commsUnsend: (input) => commsUnsendImpl(commsDeps, input),
    getIntegrationConnectionChannelCapabilities: (connectionId) =>
      integrationChannel.getIntegrationConnectionChannelCapabilities(connectionId),
    getIntegrationConnectionChannelRuntimeStatus: (connectionId) =>
      integrationChannel.getIntegrationConnectionChannelRuntimeStatus(connectionId),
    runIntegrationConnectionDiagnostics: (connectionId) =>
      integrationChannel.runIntegrationConnectionDiagnostics(connectionId),
  });
  const listIntegrationCatalog = (kind?: IntegrationKind): IntegrationCatalogEntry[] => {
    const pluginIds = new Set(
      integrationChannel
        .listIntegrationPlugins()
        .map((item) => item.pluginId.trim().toLowerCase())
        .filter((item) => item.length > 0),
    );
    const mapped = INTEGRATION_CATALOG.map((entry) => ({
      ...entry,
      maturity: resolveIntegrationCatalogMaturity(entry, pluginIds),
      runtimeAvailability: resolveIntegrationCatalogRuntimeAvailability(entry, pluginIds),
    }));
    return kind ? mapped.filter((entry) => entry.kind === kind) : mapped;
  };
  const integrations = createIntegrationRoutePort({
    approveDiscordPairing: (connectionId, pairingId) =>
      integrationChannel.approveDiscordPairing(connectionId, pairingId),
    createIntegrationConnection: (input) => integrationChannel.createIntegrationConnection(input),
    deleteIntegrationConnection: (connectionId) => integrationChannel.deleteIntegrationConnection(connectionId),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    getIntegrationFormSchema: (catalogId) => {
      const schema = getIntegrationFormSchema(catalogId);
      if (!schema) {
        throw new Error(`Unknown integration catalog id: ${catalogId}`);
      }
      return schema;
    },
    installIntegrationPlugin: (input) => integrationChannel.installIntegrationPlugin(input),
    invokeIntegrationConnectionAction: (connectionId, actionId, input = {}) =>
      invokeIntegrationConnectionActionImpl(
        {
          storage: gateway.storage,
          fetchWithDiagnosticsTimeout: (url, init) => gateway.fetchWithDiagnosticsTimeout(url, init),
          readConnectionConfigValue: (config, key) => gateway.readConnectionConfigValue(config, key),
          resolveConnectionSecret: (config, directKey, envKey) =>
            gateway.resolveConnectionSecret(config, directKey, envKey),
          publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
        },
        connectionId,
        actionId,
        input,
      ),
    listDiscordPairings: (connectionId) => integrationChannel.listDiscordPairings(connectionId),
    listIntegrationCatalog,
    listIntegrationConnections: (kind, limit) => integrationChannel.listIntegrationConnections(kind, limit),
    listIntegrationPlugins: () => integrationChannel.listIntegrationPlugins(),
    reconnectDiscordRuntime: (connectionId) => integrationChannel.reconnectDiscordRuntime(connectionId),
    revokeDiscordPairing: (connectionId, pairingId) => integrationChannel.revokeDiscordPairing(connectionId, pairingId),
    runIntegrationConnectionDiagnostics: (connectionId) =>
      integrationChannel.runIntegrationConnectionDiagnostics(connectionId),
    setIntegrationPluginEnabled: (pluginId, enabled) =>
      integrationChannel.setIntegrationPluginEnabled(pluginId, enabled),
    updateIntegrationConnection: (connectionId, input) =>
      integrationChannel.updateIntegrationConnection(connectionId, input),
  });
  const integrationWebhooks = createIntegrationWebhookRoutePort({
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    cancelLatestActiveChatTurnForSession: (sessionId, cancelledBy) =>
      gateway.cancelLatestActiveChatTurnForSession(sessionId, cancelledBy),
    ingestChannelMessage: (channel, idempotencyKey, input) =>
      gateway.ingestChannelMessage(channel, idempotencyKey, input),
    recordDevDiagnostic: (input) => gateway.recordDevDiagnostic(input),
    respondToExistingChatMessage: (sessionId, messageId, input) =>
      gateway.respondToExistingChatMessage(sessionId, messageId, input),
    resolveApprovalWithRemoteToken: (input) => gateway.resolveApprovalWithRemoteToken(input),
    resolveApprovalWithRemoteTokenId: (input) => gateway.resolveApprovalWithRemoteTokenId(input),
    setChatSessionBinding: (input) => gateway.setChatSessionBinding(input),
    updateIntegrationConnection: (connectionId, patch) =>
      integrationChannel.updateIntegrationConnection(connectionId, patch),
  });
  const knowledgeFacade = new KnowledgeFacadeService({
    invokeAndUnwrap: (request, realtimeType) => gateway.invokeAndUnwrap(request, realtimeType),
  });
  const mcpAdminDeps: mcpServerAdminService.McpServerAdminHost = {
    storage: {
      approvalInbox: gateway.storage.approvalInbox,
    },
    readMcpServers: () => gateway.readMcpServers(),
    writeMcpServers: (servers) => gateway.writeMcpServers(servers),
    patchMcpServerState: (serverId, patch) => gateway.patchMcpServerState(serverId, patch),
    readMcpTools: () => gateway.readMcpTools(),
    writeMcpTools: (tools) => gateway.writeMcpTools(tools),
    resolveConnectedMcpTools: (server, existing) => gateway.resolveConnectedMcpTools(server, existing),
    requireMcpServer: (serverId) => gateway.requireMcpServer(serverId),
    readMcpAuthState: () => gateway.readMcpAuthState(),
    writeMcpAuthState: (state) => gateway.writeMcpAuthState(state),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
  };
  const mcpDiagnosticsDeps: mcpDiagnosticsService.McpDiagnosticsHost = {
    requireFeatureEnabled: (flag) => gateway.requireFeatureEnabled(flag as keyof RuntimeSettings["features"]),
    listMcpTemplates: () => gateway.listMcpTemplates(),
    requireMcpServer: (serverId) => gateway.requireMcpServer(serverId),
    pickConnectorDiagnosticAction: (checks) => connectorDiagnosticsHelpers.pickConnectorDiagnosticAction(checks),
    recordConnectorHealthRun: (report) =>
      connectorDiagnosticsHelpers.recordConnectorHealthRun({ gatewaySql: gateway.storage.gatewaySql }, report),
  };
  const mcp = {
    completeMcpOAuth: (serverId: string, code: string, state?: string) =>
      mcpServerAdminService.completeMcpOAuth(mcpAdminDeps, serverId, code, state),
    connectMcpServer: (serverId: string) => mcpServerAdminService.connectMcpServer(mcpAdminDeps, serverId),
    createMcpServer: (input: McpServerCreateInput) => mcpServerAdminService.createMcpServer(mcpAdminDeps, input),
    deleteMcpServer: (serverId: string) => mcpServerAdminService.deleteMcpServer(mcpAdminDeps, serverId),
    disconnectMcpServer: (serverId: string) => mcpServerAdminService.disconnectMcpServer(mcpAdminDeps, serverId),
    invokeMcpTool: (input: McpInvokeRequest) => gateway.toolInvocationCoordinator.invokeMcpTool(input),
    listMcpServers: () => gateway.listMcpServers(),
    listMcpTemplateDiscovery: () => mcpDiagnosticsService.listMcpTemplateDiscovery(mcpDiagnosticsDeps),
    listMcpTemplates: () => gateway.listMcpTemplates(),
    listMcpTools: (serverId: string) => gateway.listMcpTools(serverId),
    runMcpServerHealthCheck: (serverId: string) =>
      mcpDiagnosticsService.runMcpServerHealthCheck(mcpDiagnosticsDeps, serverId),
    startMcpOAuth: (serverId: string) => mcpServerAdminService.startMcpOAuth(mcpAdminDeps, serverId),
    updateMcpServer: (serverId: string, input: McpServerUpdateInput) =>
      mcpServerAdminService.updateMcpServer(mcpAdminDeps, serverId, input),
    updateMcpServerPolicy: (serverId: string, policy: Partial<McpServerPolicy>) =>
      mcpServerAdminService.updateMcpServerPolicy(mcpAdminDeps, serverId, policy),
  };
  const obsidian = createObsidianRoutePort({
    appendObsidianNote: (relativePath, markdownBlock) =>
      gateway.obsidianVaultService.appendToNote(relativePath, markdownBlock),
    captureObsidianInboxEntry: (input) => gateway.obsidianVaultService.captureInboxEntry(input),
    getObsidianIntegrationStatus: () => gateway.obsidianVaultService.getStatus(),
    readObsidianNote: (relativePath) => gateway.obsidianVaultService.readNote(relativePath),
    searchObsidianNotes: (query, limit) => gateway.obsidianVaultService.searchNotes(query, limit),
    testObsidianIntegration: async () => {
      const status = await gateway.obsidianVaultService.testConnection();
      gateway.publishRealtime("system", "integrations", {
        type: "obsidian_test_completed",
        enabled: status.enabled,
        vaultReachable: status.vaultReachable,
        lastError: status.lastError,
        checkedAt: status.checkedAt,
      });
      return status;
    },
    updateObsidianIntegrationConfig: (input) => {
      const updated = gateway.obsidianVaultService.updateConfig(input);
      gateway.publishRealtime("system", "integrations", {
        type: "obsidian_config_updated",
        enabled: updated.enabled,
        mode: updated.mode,
        vaultPath: updated.vaultPath,
        allowedSubpaths: updated.allowedSubpaths,
      });
      return updated;
    },
  });
  const chatAttachmentHost: chatAttachmentService.ChatAttachmentHost = {
    config: gateway.config,
    storage: gateway.storage,
    getSession: (sessionId) => gateway.getSession(sessionId),
    normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    createMediaJob: (input) => gateway.mediaVoiceService.createMediaJob(input),
  };
  const ChatSessionDependencies: chatSessionService.ChatSessionDependencies = {
    storage: gateway.storage,
    operatorSummaryCache: gateway.operatorSummaryCache,
    normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    ensureChatSessionRuntimeGrants: (sessionId) => gateway.ensureChatSessionRuntimeGrants(sessionId),
    requireChatSession: (sessionId) => gateway.requireChatSession(sessionId),
    getSession: (sessionId) => gateway.getSession(sessionId),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    clearChatTurnWriteLease: (sessionId) => gateway.clearChatTurnWriteLease(sessionId),
    removeChatSessionStoredFile: async (storageRelPath) => {
      const normalized = storageRelPath.trim();
      if (!normalized) {
        return;
      }
      const fullPath = path.resolve(gateway.config.rootDir, gateway.config.assistant.workspaceDir, normalized);
      assertWritePathInJail(fullPath, gateway.config.toolPolicy.sandbox.writeJailRoots);
      await fs.rm(fullPath, { force: true });
    },
    ensureChatSessionModelDefaults: (sessionId, prefs) => gateway.ensureChatSessionModelDefaults(sessionId, prefs),
    hydrateChatPrefsWithAutonomy: (sessionId, prefs) => gateway.hydrateChatPrefsWithAutonomy(sessionId, prefs),
    patchSessionAutonomyPrefs: (sessionId, patch) => gateway.patchSessionAutonomyPrefs(sessionId, patch),
  };
  const ChatGeneratedArtifactDependencies: chatGeneratedArtifactService.ChatGeneratedArtifactDependencies = {
    storage: gateway.storage,
    requireChatSession: (sessionId) => gateway.requireChatSession(sessionId),
  };
  const ChatWorkbenchDependencies: chatWorkbenchService.ChatWorkbenchDependencies = {
    config: gateway.config,
    storage: gateway.storage,
    requireChatSession: (sessionId) => gateway.requireChatSession(sessionId),
    publishRealtime: (channel, topic, payload, options) => gateway.publishRealtime(channel, topic, payload, options),
  };
  const ChatThreadKnowledgeDependencies = createChatThreadKnowledgeDependenciesForGateway(gateway);
  const chatAttachments: GatewayRouteServiceDependencies["chatAttachments"] = {
    getChatAttachment: (attachmentId) => chatAttachmentService.getChatAttachment(chatAttachmentHost, attachmentId),
    readChatAttachmentContent: (attachmentId) =>
      chatAttachmentService.readChatAttachmentContent(chatAttachmentHost, attachmentId),
    uploadChatAttachment: (input) => chatAttachmentService.uploadChatAttachment(chatAttachmentHost, input),
  };
  const chatSessions: GatewayRouteServiceDependencies["chatSessions"] = {
    archiveChatSession: (sessionId) => chatSessionService.archiveChatSession(ChatSessionDependencies, sessionId),
    archiveChatSessionsBulk: (input) => chatSessionService.archiveChatSessionsBulk(ChatSessionDependencies, input),
    assignChatSessionProject: (sessionId, projectId) =>
      chatSessionService.assignChatSessionProject(ChatSessionDependencies, sessionId, projectId),
    attachChatThreadKnowledgeAttachment: (sessionId, input) =>
      chatThreadKnowledgeService.attachChatThreadKnowledgeAttachment(ChatThreadKnowledgeDependencies, sessionId, input),
    createChatGeneratedArtifactFromTurn: (input) =>
      chatGeneratedArtifactService.createChatGeneratedArtifactFromTurn(ChatGeneratedArtifactDependencies, input),
    createChatSession: (input) => chatSessionService.createChatSession(ChatSessionDependencies, input),
    createChatSessionWorkbenchWorktree: (sessionId, input) =>
      chatWorkbenchService.createChatSessionWorkbenchWorktree(ChatWorkbenchDependencies, sessionId, input),
    deleteChatSession: (sessionId) => chatSessionService.deleteChatSession(ChatSessionDependencies, sessionId),
    getChatGeneratedArtifact: (artifactId, options) =>
      chatGeneratedArtifactService.getChatGeneratedArtifact(ChatGeneratedArtifactDependencies, artifactId, options),
    getChatSessionBinding: (sessionId) => chatSessionService.getChatSessionBinding(ChatSessionDependencies, sessionId),
    getChatSessionWorkbench: (sessionId) =>
      chatWorkbenchService.getChatSessionWorkbench(ChatWorkbenchDependencies, sessionId),
    getChatSessionWorkbenchDiff: (sessionId) =>
      chatWorkbenchService.getChatSessionWorkbenchDiff(ChatWorkbenchDependencies, sessionId),
    getChatSessionWorkbenchFile: (sessionId, relativePath) =>
      chatWorkbenchService.getChatSessionWorkbenchFile(ChatWorkbenchDependencies, sessionId, relativePath),
    getChatSessionWorkbenchFileDiff: (sessionId, relativePath) =>
      chatWorkbenchService.getChatSessionWorkbenchFileDiff(ChatWorkbenchDependencies, sessionId, relativePath),
    getChatSessionWorkbenchOutput: (sessionId) =>
      chatWorkbenchService.getChatSessionWorkbenchOutput(ChatWorkbenchDependencies, sessionId),
    getChatSessionWorkbenchTree: (sessionId) =>
      chatWorkbenchService.getChatSessionWorkbenchTree(ChatWorkbenchDependencies, sessionId),
    listChatGeneratedArtifacts: (input) =>
      chatGeneratedArtifactService.listChatGeneratedArtifacts(ChatGeneratedArtifactDependencies, input),
    listChatSessions: (query) => chatSessionService.listChatSessions(ChatSessionDependencies, query),
    listChatThreadKnowledgeAttachments: (sessionId) =>
      chatThreadKnowledgeService.listChatThreadKnowledgeAttachments(ChatThreadKnowledgeDependencies, sessionId),
    pinChatSession: (sessionId) => chatSessionService.pinChatSession(ChatSessionDependencies, sessionId),
    removeChatThreadKnowledgeAttachment: (sessionId, attachmentId) =>
      chatThreadKnowledgeService.removeChatThreadKnowledgeAttachment(
        ChatThreadKnowledgeDependencies,
        sessionId,
        attachmentId,
      ),
    restoreChatSession: (sessionId) => chatSessionService.restoreChatSession(ChatSessionDependencies, sessionId),
    saveChatSessionWorkbenchFile: (sessionId, input) =>
      chatWorkbenchService.saveChatSessionWorkbenchFile(ChatWorkbenchDependencies, sessionId, input),
    setChatSessionBinding: (input) => chatSessionService.setChatSessionBinding(ChatSessionDependencies, input),
    unpinChatSession: (sessionId) => chatSessionService.unpinChatSession(ChatSessionDependencies, sessionId),
    updateChatSession: (sessionId, input) =>
      chatSessionService.updateChatSession(ChatSessionDependencies, sessionId, input),
  };
  const chatDelegate: GatewayRouteServiceDependencies["chatDelegate"] = {
    acceptChatDelegation: (sessionId, input) => gateway.acceptChatDelegation(sessionId, input),
    getChatDelegationRun: (sessionId, runId) => {
      const run = gateway.storage.chatDelegationRuns.get(runId);
      if (run.sessionId !== sessionId) {
        throw new NotFoundError(`Delegation run ${runId} not found for session ${sessionId}`);
      }
      return {
        run,
        steps: gateway.storage.chatDelegationSteps.listByRun(runId),
      };
    },
    runChatDelegation: (sessionId, input) => gateway.runChatDelegation(sessionId, input),
    runChatDelegationStream: (sessionId, input) => gateway.runChatDelegationStream(sessionId, input),
    suggestChatDelegation: (sessionId, input) => gateway.suggestChatDelegation(sessionId, input),
  };
  const chatTools: GatewayRouteServiceDependencies["chatTools"] = {
    getChatToolArtifactContent: (artifactId, options) =>
      chatToolArtifactService.getChatToolArtifactContent(gateway, artifactId, options),
    listChatPendingApprovals: (sessionId) => gateway.capabilitySystemService.listChatPendingApprovals(sessionId),
    resolveChatToolApproval: (sessionId, approvalId, decision, options) =>
      gateway.approvalRuntime.resolveChatToolApproval(sessionId, approvalId, decision, options),
  };
  const chatMessages: GatewayRouteServiceDependencies["chatMessages"] = {
    agentSendChatMessage: (sessionId, input) => gateway.chatTurnRuntime.agentSendChatMessage(sessionId, input),
    agentSendChatMessageStream: (sessionId, input) =>
      gateway.chatTurnRuntime.agentSendChatMessageStream(sessionId, input),
    answerChatUserInputPrompt: (sessionId, turnId, promptId, input) =>
      chatMessageRouteRuntime.answerChatUserInputPrompt(gateway, sessionId, turnId, promptId, input),
    cancelChatTurn: (sessionId, turnId, cancelledBy) =>
      gateway.chatTurnRuntime.cancelChatTurn(sessionId, turnId, cancelledBy),
    editChatTurn: (sessionId, turnId, input) => gateway.chatTurnRuntime.editChatTurn(sessionId, turnId, input),
    editChatTurnStream: (sessionId, turnId, input) =>
      gateway.chatTurnRuntime.editChatTurnStream(sessionId, turnId, input),
    getChatThread: (sessionId) => chatMessageRouteRuntime.getChatThread(gateway, sessionId),
    getTurnContextManifestForSession: (sessionId, turnId) =>
      chatMessageRouteRuntime.getTurnContextManifestForSession(gateway, sessionId, turnId),
    listChatMessages: (sessionId, limit, cursor) => gateway.listChatMessages(sessionId, limit, cursor),
    resumeAgentChatTurnStream: (sessionId, turnId, sinceEventId) =>
      gateway.chatTurnRuntime.resumeAgentChatTurnStream(sessionId, turnId, sinceEventId),
    retryChatTurn: (sessionId, turnId, input) => gateway.chatTurnRuntime.retryChatTurn(sessionId, turnId, input),
    retryChatTurnStream: (sessionId, turnId, input) =>
      gateway.chatTurnRuntime.retryChatTurnStream(sessionId, turnId, input),
    routePreflight: (sessionId, input) => gateway.chatTurnRuntime.routePreflight(sessionId, input),
    selectChatBranchTurn: (sessionId, turnId) =>
      chatMessageRouteRuntime.selectChatBranchTurn(gateway, sessionId, turnId),
  };
  const settingsRuntimeDeps = createSettingsRuntimeDependenciesForGateway(gateway);
  const settingsAuthDeps = createSettingsAuthRuntimeDependenciesForGateway(gateway);
  const settings: GatewayRouteServiceDependencies["settings"] = {
    createPersonality: (input) => gateway.personalityCatalogService.createPersonality(input),
    deletePersonality: (id) => gateway.personalityCatalogService.deletePersonality(id),
    getAuthRuntimeSettings: () => settingsAuthService.getAuthRuntimeSettings(settingsRuntimeDeps),
    getPersonalityCatalog: () => gateway.personalityCatalogService.getCatalog(),
    getSettings: () => settingsAuthService.getSettings(settingsRuntimeDeps),
    setDefaultPersonality: (id) => gateway.personalityCatalogService.setDefaultPersonality(id),
    updatePersonality: (id, input) => gateway.personalityCatalogService.updatePersonality(id, input),
    updateSettings: (input) => settingsAuthService.updateSettings(settingsRuntimeDeps, input),
  };
  const skillEvaluation = new SkillEvaluationService({
    storage: gateway.storage,
    listSkills: () => gateway.listSkills(),
    createCapabilityProposal: (input) => gateway.capabilitySystemService.createProposal(input),
    recordSkillEvaluationSignal: (input) => gateway.improvementService.recordSkillEvaluationSignal(input),
  });
  const workflowRecipes = new WorkflowRecipeService({
    listSkills: () => gateway.listSkills(),
    listToolNames: () => {
      const catalog = gateway.policyEngine?.listCatalog?.() ?? [];
      return catalog.map((entry: { name?: string; toolName?: string; id?: string }) =>
        String(entry.name ?? entry.toolName ?? entry.id ?? ""),
      );
    },
    createOrchestrationPlan: (plan) => gateway.createOrchestrationPlan(plan),
  });

  return createGatewayRouteServices({
    chatMessages,
    settings,
    chatAttachments,
    chatDelegate,
    chatSessions,
    chatTools,
    addons: createAddonsRoutePort({
      addonsService: gateway.addonsService,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload ?? {}),
      recordDevDiagnostic: (input) => gateway.recordDevDiagnostic(input),
    }),
    agents,
    assembly: {
      createAssemblyRun: (input) => gateway.assemblyService.createRun(input),
      getAssemblyRunDetail: (runId) => gateway.assemblyService.getRunDetail(runId),
      listAssemblyReputations: (limit) => gateway.assemblyService.listReputations(limit),
      listAssemblyRuns: (limit) => gateway.assemblyService.listRuns(limit),
    },
    authAdmin: {
      getAuthCredentialPlan: () => settingsAuthService.getAuthRuntimeSettings(settingsRuntimeDeps).plan,
      createDeviceAccessRequest: (input, metadata) =>
        settingsAuthService.createDeviceAccessRequest(settingsAuthDeps, input, metadata),
      exchangeCompanionSessionFromDeviceGrant: (grantId, input) =>
        settingsAuthService.exchangeCompanionSessionFromDeviceGrant(settingsAuthDeps, grantId, input),
      getCompanionSessionInfo: (sessionId) => settingsAuthService.getCompanionSessionInfo(settingsAuthDeps, sessionId),
      getCompanionSessionRecord: (sessionId) =>
        settingsAuthService.getCompanionSessionRecord(settingsAuthDeps, sessionId),
      getDeviceAccessRequestStatus: (requestId, secret) =>
        settingsAuthService.getDeviceAccessRequestStatus(settingsAuthDeps, requestId, secret),
      getRetentionPolicy: () => gateway.getRetentionPolicy(),
      listBackups: (limit) => gateway.listBackups(limit),
      listCompanionAuditEvents: (input) => settingsAuthService.listCompanionAuditEvents(settingsAuthDeps, input),
      listCompanionSessions: (input) => settingsAuthService.listCompanionSessions(settingsAuthDeps, input),
      listDeviceAccessGrants: () => settingsAuthService.listDeviceAccessGrants(settingsAuthDeps),
      pruneRetention: (input) => gateway.pruneRetention(input),
      resolveGatewayInstallToken: (input) => gateway.resolveGatewayInstallToken(input),
      revokeCompanionSession: (sessionId, actorId) =>
        settingsAuthService.revokeCompanionSession(settingsAuthDeps, sessionId, actorId),
      revokeDeviceAccessGrant: (grantId, actorId) =>
        settingsAuthService.revokeDeviceAccessGrant(settingsAuthDeps, grantId, actorId),
      rotateCompanionSession: (input) => settingsAuthService.rotateCompanionSession(settingsAuthDeps, input),
      runDatabaseCutover: (input) => gateway.runDatabaseCutover(input),
      updateRetentionPolicy: (patch) => gateway.updateRetentionPolicy(patch),
      createBackup: (input) => gateway.createBackup(input),
      verifyBackup: (input) => gateway.verifyBackup(input),
      verifyDatabaseCutover: (input) => gateway.verifyDatabaseCutover(input),
    },
    approvals: gateway.approvalRuntime,
    capabilities: gateway.capabilitySystemService,
    chatProjects: {
      archiveChatProject: (projectId) => gateway.chatProjectService.archiveChatProject(projectId),
      createChatProject: (input) => gateway.chatProjectService.createChatProject(input),
      hardDeleteChatProject: (projectId) => gateway.chatProjectService.hardDeleteChatProject(projectId),
      importChatProject: (input) => gateway.chatProjectService.importChatProject(input),
      listChatProjects: (view, limit, workspaceId) =>
        gateway.chatProjectService.listChatProjects(view, limit, workspaceId),
      restoreChatProject: (projectId) => gateway.chatProjectService.restoreChatProject(projectId),
      updateChatProject: (projectId, input) => gateway.chatProjectService.updateChatProject(projectId, input),
    },
    chatSupport: {
      commands: {
        listChatCommandCatalog: () => chatCommandService.listChatCommandCatalog(),
        parseChatCommand: (sessionId, commandText) => gateway.parseChatCommand(sessionId, commandText),
      },
      learnedMemory: {
        listChatSessionLearnedMemory: (sessionId, limit) =>
          gateway.memoryLifecycleService.listSessionLearnedMemory(sessionId, limit),
        rebuildChatSessionLearnedMemory: (sessionId) =>
          gateway.memoryLifecycleService.rebuildSessionLearnedMemory(sessionId),
        updateChatSessionLearnedMemory: (sessionId, itemId, input) =>
          gateway.memoryLifecycleService.updateSessionLearnedMemory(sessionId, itemId, input),
      },
      prefs: {
        getChatSessionPrefs: (sessionId) => gateway.getChatSessionPrefs(sessionId),
        updateChatSessionPrefs: (sessionId, input) => gateway.updateChatSessionPrefs(sessionId, input),
      },
      proactive: {
        getChatSessionProactiveStatus: (sessionId) =>
          gateway.chatProactiveService.getChatSessionProactiveStatus(sessionId),
        listChatSessionProactiveRuns: (sessionId, limit) =>
          gateway.chatProactiveService.listChatSessionProactiveRuns(sessionId, limit),
        triggerChatSessionProactive: (sessionId, input) =>
          gateway.chatProactiveService.triggerChatSessionProactive(sessionId, input),
        updateChatSessionProactivePolicy: (sessionId, input) =>
          gateway.chatProactiveService.updateChatSessionProactivePolicy(sessionId, input),
      },
      research: {
        getChatResearchRun: (sessionId, runId) => gateway.researchService.getRun(sessionId, runId),
        runChatResearch: (sessionId, input) => gateway.runChatResearch(sessionId, input),
      },
      specialists: {
        createChatSessionSpecialistCandidate: (sessionId, input) =>
          gateway.createChatSessionSpecialistCandidate(sessionId, input),
        listChatSessionSpecialistCandidates: (sessionId, limit = 200) => {
          gateway.getSession(sessionId);
          return {
            items: gateway.storage.chatSpecialistCandidates.listBySession(sessionId, limit),
          };
        },
        updateChatSessionSpecialistCandidate: (sessionId, candidateId, input) => {
          gateway.getSession(sessionId);
          const current = gateway.storage.chatSpecialistCandidates.get(candidateId);
          if (current.sessionId !== sessionId) {
            throw new Error("Specialist candidate does not belong to this session.");
          }
          return gateway.storage.chatSpecialistCandidates.patch(candidateId, input);
        },
      },
    },
    channelSetup,
    comms,
    connectors: {
      listConnectorRecords: (connectorType) =>
        filterConnectorRecords(
          buildGatewayConnectorRecords({
            integrationConnections: gateway.storage.integrationConnections.list(undefined, 1000),
            mcpServers: gateway.readMcpServers(),
            mcpTools: gateway.readMcpTools(),
          }),
          connectorType,
        ),
    },
    costs: createCostsRoutePort({
      storage: gateway.storage,
    }),
    dashboard: createDashboardRoutePort({
      backupRetentionService: gateway.backupRetentionService,
      isFeatureEnabled: (flag) => gateway.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
      memoryLifecycleService: gateway.memoryLifecycleService,
      operatorSummaryCache: gateway.operatorSummaryCache,
      realtimeEventService: gateway.realtimeEventService,
      storage: gateway.storage,
    }),
    daemon: {
      systemSettings: gateway.storage.systemSettings,
    },
    devDiagnostics: {
      isDevDiagnosticsEnabled: () => gateway.devDiagnostics.isEnabled(),
      listDevDiagnostics: (input) => gateway.devDiagnostics.list(input),
      subscribeDevDiagnostics: (listener) => gateway.devDiagnostics.subscribe(listener),
    },
    devVerification: {
      storage: gateway.storage,
      createApproval: (input) => gateway.createApproval(input),
      createChatCompletion: (input) => gateway.createChatCompletion(input),
      createChatCompletionStream: (input) => gateway.createChatCompletionStream(input),
      createChatSession: (input) => gateway.createChatSession(input),
      createWorkspace: (input) => workspaces.createWorkspace(input),
      getLlmConfig: () => gateway.getLlmConfig(),
      getProviderSecretStatus: (providerId) => gateway.getProviderSecretStatus(providerId),
      getRealtimeEventSequenceBounds: () => gateway.realtimeEventService.getRealtimeEventSequenceBounds(),
      isDevDiagnosticsEnabled: () => gateway.devDiagnostics.isEnabled(),
      listDevDiagnostics: (input) => gateway.devDiagnostics.list(input),
      publishRealtime: (eventType, source, payload, options) =>
        gateway.publishRealtime(eventType, source, payload, options),
    },
    durable: gateway.durableOperatorService,
    cron: createCronRoutePort(gateway.cronAutomationService),
    files: createFilesRoutePort({
      rootDir: gateway.config.rootDir,
      workspaceDir: gateway.config.assistant.workspaceDir,
      writeJailRoots: gateway.config.toolPolicy.sandbox.writeJailRoots,
      readOnlyRoots: gateway.config.toolPolicy.sandbox.readOnlyRoots,
      serializeRootPath: (fullPath) => gateway.serializeRootPath(fullPath),
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload ?? {}),
    }),
    gatewayEvents: {
      ingestEvent: (idempotencyKey, payload) => gateway.ingestEvent(idempotencyKey, payload),
    },
    health: {
      getDatabaseHealthSnapshot: () => gateway.databaseCutoverService.getHealthSnapshot(),
    },
    hooks: createHooksRoutePort({
      hooksService: gateway.hooksService,
      normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    }),
    improvement: {
      audit: {
        getSkillActivationPolicy: () => gateway.getSkillActivationPolicy(),
        listCapabilityCatalog: (scope) => gateway.capabilitySystemService.listCatalog(scope),
        listCapabilityProposals: (limit) => gateway.capabilitySystemService.listProposals(limit),
        listSkillImportHistory: (limit) => gateway.listSkillImportHistory(limit),
        listSkills: () => gateway.listSkills(),
      },
      improvement: gateway.improvementService,
    },
    integrations,
    integrationWebhooks,
    knowledge: knowledgeFacade,
    llamaCpp: createLlamaCppRoutePort({
      llamaCppRuntime: gateway.llamaCppRuntime,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    }),
    llm: {
      createChatCompletion: (request) => gateway.createChatCompletion(request),
      generateImage: (input) => gateway.llmService.generateImage(input),
      getOpenAICodexOAuthStatus: () => gateway.llmService.getOpenAICodexOAuthStatus(),
      getLlmConfigWithDetails: () => ({
        ...gateway.getLlmConfig(),
        providerConfigs: gateway.llmService.exportConfigFile().providers,
      }),
      listLlmModels: (providerId) => gateway.llmService.listModelsWithSource(providerId),
      listLlmProviders: () => gateway.llmService.listProviders(),
      pollOpenAICodexOAuthDeviceFlow: (flowId) => gateway.llmService.pollOpenAICodexOAuthDeviceFlow(flowId),
      previewLlmModels: (input) => gateway.llmService.previewModels(input),
      startOpenAICodexOAuthDeviceFlow: () => gateway.llmService.startOpenAICodexOAuthDeviceFlow(),
      deleteOpenAICodexOAuthCredential: () => gateway.llmService.deleteOpenAICodexOAuthCredential(),
      updateLlmConfig: (input) => {
        const updated = gateway.llmService.updateRuntimeConfig(input);
        gateway.persistLlmConfig();
        return updated;
      },
    },
    memory: gateway.memoryLifecycleService,
    mcp,
    media: gateway.mediaVoiceService,
    mesh: createMeshRoutePort({
      meshService: gateway.meshService,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    }),
    npu: createNpuRoutePort({
      npuSidecar: gateway.npuSidecar,
      publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    }),
    onboarding: {
      bootstrapOnboarding: (input) => onboardingStateService.bootstrapOnboarding(gateway, input),
      getOnboardingStartupState: () => onboardingStateService.getOnboardingStartupState(gateway),
      getOnboardingState: () => onboardingStateService.getOnboardingState(gateway),
      markOnboardingComplete: (completedBy) => onboardingStateService.markOnboardingComplete(gateway, completedBy),
    },
    obsidian,
    orchestration: {
      createOrchestrationPlan: (plan) => gateway.createOrchestrationPlan(plan),
      createPlanFromRecipe: (input) => workflowRecipes.createPlanFromRecipe(input),
      listRecipeTemplates: () => ({ items: workflowRecipes.listTemplates() }),
      previewRecipe: (input) => workflowRecipes.previewRecipe(input),
      runOrchestrationPlan: (planId) => gateway.runOrchestrationPlan(planId),
      approvePhase: (runId, phaseId, approvedBy, costIncrementUsd) =>
        gateway.approvePhase(runId, phaseId, approvedBy, costIncrementUsd),
      getRun: (runId) => gateway.getRun(runId),
      listRunCheckpoints: (runId) => gateway.listRunCheckpoints(runId),
      listRunContexts: (runId) => gateway.memoryLifecycleService.listRunContexts(runId),
    },
    promptPacks: gateway.promptPackService,
    realtimeEvents: gateway.realtimeEventService,
    runtimeLifecycle: {
      getRuntimeLifecycle: (input) => gateway.runtimeLifecycleReadService.getRuntimeLifecycle(input),
      getTranscript: (sessionId) => gateway.getTranscript(sessionId),
      listSessionTimeline: (sessionId, limit) => gateway.listSessionTimeline(sessionId, limit),
    },
    sessionsList: createSessionsListRoutePort({
      storage: gateway.storage,
      getSessionSummary: (sessionId) => gateway.getSessionSummary(sessionId),
      listSessionTimeline: (sessionId, limit) => gateway.listSessionTimeline(sessionId, limit),
    }),
    secrets: {
      deleteProviderSecret: (providerId) =>
        deleteProviderApiKeyWithFallback({
          providerId,
          rootDir: gateway.config.rootDir,
          llmService: gateway.llmService,
        }),
      getProviderSecretStatus: (providerId) => {
        const status = gateway.llmService.getProviderSecretStatus(providerId);
        return {
          providerId: status.providerId,
          hasSecret: status.hasApiKey,
          source: status.apiKeySource,
        };
      },
      saveProviderSecret: (providerId, apiKey) => {
        const status = persistProviderApiKeyWithFallback({
          providerId,
          apiKey,
          rootDir: gateway.config.rootDir,
          llmService: gateway.llmService,
        });
        gateway.llmService.clearInlineProviderApiKey(providerId);
        gateway.persistLlmConfig();
        return status;
      },
    },
    skills: {
      bulkSetSkillState: (skillIds, state, note) => gateway.bulkSetSkillState(skillIds, state, note),
      getBankrOptionalMigrationMessage: () => gateway.getBankrOptionalMigrationMessage(),
      getBankrSafetyPolicy: () => gateway.getBankrSafetyPolicy(),
      getSkillActivationPolicy: () => gateway.getSkillActivationPolicy(),
      installSkillImport: (input) => gateway.installSkillImport(input),
      isBankrBuiltinEnabled: () => gateway.isFeatureEnabled("bankrBuiltinEnabled"),
      listBankrActionAudit: (limit, cursor) => gateway.listBankrActionAudit(limit, cursor),
      listSkillEvaluationRuns: (skillId) => ({ items: skillEvaluation.listSkillEvaluationRuns(skillId) }),
      listSkillImportHistory: (limit) => gateway.listSkillImportHistory(limit),
      listSkillSources: (query, limit) => gateway.listSkillSources(query, limit),
      listSkills: () => gateway.listSkills(),
      lookupSkillSources: (queryOrUrl, limit) => gateway.lookupSkillSources(queryOrUrl, limit),
      previewSkillEvaluation: (skillId, input) => ({ run: skillEvaluation.previewSkillEvaluation(skillId, input) }),
      previewBankrAction: (input) => gateway.previewBankrAction(input),
      runSkillEvaluation: (skillId, input) => skillEvaluation.runSkillEvaluation(skillId, input),
      getSkillEvaluationRun: (runId) => skillEvaluation.getSkillEvaluationRun(runId),
      createSkillEvaluationProposal: (runId) => skillEvaluation.createSkillEvaluationProposal(runId),
      reloadSkills: () => gateway.reloadSkills(),
      resolveSkillActivation: (input) => gateway.resolveSkillActivation(input),
      setSkillState: (skillId, state, note) => gateway.setSkillState(skillId, state, note),
      updateBankrSafetyPolicy: (input) => gateway.updateBankrSafetyPolicy(input),
      updateSkillActivationPolicy: (input) => gateway.updateSkillActivationPolicy(input),
      validateSkillImport: (input) => gateway.validateSkillImport(input),
    },
    tasks: gateway.taskLifecycleService,
    tools: {
      createToolGrant: (input) => gateway.approvalRuntime.createToolGrant(input),
      evaluateToolAccess: (input) =>
        gateway.policyEngine.evaluateAccess({
          ...input,
          workspaceId:
            input.workspaceId ??
            gateway.storage.chatSessionMeta.get(input.sessionId)?.workspaceId ??
            DEFAULT_WORKSPACE_ID,
        }),
      listToolCatalog: () => gateway.policyEngine.listCatalog(),
      listToolGrants: (scope, scopeRef, limit) => gateway.approvalRuntime.listToolGrants(scope, scopeRef, limit),
      revokeToolGrant: (grantId) => gateway.approvalRuntime.revokeToolGrant(grantId),
    },
    toolsInvoke: {
      getDeploymentProfile: () => gateway.config.assistant.deploymentProfile,
      invokeTool: (input) => gateway.invokeTool(input),
      isFeatureEnabled: (flag) => gateway.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
    },
    voice: gateway.mediaVoiceService,
    workspaces,
  });
}

export function createSettingsRuntimeDependenciesForGateway(
  gateway: GatewayRouteCompositionSource,
): settingsAuthService.SettingsRuntimeDependencies {
  return {
    config: gateway.config,
    llmService: gateway.llmService,
    meshService: gateway.meshService,
    npuSidecar: gateway.npuSidecar,
    llamaCppRuntime: gateway.llamaCppRuntime,
    readFeatureFlags: () => gateway.readFeatureFlags(),
    updateFeatureFlags: (patch) => gateway.updateFeatureFlags(patch),
    assertDeploymentProfileUpdate: (input) => gateway.assertDeploymentProfileUpdate(input),
    assertFirecrawlRuntimeUpdate: (input) => gateway.assertFirecrawlRuntimeUpdate(input),
    persistLlmConfig: () => gateway.persistLlmConfig(),
    persistToolPolicyConfig: () => gateway.persistToolPolicyConfig(),
    persistBudgetsConfig: () => gateway.persistBudgetsConfig(),
    persistAssistantConfig: () => gateway.persistAssistantConfig(),
  };
}

export function createSettingsAuthRuntimeDependenciesForGateway(
  gateway: GatewayRouteCompositionSource,
): settingsAuthService.SettingsAuthRuntimeDependencies {
  return {
    config: gateway.config,
    gatewaySql: gateway.storage.gatewaySql,
    storage: gateway.storage,
    createApproval: (input) => gateway.createApproval(input),
    resolveApproval: (approvalId, input) => gateway.resolveApproval(approvalId, input),
    enqueueApprovalResolutionEffects: (approval, input) => gateway.enqueueApprovalResolutionEffects(approval, input),
    listApprovalEffects: (approvalId) => gateway.approvalEffectsService.listByApproval(approvalId),
    buildApprovalRealtimeLinks: (approval) => gateway.buildApprovalRealtimeLinks(approval),
    recordImprovementApprovalResolutionSignal: (approval) =>
      gateway.improvementService.recordApprovalResolutionSignal(approval),
    handleActivationApprovalResolution: (approval) =>
      gateway.improvementService.handleActivationApprovalResolution(approval),
    publishRealtime: (eventType, source, payload, options) =>
      gateway.publishRealtime(eventType, source, payload, options),
  };
}

export function createIntegrationDiagnosticsServiceForGateway(
  gateway: GatewayRouteCompositionSource,
): IntegrationDiagnosticsService {
  return new IntegrationDiagnosticsService({
    config: gateway.config,
    fetchWithDiagnosticsTimeout: (url, init) => gateway.fetchWithDiagnosticsTimeout(url, init),
    getDiscordRuntimeStatus: (connectionId) => gateway.discordRuntimeService.getConnectionStatus(connectionId),
    isConnectionUrlAllowlisted: (urlValue) => gateway.isConnectionUrlAllowlisted(urlValue),
    readConnectionConfigValue: (config, key) => gateway.readConnectionConfigValue(config, key),
    resolveConnectionSecret: (config, directKey, envKey) => gateway.resolveConnectionSecret(config, directKey, envKey),
  });
}

export function createIntegrationChannelServiceForGateway(
  gateway: GatewayRouteCompositionSource,
  integrationDiagnostics = createIntegrationDiagnosticsServiceForGateway(gateway),
): IntegrationChannelService {
  return new IntegrationChannelService(createIntegrationChannelPortForGateway(gateway, integrationDiagnostics));
}

function createIntegrationChannelPortForGateway(
  gateway: GatewayRouteCompositionSource,
  integrationDiagnostics: IntegrationDiagnosticsService,
): IntegrationChannelServicePort {
  return {
    storage: gateway.storage,
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
    requireFeatureEnabled: (flag) => gateway.requireFeatureEnabled(flag),
    buildIntegrationConnectionChecks: (connection) =>
      integrationDiagnostics.buildIntegrationConnectionChecks(connection),
    runIntegrationConnectionLiveChecks: (connection, options) =>
      integrationDiagnostics.runIntegrationConnectionLiveChecks(connection, options),
    pickConnectorDiagnosticAction: (checks) => connectorDiagnosticsHelpers.pickConnectorDiagnosticAction(checks),
    recordConnectorHealthRun: (report) =>
      connectorDiagnosticsHelpers.recordConnectorHealthRun({ gatewaySql: gateway.storage.gatewaySql }, report),
    syncDiscordRuntime: () => gateway.syncDiscordRuntime(),
    getDiscordRuntimeStatus: (connectionId) => gateway.discordRuntimeService.getConnectionStatus(connectionId),
    getIntegrationConnection: (connectionId) => gateway.storage.integrationConnections.get(connectionId),
    assertDiscordConnection: (connection) => gateway.assertDiscordConnection(connection),
    readDiscordPairings: () => gateway.readDiscordPairings(),
    writeDiscordPairings: (records) => gateway.writeDiscordPairings(records),
    discordRuntimeService: gateway.discordRuntimeService,
    resolveConnectionSecret: (config, directKey, envKey) => gateway.resolveConnectionSecret(config, directKey, envKey),
    readConnectionConfigValue: (config, key) => gateway.readConnectionConfigValue(config, key),
    isConnectionUrlAllowlisted: (urlValue) => gateway.isConnectionUrlAllowlisted(urlValue),
    fetchWithDiagnosticsTimeout: (url, init) => gateway.fetchWithDiagnosticsTimeout(url, init),
    readIntegrationPlugins: () => gateway.readIntegrationPlugins(),
    writeIntegrationPlugins: (plugins) => gateway.writeIntegrationPlugins(plugins),
  };
}

export function createCommsHostForGateway(
  gateway: GatewayRouteCompositionSource,
  integrationChannel = createIntegrationChannelServiceForGateway(gateway),
): CommsHost {
  return {
    invokeAndUnwrap: (request, realtimeType) => gateway.invokeAndUnwrap(request, realtimeType),
    readChatAttachmentContent: (attachmentId) => gateway.readChatAttachmentContent(attachmentId),
    getIntegrationConnection: (connectionId) => integrationChannel.getIntegrationConnection(connectionId),
    emitDiscordTyping: (connection, input) =>
      gateway.discordRuntimeService.sendTyping(connection.connectionId, input.target, input.durationMs, input.signal),
    emitTelegramTyping: (connection, input) => integrationChannel.emitTelegramTyping(connection, input),
  };
}

export function createChatThreadKnowledgeDependenciesForGateway(
  gateway: GatewayRouteCompositionSource,
): chatThreadKnowledgeService.ChatThreadKnowledgeDependencies {
  const knowledgeFacade = new KnowledgeFacadeService({
    invokeAndUnwrap: (request, realtimeType) => gateway.invokeAndUnwrap(request, realtimeType),
  });
  return {
    storage: gateway.storage,
    getSession: (sessionId) => gateway.getSession(sessionId),
    readChatAttachmentContent: (attachmentId) => gateway.readChatAttachmentContent(attachmentId),
    knowledgeDocsIngest: (input) => knowledgeFacade.knowledgeDocsIngest(input),
    knowledgeEmbeddingsQuery: (input) => knowledgeFacade.knowledgeEmbeddingsQuery(input),
  };
}
