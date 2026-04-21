import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";

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

export const orchestrationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/orchestration/plans", async (request, reply) => {
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const run = await fastify.gateway.createOrchestrationPlan(parsed.data);
    return reply.code(201).send(run);
  });

  fastify.post("/api/v1/orchestration/plans/:planId/run", async (request, reply) => {
    const planId = (request.params as { planId: string }).planId;
    const run = await fastify.gateway.runOrchestrationPlan(planId);
    return reply.send(run);
  });

  fastify.post("/api/v1/orchestration/phases/:phaseId/approve", async (request, reply) => {
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

    return reply.send(
      await fastify.gateway.approvePhase(
        parsed.data.runId,
        phaseId,
        parsed.data.approvedBy,
        parsed.data.costIncrementUsd ?? 0,
      ),
    );
  });

  fastify.get("/api/v1/orchestration/runs/:runId", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    try {
      return reply.send(fastify.gateway.getRun(runId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/orchestration/runs/:runId/checkpoints", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    try {
      return reply.send({ items: fastify.gateway.listRunCheckpoints(runId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/orchestration/runs/:runId/context", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    try {
      return reply.send({ items: fastify.gateway.listRunContexts(runId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
