import { NotFoundError, type LlmRuntimeConfig } from "@goatcitadel/contracts";
import { KnowledgeFacadeService } from "./memory-facade-service.js";
import { createWorkspacesRoutePort } from "./workspaces-route-service.js";
import * as chatAttachmentService from "./chat-attachment-service.js";
import * as chatThreadKnowledgeService from "./chat-thread-knowledge-service.js";
import * as settingsAuthService from "./settings-auth-service.js";
import type { GatewayRouteServiceDependencies } from "./gateway-route-services.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
import type { RuntimeConfigurationChangePlanAdapterDependencies } from "./runtime-configuration-change-plan-adapter.js";
import {
  createOwnErrandConversationLookup,
  type OwnErrandConversation,
} from "./browser-errands/errand-escalation-gateway.js";
import { INTEGRATION_CATALOG } from "./integration-catalog.js";
import { errandApprovalConversationLabel } from "./runtime-errand-approval-conversation-change.js";

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
  const { guidanceService: guidance } = gateway;
  return createWorkspacesRoutePort({
    storage: gateway.storage,
    normalizeWorkspaceId: (workspaceId) => gateway.normalizeWorkspaceId(workspaceId),
    publishRealtime: (eventType, source, payload) => gateway.publishRealtime(eventType, source, payload ?? {}),
    listGlobalGuidance: () => guidance.listGlobalGuidance(),
    listWorkspaceGuidance: (workspaceId) => guidance.listWorkspaceGuidance(workspaceId),
    updateGlobalGuidance: (docType, content) => guidance.updateGlobalGuidance(docType, content),
    updateWorkspaceGuidance: (workspaceId, docType, content) =>
      guidance.updateWorkspaceGuidance(workspaceId, docType, content),
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
    readSettingsRevision: () => gateway.readSettingsRevision(),
    updateFeatureFlags: (patch) => gateway.updateFeatureFlags(patch),
    assertDeploymentProfileUpdate: (input) => gateway.assertDeploymentProfileUpdate(input),
    assertFirecrawlRuntimeUpdate: (input) => gateway.assertFirecrawlRuntimeUpdate(input),
    // A partial port (a test's) without the engine holds nothing.
    readPluginToolGroupHolds: () => gateway.policyEngine?.listPluginToolGroupHolds() ?? [],
    isOwnErrandApprovalConversation: async (sessionId) =>
      (await findOwnErrandConversation(gateway, sessionId)) !== undefined,
  };
}

/**
 * The settings-owner checks the runtime configuration Change Plan adapter runs at prepare, each built from the port
 * only when it runs: the dry-run of a settings update, and the name of a picked errand approval conversation.
 */
export function createRuntimeConfigurationOwnerChecks(
  port: () => GatewayRouteCompositionPort,
): Pick<
  RuntimeConfigurationChangePlanAdapterDependencies,
  "validateSettingsUpdate" | "errandApprovalConversationTitle"
> {
  return {
    validateSettingsUpdate: async (input) => {
      await settingsAuthService.buildSettingsCandidate(createSettingsRuntimeDependenciesForGateway(port()), input);
    },
    errandApprovalConversationTitle: async (sessionId) => {
      const own = await findOwnErrandConversation(port(), sessionId);
      return own ? errandApprovalConversationLabel(own.title, channelName(own.conversation.channelKey)) : undefined;
    },
  };
}

/** The channel's name as the integration catalog shows it, such as "Telegram". */
function channelName(channelKey: string): string | undefined {
  return INTEGRATION_CATALOG.find((entry) => entry.kind === "channel" && entry.key === channelKey)?.label;
}

/** The operator's own private conversation behind a session; a session or connection that no longer exists is none. */
async function findOwnErrandConversation(
  gateway: GatewayRouteCompositionPort,
  sessionId: string,
): Promise<OwnErrandConversation | undefined> {
  const lookup = createOwnErrandConversationLookup({
    storage: gateway.storage,
    readDiscordPairings: () => gateway.readDiscordPairings(),
  });
  try {
    return await lookup(sessionId);
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

export function createSettingsAuthRuntimeDependenciesForGateway(
  gateway: GatewayRouteCompositionPort,
): settingsAuthService.SettingsAuthRuntimeDependencies {
  const storage = gateway.storage;
  return {
    config: gateway.config,
    gatewaySql: storage.gatewaySql,
    storage,
    deviceTokenVault: gateway.deviceTokenVault,
    createApproval: (input, onCreated) => gateway.createApproval(input, onCreated),
    resolveApproval: (approvalId, input) => gateway.resolveApproval(approvalId, input),
    enqueueApprovalResolutionEffects: (approval, input, options) =>
      gateway.enqueueApprovalResolutionEffects(approval, input, options),
    enqueueApprovalObservabilityEffects: (approvalId, items) =>
      gateway.approvalEffectsService.enqueueObservabilityEffects(approvalId, items),
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
    invokeAndUnwrap: (...args) => gateway.invokeAndUnwrap(...args),
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
