import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CodeModeApprovalQueueItem } from "../services/capability-system-service.js";

const chatToolDecisionSchema = z.object({
  sessionId: z.string().min(1),
  approvalId: z.string().min(1),
  allowScope: z.enum(["once", "session", "workspace"]).optional(),
});

const chatToolApprovalsQuerySchema = z.object({
  sessionId: z.string().min(1),
});

const chatToolArtifactParamsSchema = z.object({
  artifactId: z.string().uuid(),
});

const chatToolArtifactQuerySchema = z.object({
  workspaceId: z.string().min(1),
});

export function registerChatToolRoutes(fastify: FastifyInstance): void {
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;

  fastify.get("/api/v1/chat/tools/approvals", async (request, reply) => {
    const query = chatToolApprovalsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    const items = fastify.services.chatTools.listChatPendingApprovals(
      query.data.sessionId,
    ) as CodeModeApprovalQueueItem[];
    const activeItems = items.filter((item) => !item.stale);
    return reply.send({
      items,
      activeApprovalId: activeItems[0]?.approvalId ?? null,
      remainingCount: Math.max(0, activeItems.length - 1),
    });
  });

  fastify.get("/api/v1/chat/tools/artifacts/:artifactId", async (request, reply) => {
    const params = chatToolArtifactParamsSchema.safeParse(request.params);
    const query = chatToolArtifactQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      const result = await fastify.services.chatTools.getChatToolArtifactContent(params.data.artifactId, {
        workspaceId: query.data.workspaceId,
      });
      return reply.send(result);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/tools/approve", async (request, reply) => {
    const body = chatToolDecisionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      const result = await fastify.services.chatTools.resolveChatToolApproval(
        body.data.sessionId,
        body.data.approvalId,
        "approve",
        {
          allowScope: body.data.allowScope ?? "once",
          resolvedBy: resolveActorId(request),
        },
      );
      return reply.send({
        ok: true,
        approvalId: body.data.approvalId,
        allowScope: result.allowScope,
        grant: result.grant,
        resumed: result.resumed,
        resumedTurnId: result.resumedTurnId,
        resumedRunId: result.resumedRunId,
      });
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
      await fastify.services.chatTools.resolveChatToolApproval(body.data.sessionId, body.data.approvalId, "reject", {
        resolvedBy: resolveActorId(request),
      });
      return reply.send({ ok: true, approvalId: body.data.approvalId });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
}
