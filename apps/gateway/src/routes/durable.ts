import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
});

const runParamsSchema = z.object({
  runId: z.string().min(1),
});

const deadLetterParamsSchema = z.object({
  entryId: z.string().min(1),
});

const createRunBodySchema = z.object({
  workflowKey: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  retryPolicy: z
    .object({
      maxAttempts: z.number().int().positive().max(20).optional(),
      baseDelayMs: z.number().int().positive().max(300000).optional(),
      maxDelayMs: z.number().int().positive().max(900000).optional(),
      backoffMultiplier: z.number().positive().max(8).optional(),
    })
    .optional(),
  waitForEvent: z
    .object({
      eventKey: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
      correlationId: z.string().optional(),
    })
    .optional(),
});

const retryBodySchema = z.object({
  reason: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
});

const wakeBodySchema = z.object({
  eventKey: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  correlationId: z.string().optional(),
});

const actorBodySchema = z.object({
  actorId: z.string().min(1).optional(),
});

const deadLetterRecoverBodySchema = z.object({
  actorId: z.string().min(1).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
});

export const durableRoutes: FastifyPluginAsync = async (fastify) => {
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;

  fastify.get("/api/v1/durable/diagnostics", async () => {
    return fastify.gateway.getDurableDiagnostics();
  });

  fastify.get("/api/v1/durable/runs", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return {
      items: fastify.gateway.listDurableRuns(parsed.data.limit),
    };
  });

  fastify.get("/api/v1/durable/dead-letters", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return {
      items: fastify.gateway.listDurableDeadLetters(parsed.data.limit),
    };
  });

  fastify.get("/api/v1/durable/runs/:runId/checkpoints", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const query = listQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    return {
      items: fastify.gateway.listDurableRunCheckpoints(params.data.runId, query.data.limit),
    };
  });

  fastify.post("/api/v1/durable/runs", async (request, reply) => {
    const body = createRunBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.gateway.createDurableRun(body.data));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/durable/runs/:runId", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getDurableRun(params.data.runId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/durable/runs/:runId/timeline", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const query = listQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send({ items: fastify.gateway.listDurableRunTimeline(params.data.runId, query.data.limit) });
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/pause", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = actorBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.pauseDurableRun(params.data.runId, resolveActorId(request)));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/resume", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = actorBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.resumeDurableRun(params.data.runId, resolveActorId(request)));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/cancel", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = actorBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.cancelDurableRun(params.data.runId, resolveActorId(request)));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/retry", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = retryBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.retryDurableRun(params.data.runId, body.data.reason, resolveActorId(request)));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/events/wake", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = wakeBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.wakeDurableRun(params.data.runId, body.data));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/durable/dead-letters/:entryId/recover", async (request, reply) => {
    const params = deadLetterParamsSchema.safeParse(request.params);
    const body = deadLetterRecoverBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        fastify.gateway.recoverDurableDeadLetter(
          params.data.entryId,
          resolveActorId(request),
          body.data.maxAttempts ? { maxAttempts: body.data.maxAttempts } : undefined,
        ),
      );
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });
};
