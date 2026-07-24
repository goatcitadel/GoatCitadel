import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  assertDurableChildWatcherCreateRequestBounds,
  assertDurableChildWatcherIdBounds,
  assertDurableChildWatcherRunIdBounds,
  DURABLE_CHILD_WATCHER_LIMITS,
} from "@goatcitadel/contracts";
import { resolveApprovalActorId } from "./approvals.js";
import { withRouteAccess } from "./route-access.js";
import { projectDurableRouteResponse } from "../services/durable-public-projection.js";
import { markMutationCommitted, markMutationCommittedFromError } from "../plugins/idempotency.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
});

const durableRunIdSchema = z
  .string()
  .min(1)
  .max(DURABLE_CHILD_WATCHER_LIMITS.runIdBytes)
  .superRefine((value, context) => {
    try {
      assertDurableChildWatcherRunIdBounds(value);
    } catch (error) {
      context.addIssue({ code: "custom", message: (error as Error).message });
    }
  });
const durableWatcherIdSchema = z
  .string()
  .min(1)
  .max(DURABLE_CHILD_WATCHER_LIMITS.watcherIdBytes)
  .superRefine((value, context) => {
    try {
      assertDurableChildWatcherIdBounds(value);
    } catch (error) {
      context.addIssue({ code: "custom", message: (error as Error).message });
    }
  });

const runParamsSchema = z.object({ runId: durableRunIdSchema });

const childRunParamsSchema = z.object({
  runId: durableRunIdSchema,
  childRunId: durableRunIdSchema,
});

const watcherParamsSchema = z.object({
  watcherId: durableWatcherIdSchema,
});

const backgroundTaskParamsSchema = z.object({
  runId: durableRunIdSchema,
  watcherId: durableWatcherIdSchema,
});

const backgroundTaskScopeSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(200).refine(isBoundedScopeId, "Invalid workspace scope"),
    sessionId: z.string().trim().min(1).max(200).refine(isBoundedScopeId, "Invalid session scope"),
  })
  .strict();

const backgroundTaskControlBodySchema = backgroundTaskScopeSchema
  .extend({
    action: z.enum(["detach", "reattach", "cancel"]),
    expectedWatcherRevision: z.number().int().positive(),
    expectedChildVersion: z.number().int().nonnegative().optional(),
    reason: z.string().trim().min(1).max(240).optional(),
  })
  .superRefine((value, context) => {
    if (value.action === "cancel" && value.expectedChildVersion === undefined) {
      context.addIssue({
        code: "custom",
        path: ["expectedChildVersion"],
        message: "expectedChildVersion is required when action is cancel",
      });
    }
    if (value.action !== "cancel" && (value.expectedChildVersion !== undefined || value.reason !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "expectedChildVersion and reason are only valid when action is cancel",
      });
    }
  });

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function isBoundedScopeId(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= 200 && !hasAsciiControlCharacter(value);
}

const watchChildBodySchema = z
  .object({
    watcherId: z.string().trim().min(1).max(DURABLE_CHILD_WATCHER_LIMITS.watcherIdBytes).optional(),
    source: z.string().trim().min(1).max(DURABLE_CHILD_WATCHER_LIMITS.sourceBytes).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

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

  fastify.get("/api/v1/durable/runs/:runId/child-watchers", operatorOnly, async (request, reply) => {
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
        projectDurableRouteResponse({ items: durable.listChildWatchers(params.data.runId, query.data.limit) }),
      );
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send(projectDurableRouteResponse({ error: message }));
    }
  });

  fastify.get("/api/v1/durable/runs/:runId/background-tasks", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const query = backgroundTaskScopeSchema.safeParse(request.query);
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
      return reply
        .header("Cache-Control", "private, no-store")
        .send(projectDurableRouteResponse(durable.getBackgroundTaskRail(params.data.runId, query.data)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Background-task rail failed";
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send(projectDurableRouteResponse({ error: message }));
    }
  });

  fastify.post(
    "/api/v1/durable/runs/:runId/background-tasks/:watcherId/control",
    operatorOnly,
    async (request, reply) => {
      const params = backgroundTaskParamsSchema.safeParse(request.params);
      const body = backgroundTaskControlBodySchema.safeParse(request.body ?? {});
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
        const result = durable.controlBackgroundTask(
          params.data.runId,
          params.data.watcherId,
          body.data,
          resolveActorId(request),
        );
        markMutationCommitted(request);
        return reply.header("Cache-Control", "private, no-store").send(projectDurableRouteResponse(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Background-task control failed";
        return sendDurableMutationError(reply, request, error, message.toLowerCase().includes("not found") ? 404 : 409);
      }
    },
  );

  fastify.post("/api/v1/durable/runs/:runId/children/:childRunId/watch", operatorOnly, async (request, reply) => {
    const params = childRunParamsSchema.safeParse(request.params);
    const body = watchChildBodySchema.safeParse(request.body ?? {});
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
      assertDurableChildWatcherCreateRequestBounds({
        parentRunId: params.data.runId,
        childRunId: params.data.childRunId,
        ...body.data,
      });
    } catch (error) {
      return reply.code(400).send(
        projectDurableRouteResponse({
          error: error instanceof Error ? error.message : "Invalid durable child watcher input",
        }),
      );
    }
    try {
      const watcher = durable.watchChildRun({
        parentRunId: params.data.runId,
        childRunId: params.data.childRunId,
        ...body.data,
      });
      markMutationCommitted(request);
      return reply.code(201).send(projectDurableRouteResponse(watcher));
    } catch (error) {
      return sendDurableMutationError(reply, request, error, 409);
    }
  });

  fastify.post("/api/v1/durable/child-watchers/:watcherId/detach", operatorOnly, async (request, reply) => {
    const params = watcherParamsSchema.safeParse(request.params);
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
      const watcher = durable.detachChildWatcher(params.data.watcherId);
      markMutationCommitted(request);
      return reply.send(projectDurableRouteResponse(watcher));
    } catch (error) {
      return sendDurableMutationError(reply, request, error, 409);
    }
  });

  fastify.post("/api/v1/durable/child-watchers/:watcherId/reattach", operatorOnly, async (request, reply) => {
    const params = watcherParamsSchema.safeParse(request.params);
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
      const result = durable.reattachChildWatcher(params.data.watcherId);
      markMutationCommitted(request);
      return reply.send(projectDurableRouteResponse(result));
    } catch (error) {
      return sendDurableMutationError(reply, request, error, 409);
    }
  });

  fastify.post("/api/v1/durable/child-watchers/:watcherId/close", operatorOnly, async (request, reply) => {
    const params = watcherParamsSchema.safeParse(request.params);
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
      const watcher = durable.closeChildWatcher(params.data.watcherId);
      markMutationCommitted(request);
      return reply.send(projectDurableRouteResponse(watcher));
    } catch (error) {
      return sendDurableMutationError(reply, request, error, 409);
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
