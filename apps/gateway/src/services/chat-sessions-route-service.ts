import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const chatSessionsRouteMethods = [
  "archiveChatSession",
  "archiveChatSessionsBulk",
  "assignChatSessionProject",
  "attachChatThreadKnowledgeAttachment",
  "createChatGeneratedArtifactFromTurn",
  "createChatSession",
  "createChatSessionWorkbenchWorktree",
  "deleteChatSession",
  "getChatGeneratedArtifact",
  "getChatSessionBinding",
  "getChatSessionWorkbench",
  "getChatSessionWorkbenchDiff",
  "getChatSessionWorkbenchFile",
  "getChatSessionWorkbenchFileDiff",
  "getChatSessionWorkbenchOutput",
  "getChatSessionWorkbenchTree",
  "listChatGeneratedArtifacts",
  "listChatSessions",
  "listChatThreadKnowledgeAttachments",
  "pinChatSession",
  "removeChatThreadKnowledgeAttachment",
  "restoreChatSession",
  "saveChatSessionWorkbenchFile",
  "setChatSessionBinding",
  "unpinChatSession",
  "updateChatSession",
] as const;

export type ChatSessionsRouteMethod = (typeof chatSessionsRouteMethods)[number];
export type ChatSessionsRoutePort = RoutePort<ChatSessionsRouteMethod>;
export type ChatSessionsRouteService = RouteService<ChatSessionsRouteMethod>;

export function createChatSessionsRouteService(port: ChatSessionsRoutePort): ChatSessionsRouteService {
  return createRouteService(port, chatSessionsRouteMethods);
}
