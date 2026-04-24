import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const chatToolsRouteMethods = [
  "getChatToolArtifactContent",
  "listChatPendingApprovals",
  "resolveChatToolApproval",
] as const;

export type ChatToolsRouteMethod = (typeof chatToolsRouteMethods)[number];
export type ChatToolsRoutePort = RoutePort<ChatToolsRouteMethod>;
export type ChatToolsRouteService = RouteService<ChatToolsRouteMethod>;

export function createChatToolsRouteService(port: ChatToolsRoutePort): ChatToolsRouteService {
  return createRouteService(port, chatToolsRouteMethods);
}
