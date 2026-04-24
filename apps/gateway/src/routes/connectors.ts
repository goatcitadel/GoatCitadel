import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const connectorQuerySchema = z.object({
  connectorType: z.enum(["browser", "mcp_server", "integration_connection"]).optional(),
});

export const connectorsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/connectors", async (request, reply) => {
    const parsed = connectorQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.services.connectors.listConnectorRecords(parsed.data.connectorType),
    });
  });
};
