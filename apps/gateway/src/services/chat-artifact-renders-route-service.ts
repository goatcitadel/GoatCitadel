import type { ChatArtifactCritiqueResponse, ChatArtifactRenderResponse } from "@goatcitadel/contracts";
import type { ArtifactCritiqueActor } from "./html-artifact-critique-service.js";
export const chatArtifactRendersRouteMethods = [
  "renderChatGeneratedArtifact",
  "listChatArtifactRenders",
  "critiqueChatGeneratedArtifact",
] as const;
export type ChatArtifactRendersRouteMethod = (typeof chatArtifactRendersRouteMethods)[number];
export interface ChatArtifactRendersRoutePort {
  renderChatGeneratedArtifact(artifactId: string, workspaceId: string): Promise<ChatArtifactRenderResponse>;
  listChatArtifactRenders(artifactId: string, workspaceId: string): Promise<ChatArtifactRenderResponse>;
  critiqueChatGeneratedArtifact(
    artifactId: string,
    workspaceId: string,
    actor: ArtifactCritiqueActor,
    authenticatedOperator?: unknown,
  ): Promise<ChatArtifactCritiqueResponse>;
}
export type ChatArtifactRendersRouteService = Readonly<ChatArtifactRendersRoutePort>;
export function createChatArtifactRendersRouteService(
  port: ChatArtifactRendersRoutePort,
): ChatArtifactRendersRouteService {
  return Object.freeze<ChatArtifactRendersRouteService>({
    renderChatGeneratedArtifact: (artifactId, workspaceId) => port.renderChatGeneratedArtifact(artifactId, workspaceId),
    listChatArtifactRenders: (artifactId, workspaceId) => port.listChatArtifactRenders(artifactId, workspaceId),
    critiqueChatGeneratedArtifact: (
      ...args: Parameters<ChatArtifactRendersRoutePort["critiqueChatGeneratedArtifact"]>
    ) => port.critiqueChatGeneratedArtifact(...args),
  });
}
