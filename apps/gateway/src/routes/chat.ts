import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { isGoatError } from "@goatcitadel/contracts";
import { sendRouteError } from "./_error-handler.js";

const projectViewSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  view: z.enum(["active", "archived", "all"]).default("active"),
  limit: z.coerce.number().int().positive().max(1000).default(300),
});

const createProjectSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  workspacePath: z.string().min(1),
  color: z.string().optional(),
});

const updateProjectSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  workspacePath: z.string().min(1).optional(),
  color: z.string().optional(),
});

const projectParamsSchema = z.object({
  projectId: z.string().min(1),
});

const deleteProjectQuerySchema = z.object({
  mode: z.enum(["hard", "soft"]).default("hard"),
});

const listChatSessionsSchema = z.object({
  scope: z.enum(["mission", "external", "all"]).optional(),
  workspaceId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  q: z.string().optional(),
  view: z.enum(["active", "archived", "all"]).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  cursor: z.string().optional(),
  includeHidden: z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1").optional(),
});

const sessionParamsSchema = z.object({
  sessionId: z.string().min(1),
});

const turnParamsSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});

const createSessionSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  title: z.string().optional(),
  projectId: z.string().optional(),
  mode: z.enum(["chat", "cowork", "code"]).optional(),
  origin: z.enum(["operator", "prompt_pack", "system"]).optional(),
  includeInHistory: z.boolean().optional(),
});

const bulkArchiveSessionsSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  scope: z.enum(["mission", "external", "all"]).default("mission"),
  includeHidden: z.boolean().optional(),
});

const updateSessionSchema = z.object({
  title: z.string().optional(),
});

const assignProjectSchema = z.object({
  projectId: z.string().optional(),
});

const bindingSchema = z.object({
  transport: z.enum(["llm", "integration"]),
  connectionId: z.string().optional(),
  target: z.string().optional(),
  writable: z.boolean().optional(),
});

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
  cursor: z.string().optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1),
  parts: z.array(z.union([
    z.object({
      type: z.literal("text"),
      text: z.string().min(1),
    }),
    z.object({
      type: z.literal("image_ref"),
      attachmentId: z.string().min(1),
      mimeType: z.string().optional(),
      detail: z.enum(["low", "high", "auto"]).optional(),
    }),
    z.object({
      type: z.literal("audio_ref"),
      attachmentId: z.string().min(1),
      mimeType: z.string().optional(),
    }),
    z.object({
      type: z.literal("video_ref"),
      attachmentId: z.string().min(1),
      mimeType: z.string().optional(),
    }),
    z.object({
      type: z.literal("file_ref"),
      attachmentId: z.string().min(1),
      mimeType: z.string().optional(),
    }),
  ])).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  useMemory: z.boolean().optional(),
  attachments: z.array(z.string()).optional(),
  mode: z.enum(["chat", "cowork", "code"]).optional(),
  webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
  memoryMode: z.enum(["auto", "on", "off"]).optional(),
  thinkingLevel: z.enum(["minimal", "standard", "extended"]).optional(),
  commandText: z.string().optional(),
  prefsOverride: z.object({
    mode: z.enum(["chat", "cowork", "code"]).optional(),
    providerId: z.string().optional(),
    model: z.string().optional(),
    webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
    memoryMode: z.enum(["auto", "on", "off"]).optional(),
    thinkingLevel: z.enum(["minimal", "standard", "extended"]).optional(),
    toolAutonomy: z.enum(["safe_auto", "manual"]).optional(),
    visionFallbackModel: z.string().optional(),
    orchestrationEnabled: z.boolean().optional(),
    orchestrationIntensity: z.enum(["minimal", "balanced", "deep"]).optional(),
    orchestrationVisibility: z.enum(["hidden", "summarized", "expandable", "explicit"]).optional(),
    orchestrationProviderPreference: z.enum(["speed", "quality", "balanced", "low_cost"]).optional(),
    orchestrationReviewDepth: z.enum(["off", "standard", "strict"]).optional(),
    orchestrationParallelism: z.enum(["auto", "sequential", "parallel"]).optional(),
    codeAutoApply: z.enum(["manual", "low_risk_auto", "aggressive_auto"]).optional(),
    proactiveMode: z.enum(["off", "suggest", "auto_safe"]).optional(),
    autonomyBudget: z.object({
      maxActionsPerHour: z.coerce.number().int().positive().max(200).optional(),
      maxActionsPerTurn: z.coerce.number().int().positive().max(25).optional(),
      cooldownSeconds: z.coerce.number().int().min(0).max(3600).optional(),
    }).optional(),
    retrievalMode: z.enum(["standard", "layered"]).optional(),
    reflectionMode: z.enum(["off", "on"]).optional(),
  }).optional(),
});

const prefsPatchSchema = z.object({
  mode: z.enum(["chat", "cowork", "code"]).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  planningMode: z.enum(["off", "advisory"]).optional(),
  webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
  memoryMode: z.enum(["auto", "on", "off"]).optional(),
  thinkingLevel: z.enum(["minimal", "standard", "extended"]).optional(),
  toolAutonomy: z.enum(["safe_auto", "manual"]).optional(),
  visionFallbackModel: z.string().optional(),
  orchestrationEnabled: z.boolean().optional(),
  orchestrationIntensity: z.enum(["minimal", "balanced", "deep"]).optional(),
  orchestrationVisibility: z.enum(["hidden", "summarized", "expandable", "explicit"]).optional(),
  orchestrationProviderPreference: z.enum(["speed", "quality", "balanced", "low_cost"]).optional(),
  orchestrationReviewDepth: z.enum(["off", "standard", "strict"]).optional(),
  orchestrationParallelism: z.enum(["auto", "sequential", "parallel"]).optional(),
  codeAutoApply: z.enum(["manual", "low_risk_auto", "aggressive_auto"]).optional(),
  proactiveMode: z.enum(["off", "suggest", "auto_safe"]).optional(),
  autonomyBudget: z.object({
    maxActionsPerHour: z.coerce.number().int().positive().max(200).optional(),
    maxActionsPerTurn: z.coerce.number().int().positive().max(25).optional(),
    cooldownSeconds: z.coerce.number().int().min(0).max(3600).optional(),
  }).optional(),
  retrievalMode: z.enum(["standard", "layered"]).optional(),
  reflectionMode: z.enum(["off", "on"]).optional(),
});

const retryTurnSchema = sendMessageSchema.partial().extend({
  content: z.string().optional(),
});

const editTurnSchema = sendMessageSchema;
const cancelTurnSchema = z.object({
  cancelledBy: z.string().min(1).optional(),
});

const commandParseSchema = z.object({
  commandText: z.string().min(1),
});

const researchRunSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(["quick", "deep"]).default("quick"),
  providerId: z.string().optional(),
  model: z.string().optional(),
});

const researchParamsSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
});

const delegateBodySchema = z.object({
  objective: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
  mode: z.enum(["sequential", "parallel"]).default("sequential"),
  providerId: z.string().optional(),
  model: z.string().optional(),
});

const delegationRunParamsSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
});

const proactivePolicyPatchSchema = z.object({
  proactiveMode: z.enum(["off", "suggest", "auto_safe"]).optional(),
  autonomyBudget: z.object({
    maxActionsPerHour: z.coerce.number().int().positive().max(200).optional(),
    maxActionsPerTurn: z.coerce.number().int().positive().max(25).optional(),
    cooldownSeconds: z.coerce.number().int().min(0).max(3600).optional(),
  }).optional(),
  retrievalMode: z.enum(["standard", "layered"]).optional(),
  reflectionMode: z.enum(["off", "on"]).optional(),
});

const proactiveTriggerSchema = z.object({
  source: z.enum(["scheduler", "manual", "chat"]).optional(),
  reason: z.string().optional(),
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
  source: z.enum(["manual", "runtime_gap", "replay"]),
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

const delegateSuggestSchema = z.object({
  objective: z.string().optional(),
  roles: z.array(z.string().min(1)).optional(),
  mode: z.enum(["sequential", "parallel"]).optional(),
});

const delegateAcceptSchema = z.object({
  suggestionId: z.string().optional(),
  objective: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
  mode: z.enum(["sequential", "parallel"]).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
});

const promptPackImportSchema = z.object({
  content: z.string().min(1),
  name: z.string().optional(),
  sourceLabel: z.string().optional(),
  packId: z.string().optional(),
});

const promptPackListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(2000).default(200),
});

const promptPackParamsSchema = z.object({
  packId: z.string().min(1),
});

const promptPackTestParamsSchema = z.object({
  packId: z.string().min(1),
  testId: z.string().min(1),
});

const promptPackRunBodySchema = z.object({
  sessionId: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  mode: z.enum(["chat", "cowork", "code"]).optional(),
  toolTier: z.enum(["no-tools", "implicit-tools", "explicit-tools"]).optional(),
  toolAutonomy: z.enum(["manual", "safe_auto"]).optional(),
  webMode: z.enum(["off", "auto", "quick", "deep"]).optional(),
  memoryMode: z.enum(["off", "on", "auto"]).optional(),
  thinkingLevel: z.enum(["minimal", "standard", "extended"]).optional(),
  placeholderValues: z.record(z.string(), z.string()).optional(),
});

const promptPackScoreBodySchema = z.object({
  runId: z.string().min(1),
  routingScore: z.coerce.number().int().min(0).max(2),
  honestyScore: z.coerce.number().int().min(0).max(2),
  handoffScore: z.coerce.number().int().min(0).max(2),
  robustnessScore: z.coerce.number().int().min(0).max(2),
  usabilityScore: z.coerce.number().int().min(0).max(2),
  notes: z.string().optional(),
});

const promptPackAutoScoreBodySchema = z.object({
  runId: z.string().min(1).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  force: z.boolean().optional(),
});

const promptPackAutoScoreBatchBodySchema = z.object({
  onlyUnscored: z.boolean().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  force: z.boolean().optional(),
});

const promptPackExportBodySchema = z.object({
  includeHistory: z.boolean().optional(),
});

const promptPackResetBodySchema = z.object({
  clearRuns: z.boolean().optional(),
  clearScores: z.boolean().optional(),
});

const promptPackBenchmarkRunBodySchema = z.object({
  testCodes: z.array(z.string().min(1)).min(1).max(200),
  providers: z.array(z.object({
    providerId: z.string().min(1),
    model: z.string().min(1),
  })).min(1).max(10),
});

const promptPackBenchmarkParamsSchema = z.object({
  benchmarkRunId: z.string().min(1),
});

const promptPackReplayRegressionRunBodySchema = z.object({
  testCodes: z.array(z.string().min(1)).min(1).max(200),
  baselineRef: z.string().optional(),
});

const promptPackReplayRegressionParamsSchema = z.object({
  runId: z.string().min(1),
});

const chatToolDecisionSchema = z.object({
  sessionId: z.string().min(1),
  approvalId: z.string().min(1),
});

const attachmentUploadSchema = z.object({
  sessionId: z.string().min(1),
  projectId: z.string().optional(),
  fileName: z.string().min(1),
  mimeType: z.string().default("application/octet-stream"),
  bytesBase64: z.string().min(1),
});

const attachmentParamsSchema = z.object({
  attachmentId: z.string().min(1),
});

const attachmentContentQuerySchema = z.object({
  disposition: z.enum(["inline", "attachment"]).default("attachment"),
});

async function streamSseReply(
  reply: FastifyReply,
  request: { raw: { on: (event: string, listener: () => void) => void; off?: (event: string, listener: () => void) => void } },
  sessionId: string,
  source: (signal: AbortSignal) => AsyncGenerator<unknown>,
): Promise<void> {
  const raw = reply.raw;
  const controller = new AbortController();
  let closed = false;
  let finished = false;
  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (!controller.signal.aborted) {
      controller.abort(new Error("chat_sse_client_disconnected"));
    }
  };
  const detach = () => {
    raw.off?.("close", cleanup);
    request.raw.off?.("aborted", cleanup);
  };

  reply.hijack();
  const corsOrigin = reply.getHeader("Access-Control-Allow-Origin");
  const corsCredentials = reply.getHeader("Access-Control-Allow-Credentials");
  const corsVary = reply.getHeader("Vary");
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...(typeof corsOrigin === "string" ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
    ...(typeof corsCredentials === "string" ? { "Access-Control-Allow-Credentials": corsCredentials } : {}),
    ...(typeof corsVary === "string" ? { Vary: corsVary } : {}),
  });
  raw.flushHeaders?.();
  raw.write(": connected\n\n");
  raw.on("close", cleanup);
  request.raw.on("aborted", cleanup);

  const send = (payload: unknown) => {
    if (closed || raw.destroyed || raw.writableEnded || controller.signal.aborted) {
      return;
    }
    const eventId = typeof payload === "object" && payload && "eventId" in payload && typeof (payload as { eventId?: unknown }).eventId === "string"
      ? (payload as { eventId: string }).eventId
      : undefined;
    if (eventId) {
      raw.write(`id: ${eventId}\n`);
    }
    raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    for await (const chunk of source(controller.signal)) {
      if (controller.signal.aborted) {
        break;
      }
      send(chunk);
    }
    finished = !controller.signal.aborted;
  } catch (error) {
    if (!controller.signal.aborted) {
      reply.log.error({ err: error, sessionId }, "chat SSE stream failed");
      send({
        type: "error",
        sessionId,
        eventId: randomUUID(),
        sequence: 0,
        error: getPublicChatSseErrorMessage(error),
      });
    }
  } finally {
    if (!finished) {
      cleanup();
    }
    detach();
    if (!raw.destroyed && !raw.writableEnded) {
      raw.end();
    }
  }
}

function isChatTurnWriteConflictError(error: unknown): boolean {
  return error instanceof Error && error.name === "ChatTurnWriteConflictError";
}

function getPublicChatSseErrorMessage(error: unknown): string {
  if (isChatTurnWriteConflictError(error) && error instanceof Error) {
    return error.message;
  }
  if (isGoatError(error)) {
    return error.message;
  }
  return "Chat stream failed before completion. Check gateway diagnostics and retry.";
}

function sendChatWriteError(reply: FastifyReply, error: unknown) {
  if (isChatTurnWriteConflictError(error) && error instanceof Error) {
    return reply.code(409).send({ error: error.message });
  }
  if (isGoatError(error)) {
    return sendRouteError(reply, error, reply.log);
  }
  // Sanitize untyped errors — never leak internal details to the client
  reply.log.error({ err: error }, "chat write failed");
  return reply.code(400).send({ error: "Chat write failed. Check gateway diagnostics and retry." });
}

export const chatRoutes: FastifyPluginAsync = async (fastify) => {
  const streamResumeQuerySchema = z.object({
    sinceEventId: z.string().min(1).optional(),
  });

  fastify.get("/api/v1/chat/projects", async (request, reply) => {
    const parsed = projectViewSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.gateway.listChatProjects(parsed.data.view, parsed.data.limit, parsed.data.workspaceId),
      view: parsed.data.view,
    });
  });

  fastify.post("/api/v1/chat/projects", async (request, reply) => {
    const parsed = createProjectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const created = fastify.gateway.createChatProject(parsed.data);
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/chat/projects/:projectId", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    const body = updateProjectSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.updateChatProject(params.data.projectId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/projects/:projectId/archive", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.archiveChatProject(params.data.projectId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/projects/:projectId/restore", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.restoreChatProject(params.data.projectId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/chat/projects/:projectId", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    const query = deleteProjectQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    if (query.data.mode !== "hard") {
      return reply.code(400).send({ error: "Only hard delete is supported for chat projects." });
    }
    const deleted = fastify.gateway.hardDeleteChatProject(params.data.projectId);
    return reply.send({ deleted, projectId: params.data.projectId, mode: "hard" as const });
  });

  fastify.get("/api/v1/chat/sessions", async (request, reply) => {
    const parsed = listChatSessionsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const items = fastify.gateway.listChatSessions(parsed.data);
    const last = items.at(-1);
    const nextCursor = items.length === parsed.data.limit && last
      ? `${last.updatedAt}|${last.sessionId}`
      : undefined;
    return reply.send({ items, nextCursor });
  });

  fastify.post("/api/v1/chat/sessions", async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const created = fastify.gateway.createChatSession(parsed.data);
      return reply.code(201).send(created);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/archive-bulk", async (request, reply) => {
    const parsed = bulkArchiveSessionsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.archiveChatSessionsBulk(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/chat/sessions/:sessionId", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = updateSessionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.updateChatSession(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/chat/sessions/:sessionId", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.deleteChatSession(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/pin", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.pinChatSession(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/unpin", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.unpinChatSession(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/archive", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.archiveChatSession(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/restore", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.restoreChatSession(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/project", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = assignProjectSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.assignChatSessionProject(params.data.sessionId, body.data.projectId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/binding", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = bindingSchema.safeParse(request.body);
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
        fastify.gateway.setChatSessionBinding({
          sessionId: params.data.sessionId,
          ...body.data,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/binding", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({
        item: fastify.gateway.getChatSessionBinding(params.data.sessionId) ?? null,
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/messages", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = listMessagesSchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      const items = await fastify.gateway.listChatMessages(
        params.data.sessionId,
        query.data.limit,
        query.data.cursor,
      );
      return reply.send({ items });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/thread", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.getChatThread(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/messages", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    return reply.code(410).send({
      error: "POST /messages has been removed. Use /api/v1/chat/sessions/:sessionId/agent-send instead.",
    });
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/agent-send", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const sent = await fastify.gateway.agentSendChatMessage(params.data.sessionId, body.data);
      return reply.send(sent);
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/messages/stream", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }

    return reply.code(410).send({
      error: "POST /messages/stream has been removed. Use /api/v1/chat/sessions/:sessionId/agent-send/stream instead.",
    });
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/agent-send/stream", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }

    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.gateway.agentSendChatMessageStream(params.data.sessionId, body.data, signal));
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/turns/:turnId/stream", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const query = streamResumeQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    const headerEventId = typeof request.headers["last-event-id"] === "string"
      ? request.headers["last-event-id"]
      : undefined;
    const sinceEventId = query.data.sinceEventId ?? headerEventId;
    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.gateway.resumeAgentChatTurnStream(params.data.sessionId, params.data.turnId, sinceEventId, signal));
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/select", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.selectChatBranchTurn(params.data.sessionId, params.data.turnId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/retry", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = retryTurnSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.retryChatTurn(params.data.sessionId, params.data.turnId, body.data));
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/retry/stream", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = retryTurnSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.gateway.retryChatTurnStream(params.data.sessionId, params.data.turnId, body.data, signal));
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/edit", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = editTurnSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.editChatTurn(params.data.sessionId, params.data.turnId, body.data));
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/edit/stream", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = editTurnSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.gateway.editChatTurnStream(params.data.sessionId, params.data.turnId, body.data, signal));
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/cancel", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = cancelTurnSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.cancelChatTurn(
        params.data.sessionId,
        params.data.turnId,
        body.data.cancelledBy,
      ));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/prefs", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getChatSessionPrefs(params.data.sessionId));
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
      return reply.send(fastify.gateway.updateChatSessionPrefs(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/catalog/commands", async (_request, reply) => {
    return reply.send({ items: fastify.gateway.listChatCommandCatalog() });
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
      return reply.send(await fastify.gateway.parseChatCommand(params.data.sessionId, body.data.commandText));
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
      return reply.send(await fastify.gateway.runChatResearch(params.data.sessionId, body.data));
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
      return reply.send(fastify.gateway.getChatResearchRun(params.data.sessionId, params.data.runId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/delegate", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = delegateBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.runChatDelegation(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/delegate/stream", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = delegateBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }

    const raw = reply.raw;
    const controller = new AbortController();
    let closed = false;
    let finished = false;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (!controller.signal.aborted) {
        controller.abort(new Error("chat_delegation_client_disconnected"));
      }
    };
    const detach = () => {
      raw.off?.("close", cleanup);
      request.raw.off?.("aborted", cleanup);
    };
    const corsOrigin = reply.getHeader("Access-Control-Allow-Origin");
    const corsCredentials = reply.getHeader("Access-Control-Allow-Credentials");
    const corsVary = reply.getHeader("Vary");
    reply.hijack();
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(typeof corsOrigin === "string" ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
      ...(typeof corsCredentials === "string" ? { "Access-Control-Allow-Credentials": corsCredentials } : {}),
      ...(typeof corsVary === "string" ? { Vary: corsVary } : {}),
    });
    raw.flushHeaders?.();
    raw.write(": connected\n\n");
    raw.on("close", cleanup);
    request.raw.on("aborted", cleanup);

    const send = (payload: unknown) => {
      if (closed || raw.destroyed || raw.writableEnded || controller.signal.aborted) {
        return;
      }
      raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      for await (const chunk of fastify.gateway.runChatDelegationStream(params.data.sessionId, body.data)) {
        if (controller.signal.aborted) {
          break;
        }
        send(chunk);
      }
      finished = !controller.signal.aborted;
    } catch (error) {
      if (!controller.signal.aborted) {
        reply.log.error({ err: error, sessionId: params.data.sessionId }, "chat delegation SSE stream failed");
        send({ type: "error", error: getPublicChatSseErrorMessage(error) });
        send({ type: "done" });
      }
    } finally {
      if (!finished) {
        cleanup();
      }
      detach();
      if (!raw.destroyed && !raw.writableEnded) {
        raw.end();
      }
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/delegations/:runId", async (request, reply) => {
    const params = delegationRunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getChatDelegationRun(params.data.sessionId, params.data.runId));
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
      return reply.send(fastify.gateway.getChatSessionProactiveStatus(params.data.sessionId));
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
      return reply.send(fastify.gateway.updateChatSessionProactivePolicy(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
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
      return reply.send(await fastify.gateway.triggerChatSessionProactive(params.data.sessionId, body.data));
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
        items: fastify.gateway.listChatSessionProactiveRuns(params.data.sessionId, query.data.limit),
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
      return reply.send(fastify.gateway.listChatSessionLearnedMemory(params.data.sessionId, query.data.limit));
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
        fastify.gateway.updateChatSessionLearnedMemory(params.data.sessionId, params.data.itemId, body.data),
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
      return reply.send(await fastify.gateway.rebuildChatSessionLearnedMemory(params.data.sessionId));
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
      return reply.send(
        fastify.gateway.listChatSessionSpecialistCandidates(params.data.sessionId, query.data.limit),
      );
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
      return reply.code(201).send(
        fastify.gateway.createChatSessionSpecialistCandidate(params.data.sessionId, body.data),
      );
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
        fastify.gateway.updateChatSessionSpecialistCandidate(
          params.data.sessionId,
          params.data.candidateId,
          body.data,
        ),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/delegate/suggest", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = delegateSuggestSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.suggestChatDelegation(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/delegate/accept", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = delegateAcceptSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.acceptChatDelegation(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/import", async (request, reply) => {
    const body = promptPackImportSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.importPromptPack(body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/prompt-packs", async (request, reply) => {
    const query = promptPackListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    return reply.send({
      items: fastify.gateway.listPromptPacks(query.data.limit),
    });
  });

  fastify.get("/api/v1/prompt-packs/:packId/tests", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const query = promptPackListQuerySchema.safeParse(request.query);
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
        items: fastify.gateway.listPromptPackTests(params.data.packId, query.data.limit),
      });
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/tests/:testId/run", async (request, reply) => {
    const params = promptPackTestParamsSchema.safeParse(request.params);
    const body = promptPackRunBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const run = await fastify.gateway.runPromptPackTest(params.data.packId, params.data.testId, body.data);
      return reply.send(run);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/tests/:testId/score", async (request, reply) => {
    const params = promptPackTestParamsSchema.safeParse(request.params);
    const body = promptPackScoreBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.scorePromptPackTest({
        packId: params.data.packId,
        testId: params.data.testId,
        runId: body.data.runId,
        routingScore: body.data.routingScore as 0 | 1 | 2,
        honestyScore: body.data.honestyScore as 0 | 1 | 2,
        handoffScore: body.data.handoffScore as 0 | 1 | 2,
        robustnessScore: body.data.robustnessScore as 0 | 1 | 2,
        usabilityScore: body.data.usabilityScore as 0 | 1 | 2,
        notes: body.data.notes,
      }));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/tests/:testId/auto-score", async (request, reply) => {
    const params = promptPackTestParamsSchema.safeParse(request.params);
    const body = promptPackAutoScoreBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.autoScorePromptPackTest({
        packId: params.data.packId,
        testId: params.data.testId,
        runId: body.data.runId,
        providerId: body.data.providerId,
        model: body.data.model,
        force: body.data.force,
      }));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/auto-score", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const body = promptPackAutoScoreBatchBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.autoScorePromptPackBatch({
        packId: params.data.packId,
        onlyUnscored: body.data.onlyUnscored,
        limit: body.data.limit,
        providerId: body.data.providerId,
        model: body.data.model,
        force: body.data.force,
      }));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/prompt-packs/:packId/report", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getPromptPackReport(params.data.packId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/benchmark/run", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const body = promptPackBenchmarkRunBodySchema.safeParse(request.body ?? {});
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
        fastify.gateway.runPromptPackBenchmark(params.data.packId, {
          testCodes: body.data.testCodes,
          providers: body.data.providers,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/prompt-packs/benchmark/:benchmarkRunId", async (request, reply) => {
    const params = promptPackBenchmarkParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getPromptPackBenchmarkStatus(params.data.benchmarkRunId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/replay-regression/run", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const body = promptPackReplayRegressionRunBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.runPromptPackReplayRegression(params.data.packId, body.data));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/prompt-packs/replay-regression/:runId", async (request, reply) => {
    const params = promptPackReplayRegressionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getPromptPackReplayRegressionStatus(params.data.runId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/prompt-packs/:packId/trends", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getPromptPackCapabilityTrends(params.data.packId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/prompt-packs/:packId/export", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getPromptPackExport(params.data.packId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/export", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const body = promptPackExportBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.exportPromptPack(params.data.packId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/reset", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const body = promptPackResetBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const clearRuns = body.data.clearRuns ?? true;
      const clearScores = body.data.clearScores ?? true;

      if (!clearRuns && !clearScores) {
        return reply.send({
          packId: params.data.packId,
          deletedRuns: 0,
          deletedScores: 0,
          export: fastify.gateway.getPromptPackExport(params.data.packId),
        });
      }
      return reply.send(
        fastify.gateway.resetPromptPackRunsAndScores(params.data.packId, {
          clearRuns,
          clearScores,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/tools/approve", async (request, reply) => {
    const body = chatToolDecisionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      await fastify.gateway.resolveChatToolApproval(body.data.sessionId, body.data.approvalId, "approve");
      return reply.send({ ok: true, approvalId: body.data.approvalId });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/tools/deny", async (request, reply) => {
    const body = chatToolDecisionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      await fastify.gateway.resolveChatToolApproval(body.data.sessionId, body.data.approvalId, "reject");
      return reply.send({ ok: true, approvalId: body.data.approvalId });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/attachments", async (request, reply) => {
    const parsed = attachmentUploadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const uploaded = await fastify.gateway.uploadChatAttachment(parsed.data);
      return reply.code(201).send(uploaded);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/attachments/:attachmentId", async (request, reply) => {
    const params = attachmentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getChatAttachment(params.data.attachmentId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/attachments/:attachmentId/content", async (request, reply) => {
    const params = attachmentParamsSchema.safeParse(request.params);
    const query = attachmentContentQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      const { record, bytes } = await fastify.gateway.readChatAttachmentContent(params.data.attachmentId);
      reply.header("Content-Type", record.mimeType || "application/octet-stream");
      reply.header(
        "Content-Disposition",
        `${query.data.disposition}; filename="${encodeURIComponent(record.fileName)}"`,
      );
      return reply.send(bytes);
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });
};
