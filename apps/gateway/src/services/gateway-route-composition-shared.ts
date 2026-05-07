import type { LlmRuntimeConfig } from "@goatcitadel/contracts";
import { KnowledgeFacadeService } from "./memory-facade-service.js";
import { createWorkspacesRoutePort } from "./workspaces-route-service.js";
import * as chatAttachmentService from "./chat-attachment-service.js";
import * as chatThreadKnowledgeService from "./chat-thread-knowledge-service.js";
import * as settingsAuthService from "./settings-auth-service.js";
import type { GatewayRouteServiceDependencies } from "./gateway-route-services.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";

export const DEFAULT_WORKSPACE_ID = "default";

export function getLlmConfigForGateway(gateway: Pick<GatewayRouteCompositionPort, "llmService">): LlmRuntimeConfig {
  return gateway.llmService.getRuntimeConfig({
    includeKeychainForActiveProvider: true,
    useCache: true,
  });
}

export function getProviderSecretStatusForGateway(
  gateway: Pick<GatewayRouteCompositionPort, "llmService">,
  providerId: string,
): {
  providerId: string;
  hasSecret: boolean;
  source: "none" | "keychain" | "env" | "inline";
} {
  const status = gateway.llmService.getProviderSecretStatus(providerId);
  return {
    providerId: status.providerId,
    hasSecret: status.hasApiKey,
    source: status.apiKeySource,
  };
}

export function createWorkspacesRoutePortForGateway(
  gateway: GatewayRouteCompositionPort,
): GatewayRouteServiceDependencies["workspaces"] {
  return createWorkspacesRoutePort({
    storage: gateway.storage,
    normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload ?? {}),
    listGlobalGuidance: () => gateway.guidanceService.listGlobalGuidance(),
    listWorkspaceGuidance: (workspaceId) => gateway.guidanceService.listWorkspaceGuidance(workspaceId),
    updateGlobalGuidance: (docType, content) => gateway.guidanceService.updateGlobalGuidance(docType, content),
    updateWorkspaceGuidance: (workspaceId, docType, content) =>
      gateway.guidanceService.updateWorkspaceGuidance(workspaceId, docType, content),
  });
}

export function createSettingsRuntimeDependenciesForGateway(
  gateway: GatewayRouteCompositionPort,
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
  gateway: GatewayRouteCompositionPort,
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

export function createChatThreadKnowledgeDependenciesForGateway(
  gateway: GatewayRouteCompositionPort,
): chatThreadKnowledgeService.ChatThreadKnowledgeDependencies {
  const knowledgeFacade = new KnowledgeFacadeService({
    invokeAndUnwrap: (request, realtimeType) => gateway.invokeAndUnwrap(request, realtimeType),
  });
  return {
    storage: gateway.storage,
    getSession: (sessionId) => gateway.getSession(sessionId),
    readChatAttachmentContent: (attachmentId) => readChatAttachmentContentForGateway(gateway, attachmentId),
    knowledgeDocsIngest: (input) => knowledgeFacade.knowledgeDocsIngest(input),
    knowledgeEmbeddingsQuery: (input) => knowledgeFacade.knowledgeEmbeddingsQuery(input),
  };
}

export function readChatAttachmentContentForGateway(gateway: GatewayRouteCompositionPort, attachmentId: string) {
  return chatAttachmentService.readChatAttachmentContent(
    {
      config: gateway.config,
      storage: gateway.storage,
    },
    attachmentId,
  );
}
