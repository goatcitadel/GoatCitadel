import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";
import { normalizeMemoryForgetCriteria } from "../services/security-utils.js";

const composeSchema = z.object({
  scope: z.enum(["chat", "orchestration"]),
  prompt: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  phaseId: z.string().min(1).optional(),
  citadelId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  workspace: z.string().min(1).optional(),
  relationScope: z.enum(["self", "peer", "project"]).optional(),
  maxContextTokens: z.number().int().positive().optional(),
  forceRefresh: z.boolean().optional(),
  queryEmbedding: z.array(z.number()).min(1).max(4096).optional(),
});

const statsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(60),
});

const retrievalBenchmarkSchema = z.object({
  prompts: z.array(z.string().trim().min(1)).min(1).max(25),
  workspace: z.string().trim().min(1).optional(),
  relationScope: z.enum(["self", "peer", "project"]).optional(),
  maxContextTokens: z.number().int().positive().optional(),
});

const itemParamsSchema = z.object({
  itemId: z.string().trim().min(1),
});

const structuredIdParamsSchema = z.object({
  id: z.string().trim().min(1),
});

const structuredHistoryParamsSchema = z.object({
  kind: z.enum(["entity", "relation", "decision"]),
  id: z.string().trim().min(1),
});

const contextParamsSchema = z.object({
  contextId: z.string().trim().min(1),
});

const traceCandidateParamsSchema = z.object({
  candidateId: z.string().trim().min(1),
});

const workspaceQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const maintenancePolicyPatchSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  runMode: z.enum(["manual", "scheduled", "hybrid"]).optional(),
  timingStrategy: z.enum(["fixed", "recommendation_first"]).optional(),
  schedule: z
    .object({
      frequency: z.enum(["daily", "weekly"]),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      weekday: z.number().int().min(0).max(6).optional(),
    })
    .nullable()
    .optional(),
  timeZone: z.string().trim().min(1).optional(),
  minHoursSinceLastSuccess: z
    .number()
    .int()
    .min(0)
    .max(24 * 365)
    .optional(),
  minChangedSessions: z.number().int().min(1).max(10_000).optional(),
  providerId: z.string().trim().min(1).nullable().optional(),
  model: z.string().trim().min(1).nullable().optional(),
  executionTarget: z.enum(["auto", "local", "cloud"]).optional(),
  unavailableModelPolicy: z.enum(["skip", "error"]).optional(),
});

const maintenanceRunNowSchema = z.object({
  workspaceId: z.string().trim().min(1),
  triggerSource: z.enum(["manual", "recommendation"]).optional(),
});

const maintenanceRunParamsSchema = z.object({
  runId: z.string().trim().min(1),
});

const maintenanceRecommendationParamsSchema = z.object({
  recommendationId: z.string().trim().min(1),
});

const listItemsQuerySchema = z.object({
  namespace: z.string().optional(),
  status: z.enum(["active", "forgotten", "all"]).optional(),
  query: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

const structuredScopeSchema = z.enum(["global", "workspace", "session", "run"]);
const structuredStatusQuerySchema = z.enum(["active", "forgotten", "superseded", "all"]);
const structuredAuthoritySchema = z.enum(["operator", "agent_proposed", "trusted_lifecycle", "imported_skill"]);
const learningStatusQuerySchema = z.enum(["proposed", "trusted", "superseded", "forgotten", "all"]);
const learningTypeSchema = z.enum(["workflow", "bug_pattern", "operator_preference", "repo_fact", "tooling"]);
const structuredSourceRefSchema = z.object({
  sourceType: z.enum(["manual", "memory_item", "session", "run", "artifact", "summary", "turn", "external"]),
  sourceRef: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
});
const memoryFeedbackKindSchema = z.enum(["stale", "missing", "irrelevant", "useful"]);
const memoryFeedbackStatusQuerySchema = z.enum(["open", "reviewed", "dismissed", "all"]);
const memoryFeedbackTargetKindSchema = z.enum([
  "context",
  "citation",
  "memory_item",
  "entity",
  "relation",
  "decision",
  "learning",
  "trace_candidate",
]);
const traceCandidateTypeSchema = z.enum([
  "fact",
  "decision",
  "tool_outcome",
  "operator_preference",
  "repo_fact",
  "workflow",
]);
const traceCandidateStatusQuerySchema = z.enum(["proposed", "rejected", "promoted", "all"]);

const queryBooleanSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return value;
}, z.boolean());

const structuredListQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  status: structuredStatusQuerySchema.optional(),
  query: z.string().trim().min(1).optional(),
  entityId: z.string().trim().min(1).optional(),
  dueForReview: queryBooleanSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const learningListQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  status: learningStatusQuerySchema.optional(),
  query: z.string().trim().min(1).optional(),
  key: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const memoryRecallSchema = z.object({
  mode: z.enum(["targeted", "summary", "post_compaction_resume"]),
  scope: z.enum(["chat", "orchestration"]).optional(),
  prompt: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  phaseId: z.string().trim().min(1).optional(),
  workspace: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  relationScope: z.enum(["self", "peer", "project"]).optional(),
  maxContextTokens: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(25).optional(),
  queryEmbedding: z.array(z.number()).min(1).max(4096).optional(),
});

const feedbackListQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  kind: z.union([memoryFeedbackKindSchema, z.literal("all")]).optional(),
  status: memoryFeedbackStatusQuerySchema.optional(),
  targetKind: memoryFeedbackTargetKindSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const feedbackCreateSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  kind: memoryFeedbackKindSchema,
  targetKind: memoryFeedbackTargetKindSchema,
  targetRef: z.string().trim().min(1).optional(),
  contextId: z.string().trim().min(1).optional(),
  citationId: z.string().trim().min(1).optional(),
  note: z.string().trim().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const memoryQualityIssueKindSchema = z.enum([
  "stale_low_value",
  "near_duplicate",
  "likely_contradiction",
  "source_drift",
  "retrieval_gap",
]);
const memoryQualityIssueStatusSchema = z.enum(["open", "resolved", "dismissed"]);
const memoryQualityIssueStatusQuerySchema = z.union([memoryQualityIssueStatusSchema, z.literal("all")]);

const memoryQualityIssueListQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  kind: z.union([memoryQualityIssueKindSchema, z.literal("all")]).optional(),
  status: memoryQualityIssueStatusQuerySchema.optional(),
  targetKind: memoryFeedbackTargetKindSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const memoryQualityScanSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().max(500).optional(),
  dryRun: z.boolean().optional(),
});

const memoryQualityIssueParamsSchema = z.object({
  issueId: z.string().trim().min(1),
});

const memoryQualityIssuePatchSchema = z.object({
  status: memoryQualityIssueStatusSchema,
  resolutionNote: z.string().trim().min(1).optional(),
});

const traceCandidateListQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  status: traceCandidateStatusQuerySchema.optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const traceCandidateCreateSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  candidateType: traceCandidateTypeSchema.optional(),
  sourceText: z.string().trim().min(1).optional(),
  sourceSessionId: z.string().trim().min(1).optional(),
  sourceRunId: z.string().trim().min(1).optional(),
  sourceTurnId: z.string().trim().min(1).optional(),
  toolCallId: z.string().trim().min(1).optional(),
  proposedInsight: z.string().trim().min(1),
  confidence: z.number().min(0).max(1).optional(),
  sourceRefs: z.array(structuredSourceRefSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const learningFileRefSchema = z.object({
  path: z.string().trim().min(1),
  contentHash: z.string().trim().min(1).optional(),
});

const learningCreateSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  key: z.string().trim().min(1),
  type: learningTypeSchema.optional(),
  insight: z.string().trim().min(1),
  confidence: z.number().min(0).max(1).optional(),
  sourceRefs: z.array(structuredSourceRefSchema).optional(),
  fileRefs: z.array(learningFileRefSchema).optional(),
  authority: structuredAuthoritySchema.optional(),
});

const learningStalenessQuerySchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  learningId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const entityCreateSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  scope: structuredScopeSchema.optional(),
  title: z.string().trim().min(1),
  entityType: z.string().trim().min(1).optional(),
  aliases: z.array(z.string().trim().min(1)).optional(),
  summary: z.string().trim().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceRefs: z.array(structuredSourceRefSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
  authority: structuredAuthoritySchema.optional(),
});

const relationCreateSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  scope: structuredScopeSchema.optional(),
  title: z.string().trim().min(1).optional(),
  fromEntityId: z.string().trim().min(1),
  toEntityId: z.string().trim().min(1),
  relationType: z.string().trim().min(1),
  confidence: z.number().min(0).max(1).optional(),
  sourceRefs: z.array(structuredSourceRefSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
  authority: structuredAuthoritySchema.optional(),
});

const decisionCreateSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  scope: structuredScopeSchema.optional(),
  title: z.string().trim().min(1).optional(),
  decision: z.string().trim().min(1),
  alternatives: z.array(z.string().trim().min(1)).optional(),
  rationale: z.string().trim().min(1),
  expectedOutcome: z.string().trim().min(1).optional(),
  reviewAt: z.string().datetime().optional(),
  linkedEntityIds: z.array(z.string().trim().min(1)).optional(),
  linkedRelationIds: z.array(z.string().trim().min(1)).optional(),
  sessionId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceRefs: z.array(structuredSourceRefSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
  authority: structuredAuthoritySchema.optional(),
});

const decisionRetrospectiveSchema = z.object({
  outcome: z.enum(["unknown", "validated", "partially_validated", "invalidated"]),
  notes: z.string().trim().min(1),
  improvementCandidateId: z.string().trim().min(1).optional(),
});

const patchItemSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
  pinned: z.boolean().optional(),
  ttlOverrideSeconds: z.number().int().positive().max(31_536_000).nullable().optional(),
});

const batchMutationSchema = z.object({
  actionId: z.string().trim().min(1).max(120).optional(),
  source: z.string().trim().min(1).max(160).optional(),
  operations: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("patch_item"),
          itemId: z.string().trim().min(1),
          patch: patchItemSchema,
        }),
        z.object({
          kind: z.literal("forget_item"),
          itemId: z.string().trim().min(1),
        }),
      ]),
    )
    .min(1)
    .max(100),
});

const forgetItemSchema = z.object({});

const forgetManySchema = z
  .object({
    itemIds: z.array(z.string().min(1)).optional(),
    namespace: z.string().optional(),
    query: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const criteria = normalizeMemoryForgetCriteria(value);
    if (!criteria.hasCriteria) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one criterion: itemIds, namespace, or query.",
        path: ["itemIds"],
      });
    }
  });

export const memoryRoutes: FastifyPluginAsync = async (fastify) => {
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;
  const operatorOnly = withRouteAccess(fastify, "operator");
  const memory = fastify.services.memory;

  const sendMaintenanceError = (
    reply: { code: (status: number) => { send: (body: { error: string }) => unknown } },
    error: unknown,
  ) => {
    const message = error instanceof Error ? error.message : "Memory maintenance request failed.";
    const lower = message.toLowerCase();
    const status = lower.includes("not found") ? 404 : 409;
    return reply.code(status).send({ error: message });
  };

  fastify.post(
    "/api/v1/memory/context/compose",
    withRouteAccess(fastify, "authenticated-read"),
    async (request, reply) => {
      const parsed = composeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      return reply.send(await memory.composeContext(parsed.data));
    },
  );

  fastify.get(
    "/api/v1/memory/context/:contextId",
    withRouteAccess(fastify, "authenticated-read"),
    async (request, reply) => {
      const params = contextParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: params.error.flatten() });
      }
      try {
        return reply.send(memory.getContext(params.data.contextId));
      } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
      }
    },
  );

  fastify.get("/api/v1/memory/maintenance/policy", operatorOnly, async (request, reply) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(memory.getMaintenancePolicy(parsed.data.workspaceId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/memory/maintenance/policy", operatorOnly, async (request, reply) => {
    const parsed = maintenancePolicyPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const { workspaceId, ...patch } = parsed.data;
      return reply.send(memory.patchMaintenancePolicy(workspaceId, patch));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/maintenance/status", operatorOnly, async (request, reply) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(memory.getMaintenanceStatus(parsed.data.workspaceId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/maintenance/runs", operatorOnly, async (request, reply) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({
        items: memory.listMaintenanceRuns(parsed.data.workspaceId, parsed.data.limit ?? 50),
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  const handleMaintenanceRunNow = async (
    request: { body?: unknown },
    reply: {
      code: (status: number) => { send: (body: { error: unknown }) => unknown };
      send: (body: unknown) => unknown;
    },
  ) => {
    const parsed = maintenanceRunNowSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(memory.runMaintenanceNow(parsed.data));
    } catch (error) {
      return sendMaintenanceError(reply, error);
    }
  };

  fastify.post("/api/v1/memory/maintenance/run-now", operatorOnly, handleMaintenanceRunNow);
  fastify.post("/api/v1/memory/maintenance/run", operatorOnly, handleMaintenanceRunNow);

  fastify.get("/api/v1/memory/maintenance/runs/:runId/provenance", operatorOnly, async (request, reply) => {
    const parsed = maintenanceRunParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(memory.getMaintenanceRunProvenance(parsed.data.runId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/maintenance/recommendations", operatorOnly, async (request, reply) => {
    const parsed = workspaceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({
        items: memory.listMaintenanceRecommendations(parsed.data.workspaceId, parsed.data.limit ?? 50),
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post(
    "/api/v1/memory/maintenance/recommendations/:recommendationId/accept",
    operatorOnly,
    async (request, reply) => {
      const parsed = maintenanceRecommendationParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      try {
        return reply.send(memory.acceptMaintenanceRecommendation(parsed.data.recommendationId));
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.post(
    "/api/v1/memory/maintenance/recommendations/:recommendationId/reject",
    operatorOnly,
    async (request, reply) => {
      const parsed = maintenanceRecommendationParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      try {
        return reply.send(memory.rejectMaintenanceRecommendation(parsed.data.recommendationId));
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.get("/api/v1/memory/qmd/stats", withRouteAccess(fastify, "authenticated-read"), async (request, reply) => {
    const parsed = statsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const to = parsed.data.to ?? new Date().toISOString();
    const from = parsed.data.from ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const stats = memory.getQmdStats(from, to);
    const recent = memory.listRecentContexts(parsed.data.limit);
    return reply.send({
      ...stats,
      recent,
    });
  });

  fastify.get(
    "/api/v1/memory/retrieval/status",
    withRouteAccess(fastify, "authenticated-read"),
    async (_request, reply) => {
      return reply.send(memory.getRetrievalStatus());
    },
  );

  fastify.post("/api/v1/memory/retrieval-benchmark", operatorOnly, async (request, reply) => {
    const parsed = retrievalBenchmarkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await memory.runRetrievalBenchmark(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/recall", withRouteAccess(fastify, "authenticated-read"), async (request, reply) => {
    const parsed = memoryRecallSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await memory.recall(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/feedback", operatorOnly, async (request, reply) => {
    const parsed = feedbackListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({ items: memory.listFeedback(parsed.data) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/feedback", operatorOnly, async (request, reply) => {
    const parsed = feedbackCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(memory.recordFeedback(parsed.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/quality/issues", operatorOnly, async (request, reply) => {
    const parsed = memoryQualityIssueListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({ items: memory.listQualityIssues(parsed.data) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/quality/scan", operatorOnly, async (request, reply) => {
    const parsed = memoryQualityScanSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(memory.runQualityScan(parsed.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/memory/quality/issues/:issueId", operatorOnly, async (request, reply) => {
    const params = memoryQualityIssueParamsSchema.safeParse(request.params);
    const body = memoryQualityIssuePatchSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(memory.patchQualityIssue(params.data.issueId, body.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/trace-candidates", operatorOnly, async (request, reply) => {
    const parsed = traceCandidateListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({ items: memory.listTraceCandidates(parsed.data) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/trace-candidates", operatorOnly, async (request, reply) => {
    const parsed = traceCandidateCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(202).send(await memory.proposeTraceCandidate(parsed.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/trace-candidates/:candidateId/promote", operatorOnly, async (request, reply) => {
    const parsed = traceCandidateParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(memory.promoteTraceCandidate(parsed.data.candidateId, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/items", operatorOnly, async (request, reply) => {
    const parsed = listItemsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({
        items: memory.listItems(parsed.data),
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/items/batch-mutate", operatorOnly, async (request, reply) => {
    const body = batchMutationSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.send(
        memory.batchMutateItems(
          {
            actionId: body.data.actionId,
            source: body.data.source,
            operations: body.data.operations,
          },
          resolveActorId(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/memory/items/:itemId", operatorOnly, async (request, reply) => {
    const params = itemParamsSchema.safeParse(request.params);
    const body = patchItemSchema.safeParse(request.body ?? {});
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
        memory.patchItem(
          params.data.itemId,
          {
            title: body.data.title,
            content: body.data.content,
            metadata: body.data.metadata,
            pinned: body.data.pinned,
            ttlOverrideSeconds: body.data.ttlOverrideSeconds,
          },
          resolveActorId(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/items/:itemId/forget", operatorOnly, async (request, reply) => {
    const params = itemParamsSchema.safeParse(request.params);
    const body = forgetItemSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(memory.forgetItem(params.data.itemId, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/items/:itemId/history", operatorOnly, async (request, reply) => {
    const params = itemParamsSchema.safeParse(request.params);
    const query = statsQuerySchema.safeParse(request.query);
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
        items: memory.listItemHistory(params.data.itemId, query.data.limit),
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/forget", operatorOnly, async (request, reply) => {
    const body = forgetManySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.send(
        memory.forget({
          itemIds: body.data.itemIds,
          namespace: body.data.namespace,
          query: body.data.query,
          actorId: resolveActorId(request),
        }),
      );
    } catch (error) {
      const message = (error as Error).message;
      if (message.toLowerCase().includes("at least one criterion")) {
        return reply.code(400).send({ error: message });
      }
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/learnings", operatorOnly, async (request, reply) => {
    const parsed = learningListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({ items: memory.listLearnings(parsed.data) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/learnings", operatorOnly, async (request, reply) => {
    const parsed = learningCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(memory.createLearning(parsed.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/learnings/propose", operatorOnly, async (request, reply) => {
    const parsed = learningCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(202).send(memory.proposeLearning(parsed.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/learnings/:id/supersede", operatorOnly, async (request, reply) => {
    const params = structuredIdParamsSchema.safeParse(request.params);
    const body = learningCreateSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(memory.supersedeLearning(params.data.id, body.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/learnings/:id/forget", operatorOnly, async (request, reply) => {
    const parsed = structuredIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(memory.forgetLearning(parsed.data.id, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/learnings/staleness", operatorOnly, async (request, reply) => {
    const parsed = learningStalenessQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(memory.checkLearningStaleness(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/entities", operatorOnly, async (request, reply) => {
    const parsed = structuredListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({ items: memory.listEntities(parsed.data) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/entities", operatorOnly, async (request, reply) => {
    const parsed = entityCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(memory.createEntity(parsed.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/entities/:id/forget", operatorOnly, async (request, reply) => {
    const parsed = structuredIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(memory.forgetEntity(parsed.data.id, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/relations", operatorOnly, async (request, reply) => {
    const parsed = structuredListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({ items: memory.listRelations(parsed.data) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/relations", operatorOnly, async (request, reply) => {
    const parsed = relationCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(memory.createRelation(parsed.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/decisions", operatorOnly, async (request, reply) => {
    const parsed = structuredListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({ items: memory.listDecisions(parsed.data) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/decisions", operatorOnly, async (request, reply) => {
    const parsed = decisionCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(memory.createDecision(parsed.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/decisions/:id/retrospective", operatorOnly, async (request, reply) => {
    const params = structuredIdParamsSchema.safeParse(request.params);
    const body = decisionRetrospectiveSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(memory.addDecisionRetrospective(params.data.id, body.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/decisions/:id/forget", operatorOnly, async (request, reply) => {
    const parsed = structuredIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(memory.forgetDecision(parsed.data.id, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/structured/:kind/:id/history", operatorOnly, async (request, reply) => {
    const params = structuredHistoryParamsSchema.safeParse(request.params);
    const query = statsQuerySchema.safeParse(request.query);
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
        items: memory.listStructuredHistory(params.data.kind, params.data.id, query.data.limit),
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
