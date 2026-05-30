import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const chatSessionsRouteMethods = [
  "archiveChatSession",
  "archiveChatSessionsBulk",
  "applyChatSessionWorkbenchPatch",
  "assignChatSessionProject",
  "attachChatThreadKnowledgeAttachment",
  "createChatGeneratedArtifactFromTurn",
  "createChatSideChat",
  "createChatSession",
  "createChatSessionWorkbenchWorktree",
  "deleteChatSession",
  "exportChatSessionWorkbenchPatch",
  "getChatGeneratedArtifact",
  "getChatSessionBinding",
  "getChatSessionWorkbench",
  "getChatSessionWorkbenchDiff",
  "getChatSessionWorkbenchFile",
  "getChatSessionWorkbenchFileDiff",
  "getChatSessionWorkbenchOutput",
  "getChatSessionWorkbenchTree",
  "getChatSideChat",
  "listChatGeneratedArtifacts",
  "listChatSessions",
  "listChatThreadKnowledgeAttachments",
  "listRecentCrossProjectSessions",
  "pinChatSession",
  "removeChatThreadKnowledgeAttachment",
  "restoreChatSession",
  "revertChatSessionWorkbenchChanges",
  "revertChatSessionWorkbenchFile",
  "runChatSessionWorkbenchCommand",
  "runChatSessionWorkbenchFileOperation",
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
