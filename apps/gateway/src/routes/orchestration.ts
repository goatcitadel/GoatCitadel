import type { FastifyPluginAsync } from "fastify";
import type { OrchestrationRunPolicyContext } from "@goatcitadel/contracts";
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
const activepiecesTemplateExportBodySchema = recipeBodySchema.and(
  z.object({
    flowName: z.string().trim().min(1).max(160).optional(),
    webhookPath: z.string().trim().min(1).max(240).optional(),
  }),
);
const n8nTemplateExportBodySchema = recipeBodySchema.and(
  z.object({
    workflowName: z.string().trim().min(1).max(160).optional(),
    webhookPath: z.string().trim().min(1).max(240).optional(),
  }),
);
const automationDraftBodySchema = z.object({
  taskDescription: z.string().trim().min(1),
  trigger: z.string().trim().min(1).optional(),
  frequency: z.string().trim().min(1).optional(),
  successCriteria: z.array(z.string().trim().min(1)).optional(),
  constraints: z.array(z.string().trim().min(1)).optional(),
  workspaceId: z.string().trim().min(1).max(80).optional(),
});

const routeIdSchema = z.string().trim().min(1).max(256);
const workspaceQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).max(80).optional(),
});
const runPolicyBodySchema = z.object({
  workspaceId: z.string().trim().min(1).max(80).optional(),
  permissionProfileId: z.string().trim().min(1).max(128).optional(),
  localOperatorOverrideId: z.string().trim().min(1).max(128).optional(),
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
  costIncrementUsd: z.number().finite().nonnegative().optional(),
  workspaceId: z.string().trim().min(1).max(80).optional(),
});
const runCancelBodySchema = z.object({
  workspaceId: z.string().trim().min(1).max(80).optional(),
});

export const orchestrationRoutes: FastifyPluginAsync = async (fastify) => {
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;
  const buildRunPolicyContext = (
    request: { authActorId?: string; authActorSource?: OrchestrationRunPolicyContext["authActorSource"]; ip?: string },
    body: z.infer<typeof runPolicyBodySchema>,
  ): OrchestrationRunPolicyContext => ({
    operatorId: resolveActorId(request),
    authActorId: request.authActorId,
    authActorSource: request.authActorSource,
    workspaceId: body.workspaceId,
    permissionProfileId: body.permissionProfileId,
    localOperatorOverrideId: body.localOperatorOverrideId,
  });
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

  fastify.post("/api/v1/orchestration/recipes/draft-automation", operatorOnly, async (request, reply) => {
    const parsed = automationDraftBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(orchestration.draftAutomationRecipe(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/orchestration/recipes/activepieces-template/export", operatorOnly, async (request, reply) => {
    const parsed = activepiecesTemplateExportBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(orchestration.exportActivepiecesTemplate(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/orchestration/recipes/n8n-template/export", operatorOnly, async (request, reply) => {
    const parsed = n8nTemplateExportBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(orchestration.exportN8nTemplate(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/orchestration/recipes/plans", operatorOnly, async (request, reply) => {
    const parsed = recipeBodySchema.safeParse(request.body);
    const policyBody = runPolicyBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (!policyBody.success) {
      return reply.code(400).send({ error: policyBody.error.flatten() });
    }
    try {
      return reply
        .code(201)
        .send(await orchestration.createPlanFromRecipe(parsed.data, buildRunPolicyContext(request, policyBody.data)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/orchestration/plans", operatorOnly, async (request, reply) => {
    const parsed = planSchema.safeParse(request.body);
    const policyBody = runPolicyBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (!policyBody.success) {
      return reply.code(400).send({ error: policyBody.error.flatten() });
    }

    try {
      const run = await orchestration.createPlan(parsed.data, buildRunPolicyContext(request, policyBody.data));
      return reply.code(201).send(run);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/orchestration/plans/:planId/run", operatorOnly, async (request, reply) => {
    const params = planRunParamsSchema.safeParse(request.params);
    const body = runPolicyBodySchema.safeParse(request.body ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      const run = await orchestration.runPlan(params.data.planId, buildRunPolicyContext(request, body.data));
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
            resolveActorId(request),
            body.data.costIncrementUsd ?? 0,
            body.data.workspaceId,
          ),
        );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/orchestration/runs/:runId/cancel", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = runCancelBodySchema.safeParse(request.body ?? {});
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply
        .code(202)
        .send(await orchestration.cancelRun(params.data.runId, resolveActorId(request), body.data.workspaceId));
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

  fastify.get("/api/v1/orchestration/runs/:runId/trace", operatorOnly, async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    try {
      return reply.send(orchestration.getRunTrace(params.data.runId, query.data.workspaceId));
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
