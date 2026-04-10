import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const accessEvaluateSchema = z.object({
  toolName: z.string().min(1),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  args: z.record(z.unknown()).optional(),
});

const grantScopeSchema = z.enum(["global", "session", "workspace", "agent", "task"]);

const grantsQuerySchema = z.object({
  scope: grantScopeSchema.optional(),
  scopeRef: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

const createGrantSchema = z.object({
  toolPattern: z.string().min(1),
  decision: z.enum(["allow", "deny"]),
  scope: grantScopeSchema,
  scopeRef: z.string().optional(),
  grantType: z.enum(["one_time", "ttl", "persistent"]).optional(),
  constraints: z.object({
    allowedHosts: z.array(z.string().min(1)).optional(),
    allowedPaths: z.array(z.string().min(1)).optional(),
    referenceRoots: z.array(z.object({
      label: z.string().min(1),
      rootPath: z.string().min(1),
      access: z.literal("read_only"),
    })).optional(),
    maxWritesPerHour: z.number().int().positive().optional(),
    maxCallsPerHour: z.number().int().positive().optional(),
    mutationAllowed: z.boolean().optional(),
  }).optional(),
  createdBy: z.string().min(1),
  expiresAt: z.string().datetime().optional(),
  usesRemaining: z.number().int().positive().optional(),
});

const revokeParamsSchema = z.object({
  grantId: z.string().uuid(),
});

export const toolsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/tools/catalog", async (_request, reply) => {
    return reply.send({ items: fastify.gateway.listToolCatalog() });
  });

  fastify.post("/api/v1/tools/access/evaluate", async (request, reply) => {
    const parsed = accessEvaluateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    return reply.send(fastify.gateway.evaluateToolAccess(parsed.data));
  });

  fastify.get("/api/v1/tools/grants", async (request, reply) => {
    const parsed = grantsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    return reply.send({
      items: fastify.gateway.listToolGrants(parsed.data.scope, parsed.data.scopeRef, parsed.data.limit),
    });
  });

  fastify.post("/api/v1/tools/grants", async (request, reply) => {
    const parsed = createGrantSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const created = fastify.gateway.createToolGrant(parsed.data);
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/tools/grants/:grantId/revoke", async (request, reply) => {
    const params = revokeParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }

    const revoked = fastify.gateway.revokeToolGrant(params.data.grantId);
    if (!revoked) {
      return reply.code(404).send({ error: `Tool grant ${params.data.grantId} not found or already revoked` });
    }

    return reply.send({ revoked: true, grantId: params.data.grantId });
  });
};
