import type { FastifyPluginAsync } from "fastify";
import { registerChatProjectRoutes } from "./chat.projects.js";
import { registerChatSessionRoutes } from "./chat.sessions.js";
import { registerChatAttachmentRoutes } from "./chat.attachments.js";
import { registerChatMessageRoutes } from "./chat.messages.js";
import { registerChatDelegateRoutes } from "./chat.delegate.js";
import { registerChatToolRoutes } from "./chat.tools.js";
import { registerChatMiscRoutes } from "./chat.misc.js";

export const chatRoutes: FastifyPluginAsync = async (fastify) => {
  registerChatProjectRoutes(fastify);
  registerChatSessionRoutes(fastify);
  registerChatMessageRoutes(fastify);
  registerChatDelegateRoutes(fastify);
  registerChatMiscRoutes(fastify);
  registerChatToolRoutes(fastify);
  registerChatAttachmentRoutes(fastify);
};
