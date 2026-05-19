import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";

export const skillsRoutes: FastifyPluginAsync = async (fastify) => {
  const skills = fastify.services.skills;

  const skillParamsSchema = z.object({
    skillId: z.string().min(1),
  });

  const stateSchema = z.enum(["enabled", "sleep", "disabled"]);

  const updateStateSchema = z.object({
    state: stateSchema,
    note: z.string().trim().max(300).optional(),
  });

  const bulkStateSchema = z.object({
    skillIds: z.array(z.string().min(1)).min(1),
    state: stateSchema,
    note: z.string().trim().max(300).optional(),
  });

  const activationPolicyPatchSchema = z.object({
    guardedAutoThreshold: z.number().min(0).max(1).optional(),
    requireFirstUseConfirmation: z.boolean().optional(),
  });

  const sourceQuerySchema = z.object({
    q: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });

  const importSourceTypeSchema = z.enum(["local_path", "local_zip", "git_url"]);
  const sourceProviderSchema = z.enum(["agentskill", "skillsmp", "clawhub", "github", "local", "external"]);

  const validateImportSchema = z.object({
    sourceRef: z.string().min(1),
    sourceType: importSourceTypeSchema.optional(),
    sourceProvider: sourceProviderSchema.optional(),
  });

  const installImportSchema = validateImportSchema.extend({
    force: z.boolean().optional(),
    confirmHighRisk: z.boolean().optional(),
  });

  const importHistoryQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(300).optional(),
  });

  const skillEvaluationScenarioSchema = z.object({
    scenarioId: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    expectedOutcome: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)).optional(),
  });

  const skillEvaluationCriterionSchema = z.object({
    criterionId: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1),
    description: z.string().trim().min(1),
    requiredTerms: z.array(z.string().trim().min(1)).optional(),
  });

  const skillEvaluationBodySchema = z.object({
    scenarios: z.array(skillEvaluationScenarioSchema).min(1).max(8).optional(),
    criteria: z.array(skillEvaluationCriterionSchema).min(1).max(8).optional(),
    maxRounds: z.number().int().min(1).max(3).optional(),
    targetPassRate: z.number().min(0).max(1).optional(),
  });

  const skillIdQuerySchema = z.object({
    skillId: z.string().min(1),
  });

  const skillEvaluationByIdBodySchema = skillEvaluationBodySchema.extend({
    skillId: z.string().min(1),
  });

  const updateStateByIdSchema = updateStateSchema.extend({
    skillId: z.string().min(1),
  });

  fastify.get("/api/v1/skills", async (_request, reply) => {
    return reply.send({ items: skills.listSkills() });
  });

  fastify.post("/api/v1/skills/reload", async (_request, reply) => {
    const items = await skills.reloadSkills();
    return reply.send({ items });
  });

  fastify.get("/api/v1/skills/sources", async (request, reply) => {
    const parsed = sourceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await skills.listSkillSources(parsed.data.q, parsed.data.limit));
  });

  fastify.get("/api/v1/skills/lookup", async (request, reply) => {
    const parsed = sourceQuerySchema
      .extend({
        q: z.string().trim().min(1),
      })
      .safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await skills.lookupSkillSources(parsed.data.q, parsed.data.limit));
  });

  fastify.post("/api/v1/skills/import/validate", async (request, reply) => {
    const parsed = validateImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await skills.validateSkillImport(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/skills/import/install", async (request, reply) => {
    const parsed = installImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(await skills.installSkillImport(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/skills/import/history", async (request, reply) => {
    const parsed = importHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: skills.listSkillImportHistory(parsed.data.limit),
    });
  });

  fastify.get("/api/v1/skills/evaluations/:runId", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(skills.getSkillEvaluationRun(params.data.runId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/skills/evaluations/:runId/proposal", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.code(201).send(skills.createSkillEvaluationProposal(params.data.runId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/skills/by-id/evaluations/preview", async (request, reply) => {
    const body = skillEvaluationByIdBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    const { skillId, ...input } = body.data;
    try {
      return reply.send(skills.previewSkillEvaluation(skillId, input));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/skills/by-id/evaluations/run", async (request, reply) => {
    const body = skillEvaluationByIdBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    const { skillId, ...input } = body.data;
    try {
      return reply.code(201).send(skills.runSkillEvaluation(skillId, input));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/skills/by-id/evaluations", async (request, reply) => {
    const query = skillIdQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    try {
      return reply.send(skills.listSkillEvaluationRuns(query.data.skillId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/skills/by-id/state", async (request, reply) => {
    const body = updateStateByIdSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      const updated = skills.setSkillState(body.data.skillId, body.data.state, body.data.note);
      return reply.send(updated);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/skills/:skillId/evaluations/preview", async (request, reply) => {
    const params = skillParamsSchema.safeParse(request.params);
    const body = skillEvaluationBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(skills.previewSkillEvaluation(params.data.skillId, body.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/skills/:skillId/evaluations/run", async (request, reply) => {
    const params = skillParamsSchema.safeParse(request.params);
    const body = skillEvaluationBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.code(201).send(skills.runSkillEvaluation(params.data.skillId, body.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/skills/:skillId/evaluations", async (request, reply) => {
    const params = skillParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(skills.listSkillEvaluationRuns(params.data.skillId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/skills/resolve-activation", async (request, reply) => {
    const schema = z.object({
      text: z.string().min(1),
      explicitSkills: z.array(z.string()).optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const decision = skills.resolveSkillActivation(parsed.data);
    return reply.send(decision);
  });

  fastify.patch("/api/v1/skills/:skillId/state", async (request, reply) => {
    const params = skillParamsSchema.safeParse(request.params);
    const body = updateStateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const updated = skills.setSkillState(params.data.skillId, body.data.state, body.data.note);
      return reply.send(updated);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/skills/bulk-state", async (request, reply) => {
    const parsed = bulkStateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const items = skills.bulkSetSkillState(parsed.data.skillIds, parsed.data.state, parsed.data.note);
      return reply.send({ items });
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/skills/activation-policies", async (_request, reply) => {
    return reply.send(skills.getSkillActivationPolicy());
  });

  fastify.patch("/api/v1/skills/activation-policies", async (request, reply) => {
    const parsed = activationPolicyPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(skills.updateSkillActivationPolicy(parsed.data));
  });
};
