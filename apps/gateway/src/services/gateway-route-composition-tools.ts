import type {
  McpInvokeRequest,
  McpServerCreateInput,
  McpServerPolicy,
  McpServerUpdateInput,
} from "@goatcitadel/contracts";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import * as connectorDiagnosticsHelpers from "./connector-diagnostics-helpers.js";
import { buildLlmProviderAdvice } from "./llm-provider-advice-service.js";
import { inferRuntimeEngineKind, LlmRuntimeTruthService } from "./llm-runtime-truth-service.js";
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
    readMcpServers: async () => await gateway.readMcpServers(),
    writeMcpServers: async (servers) => await gateway.writeMcpServers(servers),
    patchMcpServerState: async (serverId, patch) => await gateway.patchMcpServerState(serverId, patch),
    readMcpTools: async () => await gateway.readMcpTools(),
    writeMcpTools: async (tools) => await gateway.writeMcpTools(tools),
    resolveConnectedMcpTools: async (server, existing) => await gateway.resolveConnectedMcpTools(server, existing),
    exchangeMcpOAuthCode: (server, code, stateRecord) =>
      gateway.mcpOAuth.exchangeAuthorizationCode(server, code, stateRecord),
    requireMcpServer: async (serverId) => await gateway.requireMcpServer(serverId),
    readMcpAuthState: async () => await gateway.readMcpAuthState(),
    writeMcpAuthState: async (state) => await gateway.writeMcpAuthState(state),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload),
  };
  const mcpDiagnosticsDeps: mcpDiagnosticsService.McpDiagnosticsHost = {
    requireFeatureEnabled: (flag) => gateway.requireFeatureEnabled(flag as keyof RuntimeSettings["features"]),
    listMcpTemplates: async () => await gateway.listMcpTemplates(),
    requireMcpServer: async (serverId) => await gateway.requireMcpServer(serverId),
    pickConnectorDiagnosticAction: (checks) => connectorDiagnosticsHelpers.pickConnectorDiagnosticAction(checks),
    recordConnectorHealthRun: async (report) =>
      await connectorDiagnosticsHelpers.recordConnectorHealthRun({ gatewaySql: gateway.storage.gatewaySql }, report),
  };
  const llmRuntimeTruth = new LlmRuntimeTruthService({
    storage: gateway.storage,
    listProviders: () => gateway.llmService.listProviders(),
  });

  return {
    llm: {
      createChatCompletion: (request, attribution) => gateway.createChatCompletion(request, attribution),
      generateImage: (input, attribution) => gateway.llmService.generateImage(input, attribution),
      getOpenAICodexOAuthStatus: () => gateway.llmService.getOpenAICodexOAuthStatus(),
      getLlmConfigWithDetails: () => ({
        revision: gateway.readSettingsRevision(),
        ...getLlmConfigForGateway(gateway),
        providerConfigs: gateway.llmService.exportConfigFile().providers,
      }),
      getProviderAdvice: async (input) => {
        const providers = gateway.llmService.listProviders();
        const latestMeasurements = new Map(
          await Promise.all(
            providers.map(
              async (provider) =>
                [
                  `${provider.providerId}\u0000${provider.defaultModel}`,
                  await llmRuntimeTruth.latestMeasurement(provider.providerId, provider.defaultModel),
                ] as const,
            ),
          ),
        );
        return buildLlmProviderAdvice(input, providers, {
          latestMeasurement: (providerId, model) => latestMeasurements.get(`${providerId}\u0000${model}`),
          inferEngineKind: inferRuntimeEngineKind,
        });
      },
      exportLlmEvalProofRuns: (limit) => llmRuntimeTruth.exportEvalProofRuns(limit),
      listLlmEvalProofRuns: (limit) => llmRuntimeTruth.listEvalProofRuns(limit),
      listLlmLocalEngines: () => llmRuntimeTruth.listLocalEngines(),
      listLlmModels: (providerId) => gateway.llmService.listModelsWithSource(providerId),
      listLlmProviders: () => gateway.llmService.listProviders(),
      listLlmRuntimeMeasurements: (query) => llmRuntimeTruth.listMeasurements(query),
      pollOpenAICodexOAuthDeviceFlow: (flowId) => gateway.llmService.pollOpenAICodexOAuthDeviceFlow(flowId),
      previewLlmModels: (input) => gateway.llmService.previewModels(input),
      runLlmEvalProof: (input) => llmRuntimeTruth.runEvalProof(input),
      startOpenAICodexOAuthDeviceFlow: () => gateway.llmService.startOpenAICodexOAuthDeviceFlow(),
      deleteOpenAICodexOAuthCredential: () => gateway.llmService.deleteOpenAICodexOAuthCredential(),
      updateLlmConfig: async (input) => {
        const { expectedRevision, ...llm } = input;
        const updated = await gateway.updateSettings({ expectedRevision, llm });
        return { revision: updated.revision, ...updated.llm };
      },
    },
    mcp: {
      elicitations: gateway.mcpElicitationService,
      completeMcpOAuth: async (serverId: string, code: string, state?: string) =>
        await mcpServerAdminService.completeMcpOAuth(mcpAdminDeps, serverId, code, state),
      connectMcpServer: async (serverId: string) =>
        await mcpServerAdminService.connectMcpServer(mcpAdminDeps, serverId),
      createMcpServer: async (input: McpServerCreateInput) =>
        await mcpServerAdminService.createMcpServer(mcpAdminDeps, input),
      deleteMcpServer: async (serverId: string) => await mcpServerAdminService.deleteMcpServer(mcpAdminDeps, serverId),
      disconnectMcpServer: async (serverId: string) =>
        await mcpServerAdminService.disconnectMcpServer(mcpAdminDeps, serverId),
      // Route through the guarded public method (enrich → capability-scope assert → coordinator)
      // so the REST /mcp/invoke surface is subject to the same workspace/citadel scope as the
      // autonomous-model path (spec §7a: "covers every caller (model and REST)").
      invokeMcpTool: (input: McpInvokeRequest) => gateway.invokeMcpTool(input),
      listMcpServers: async () => await gateway.listMcpServers(),
      listMcpTemplateDiscovery: async () => await mcpDiagnosticsService.listMcpTemplateDiscovery(mcpDiagnosticsDeps),
      listMcpTemplates: async () => await gateway.listMcpTemplates(),
      listMcpTools: async (serverId: string) => await gateway.listMcpTools(serverId),
      runMcpServerHealthCheck: async (serverId: string) =>
        await mcpDiagnosticsService.runMcpServerHealthCheck(mcpDiagnosticsDeps, serverId),
      startMcpOAuth: async (serverId: string) => await mcpServerAdminService.startMcpOAuth(mcpAdminDeps, serverId),
      updateMcpServer: async (serverId: string, input: McpServerUpdateInput) =>
        await mcpServerAdminService.updateMcpServer(mcpAdminDeps, serverId, input),
      updateMcpServerPolicy: async (serverId: string, policy: Partial<McpServerPolicy>) =>
        await mcpServerAdminService.updateMcpServerPolicy(mcpAdminDeps, serverId, policy),
    },
    secrets: {
      deleteProviderSecret: (providerId, expectedRevision, storage) =>
        gateway.deleteProviderSecret({ providerId, expectedRevision, storage }),
      getProviderSecretStatus: (providerId) => {
        const status = gateway.llmService.getProviderSecretStatus(providerId);
        return {
          providerId: status.providerId,
          hasSecret: status.hasApiKey,
          source: status.apiKeySource,
        };
      },
      saveProviderSecret: (providerId, apiKey, expectedRevision, storage, envVar) =>
        gateway.saveProviderSecret({ providerId, apiKey, expectedRevision, storage, envVar }),
    },
    tools: {
      activatePermissionProfile: (input) => gateway.activatePermissionProfile(input),
      archivePermissionProfile: (profileId, archivedBy) => gateway.archivePermissionProfile(profileId, archivedBy),
      createLocalOperatorOverride: (input) => gateway.createLocalOperatorOverride(input),
      createPermissionProfile: (input) => gateway.createPermissionProfile(input),
      createToolGrant: (input) => gateway.approvalRuntime.createToolGrant(input),
      evaluateToolAccess: async (input) =>
        await gateway.evaluateToolAccess({
          ...input,
          workspaceId:
            input.workspaceId ??
            (await gateway.storage.chatSessionMeta.get(input.sessionId))?.workspaceId ??
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
