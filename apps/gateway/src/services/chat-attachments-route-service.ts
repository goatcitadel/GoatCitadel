import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const chatAttachmentsRouteMethods = [
  "getChatAttachment",
  "readChatAttachmentContent",
  "resolveChatAttachmentContent",
  "uploadChatAttachment",
] as const;

export type ChatAttachmentsRouteMethod = (typeof chatAttachmentsRouteMethods)[number];
export type ChatAttachmentsRoutePort = RoutePort<ChatAttachmentsRouteMethod>;
export type ChatAttachmentsRouteService = RouteService<ChatAttachmentsRouteMethod>;

export function createChatAttachmentsRouteService(port: ChatAttachmentsRoutePort): ChatAttachmentsRouteService {
  return createRouteService(port, chatAttachmentsRouteMethods);
}
