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

const cronReviewParamsSchema = z.object({
  itemId: z.string().min(1),
});

const cronReviewQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

const cronJobCreateSchema = z.object({
  jobId: z.string().min(3).max(64),
  name: z.string().min(1).max(120),
  action: z.enum(["task", "improvement", "backup", "memory_flush", "cost_report", "update_review"]).optional(),
  description: z.string().max(2000).optional(),
  schedule: z.string().min(1).max(128),
  enabled: z.boolean().optional(),
  endAt: z.string().datetime().optional(),
});

const cronJobUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  action: z.enum(["task", "improvement", "backup", "memory_flush", "cost_report", "update_review"]).optional(),
  description: z.string().max(2000).optional(),
  schedule: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  endAt: z.union([z.string().datetime(), z.null()]).optional(),
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
]);

const updateSettingsSchema = z.object({
  deploymentProfile: z.enum(["local_dev", "trusted_local", "remote_hardened"]).optional(),
  defaultToolProfile: z.string().min(1).optional(),
  budgetMode: z.enum(["saver", "balanced", "power"]).optional(),
  readAccessMode: z.enum(["roots_only", "approval_required", "full_disk"]).optional(),
  networkAllowlist: z.array(z.string().min(1)).optional(),
  auth: authUpdateSchema.optional(),
  llm: z
    .object({
      activeProviderId: z.string().optional(),
      activeModel: z.string().optional(),
      upsertProvider: z
        .object({
          providerId: z.string().min(1),
          label: z.string().min(1).optional(),
          baseUrl: z.string().url().optional(),
          apiStyle: llmApiStyleSchema.optional(),
          authMode: z.enum(["api-key", "codex-oauth"]).optional(),
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
      memoryMaintenanceV1Enabled: z.boolean().optional(),
      connectorDiagnosticsV1Enabled: z.boolean().optional(),
      computerUseGuardrailsV1Enabled: z.boolean().optional(),
      bankrBuiltinEnabled: z.boolean().optional(),
      cronReviewQueueV1Enabled: z.boolean().optional(),
      replayRegressionV1Enabled: z.boolean().optional(),
      codeModeV1Enabled: z.boolean().optional(),
      improvementLedgerV1Enabled: z.boolean().optional(),
      improvementActivationV1Enabled: z.boolean().optional(),
    })
    .optional(),
});

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
      return reply.code(400).send({ error: (error as Error).message });
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
      return reply.code(notFound ? 404 : 400).send({ error: message });
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
    try {
      return reply.send(await fastify.services.cron.runCronJobNow(parsed.data.jobId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      const noHandler = message.toLowerCase().includes("no runnable handler");
      return reply.code(notFound ? 404 : noHandler ? 409 : 400).send({ error: message });
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
};
