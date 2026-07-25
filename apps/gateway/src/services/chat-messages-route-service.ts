import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const chatMessagesRouteMethods = [
  "agentSendChatMessage",
  "agentSendChatMessageStream",
  "answerChatUserInputPrompt",
  "cancelChatTurn",
  "editChatTurn",
  "editChatTurnStream",
  "getChatThread",
  "getChatTurnCapabilityProfile",
  "getTurnContextManifestForSession",
  "listChatMessagePage",
  "listChatMessages",
  "readChatHistoryWindow",
  "readChatHistoryContinuation",
  "resumeAgentChatTurnStream",
  "retryChatTurn",
  "retryChatTurnStream",
  "routePreflight",
  "selectChatBranchTurn",
] as const;

export type ChatMessagesRouteMethod = (typeof chatMessagesRouteMethods)[number];
export type ChatMessagesRoutePort = RoutePort<ChatMessagesRouteMethod>;
export type ChatMessagesRouteService = RouteService<ChatMessagesRouteMethod>;

export function createChatMessagesRouteService(port: ChatMessagesRoutePort): ChatMessagesRouteService {
  return createRouteService(port, chatMessagesRouteMethods);
}
