import type { FastifyInstance } from "fastify";
import { z } from "zod";

const chatToolDecisionSchema = z.object({
  sessionId: z.string().min(1),
  approvalId: z.string().min(1),
});

export function registerChatToolRoutes(fastify: FastifyInstance): void {
  fastify.post("/api/v1/chat/tools/approve", async (request, reply) => {
    const body = chatToolDecisionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      await fastify.gateway.resolveChatToolApproval(body.data.sessionId, body.data.approvalId, "approve");
      return reply.send({ ok: true, approvalId: body.data.approvalId });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/tools/deny", async (request, reply) => {
    const body = chatToolDecisionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      await fastify.gateway.resolveChatToolApproval(body.data.sessionId, body.data.approvalId, "reject");
      return reply.send({ ok: true, approvalId: body.data.approvalId });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
}
