import type { FastifyPluginAsync } from "fastify";
import { planSchema } from "@goatcitadel/orchestration";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const recipeBodySchema = z
  .object({
    source: z.string().min(1).optional(),
    recipe: z.unknown().optional(),
  })
  .refine((value) => value.source !== undefined || value.recipe !== undefined, {
    message: "Provide source or recipe.",
  });

const routeIdSchema = z.string().trim().min(1).max(256);
const workspaceQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(80).optional(),
});
const planRunParamsSchema = z.object({
  planId: routeIdSchema,
});
const runParamsSchema = z.object({
  runId: routeIdSchema,
});
const phaseApproveParamsSchema = z.object({
  phaseId: routeIdSchema,
});
const phaseApproveBodySchema = z.object({
  runId: routeIdSchema,
  approvedBy: z.string().trim().min(1).max(128).default("operator"),
  costIncrementUsd: z.number().finite().nonnegative().optional(),
  workspaceId: z.string().trim().min(1).max(80).optional(),
});

export const orchestrationRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");
  const orchestration = fastify.services.orchestration;

  fastify.get("/api/v1/orchestration/recipes/templates", operatorOnly, async (_request, reply) => {
    return reply.send(orchestration.listRecipeTemplates());
  });

  fastify.post("/api/v1/orchestration/recipes/preview", operatorOnly, async (request, reply) => {
    const parsed = recipeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(orchestration.previewRecipe(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/orchestration/recipes/plans", operatorOnly, async (request, reply) => {
    const parsed = recipeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(await orchestration.createPlanFromRecipe(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/orchestration/plans", operatorOnly, async (request, reply) => {
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const run = await orchestration.createPlan(parsed.data);
      return reply.code(201).send(run);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/orchestration/plans/:planId/run", operatorOnly, async (request, reply) => {
    const params = planRunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const run = await orchestration.runPlan(params.data.planId);
      return reply.send(run);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/orchestration/phases/:phaseId/approve", operatorOnly, async (request, reply) => {
    const params = phaseApproveParamsSchema.safeParse(request.params);
    const body = phaseApproveBodySchema.safeParse(request.body);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }

    try {
      return reply
        .code(202)
        .send(
          await orchestration.approvePhase(
            body.data.runId,
            params.data.phaseId,
            body.data.approvedBy,
            body.data.costIncrementUsd ?? 0,
            body.data.workspaceId,
          ),
        );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/orchestration/runs/:runId", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    try {
      return reply.send(orchestration.getRun(params.data.runId, query.data.workspaceId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/orchestration/runs/:runId/checkpoints", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    try {
      return reply.send({ items: orchestration.listRunCheckpoints(params.data.runId, query.data.workspaceId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/orchestration/runs/:runId/context", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    try {
      orchestration.getRun(params.data.runId, query.data.workspaceId);
      return reply.send({ items: orchestration.listRunContexts(params.data.runId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
