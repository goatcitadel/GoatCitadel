import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionParamsSchema } from "./chat.shared.js";
import { sendRouteError } from "./_error-handler.js";

const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
  request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;

const chatOnlyModeSchema = z.enum(["chat", "cowork", "code"]).transform(() => "chat" as const);

const prefsPatchSchema = z.object({
  expectedRevision: z.number().int().positive(),
  mode: chatOnlyModeSchema.optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  planningMode: z.enum(["off", "advisory"]).optional(),
  webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
  memoryMode: z.enum(["auto", "on", "off"]).optional(),
  thinkingLevel: z.enum(["off", "minimal", "standard", "extended", "deep", "max", "ultra"]).optional(),
  speedMode: z.enum(["standard", "fast"]).optional(),
  subagentPolicy: z.enum(["off", "ask_when_useful", "auto_when_useful"]).optional(),
  toolAutonomy: z.enum(["safe_auto", "manual"]).optional(),
  imageProviderId: z.string().optional(),
  imageModel: z.string().optional(),
  visionFallbackModel: z.string().optional(),
  orchestrationEnabled: z.boolean().optional(),
  orchestrationIntensity: z.enum(["minimal", "balanced", "deep"]).optional(),
  orchestrationVisibility: z.enum(["hidden", "summarized", "expandable", "explicit"]).optional(),
  orchestrationProviderPreference: z.enum(["speed", "quality", "balanced", "low_cost"]).optional(),
  orchestrationReviewDepth: z.enum(["off", "standard", "strict"]).optional(),
  orchestrationParallelism: z.enum(["auto", "sequential", "parallel"]).optional(),
  codeAutoApply: z.enum(["manual", "low_risk_auto", "aggressive_auto"]).optional(),
  proactiveMode: z.enum(["off", "suggest", "auto_safe", "auto_full"]).optional(),
  autonomyBudget: z
    .object({
      maxActionsPerHour: z.coerce.number().int().positive().max(200).optional(),
      maxActionsPerTurn: z.coerce.number().int().positive().max(25).optional(),
      cooldownSeconds: z.coerce.number().int().min(0).max(3600).optional(),
    })
    .optional(),
  retrievalMode: z.enum(["standard", "layered"]).optional(),
  reflectionMode: z.enum(["off", "on"]).optional(),
});

const commandParseSchema = z.object({
  commandText: z.string().min(1),
  idempotencyKey: z.string().min(1).max(384).optional(),
  policyRunId: z.string().optional(),
  policyTaskId: z.string().optional(),
  permissionProfileId: z.string().optional(),
  localOperatorOverrideId: z.string().optional(),
  surface: chatOnlyModeSchema.optional(),
});

const researchRunSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(["quick", "deep"]).default("quick"),
  providerId: z.string().optional(),
  model: z.string().optional(),
  policyRunId: z.string().optional(),
  policyTaskId: z.string().optional(),
  permissionProfileId: z.string().optional(),
  localOperatorOverrideId: z.string().optional(),
  surface: chatOnlyModeSchema.optional(),
});

const researchParamsSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
});

const proactivePolicyPatchSchema = z.object({
  expectedRevision: z.number().int().positive(),
  proactiveMode: z.enum(["off", "suggest", "auto_safe", "auto_full"]).optional(),
  autonomyBudget: z
    .object({
      maxActionsPerHour: z.coerce.number().int().positive().max(200).optional(),
      maxActionsPerTurn: z.coerce.number().int().positive().max(25).optional(),
      cooldownSeconds: z.coerce.number().int().min(0).max(3600).optional(),
    })
    .optional(),
  retrievalMode: z.enum(["standard", "layered"]).optional(),
  reflectionMode: z.enum(["off", "on"]).optional(),
});

const proactiveTriggerSchema = z.object({
  source: z.enum(["scheduler", "manual", "chat"]).optional(),
  reason: z.string().optional(),
  surface: z.enum(["chat", "cowork", "code"]).optional(),
  permissionProfileId: z.string().optional(),
  localOperatorOverrideId: z.string().optional(),
});

const proactiveRunListSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
});

const learnedMemoryParamsSchema = z.object({
  sessionId: z.string().min(1),
  itemId: z.string().min(1),
});

const learnedMemoryListSchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

const learnedMemoryPatchSchema = z.object({
  status: z.enum(["active", "superseded", "conflict", "disabled"]).optional(),
  content: z.string().optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  resolutionNote: z.string().optional(),
});

const specialistCandidateListSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(200),
});

const specialistCandidateRoutingHintsSchema = z.object({
  preferredModes: z.array(z.enum(["chat", "cowork", "code"])).min(1),
  objectiveKeywords: z.array(z.string().min(1)).optional(),
  requiresProjectBinding: z.boolean().optional(),
  maxInvocationsPerRun: z.coerce.number().int().positive().max(25).optional(),
});

const specialistCandidateEvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  kind: z.enum(["role_gap", "tool_gap", "skill_gap", "successful_workaround"]),
  summary: z.string().min(1),
  turnId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  skillRef: z.string().min(1).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
});

const specialistCandidateSuggestionSchema = z.object({
  candidateId: z.string().min(1),
  title: z.string().min(1),
  role: z.string().min(1),
  summary: z.string().min(1),
  reason: z.string().min(1),
  source: z.enum(["manual", "runtime_gap", "replay", "catalog"]),
  confidence: z.coerce.number().min(0).max(1),
  suggestedStatus: z.enum(["suggested", "drafted", "disabled"]),
  suggestedRoutingMode: z.enum(["disabled", "manual_only", "strong_match_only"]),
  requiresApproval: z.literal(true),
  suggestedTools: z.array(z.string().min(1)).optional(),
  suggestedSkills: z.array(z.string().min(1)).optional(),
  routingHints: specialistCandidateRoutingHintsSchema,
  evidence: z.array(specialistCandidateEvidenceSchema),
});

const specialistCandidateCreateSchema = z.object({
  turnId: z.string().min(1).optional(),
  suggestion: specialistCandidateSuggestionSchema,
});

const specialistCandidatePatchSchema = z.object({
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  status: z.enum(["suggested", "drafted", "disabled", "approved", "active", "retired"]).optional(),
  routingMode: z.enum(["disabled", "manual_only", "strong_match_only"]).optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  suggestedTools: z.array(z.string().min(1)).optional(),
  suggestedSkills: z.array(z.string().min(1)).optional(),
  routingHints: specialistCandidateRoutingHintsSchema.optional(),
  evidence: z.array(specialistCandidateEvidenceSchema).optional(),
});

const specialistCandidateParamsSchema = z.object({
  sessionId: z.string().min(1),
  candidateId: z.string().min(1),
});

const steerRequestSchema = z.object({
  instruction: z.string().min(1),
});

const goalRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  goal: z.string().min(1),
  turnBudget: z.coerce.number().int().positive().max(1000).optional(),
});

const goalDeleteQuerySchema = z.object({
  expectedRevision: z.coerce.number().int().positive(),
});

export function registerChatMiscRoutes(fastify: FastifyInstance): void {
  const chatSupport = () => fastify.services.chatSupport;

  fastify.get("/api/v1/chat/sessions/:sessionId/prefs", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(chatSupport().getChatSessionPrefs(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/chat/sessions/:sessionId/prefs", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = prefsPatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(chatSupport().updateChatSessionPrefs(params.data.sessionId, body.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/chat/catalog/commands", async (_request, reply) => {
    return reply.send({ items: chatSupport().listChatCommandCatalog() });
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/commands/parse", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = commandParseSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await chatSupport().parseChatCommand(params.data.sessionId, body.data.commandText, {
          resolvedBy: resolveActorId(request),
          operatorId: resolveActorId(request),
          authActorId: request.authActorId,
          authActorSource: request.authActorSource,
          idempotencyKey: body.data.idempotencyKey,
          policyRunId: body.data.policyRunId,
          policyTaskId: body.data.policyTaskId,
          permissionProfileId: body.data.permissionProfileId,
          localOperatorOverrideId: body.data.localOperatorOverrideId,
          surface: body.data.surface ?? "chat",
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/research/run", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = researchRunSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await chatSupport().runChatResearch(params.data.sessionId, {
          ...body.data,
          operatorId: resolveActorId(request),
          authActorId: request.authActorId,
          authActorSource: request.authActorSource,
          surface: body.data.surface ?? "chat",
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/research/:runId", async (request, reply) => {
    const params = researchParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(chatSupport().getChatResearchRun(params.data.sessionId, params.data.runId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/proactive/status", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(chatSupport().getChatSessionProactiveStatus(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/chat/sessions/:sessionId/proactive/policy", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = proactivePolicyPatchSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(chatSupport().updateChatSessionProactivePolicy(params.data.sessionId, body.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/proactive/trigger", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = proactiveTriggerSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await chatSupport().triggerChatSessionProactive(params.data.sessionId, {
          ...body.data,
          operatorId: resolveActorId(request),
          authActorId: request.authActorId,
          authActorSource: request.authActorSource,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/proactive/runs", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = proactiveRunListSchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send({
        items: chatSupport().listChatSessionProactiveRuns(params.data.sessionId, query.data.limit),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/learned-memory", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = learnedMemoryListSchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send(chatSupport().listChatSessionLearnedMemory(params.data.sessionId, query.data.limit));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/chat/sessions/:sessionId/learned-memory/:itemId", async (request, reply) => {
    const params = learnedMemoryParamsSchema.safeParse(request.params);
    const body = learnedMemoryPatchSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        chatSupport().updateChatSessionLearnedMemory(params.data.sessionId, params.data.itemId, body.data),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/learned-memory/rebuild", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await chatSupport().rebuildChatSessionLearnedMemory(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/specialist-candidates", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = specialistCandidateListSchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send(chatSupport().listChatSessionSpecialistCandidates(params.data.sessionId, query.data.limit));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/specialist-candidates", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = specialistCandidateCreateSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.code(201).send(chatSupport().createChatSessionSpecialistCandidate(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/chat/sessions/:sessionId/specialist-candidates/:candidateId", async (request, reply) => {
    const params = specialistCandidateParamsSchema.safeParse(request.params);
    const body = specialistCandidatePatchSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        chatSupport().updateChatSessionSpecialistCandidate(params.data.sessionId, params.data.candidateId, body.data),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/steer", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = steerRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await chatSupport().submitChatSteerInstruction(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/goal", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await chatSupport().getChatSessionGoal(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/goal", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = goalRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await chatSupport().setChatSessionGoal(params.data.sessionId, body.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/chat/sessions/:sessionId/goal", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = goalDeleteQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await chatSupport().clearChatSessionGoal(params.data.sessionId, query.data.expectedRevision));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
}
