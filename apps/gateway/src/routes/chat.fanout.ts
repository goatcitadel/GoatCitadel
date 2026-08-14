import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NotFoundError } from "@goatcitadel/contracts";
import { sessionParamsSchema } from "./chat.shared.js";

const fanoutParamsSchema = sessionParamsSchema.extend({
  invocationId: z.string().trim().min(1).max(256),
});

/**
 * The only direct aggregate control in v1. Individual child retries and
 * rewiring deliberately remain unavailable; stop asks the canonical durable
 * aggregate to cancel active children and wake the parked parent truthfully.
 */
export function registerChatFanoutRoutes(fastify: FastifyInstance): void {
  fastify.post("/api/v1/chat/sessions/:sessionId/fanouts/:invocationId/stop", async (request, reply) => {
    const params = fanoutParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const invocation = await fastify.services.chatDelegate.stopChatFanout(
        params.data.sessionId,
        params.data.invocationId,
      );
      return reply.send({
        invocationId: invocation.invocationId,
        status: invocation.status,
        ...(invocation.terminalReason ? { terminalReason: invocation.terminalReason } : {}),
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return reply.code(404).send({ error: "Chat fan-out invocation was not found for this session." });
      }
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
}
