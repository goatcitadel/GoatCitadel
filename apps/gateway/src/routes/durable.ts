import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { resolveApprovalActorId } from "./approvals.js";
import { withRouteAccess } from "./route-access.js";
import { projectDurableRouteResponse } from "../services/durable-public-projection.js";
import { markMutationCommitted, markMutationCommittedFromError } from "../plugins/idempotency.js";

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

const retryBodySchema = z
  .object({
    reason: z.string().min(1).optional(),
  })
  .strict();

const wakeBodySchema = z.object({
  eventKey: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  correlationId: z.string().optional(),
});

const actorBodySchema = z.object({}).strict();

const deadLetterRecoverBodySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(20).optional(),
  })
  .strict();

function sendDurableMutationError(
  reply: FastifyReply,
  request: FastifyRequest,
  error: unknown,
  fallbackStatus: number,
) {
  markMutationCommittedFromError(request, error);
  const message = error instanceof Error ? error.message : "Durable operation failed";
  if (!request.mutationCommitted) {
    return reply.code(fallbackStatus).send(projectDurableRouteResponse({ error: message }));
  }

  reply.log.error(
    projectDurableRouteResponse({
      error: message,
      errorName: error instanceof Error ? error.name : "Error",
      mutationCommitted: true,
    }),
    "durable mutation failed after commit",
  );
  const response: Record<string, unknown> = {
    error: message,
    code: "mutation_committed",
    retryable: false,
  };
  if (error !== null && typeof error === "object" && "canonicalResult" in error) {
    response.canonicalResult = (error as { canonicalResult?: unknown }).canonicalResult;
  }
  return reply.code(500).send(projectDurableRouteResponse(response));
}

export const durableRoutes: FastifyPluginAsync = async (fastify) => {
  const resolveActorId = (request: {
    authActorId?: string;
    authDeviceId?: string;
    authCompanionSessionId?: string;
    ip?: string;
  }) => resolveApprovalActorId(request);
  const operatorOnly = withRouteAccess(fastify, "operator");
  const durable = fastify.services.durable;

  fastify.get("/api/v1/durable/diagnostics", operatorOnly, async () => {
    return projectDurableRouteResponse(durable.getDiagnostics());
  });

  fastify.get("/api/v1/durable/runs", operatorOnly, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(projectDurableRouteResponse({ error: parsed.error.flatten() }));
    }
    return projectDurableRouteResponse({
      items: durable.listRuns(parsed.data.limit),
    });
  });

  fastify.get("/api/v1/durable/dead-letters", operatorOnly, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send(projectDurableRouteResponse({ error: parsed.error.flatten() }));
    }
    return projectDurableRouteResponse({
      items: durable.listDeadLetters(parsed.data.limit),
    });
  });

  fastify.get("/api/v1/durable/runs/:runId/checkpoints", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const query = listQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send(
        projectDurableRouteResponse({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            query: query.success ? undefined : query.error.flatten(),
          },
        }),
      );
    }
    return projectDurableRouteResponse({
      items: durable.listRunCheckpoints(params.data.runId, query.data.limit),
    });
  });

  fastify.post("/api/v1/durable/runs", operatorOnly, async (request, reply) => {
    const body = createRunBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(projectDurableRouteResponse({ error: body.error.flatten() }));
    }
    try {
      const run = durable.createRun(body.data);
      markMutationCommitted(request);
      return reply.code(201).send(projectDurableRouteResponse(run));
    } catch (error) {
      return sendDurableMutationError(reply, request, error, 409);
    }
  });

  fastify.get("/api/v1/durable/runs/:runId", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(projectDurableRouteResponse({ error: params.error.flatten() }));
    }
    try {
      return reply.send(projectDurableRouteResponse(durable.getRun(params.data.runId)));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send(projectDurableRouteResponse({ error: message }));
    }
  });

  fastify.get("/api/v1/durable/runs/:runId/timeline", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const query = listQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send(
        projectDurableRouteResponse({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            query: query.success ? undefined : query.error.flatten(),
          },
        }),
      );
    }
    try {
      return reply.send(
        projectDurableRouteResponse({ items: durable.listRunTimeline(params.data.runId, query.data.limit) }),
      );
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send(projectDurableRouteResponse({ error: message }));
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/pause", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = actorBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send(
        projectDurableRouteResponse({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        }),
      );
    }
    try {
      const run = durable.pauseRun(params.data.runId, resolveActorId(request));
      markMutationCommitted(request);
      return reply.send(projectDurableRouteResponse(run));
    } catch (error) {
      return sendDurableMutationError(reply, request, error, 409);
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/resume", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = actorBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send(
        projectDurableRouteResponse({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        }),
      );
    }
    try {
      const run = durable.resumeRun(params.data.runId, resolveActorId(request));
      markMutationCommitted(request);
      return reply.send(projectDurableRouteResponse(run));
    } catch (error) {
      return sendDurableMutationError(reply, request, error, 409);
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/cancel", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = actorBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send(
        projectDurableRouteResponse({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        }),
      );
    }
    try {
      const run = durable.cancelRun(params.data.runId, resolveActorId(request));
      markMutationCommitted(request);
      return reply.send(projectDurableRouteResponse(run));
    } catch (error) {
      return sendDurableMutationError(reply, request, error, 409);
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/retry", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = retryBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send(
        projectDurableRouteResponse({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        }),
      );
    }
    try {
      const run = durable.retryRun(params.data.runId, body.data.reason, resolveActorId(request));
      markMutationCommitted(request);
      return reply.send(projectDurableRouteResponse(run));
    } catch (error) {
      return sendDurableMutationError(reply, request, error, 409);
    }
  });

  fastify.post("/api/v1/durable/runs/:runId/events/wake", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = wakeBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(
        projectDurableRouteResponse({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        }),
      );
    }
    try {
      const result = durable.wakeRun(params.data.runId, body.data);
      if (result.outcome === "failed") {
        return reply.code(503).send(projectDurableRouteResponse(result));
      }
      markMutationCommitted(request);
      return reply.send(projectDurableRouteResponse(result));
    } catch (error) {
      return sendDurableMutationError(reply, request, error, 409);
    }
  });

  fastify.post("/api/v1/durable/dead-letters/:entryId/recover", operatorOnly, async (request, reply) => {
    const params = deadLetterParamsSchema.safeParse(request.params);
    const body = deadLetterRecoverBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send(
        projectDurableRouteResponse({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        }),
      );
    }
    try {
      const run = durable.recoverDeadLetter(
        params.data.entryId,
        resolveActorId(request),
        body.data.maxAttempts ? { maxAttempts: body.data.maxAttempts } : undefined,
      );
      markMutationCommitted(request);
      return reply.send(projectDurableRouteResponse(run));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return sendDurableMutationError(reply, request, error, notFound ? 404 : 409);
    }
  });
};
