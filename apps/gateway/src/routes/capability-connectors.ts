import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ServiceUnavailableError } from "@goatcitadel/contracts";
import { sendRouteError } from "./_error-handler.js";

const querySchema = z.object({ workspaceId: z.string().min(1).max(200) }).strict();

/**
 * Capabilities › Apps. One merged, read-only list of every app the AI can use in a workspace. It reads local state
 * only: no live checks, no realtime events, and no secret value ever appears in the response.
 */
export const capabilityConnectorsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/api/v1/capabilities/connectors",
    // Tighter than the general read bucket: each list reads MCP, integrations, web search and settings.
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const query = querySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      try {
        markNoStore(reply);
        return reply.send(await requireOwner(fastify).list(query.data.workspaceId));
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
};

function requireOwner(fastify: FastifyInstance) {
  const owner = fastify.services.capabilityConnectors;
  if (!owner) throw new ServiceUnavailableError("The Capabilities app list is unavailable.");
  return owner;
}

function markNoStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
}
