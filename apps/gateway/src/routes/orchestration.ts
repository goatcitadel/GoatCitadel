import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const planSchema = z.object({
  planId: z.string().min(1),
  goal: z.string().min(1),
  mode: z.enum(["auto", "hitl"]),
  maxIterations: z.number().int().positive(),
  maxRuntimeMinutes: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
  waves: z
    .array(
      z.object({
        waveId: z.string().min(1),
        verify: z.array(z.string()).default([]),
        budgetUsd: z.number().nonnegative(),
        ownership: z.array(
          z.object({
            agentId: z.string().min(1),
            paths: z.array(z.string()).min(1),
          }),
        ),
        phases: z
          .array(
            z.object({
              phaseId: z.string().min(1),
              ownerAgentId: z.string().min(1),
              specPath: z.string().min(1),
              loopMode: z.enum(["fresh-context", "compaction"]),
              requiresApproval: z.boolean(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

const recipeBodySchema = z
  .object({
    source: z.string().min(1).optional(),
    recipe: z.unknown().optional(),
  })
  .refine((value) => value.source !== undefined || value.recipe !== undefined, {
    message: "Provide source or recipe.",
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
    const planId = (request.params as { planId: string }).planId;
    try {
      const run = await orchestration.runPlan(planId);
      return reply.send(run);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/orchestration/phases/:phaseId/approve", operatorOnly, async (request, reply) => {
    const phaseId = (request.params as { phaseId: string }).phaseId;
    const schema = z.object({
      runId: z.string().min(1),
      approvedBy: z.string().min(1).default("operator"),
      costIncrementUsd: z.number().nonnegative().optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(
        await orchestration.approvePhase(
          parsed.data.runId,
          phaseId,
          parsed.data.approvedBy,
          parsed.data.costIncrementUsd ?? 0,
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/orchestration/runs/:runId", operatorOnly, async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    try {
      return reply.send(orchestration.getRun(runId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/orchestration/runs/:runId/checkpoints", operatorOnly, async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    try {
      return reply.send({ items: orchestration.listRunCheckpoints(runId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/orchestration/runs/:runId/context", operatorOnly, async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    try {
      return reply.send({ items: orchestration.listRunContexts(runId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
