import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const chatProjectsRouteMethods = [
  "archiveChatProject",
  "createChatProject",
  "hardDeleteChatProject",
  "importChatProject",
  "listChatProjects",
  "restoreChatProject",
  "updateChatProject",
] as const;

export type ChatProjectsRouteMethod = (typeof chatProjectsRouteMethods)[number];
export type ChatProjectsRoutePort = RoutePort<ChatProjectsRouteMethod>;
export type ChatProjectsRouteService = RouteService<ChatProjectsRouteMethod>;

export function createChatProjectsRouteService(port: ChatProjectsRoutePort): ChatProjectsRouteService {
  return createRouteService(port, chatProjectsRouteMethods);
}
