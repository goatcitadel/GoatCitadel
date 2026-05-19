import type {
  McpInvokeRequest,
  McpServerCreateInput,
  McpServerPolicy,
  McpServerUpdateInput,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { deleteProviderApiKeyWithFallback, persistProviderApiKeyWithFallback } from "./provider-secret-persistence.js";
import * as connectorDiagnosticsHelpers from "./connector-diagnostics-helpers.js";
import * as mcpDiagnosticsService from "./mcp-diagnostics-service.js";
import * as mcpServerAdminService from "./mcp-server-admin-service.js";
import type { GatewayRouteCompositionPort, RouteDependencyDomain } from "./gateway-route-composition-port.js";
import { DEFAULT_WORKSPACE_ID, getLlmConfigForGateway } from "./gateway-route-composition-shared.js";

export function composeToolsMcpRouteDependencies(
  gateway: GatewayRouteCompositionPort,
): RouteDependencyDomain<"llm" | "mcp" | "secrets" | "tools" | "toolsInvoke"> {
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

  return {
    llm: {
      createChatCompletion: (request) => gateway.createChatCompletion(request),
      generateImage: (input) => gateway.llmService.generateImage(input),
      getOpenAICodexOAuthStatus: () => gateway.llmService.getOpenAICodexOAuthStatus(),
      getLlmConfigWithDetails: () => ({
        ...getLlmConfigForGateway(gateway),
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
    mcp: {
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
    },
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
    tools: {
      activatePermissionProfile: (input) => gateway.activatePermissionProfile(input),
      archivePermissionProfile: (profileId, archivedBy) => gateway.archivePermissionProfile(profileId, archivedBy),
      createLocalOperatorOverride: (input) => gateway.createLocalOperatorOverride(input),
      createPermissionProfile: (input) => gateway.createPermissionProfile(input),
      createToolGrant: (input) => gateway.approvalRuntime.createToolGrant(input),
      evaluateToolAccess: (input) =>
        gateway.evaluateToolAccess({
          ...input,
          workspaceId:
            input.workspaceId ??
            gateway.storage.chatSessionMeta.get(input.sessionId)?.workspaceId ??
            DEFAULT_WORKSPACE_ID,
        }),
      listPermissionProfiles: (includeArchived) => gateway.listPermissionProfiles(includeArchived),
      listActiveLocalOperatorOverrides: (operatorId) => gateway.listActiveLocalOperatorOverrides(operatorId),
      listToolCatalog: () => gateway.policyEngine.listCatalog(),
      listToolGrants: (scope, scopeRef, limit) => gateway.approvalRuntime.listToolGrants(scope, scopeRef, limit),
      resolveToolPolicyContext: (input) => gateway.resolveToolPolicyContext(input),
      revokeLocalOperatorOverride: (overrideId, revokedBy) =>
        gateway.revokeLocalOperatorOverride(overrideId, revokedBy),
      revokeToolGrant: (grantId, revokedBy) => gateway.approvalRuntime.revokeToolGrant(grantId, revokedBy),
      updatePermissionProfile: (profileId, input) => gateway.updatePermissionProfile(profileId, input),
    },
    toolsInvoke: {
      getDeploymentProfile: () => gateway.config.assistant.deploymentProfile,
      invokeTool: (input) => gateway.invokeTool(input),
      isFeatureEnabled: (flag) => gateway.isFeatureEnabled(flag as keyof RuntimeSettings["features"]),
    },
  };
}
