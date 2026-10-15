import * as chatAttachmentService from "./chat-attachment-service.js";
import * as chatGeneratedArtifactService from "./chat-generated-artifact-service.js";
import * as htmlArtifactCritiqueService from "./html-artifact-critique-service.js";
import * as htmlArtifactRenderService from "./html-artifact-render-service.js";
import type { ChatArtifactRendersRoutePort } from "./chat-artifact-renders-route-service.js";
import type { GatewayRouteCompositionPort } from "./gateway-route-composition-port.js";
/** Artifact routes reuse the original session, attachment, durable-turn and background owners. */
export function composeChatArtifactRenderDependencies(
  gateway: Pick<
    GatewayRouteCompositionPort,
    "config" | "storage" | "chatTurnRuntime" | "llmService" | "resolveChatRunVariableInput"
  >,
  ChatGeneratedArtifactDependencies: chatGeneratedArtifactService.ChatGeneratedArtifactDependencies,
  chatAttachmentHost: chatAttachmentService.ChatAttachmentHost,
  backgroundTasks: htmlArtifactCritiqueService.HtmlArtifactCritiqueDependencies["backgroundTasks"],
  log: htmlArtifactCritiqueService.HtmlArtifactCritiqueDependencies["log"],
): ChatArtifactRendersRoutePort {
  const htmlArtifactRenderDependencies: htmlArtifactRenderService.HtmlArtifactRenderDependencies = {
    config: gateway.config,
    storage: gateway.storage,
    getChatGeneratedArtifact: (artifactId, options) =>
      chatGeneratedArtifactService.getChatGeneratedArtifact(ChatGeneratedArtifactDependencies, artifactId, options),
    uploadChatAttachment: (input) => chatAttachmentService.uploadChatAttachment(chatAttachmentHost, input),
  };
  const htmlArtifactCritiqueDependencies: htmlArtifactCritiqueService.HtmlArtifactCritiqueDependencies = {
    getChatGeneratedArtifact: htmlArtifactRenderDependencies.getChatGeneratedArtifact,
    renderChatGeneratedArtifact: (artifactId, workspaceId) =>
      htmlArtifactRenderService.renderChatGeneratedArtifact(htmlArtifactRenderDependencies, artifactId, workspaceId),
    routePreflight: (sessionId, input) => gateway.chatTurnRuntime.routePreflight(sessionId, input),
    providerSupportsVision: (providerId) =>
      gateway.llmService
        .listProviders()
        .some((provider) => provider.providerId === providerId && provider.capabilities?.vision === true),
    sendChatTurn: async (sessionId, input, turnIdentity, authenticatedOperator) =>
      await gateway.chatTurnRuntime.agentSendChatMessage(
        sessionId,
        await gateway.resolveChatRunVariableInput(sessionId, input),
        {
          turnIdentity,
          ...(authenticatedOperator ? { authenticatedOperator: authenticatedOperator as never } : {}),
        },
      ),
    backgroundTasks,
    log,
  };
  const chatArtifactRenders: ChatArtifactRendersRoutePort = {
    renderChatGeneratedArtifact: (artifactId, workspaceId) =>
      htmlArtifactRenderService.renderChatGeneratedArtifact(htmlArtifactRenderDependencies, artifactId, workspaceId),
    listChatArtifactRenders: (artifactId, workspaceId) =>
      htmlArtifactRenderService.listChatArtifactRenders(htmlArtifactRenderDependencies, artifactId, workspaceId),
    critiqueChatGeneratedArtifact: (artifactId, workspaceId, actor, authenticatedOperator) =>
      htmlArtifactCritiqueService.critiqueChatGeneratedArtifact(
        htmlArtifactCritiqueDependencies,
        artifactId,
        workspaceId,
        actor,
        authenticatedOperator,
      ),
  };
  return chatArtifactRenders;
}
