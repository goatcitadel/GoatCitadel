import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { projectImportProvenanceReferencesForPublic } from "../services/import-provenance-public-projection.js";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const skillsListQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
});

const skillHubListQuerySchema = z.object({
  workspaceId: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const skillHubOperationSchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    snapshotId: z.string().trim().min(1),
    operationKind: z.enum([
      "install_inactive",
      "stage_update_candidate",
      "stage_rollback_candidate",
      "activate",
      "revoke",
    ]),
    sessionId: z.string().trim().min(1).optional(),
    turnId: z.string().trim().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.turnId && !value.sessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["turnId"],
        message: "Skill Hub turn lineage requires a session ID.",
      });
    }
  });

const skillHubSourceReviewSchema = z
  .object({
    workspaceId: z.string().min(1).max(256),
    sourceRef: z.string().min(1).max(2_048),
    sourceType: z.enum(["git_url", "remote_bundle"]).optional(),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();

const skillHubRollbackReviewSchema = z
  .object({
    workspaceId: z.string().min(1).max(256),
    snapshotId: z.string().min(1).max(256),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();

export const skillsRoutes: FastifyPluginAsync = async (fastify) => {
  const skills = fastify.services.skills;
  const operatorOnly = withRouteAccess(fastify, "operator");
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;

  const skillParamsSchema = z.object({
    skillId: z.string().min(1),
  });

  const stateSchema = z.enum(["enabled", "sleep", "disabled"]);

  const updateStateSchema = z.object({
    expectedRevision: z.number().int().positive(),
    state: stateSchema,
    note: z.string().trim().max(300).optional(),
  });

  const bulkStateSchema = z.object({
    skillIds: z.array(z.string().min(1)).min(1),
    expectedRevisionsBySkillId: z.record(z.string(), z.number().int().positive()),
    state: stateSchema,
    note: z.string().trim().max(300).optional(),
  });

  const activationPolicyPatchSchema = z.object({
    expectedRevision: z.number().int().positive(),
    guardedAutoThreshold: z.number().min(0).max(1).optional(),
    requireFirstUseConfirmation: z.boolean().optional(),
  });

  const sourceQuerySchema = z.object({
    q: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });

  const importSourceTypeSchema = z.enum(["local_path", "local_zip", "git_url"]);
  const sourceProviderSchema = z.enum(["agentskill", "skillsmp", "clawhub", "github", "local", "external"]);
  const skillExportTargetSchema = z.enum(["codex", "claude", "generic-markdown"]);

  const importSourceObjectSchema = z.object({
    sourceRef: z.string().min(1),
    sourceType: importSourceTypeSchema.optional(),
    sourceProvider: sourceProviderSchema.optional(),
  });

  const refineGitSourceRef = (value: { sourceRef: string; sourceType?: string }): boolean =>
    !(value.sourceType === "git_url" && value.sourceRef.trim().startsWith("-"));
  const gitSourceRefIssue = {
    message: "Git source ref must not begin with '-'.",
    path: ["sourceRef"],
  };

  const validateImportSchema = importSourceObjectSchema.refine(refineGitSourceRef, gitSourceRefIssue);

  const installImportSchema = importSourceObjectSchema
    .extend({
      force: z.boolean().optional(),
      confirmHighRisk: z.boolean().optional(),
    })
    .refine(refineGitSourceRef, gitSourceRefIssue);

  const skillExportSchema = z.object({
    skillIds: z.array(z.string().min(1)).min(1).max(50),
    target: skillExportTargetSchema,
    includeReferences: z.boolean().optional(),
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

  fastify.get("/api/v1/skills", async (request, reply) => {
    const parsed = skillsListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const workspaceId = parsed.data.workspaceId;
    if (workspaceId !== undefined) {
      const effective = await fastify.services.capabilityScope.resolveEffectiveSkills(workspaceId);
      return reply.send({ items: skills.listSkills(effective) });
    }
    return reply.send({ items: skills.listSkills() });
  });

  fastify.get("/api/v1/skills/hub", operatorOnly, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = skillHubListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(skills.listSkillHub(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/skills/hub/operations", operatorOnly, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = skillHubOperationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(
        await skills.createSkillHubApproval({
          ...parsed.data,
          actorId: request.authActorId,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/skills/hub/reviews", operatorOnly, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = skillHubSourceReviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const reviewed = await skills.reviewSkillHubSource({
        ...parsed.data,
        actorId: request.authActorId,
      });
      return reply.code(reviewed.replayed ? 200 : 201).send(reviewed);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/skills/hub/rollback-reviews", operatorOnly, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = skillHubRollbackReviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const reviewed = await skills.prepareSkillHubRollbackReview({
        ...parsed.data,
        actorId: request.authActorId,
      });
      return reply.code(reviewed.replayed ? 200 : 201).send(reviewed);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
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
    return reply.send(
      projectImportProvenanceReferencesForPublic(await skills.listSkillSources(parsed.data.q, parsed.data.limit)),
    );
  });

  fastify.get("/api/v1/skills/export/targets", async (_request, reply) => {
    return reply.send({ items: skills.listSkillExportTargets() });
  });

  fastify.post("/api/v1/skills/export/preview", async (request, reply) => {
    const parsed = skillExportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(skills.previewSkillExport({ ...parsed.data, actorId: request.authActorId }));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/skills/export/package", async (request, reply) => {
    const parsed = skillExportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(skills.packageSkillExport({ ...parsed.data, actorId: request.authActorId }));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
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
    return reply.send(
      projectImportProvenanceReferencesForPublic(await skills.lookupSkillSources(parsed.data.q, parsed.data.limit)),
    );
  });

  fastify.post("/api/v1/skills/import/validate", async (request, reply) => {
    const parsed = validateImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(projectImportProvenanceReferencesForPublic(await skills.validateSkillImport(parsed.data)));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  // HX-402 P2: the legacy executable install is retired. Validation stays
  // advisory; the response is a structured redirect into the governed Skill
  // Hub review surface and never publishes bytes or alters callability.
  fastify.post("/api/v1/skills/import/install", async (request, reply) => {
    const parsed = installImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(projectImportProvenanceReferencesForPublic(await skills.installSkillImport(parsed.data)));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/skills/import/history", async (request, reply) => {
    const parsed = importHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(
      projectImportProvenanceReferencesForPublic({
        items: skills.listSkillImportHistory(parsed.data.limit),
      }),
    );
  });

  fastify.get("/api/v1/skills/evaluations/:runId", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await skills.getSkillEvaluationRun(params.data.runId));
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
      return reply.code(201).send(await skills.createSkillEvaluationProposal(params.data.runId));
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
      return reply.send(await skills.previewSkillEvaluation(skillId, input));
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
      return reply.code(201).send(await skills.runSkillEvaluation(skillId, input));
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
      return reply.send(await skills.listSkillEvaluationRuns(query.data.skillId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // HX-402 P2: operator skill-state verbs are approval-first. Each verb
  // commits one canonical `skill.lifecycle` approval (202 + pending-approval
  // envelope); the recovered approval effect is the only executor. A
  // byte-identical current state answers 200 with a no-op envelope.
  fastify.patch("/api/v1/skills/by-id/state", async (request, reply) => {
    const body = updateStateByIdSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      const outcome = await skills.setSkillState(body.data.skillId, body.data.state, body.data.note, {
        expectedRevision: body.data.expectedRevision,
        requesterId: resolveActorId(request),
      });
      return reply.code(outcome.pendingApproval ? 202 : 200).send(outcome);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
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
      return reply.send(await skills.previewSkillEvaluation(params.data.skillId, body.data));
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
      return reply.code(201).send(await skills.runSkillEvaluation(params.data.skillId, body.data));
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
      return reply.send(await skills.listSkillEvaluationRuns(params.data.skillId));
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

    const decision = await skills.resolveSkillActivation(parsed.data);
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
      const outcome = await skills.setSkillState(params.data.skillId, body.data.state, body.data.note, {
        expectedRevision: body.data.expectedRevision,
        requesterId: resolveActorId(request),
      });
      return reply.code(outcome.pendingApproval ? 202 : 200).send(outcome);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/skills/bulk-state", async (request, reply) => {
    const parsed = bulkStateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const outcome = await skills.bulkSetSkillState(parsed.data.skillIds, parsed.data.state, parsed.data.note, {
        expectedRevisionsBySkillId: parsed.data.expectedRevisionsBySkillId,
        requesterId: resolveActorId(request),
      });
      return reply.code(outcome.pendingApproval ? 202 : 200).send(outcome);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/skills/activation-policies", async (_request, reply) => {
    return reply.send(await skills.getSkillActivationPolicy());
  });

  fastify.patch("/api/v1/skills/activation-policies", async (request, reply) => {
    const parsed = activationPolicyPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { expectedRevision, ...input } = parsed.data;
    try {
      const outcome = await skills.updateSkillActivationPolicy(input, {
        expectedRevision,
        requesterId: resolveActorId(request),
      });
      return reply.code(outcome.pendingApproval ? 202 : 200).send(outcome);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
