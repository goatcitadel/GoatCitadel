import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  cursor: z.string().optional(),
});

const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

const runtimeLifecycleQuerySchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  turnId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  approvalId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
}).refine(
  (value) => Boolean(value.sessionId || value.turnId || value.runId || value.approvalId || value.taskId),
  {
    message: "Provide at least one lifecycle identifier.",
    path: ["sessionId"],
  },
);

export const sessionsListRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/runtime/lifecycle", async (request, reply) => {
    const parsed = runtimeLifecycleQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.gateway.getRuntimeLifecycle(parsed.data));
  });

  fastify.get("/api/v1/sessions", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const items = fastify.gateway.listSessions(parsed.data.limit, parsed.data.cursor);
    const last = items[items.length - 1];
    const nextCursor = items.length === parsed.data.limit && last
      ? `${last.updatedAt}|${last.sessionId}`
      : undefined;

    return reply.send({ items, nextCursor });
  });

  fastify.get("/api/v1/sessions/:sessionId", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    return reply.send(fastify.gateway.getSession(sessionId));
  });

  fastify.get("/api/v1/sessions/:sessionId/transcript", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const events = await fastify.gateway.getTranscript(sessionId);
    return reply.send({ items: events });
  });

  fastify.get("/api/v1/sessions/:sessionId/summary", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    return reply.send(await fastify.gateway.getSessionSummary(sessionId));
  });

  fastify.get("/api/v1/sessions/:sessionId/timeline", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const parsed = timelineQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({ items: await fastify.gateway.listSessionTimeline(sessionId, parsed.data.limit) });
  });
};
