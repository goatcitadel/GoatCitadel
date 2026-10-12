import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const chatArtifactRendersRouteMethods = ["renderChatGeneratedArtifact", "listChatArtifactRenders"] as const;

export type ChatArtifactRendersRouteMethod = (typeof chatArtifactRendersRouteMethods)[number];
export type ChatArtifactRendersRoutePort = RoutePort<ChatArtifactRendersRouteMethod>;
export type ChatArtifactRendersRouteService = RouteService<ChatArtifactRendersRouteMethod>;

export function createChatArtifactRendersRouteService(
  port: ChatArtifactRendersRoutePort,
): ChatArtifactRendersRouteService {
  return createRouteService(port, chatArtifactRendersRouteMethods);
}
