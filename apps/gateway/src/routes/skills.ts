import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

export const skillsRoutes: FastifyPluginAsync = async (fastify) => {
  const skills = fastify.services.skills;

  const sendBankrMigrationResponse = () => ({
    error: skills.getBankrOptionalMigrationMessage(),
    code: "bankr_builtin_disabled",
    docsPath: "docs/OPTIONAL_BANKR_SKILL.md",
    templatePath: "templates/skills/bankr-optional/SKILL.md",
  });

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

  const bankrActionTypeSchema = z.enum(["read", "trade", "transfer", "sign", "submit", "deploy"]);

  const bankrPolicyPatchSchema = z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(["read_only", "read_write"]).optional(),
    dailyUsdCap: z.number().positive().optional(),
    perActionUsdCap: z.number().positive().optional(),
    requireApprovalEveryWrite: z.boolean().optional(),
    allowedChains: z.array(z.string().min(1)).optional(),
    allowedActionTypes: z.array(bankrActionTypeSchema).optional(),
    blockedSymbols: z.array(z.string().min(1)).optional(),
  });

  const bankrPreviewSchema = z.object({
    prompt: z.string().optional(),
    actionType: bankrActionTypeSchema.optional(),
    chain: z.string().optional(),
    symbol: z.string().optional(),
    usdEstimate: z.number().positive().optional(),
    sessionId: z.string().optional(),
    actorId: z.string().optional(),
  });

  const bankrAuditQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    cursor: z.string().optional(),
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

  fastify.get("/api/v1/skills/bankr/policy", async (_request, reply) => {
    if (!skills.isBankrBuiltinEnabled()) {
      return reply.code(410).send(sendBankrMigrationResponse());
    }
    return reply.send(skills.getBankrSafetyPolicy());
  });

  fastify.patch("/api/v1/skills/bankr/policy", async (request, reply) => {
    if (!skills.isBankrBuiltinEnabled()) {
      return reply.code(410).send(sendBankrMigrationResponse());
    }
    const parsed = bankrPolicyPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(skills.updateBankrSafetyPolicy(parsed.data));
  });

  fastify.post("/api/v1/skills/bankr/preview", async (request, reply) => {
    if (!skills.isBankrBuiltinEnabled()) {
      return reply.code(410).send(sendBankrMigrationResponse());
    }
    const parsed = bankrPreviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(skills.previewBankrAction(parsed.data));
  });

  fastify.get("/api/v1/skills/bankr/audit", async (request, reply) => {
    if (!skills.isBankrBuiltinEnabled()) {
      return reply.code(410).send(sendBankrMigrationResponse());
    }
    const parsed = bankrAuditQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: skills.listBankrActionAudit(parsed.data.limit ?? 100, parsed.data.cursor),
    });
  });
};
