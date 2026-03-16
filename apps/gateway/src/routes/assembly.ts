import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const participantSchema = z.object({
  participantId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  label: z.string().min(1).optional(),
});

const contextRefSchema = z.object({
  kind: z.enum(["session", "task", "file", "url", "note"]),
  ref: z.string().min(1),
  label: z.string().min(1).optional(),
});

const settingsSchema = z.object({
  mode: z.enum(["consensus", "debate", "critique", "brainstorm"]),
  participantModels: z.array(participantSchema).min(2).max(5),
  maxRounds: z.number().int().positive(),
  maxCritiquePasses: z.number().int().positive(),
  maxInterModelExchanges: z.number().int().positive(),
  convergenceThreshold: z.number().min(0).max(1),
  stagnationWindow: z.number().int().positive(),
  timeBudgetMs: z.number().int().positive(),
  tokenBudget: z.number().int().positive(),
  costBudgetUsd: z.number().positive(),
  domainPreset: z.enum(["coding", "architecture", "writing", "seo", "analysis", "strategy"]),
  synthesisStyle: z.enum(["concise", "balanced", "detailed"]),
  exportTargets: z.array(z.enum(["artifact", "chat", "task"])).default(["artifact"]),
});

const adversarialSettingsSchema = z.object({
  enabled: z.boolean(),
  reviewerCount: z.number().int().positive(),
  selectionStrategy: z.enum(["user_selected", "auto_selected_by_reputation", "rotate_among_participants"]),
  strictness: z.enum(["light", "balanced", "aggressive"]),
  requireMitigations: z.boolean(),
  requireEvidenceTags: z.boolean(),
  defenseRoundEnabled: z.boolean(),
  repetitiveObjectionCutoff: z.boolean(),
  minorityReportRequired: z.boolean(),
  reviewerModelRefs: z.array(z.string().min(1)).optional(),
});

const createRunSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  sourceSessionId: z.string().min(1).optional(),
  sourceTaskId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  prompt: z.string().min(1),
  contextRefs: z.array(contextRefSchema).optional(),
  settings: settingsSchema,
  adversarialSettings: adversarialSettingsSchema.optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(250).optional(),
});

export const assemblyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/assembly/runs", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({ items: fastify.gateway.listAssemblyRuns(parsed.data.limit ?? 50) });
  });

  fastify.post("/api/v1/assembly/runs", async (request, reply) => {
    const parsed = createRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.code(201).send(await fastify.gateway.createAssemblyRun(parsed.data));
  });

  fastify.get("/api/v1/assembly/runs/:runId", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    return reply.send(fastify.gateway.getAssemblyRunDetail(runId));
  });

  fastify.get("/api/v1/assembly/reputation", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({ items: fastify.gateway.listAssemblyReputations(parsed.data.limit ?? 50) });
  });
};
