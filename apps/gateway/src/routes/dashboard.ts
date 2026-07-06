import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { LlmProviderRequestConfigSchema } from "@goatcitadel/contracts";

const memoryQuerySchema = z.object({
  dir: z.string().default("memory"),
});

const cronJobParamsSchema = z.object({
  jobId: z.string().min(1),
});

const cronRunParamsSchema = z.object({
  runId: z.string().min(1),
});

const cronManualRunBodySchema = z
  .object({
    force: z.boolean().optional(),
    reason: z.string().trim().min(1).max(160).optional(),
  })
  .default({});

const observeRunParamsSchema = z.object({
  runId: z.string().min(1),
});

const opsQualityExportQuerySchema = z.object({
  packLimit: z.coerce.number().int().positive().max(2000).default(200),
  evalLimit: z.coerce.number().int().positive().max(200).default(50),
  format: z.literal("otel_json").default("otel_json"),
});

const cronReviewParamsSchema = z.object({
  itemId: z.string().min(1),
});

const cronReviewQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

const cronJobCreateSchema = z.object({
  jobId: z.string().min(3).max(64),
  name: z.string().min(1).max(120),
  action: z
    .enum([
      "task",
      "improvement",
      "curator",
      "backup",
      "memory_flush",
      "memory_consolidation",
      "cost_report",
      "update_review",
      "watchdog",
      "no_agent",
    ])
    .optional(),
  actionConfig: z.record(z.string(), z.unknown()).optional(),
  description: z.string().max(2000).optional(),
  schedule: z.string().min(1).max(128),
  enabled: z.boolean().optional(),
  endAt: z.string().datetime().optional(),
  workdir: z.string().min(1).optional(),
  contextFrom: z.string().min(1).optional(),
  lastRunOutput: z.string().optional(),
  lastRunId: z.string().min(1).optional(),
});

const cronJobUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  action: z
    .enum([
      "task",
      "improvement",
      "curator",
      "backup",
      "memory_flush",
      "memory_consolidation",
      "cost_report",
      "update_review",
      "watchdog",
      "no_agent",
    ])
    .optional(),
  actionConfig: z.union([z.record(z.string(), z.unknown()), z.null()]).optional(),
  description: z.string().max(2000).optional(),
  schedule: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  endAt: z.union([z.string().datetime(), z.null()]).optional(),
  workdir: z.union([z.string().min(1), z.null()]).optional(),
  contextFrom: z.union([z.string().min(1), z.null()]).optional(),
  lastRunOutput: z.union([z.string(), z.null()]).optional(),
  lastRunId: z.union([z.string().min(1), z.null()]).optional(),
});

const authUpdateSchema = z.object({
  mode: z.enum(["none", "token", "basic"]).optional(),
  allowLoopbackBypass: z.boolean().optional(),
  token: z.string().optional(),
  basicUsername: z.string().optional(),
  basicPassword: z.string().optional(),
});

const llmApiStyleSchema = z.enum([
  "openai-chat-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-messages",
]);

const personalityCategorySchema = z.enum(["core", "critical", "execution", "social", "thinking", "flavor", "chaos"]);

const personalityParamsSchema = z.object({
  personalityId: z.string().min(1),
});

const personalityMutationSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  category: personalityCategorySchema.optional(),
  description: z.string().optional(),
  tone: z.string().optional(),
  style: z.string().optional(),
  systemOverlay: z.string().optional(),
  safetyNotes: z.array(z.string()).optional(),
});

const personalityDefaultSchema = z.object({
  personalityId: z.string().min(1),
});

export const updateSettingsSchema = z.object({
  deploymentProfile: z.enum(["local_dev", "trusted_local", "remote_hardened"]).optional(),
  toolApprovalMode: z.enum(["approve_all", "approve_risky", "bypass"]).optional(),
  defaultToolProfile: z.string().min(1).optional(),
  budgetMode: z.enum(["saver", "balanced", "power"]).optional(),
  readAccessMode: z.enum(["roots_only", "approval_required", "full_disk"]).optional(),
  networkAllowlist: z.array(z.string().min(1)).optional(),
  auth: authUpdateSchema.optional(),
  llm: z
    .object({
      activeProviderId: z.string().optional(),
      activeModel: z.string().optional(),
      utilityProviderId: z.string().optional(),
      utilityModel: z.string().optional(),
      upsertProvider: z
        .object({
          providerId: z.string().min(1),
          label: z.string().min(1).optional(),
          baseUrl: z.string().url().optional(),
          apiStyle: llmApiStyleSchema.optional(),
          authMode: z.enum(["api-key", "codex-oauth", "claude-code-oauth"]).optional(),
          defaultModel: z.string().min(1).optional(),
          apiKey: z.string().min(1).optional(),
          apiKeyEnv: z.string().min(1).optional(),
          request: LlmProviderRequestConfigSchema.optional(),
          headers: z.record(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  memory: z
    .object({
      enabled: z.boolean().optional(),
      qmdEnabled: z.boolean().optional(),
      qmdApplyToChat: z.boolean().optional(),
      qmdApplyToOrchestration: z.boolean().optional(),
      qmdMaxContextTokens: z.number().int().positive().optional(),
      qmdMinPromptChars: z.number().int().nonnegative().optional(),
      qmdCacheTtlSeconds: z.number().int().positive().optional(),
      qmdDistillerProviderId: z.string().optional(),
      qmdDistillerModel: z.string().optional(),
    })
    .optional(),
  web: z
    .object({
      firecrawl: z
        .object({
          enabled: z.boolean().optional(),
          baseUrl: z.string().url().optional(),
          apiKeyEnv: z.string().optional(),
          timeoutMs: z.number().int().positive().optional(),
          defaultReadBackend: z.enum(["native", "firecrawl"]).optional(),
          fallbackToNative: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  mesh: z
    .object({
      enabled: z.boolean().optional(),
      mode: z.enum(["lan", "wan", "tailnet"]).optional(),
      nodeId: z.string().min(1).optional(),
      mdns: z.boolean().optional(),
      staticPeers: z.array(z.string().min(1)).optional(),
      requireMtls: z.boolean().optional(),
      tailnetEnabled: z.boolean().optional(),
    })
    .optional(),
  npu: z
    .object({
      enabled: z.boolean().optional(),
      autoStart: z.boolean().optional(),
      sidecarUrl: z.string().url().optional(),
    })
    .optional(),
  llamaCpp: z
    .object({
      enabled: z.boolean().optional(),
      autoStart: z.boolean().optional(),
      baseUrl: z.string().url().optional(),
      command: z.string().min(1).optional(),
      extraArgs: z.array(z.string()).optional(),
      modelsRootPath: z.string().optional(),
      modelPath: z.string().optional(),
      alias: z.string().min(1).optional(),
      ctxSize: z.number().int().positive().nullable().optional(),
      threads: z.number().int().positive().nullable().optional(),
      gpuLayers: z.number().int().nonnegative().nullable().optional(),
      parallel: z.number().int().positive().nullable().optional(),
      batchSize: z.number().int().positive().nullable().optional(),
      ubatchSize: z.number().int().positive().nullable().optional(),
      flashAttention: z.boolean().nullable().optional(),
    })
    .optional(),
  features: z
    .object({
      durableKernelV1Enabled: z.boolean().optional(),
      replayOverridesV1Enabled: z.boolean().optional(),
      memoryLifecycleAdminV1Enabled: z.boolean().optional(),
      memoryLifecycleAutoForgetEnabled: z.boolean().optional(),
      memoryMaintenanceV1Enabled: z.boolean().optional(),
      connectorDiagnosticsV1Enabled: z.boolean().optional(),
      computerUseGuardrailsV1Enabled: z.boolean().optional(),
      cronReviewQueueV1Enabled: z.boolean().optional(),
      replayRegressionV1Enabled: z.boolean().optional(),
      codeModeV1Enabled: z.boolean().optional(),
      improvementLedgerV1Enabled: z.boolean().optional(),
      improvementActivationV1Enabled: z.boolean().optional(),
      coworkRuntimeQualityV1Disabled: z.boolean().optional(),
      orchestrationFinalStreamingV1Disabled: z.boolean().optional(),
      autonomyV1Disabled: z.boolean().optional(),
      plannerFastPathV1Disabled: z.boolean().optional(),
      parallelToolExecutionV1Disabled: z.boolean().optional(),
      streamIdleWatchdogV1Disabled: z.boolean().optional(),
      plannerFanoutV1Disabled: z.boolean().optional(),
      subagentFanoutV1Disabled: z.boolean().optional(),
      chatThinkingStreamV1Enabled: z.boolean().optional(),
      utilityModelRoutingV1Enabled: z.boolean().optional(),
      cronEvidenceV1Enabled: z.boolean().optional(),
      memoryConsolidationV1Enabled: z.boolean().optional(),
      signalInboundV1Enabled: z.boolean().optional(),
      channelVoiceInboundV1Enabled: z.boolean().optional(),
      channelVoiceReplyV1Enabled: z.boolean().optional(),
    })
    .optional(),
});

const unsafeConfigPayloadKeys = new Set(["__proto__", "prototype", "constructor"]);

function findUnsafeConfigPayloadKey(value: unknown, path: string[] = []): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const unsafe = findUnsafeConfigPayloadKey(value[index], [...path, String(index)]);
      if (unsafe) {
        return unsafe;
      }
    }
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (unsafeConfigPayloadKeys.has(key)) {
      return [...path, key].join(".") || key;
    }
    const unsafe = findUnsafeConfigPayloadKey((value as Record<string, unknown>)[key], [...path, key]);
    if (unsafe) {
      return unsafe;
    }
  }
  return undefined;
}

const timelineSummaryQuerySchema = z.object({
  eventLimit: z.coerce.number().int().positive().max(300).default(60),
  sessionLimit: z.coerce.number().int().positive().max(120).default(24),
  cronReviewLimit: z.coerce.number().int().positive().max(120).default(24),
  improvementLimit: z.coerce.number().int().positive().max(60).default(12),
});

const healthSummaryQuerySchema = z.object({
  costScope: z.enum(["session", "day", "agent", "task"]).default("day"),
  logTail: z.coerce.number().int().positive().max(200).default(40),
  backupLimit: z.coerce.number().int().positive().max(24).default(6),
});

const opsQualityQuerySchema = z.object({
  packLimit: z.coerce.number().int().positive().max(2000).default(200),
  evalLimit: z.coerce.number().int().positive().max(200).default(25),
});

export const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/dashboard/state", async (_request, reply) => {
    return reply.send(fastify.services.dashboard.getDashboardState());
  });

  fastify.get("/api/v1/system/vitals", async (_request, reply) => {
    return reply.send(fastify.services.dashboard.getSystemVitals());
  });

  fastify.get("/api/v1/observe/timeline", async (request, reply) => {
    const parsed = timelineSummaryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const reviewQueue = fastify.services.dashboard.isFeatureEnabled("cronReviewQueueV1Enabled")
      ? fastify.services.cron.listCronReviewQueue(parsed.data.cronReviewLimit)
      : [];
    return reply.send({
      generatedAt: new Date().toISOString(),
      events: {
        items: fastify.services.dashboard.listRealtimeEvents(parsed.data.eventLimit),
      },
      sessions: {
        items: fastify.services.dashboard.listSessions(parsed.data.sessionLimit),
      },
      scheduler: {
        jobs: fastify.services.cron.listCronJobs(),
        reviewQueue,
      },
      improvement: {
        reports: fastify.services.improvement.listImprovementReports(parsed.data.improvementLimit),
        replayRuns: fastify.services.improvement.listDecisionReplayRuns(parsed.data.improvementLimit),
      },
    });
  });

  fastify.get("/api/v1/ops/quality", async (request, reply) => {
    const parsed = opsQualityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(fastify.services.dashboard.getOpsQualitySnapshot(parsed.data));
  });

  fastify.get("/api/v1/ops/quality/export", async (request, reply) => {
    const parsed = opsQualityExportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(fastify.services.dashboard.getOpsQualityExport(parsed.data));
  });

  fastify.get("/api/v1/observe/health", async (request, reply) => {
    const parsed = healthSummaryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const now = new Date();
    const to = now.toISOString();
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const backups = await fastify.services.dashboard.listBackups(parsed.data.backupLimit);
    return reply.send({
      generatedAt: to,
      systemVitals: fastify.services.dashboard.getSystemVitals(),
      daemonStatus: fastify.services.daemon.getDaemonStatus(),
      daemonLogs: {
        items: fastify.services.daemon.listDaemonLogs(parsed.data.logTail),
      },
      costs: {
        summary: {
          items: fastify.services.dashboard.costSummary(parsed.data.costScope, from, to),
          scope: parsed.data.costScope,
          from,
          to,
          usageAvailability: fastify.services.dashboard.costUsageAvailability(from, to),
        },
        qmd: fastify.services.dashboard.getMemoryQmdStats(from, to),
      },
      backups: {
        items: backups,
        latest: backups[0] ?? null,
      },
    });
  });

  fastify.get("/api/v1/observe/runs/:runId/trace", async (request, reply) => {
    const parsed = observeRunParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.dashboard.getObserveRunTrace(parsed.data.runId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/observe/runs/:runId/trace/export", async (request, reply) => {
    const parsed = observeRunParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.dashboard.getObserveRunTraceExport(parsed.data.runId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/cron/jobs", async (_request, reply) => {
    return reply.send({ items: fastify.services.cron.listCronJobs() });
  });

  fastify.get("/api/v1/cron/jobs/:jobId", async (request, reply) => {
    const parsed = cronJobParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.cron.getCronJob(parsed.data.jobId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/cron/jobs", async (request, reply) => {
    const parsed = cronJobCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const job = fastify.services.cron.createCronJob(parsed.data);
      return reply.code(201).send(job);
    } catch (error) {
      const message = (error as Error).message;
      return reply.code(isUnsupportedCronActionError(message) ? 409 : 400).send({ error: message });
    }
  });

  fastify.patch("/api/v1/cron/jobs/:jobId", async (request, reply) => {
    const parsedParams = cronJobParamsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: parsedParams.error.flatten() });
    }
    const parsedBody = cronJobUpdateSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error.flatten() });
    }
    if (Object.keys(parsedBody.data).length === 0) {
      return reply.code(400).send({ error: "No update fields were provided." });
    }
    try {
      return reply.send(fastify.services.cron.updateCronJob(parsedParams.data.jobId, parsedBody.data));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : isUnsupportedCronActionError(message) ? 409 : 400).send({ error: message });
    }
  });

  fastify.post("/api/v1/cron/jobs/:jobId/start", async (request, reply) => {
    const parsed = cronJobParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.cron.setCronJobEnabled(parsed.data.jobId, true));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 400).send({ error: message });
    }
  });

  fastify.post("/api/v1/cron/jobs/:jobId/pause", async (request, reply) => {
    const parsed = cronJobParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.cron.setCronJobEnabled(parsed.data.jobId, false));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 400).send({ error: message });
    }
  });

  fastify.post("/api/v1/cron/jobs/:jobId/run", async (request, reply) => {
    const parsed = cronJobParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const parsedBody = cronManualRunBodySchema.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error.flatten() });
    }
    try {
      const options =
        parsedBody.data.force === true || parsedBody.data.reason
          ? { force: parsedBody.data.force === true, reason: parsedBody.data.reason }
          : undefined;
      return reply.send(
        options
          ? await fastify.services.cron.runCronJobNow(parsed.data.jobId, options)
          : await fastify.services.cron.runCronJobNow(parsed.data.jobId),
      );
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      const noHandler = message.toLowerCase().includes("no runnable handler");
      return reply.code(notFound ? 404 : noHandler || isUnsupportedCronActionError(message) ? 409 : 400).send({
        error: message,
      });
    }
  });

  fastify.delete("/api/v1/cron/jobs/:jobId", async (request, reply) => {
    const parsed = cronJobParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const result = fastify.services.cron.deleteCronJob(parsed.data.jobId);
      if (!result.deleted) {
        return reply.code(404).send({ error: `Cron job not found: ${result.jobId}` });
      }
      return reply.send(result);
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      const protectedJob = message.toLowerCase().includes("cannot be deleted");
      return reply.code(notFound ? 404 : protectedJob ? 409 : 400).send({ error: message });
    }
  });

  fastify.get("/api/v1/cron/review-queue", async (request, reply) => {
    const parsed = cronReviewQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send({ items: fastify.services.cron.listCronReviewQueue(parsed.data.limit) });
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/cron/review-queue/:itemId/retry", async (request, reply) => {
    const parsed = cronReviewParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.cron.retryCronReviewQueueItem(parsed.data.itemId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/cron/runs/:runId/diff", async (request, reply) => {
    const parsed = cronRunParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.cron.getCronRunDiff(parsed.data.runId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/operators", async (_request, reply) => {
    return reply.send({ items: fastify.services.dashboard.listOperators() });
  });

  fastify.get("/api/v1/memory/files", async (request, reply) => {
    const parsed = memoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const items = await fastify.services.dashboard.listMemoryFiles(parsed.data.dir);
    return reply.send({ items });
  });

  fastify.get("/api/v1/settings", async (_request, reply) => {
    return reply.send(fastify.services.settings.getSettings());
  });

  fastify.patch("/api/v1/settings", async (request, reply) => {
    const unsafeKey = findUnsafeConfigPayloadKey(request.body);
    if (unsafeKey) {
      return reply.code(400).send({ error: `Unsafe config key is not allowed: ${unsafeKey}` });
    }
    const parsed = updateSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(fastify.services.settings.updateSettings(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/auth/settings", async (_request, reply) => {
    return reply.send(fastify.services.settings.getAuthRuntimeSettings());
  });

  fastify.patch("/api/v1/auth/settings", async (request, reply) => {
    const unsafeKey = findUnsafeConfigPayloadKey(request.body);
    if (unsafeKey) {
      return reply.code(400).send({ error: `Unsafe config key is not allowed: ${unsafeKey}` });
    }
    const parsed = authUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(fastify.services.settings.updateSettings({ auth: parsed.data }).auth);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/personalities", async (_request, reply) => {
    return reply.send(fastify.services.settings.getPersonalityCatalog());
  });

  fastify.post("/api/v1/personalities", async (request, reply) => {
    const parsed = personalityMutationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.services.settings.createPersonality(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/personalities/default", async (request, reply) => {
    const parsed = personalityDefaultSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.settings.setDefaultPersonality(parsed.data.personalityId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/personalities/:personalityId", async (request, reply) => {
    const params = personalityParamsSchema.safeParse(request.params);
    const body = personalityMutationSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.services.settings.updatePersonality(params.data.personalityId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/personalities/:personalityId", async (request, reply) => {
    const params = personalityParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.settings.deletePersonality(params.data.personalityId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};

function isUnsupportedCronActionError(message: string): boolean {
  return message.includes("GOATCITADEL_EXPERIMENTAL_NO_AGENT_CRON");
}
