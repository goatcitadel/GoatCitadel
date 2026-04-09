import type { FastifyInstance } from "fastify";
import { z } from "zod";

const chatToolDecisionSchema = z.object({
  sessionId: z.string().min(1),
  approvalId: z.string().min(1),
});

const chatToolApprovalsQuerySchema = z.object({
  sessionId: z.string().min(1),
});

export function registerChatToolRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/v1/chat/tools/approvals", async (request, reply) => {
    const query = chatToolApprovalsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    const items = fastify.gateway.listChatPendingApprovals(query.data.sessionId);
    const activeItems = items.filter((item) => !item.stale);
    return reply.send({
      items,
      activeApprovalId: activeItems[0]?.approvalId ?? null,
      remainingCount: Math.max(0, activeItems.length - 1),
    });
  });

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
