import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { projectPublicSecretValue } from "../services/public-secret-projection.js";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const inboxQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9._-]+$/),
}).strict();

export const inboxRoutes: FastifyPluginAsync = async (fastify, _opts) => {
  const operatorOnly = withRouteAccess(fastify, "operator");

  fastify.get("/api/v1/inbox", operatorOnly, async (request, reply) => {
    const parsed = inboxQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid inbox query." });
    try {
      try {
        await fastify.services.workspaces.getWorkspace(parsed.data.workspaceId);
      } catch {
        return reply.code(404).send({ error: "Workspace not found." });
      }
      reply.header("Cache-Control", "private, no-store");
      const projection = await fastify.services.inbox.getProjection(parsed.data.workspaceId, (source, error) => {
        request.log.warn({ source, errorName: error instanceof Error ? error.name : "unknown" }, "Inbox owner unavailable");
      });
      return reply.send(projectPublicSecretValue(projection));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
