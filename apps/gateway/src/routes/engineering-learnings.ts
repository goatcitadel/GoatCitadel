import type { FastifyInstance } from "fastify";
import { z } from "zod";

const statusSchema = z.enum(["proposed", "active", "stale", "superseded", "rejected", "archived"]);
const actionSchema = z.enum(["activate", "update", "consolidate", "replace", "reject", "archive"]);
const paramsSchema = z.object({ learningId: z.string().trim().min(1).max(256) });
const listQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(256),
  projectId: z.string().trim().min(1).max(256).optional(),
  status: statusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const contextQuerySchema = listQuerySchema.omit({ status: true }).extend({
  paths: z.union([z.string(), z.array(z.string())]).optional(),
});
const proposalSchema = z.object({
  workspaceId: z.string().trim().min(1).max(256),
  projectId: z.string().trim().min(1).max(256).optional(),
  source: z.object({
    sessionId: z.string().trim().min(1).max(256).optional(),
    turnId: z.string().trim().min(1).max(256).optional(),
    runId: z.string().trim().min(1).max(256),
    patchArtifactId: z.string().trim().min(1).max(512).optional(),
    commitSha: z.string().trim().min(7).max(128).optional(),
  }),
  disposition: z.literal("completed"),
  changedFiles: z.array(z.string().trim().min(1).max(2_048)).min(1).max(1_000),
  verificationEvidence: z.array(z.string().trim().min(1).max(2_048)).min(1).max(1_000),
  failedClaimVerification: z.boolean().optional(),
  title: z.string().trim().min(1).max(300),
  problem: z.string().trim().min(1).max(8_000),
  rootCause: z.string().trim().min(1).max(8_000),
  resolution: z.string().trim().min(1).max(8_000),
  prevention: z.string().trim().min(1).max(8_000),
  failedAttempts: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  applicablePaths: z.array(z.string().trim().min(1).max(2_048)).max(1_000).optional(),
});
const actionBodySchema = z.object({
  action: actionSchema,
  actorId: z.string().trim().min(1).max(256).optional(),
  targetLearningIds: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
  updates: z
    .object({
      title: z.string().trim().min(1).max(300).optional(),
      problem: z.string().trim().min(1).max(8_000).optional(),
      rootCause: z.string().trim().min(1).max(8_000).optional(),
      resolution: z.string().trim().min(1).max(8_000).optional(),
      prevention: z.string().trim().min(1).max(8_000).optional(),
      failedAttempts: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
      applicablePaths: z.array(z.string().trim().min(1).max(2_048)).max(1_000).optional(),
    })
    .optional(),
});

export async function engineeringLearningRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/v1/engineering-learnings", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      return reply.send(fastify.gatewayRuntime.engineeringLearningService.list(query.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/engineering-learnings/context", async (request, reply) => {
    const query = contextQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    const rawPaths = query.data.paths;
    const paths = rawPaths === undefined ? undefined : Array.isArray(rawPaths) ? rawPaths : rawPaths.split(",");
    try {
      return reply.send(fastify.gatewayRuntime.engineeringLearningService.retrieveContext({ ...query.data, paths }));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/engineering-learnings/proposals", async (request, reply) => {
    const body = proposalSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return reply.code(201).send(fastify.gatewayRuntime.engineeringLearningService.propose(body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/engineering-learnings/maintenance/refresh", async (_request, reply) => {
    try {
      return reply.send({ staleCount: fastify.gatewayRuntime.engineeringLearningService.refreshAll() });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/engineering-learnings/:learningId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      return reply.send(fastify.gatewayRuntime.engineeringLearningService.get(params.data.learningId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/engineering-learnings/:learningId/overlaps", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      return reply.send({
        items: fastify.gatewayRuntime.engineeringLearningService.findOverlaps(params.data.learningId),
      });
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/engineering-learnings/:learningId/actions", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = actionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.code(202).send(
        await fastify.gatewayRuntime.engineeringLearningService.requestAction(params.data.learningId, {
          ...body.data,
          actorId: body.data.actorId ?? request.authActorId,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
}
