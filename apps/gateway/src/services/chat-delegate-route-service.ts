import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const chatDelegateRouteMethods = [
  "acceptChatDelegation",
  "getChatDelegationRun",
  "getLatestChatWorkspaceExplorer",
  "listChatDelegatedScopeCandidates",
  "requestChatDelegatedScopeExpansion",
  "runChatDelegation",
  "runChatDelegationStream",
  "suggestChatDelegation",
] as const;

export type ChatDelegateRouteMethod = (typeof chatDelegateRouteMethods)[number];
export type ChatDelegateRoutePort = RoutePort<ChatDelegateRouteMethod>;
export type ChatDelegateRouteService = RouteService<ChatDelegateRouteMethod>;

export function createChatDelegateRouteService(port: ChatDelegateRoutePort): ChatDelegateRouteService {
  return createRouteService(port, chatDelegateRouteMethods);
}
