import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withRouteAccess } from "./route-access.js";

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
  const operatorOnly = withRouteAccess(fastify, "operator");
  const durable = fastify.services.durable;

  fastify.get("/api/v1/durable/diagnostics", operatorOnly, async () => {
    return durable.getDiagnostics();
  });

  fastify.get("/api/v1/durable/runs", operatorOnly, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return {
      items: durable.listRuns(parsed.data.limit),
    };
  });

  fastify.get("/api/v1/durable/dead-letters", operatorOnly, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return {
      items: durable.listDeadLetters(parsed.data.limit),
    };
  });

  fastify.get("/api/v1/durable/runs/:runId/checkpoints", operatorOnly, async (request, reply) => {
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
      items: durable.listRunCheckpoints(params.data.runId, query.data.limit),
    };
  });

  fastify.post("/api/v1/durable/runs", operatorOnly, async (request, reply) => {
    const body = createRunBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.code(201).send(durable.createRun(body.data));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/durable/runs/:runId", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(durable.getRun(params.data.runId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/durable/runs/:runId/timeline", operatorOnly, async (request, reply) => {
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
      return reply.send({ items: durable.listRunTimeline(params.data.runId, query.data.limit) });
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/pause", operatorOnly, async (request, reply) => {
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
      return reply.send(durable.pauseRun(params.data.runId, resolveActorId(request)));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/resume", operatorOnly, async (request, reply) => {
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
      return reply.send(durable.resumeRun(params.data.runId, resolveActorId(request)));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/cancel", operatorOnly, async (request, reply) => {
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
      return reply.send(durable.cancelRun(params.data.runId, resolveActorId(request)));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/retry", operatorOnly, async (request, reply) => {
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
      return reply.send(durable.retryRun(params.data.runId, body.data.reason, resolveActorId(request)));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/events/wake", operatorOnly, async (request, reply) => {
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
      return reply.send(durable.wakeRun(params.data.runId, body.data));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/durable/dead-letters/:entryId/recover", operatorOnly, async (request, reply) => {
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
        durable.recoverDeadLetter(
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
