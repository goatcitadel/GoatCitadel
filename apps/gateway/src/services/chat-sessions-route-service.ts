import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const chatSessionsRouteMethods = [
  "archiveChatSession",
  "archiveChatSessionsBulk",
  "applyChatSessionWorkbenchPatch",
  "assignChatSessionProject",
  "attachChatThreadKnowledgeAttachment",
  "createChatGeneratedArtifactFromTurn",
  "createChatGeneratedArtifactVersion",
  "createDocumentPatchProposal",
  "createAssistantDocumentPatchProposal",
  "applyDocumentPatchProposal",
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
  "listDocumentPatchProposals",
  "listChatSessions",
  "listChatTimers",
  "listChatThreadKnowledgeAttachments",
  "listRecentCrossProjectSessions",
  "pinChatSession",
  "removeChatThreadKnowledgeAttachment",
  "rejectDocumentPatchProposal",
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
