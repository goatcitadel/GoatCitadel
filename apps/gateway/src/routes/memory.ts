import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { normalizeMemoryForgetCriteria } from "../services/security-utils.js";

const composeSchema = z.object({
  scope: z.enum(["chat", "orchestration"]),
  prompt: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  phaseId: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  maxContextTokens: z.number().int().positive().optional(),
  forceRefresh: z.boolean().optional(),
});

const statsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(60),
});

const itemParamsSchema = z.object({
  itemId: z.string().trim().min(1),
});

const contextParamsSchema = z.object({
  contextId: z.string().trim().min(1),
});

const workspaceQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const maintenancePolicyPatchSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  runMode: z.enum(["manual", "scheduled", "hybrid"]).optional(),
  timingStrategy: z.enum(["fixed", "recommendation_first"]).optional(),
  schedule: z.object({
    frequency: z.enum(["daily", "weekly"]),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekday: z.number().int().min(0).max(6).optional(),
  }).nullable().optional(),
  timeZone: z.string().trim().min(1).optional(),
  minHoursSinceLastSuccess: z.number().int().min(0).max(24 * 365).optional(),
  minChangedSessions: z.number().int().min(1).max(10_000).optional(),
  providerId: z.string().trim().min(1).nullable().optional(),
  model: z.string().trim().min(1).nullable().optional(),
  executionTarget: z.enum(["auto", "local", "cloud"]).optional(),
  unavailableModelPolicy: z.enum(["skip", "error"]).optional(),
});

const maintenanceRunNowSchema = z.object({
  workspaceId: z.string().trim().min(1),
  triggerSource: z.enum(["manual", "recommendation"]).optional(),
});

const maintenanceRunParamsSchema = z.object({
  runId: z.string().trim().min(1),
});

const maintenanceRecommendationParamsSchema = z.object({
  recommendationId: z.string().trim().min(1),
});

const listItemsQuerySchema = z.object({
  namespace: z.string().optional(),
  status: z.enum(["active", "forgotten", "all"]).optional(),
  query: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

const patchItemSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
  pinned: z.boolean().optional(),
  ttlOverrideSeconds: z.number().int().positive().max(31_536_000).nullable().optional(),
});

const forgetItemSchema = z.object({});

const forgetManySchema = z.object({
  itemIds: z.array(z.string().min(1)).optional(),
  namespace: z.string().optional(),
  query: z.string().optional(),
}).superRefine((value, ctx) => {
  const criteria = normalizeMemoryForgetCriteria(value);
  if (!criteria.hasCriteria) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one criterion: itemIds, namespace, or query.",
      path: ["itemIds"],
    });
  }
});

export const memoryRoutes: FastifyPluginAsync = async (fastify) => {
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;

  const sendMaintenanceError = (reply: { code: (status: number) => { send: (body: { error: string }) => unknown } }, error: unknown) => {
    const message = error instanceof Error ? error.message : "Memory maintenance request failed.";
    const lower = message.toLowerCase();
    const status = lower.includes("not found") ? 404 : 409;
    return reply.code(status).send({ error: message });
  };

  fastify.post("/api/v1/memory/context/compose", async (request, reply) => {
    const parsed = composeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.gateway.composeMemoryContext(parsed.data));
  });

  fastify.get("/api/v1/memory/context/:contextId", async (request, reply) => {
    const params = contextParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getMemoryContext(params.data.contextId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/memory/maintenance/policy", async (request, reply) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getMemoryMaintenancePolicy(parsed.data.workspaceId));
    } catch (error) {
      return sendMaintenanceError(reply, error);
    }
  });

  fastify.patch("/api/v1/memory/maintenance/policy", async (request, reply) => {
    const parsed = maintenancePolicyPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const { workspaceId, ...patch } = parsed.data;
      return reply.send(fastify.gateway.patchMemoryMaintenancePolicy(workspaceId, patch));
    } catch (error) {
      return sendMaintenanceError(reply, error);
    }
  });

  fastify.get("/api/v1/memory/maintenance/status", async (request, reply) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getMemoryMaintenanceStatus(parsed.data.workspaceId));
    } catch (error) {
      return sendMaintenanceError(reply, error);
    }
  });

  fastify.get("/api/v1/memory/maintenance/runs", async (request, reply) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({
        items: fastify.gateway.listMemoryMaintenanceRuns(parsed.data.workspaceId, parsed.data.limit ?? 50),
      });
    } catch (error) {
      return sendMaintenanceError(reply, error);
    }
  });

  const handleMaintenanceRunNow = async (
    request: { body?: unknown },
    reply: {
      code: (status: number) => { send: (body: { error: unknown }) => unknown };
      send: (body: unknown) => unknown;
    },
  ) => {
    const parsed = maintenanceRunNowSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.runMemoryMaintenanceNow(parsed.data));
    } catch (error) {
      return sendMaintenanceError(reply, error);
    }
  };

  fastify.post("/api/v1/memory/maintenance/run-now", handleMaintenanceRunNow);
  fastify.post("/api/v1/memory/maintenance/run", handleMaintenanceRunNow);

  fastify.get("/api/v1/memory/maintenance/runs/:runId/provenance", async (request, reply) => {
    const parsed = maintenanceRunParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getMemoryMaintenanceRunProvenance(parsed.data.runId));
    } catch (error) {
      return sendMaintenanceError(reply, error);
    }
  });

  fastify.get("/api/v1/memory/maintenance/recommendations", async (request, reply) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({
        items: fastify.gateway.listMemoryMaintenanceRecommendations(parsed.data.workspaceId, parsed.data.limit ?? 50),
      });
    } catch (error) {
      return sendMaintenanceError(reply, error);
    }
  });

  fastify.post("/api/v1/memory/maintenance/recommendations/:recommendationId/accept", async (request, reply) => {
    const parsed = maintenanceRecommendationParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.acceptMemoryMaintenanceRecommendation(parsed.data.recommendationId));
    } catch (error) {
      return sendMaintenanceError(reply, error);
    }
  });

  fastify.post("/api/v1/memory/maintenance/recommendations/:recommendationId/reject", async (request, reply) => {
    const parsed = maintenanceRecommendationParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.rejectMemoryMaintenanceRecommendation(parsed.data.recommendationId));
    } catch (error) {
      return sendMaintenanceError(reply, error);
    }
  });

  fastify.get("/api/v1/memory/qmd/stats", async (request, reply) => {
    const parsed = statsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const to = parsed.data.to ?? new Date().toISOString();
    const from = parsed.data.from ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const stats = fastify.gateway.getMemoryQmdStats(from, to);
    const recent = fastify.gateway.listRecentMemoryContexts(parsed.data.limit);
    return reply.send({
      ...stats,
      recent,
    });
  });

  fastify.get("/api/v1/memory/items", async (request, reply) => {
    const parsed = listItemsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({
        items: fastify.gateway.listMemoryItems(parsed.data),
      });
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/memory/items/:itemId", async (request, reply) => {
    const params = itemParamsSchema.safeParse(request.params);
    const body = patchItemSchema.safeParse(request.body ?? {});
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
        fastify.gateway.patchMemoryItem(
          params.data.itemId,
          {
            title: body.data.title,
            content: body.data.content,
            metadata: body.data.metadata,
            pinned: body.data.pinned,
            ttlOverrideSeconds: body.data.ttlOverrideSeconds,
          },
          resolveActorId(request),
        ),
      );
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.post("/api/v1/memory/items/:itemId/forget", async (request, reply) => {
    const params = itemParamsSchema.safeParse(request.params);
    const body = forgetItemSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.forgetMemoryItem(params.data.itemId, resolveActorId(request)));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/memory/items/:itemId/history", async (request, reply) => {
    const params = itemParamsSchema.safeParse(request.params);
    const query = statsQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send({
        items: fastify.gateway.listMemoryItemHistory(params.data.itemId, query.data.limit),
      });
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.post("/api/v1/memory/forget", async (request, reply) => {
    const body = forgetManySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.forgetMemory({
        itemIds: body.data.itemIds,
        namespace: body.data.namespace,
        query: body.data.query,
        actorId: resolveActorId(request),
      }));
    } catch (error) {
      const message = (error as Error).message;
      if (message.toLowerCase().includes("at least one criterion")) {
        return reply.code(400).send({ error: message });
      }
      return reply.code(409).send({ error: message });
    }
  });
};
