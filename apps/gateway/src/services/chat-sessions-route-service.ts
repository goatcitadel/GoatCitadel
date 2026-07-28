import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const chatSessionsRouteMethods = [
  "archiveChatSession",
  "archiveChatSessionsBulk",
  "applyChatSessionWorkbenchPatch",
  "assignChatSessionProject",
  "attachChatThreadKnowledgeAttachment",
  "createChatGeneratedArtifactFromTurn",
  "createChatSideChat",
  "createChatTimer",
  "createChatSession",
  "createChatSessionWorkbenchWorktree",
  "deleteChatSession",
  "exportChatSessionWorkbenchPatch",
  "forkChatSessionFromTurn",
  "getChatGeneratedArtifact",
  "getChatSessionBinding",
  "getChatSessionStatus",
  "getChatSessionWorkbench",
  "getChatSessionWorkbenchDiff",
  "getChatSessionWorkbenchFile",
  "getChatSessionWorkbenchFileDiff",
  "getChatSessionWorkbenchOutput",
  "getChatSessionWorkbenchTree",
  "getChatSideChat",
  "listChatGeneratedArtifacts",
  "listChatSessions",
  "listChatTimers",
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
  "searchChatSessions",
  "setChatSessionBinding",
  "unpinChatSession",
  "updateChatSession",
  "cancelChatTimer",
] as const;

export type ChatSessionsRouteMethod = (typeof chatSessionsRouteMethods)[number];
export type ChatSessionsRoutePort = RoutePort<ChatSessionsRouteMethod>;
export type ChatSessionsRouteService = RouteService<ChatSessionsRouteMethod>;

export function createChatSessionsRouteService(port: ChatSessionsRoutePort): ChatSessionsRouteService {
  return createRouteService(port, chatSessionsRouteMethods);
}
