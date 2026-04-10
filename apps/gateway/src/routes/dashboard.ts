import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

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
  schedule: z.string().min(1).max(128),
  enabled: z.boolean().optional(),
});

const cronJobUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  schedule: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
});

const authUpdateSchema = z.object({
  mode: z.enum(["none", "token", "basic"]).optional(),
  allowLoopbackBypass: z.boolean().optional(),
  token: z.string().optional(),
  basicUsername: z.string().optional(),
  basicPassword: z.string().optional(),
});

const llmApiStyleSchema = z.enum(["openai-chat-completions", "openai-responses", "anthropic-messages"]);

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
          defaultModel: z.string().min(1).optional(),
          apiKey: z.string().min(1).optional(),
          apiKeyEnv: z.string().min(1).optional(),
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
    })
    .optional(),
});

export const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/dashboard/state", async (_request, reply) => {
    return reply.send(fastify.gateway.getDashboardState());
  });

  fastify.get("/api/v1/system/vitals", async (_request, reply) => {
    return reply.send(fastify.gateway.getSystemVitals());
  });

  fastify.get("/api/v1/cron/jobs", async (_request, reply) => {
    return reply.send({ items: fastify.gateway.listCronJobs() });
  });

  fastify.get("/api/v1/cron/jobs/:jobId", async (request, reply) => {
    const parsed = cronJobParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getCronJob(parsed.data.jobId));
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
      const job = fastify.gateway.createCronJob(parsed.data);
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
      return reply.send(fastify.gateway.updateCronJob(parsedParams.data.jobId, parsedBody.data));
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
      return reply.send(fastify.gateway.setCronJobEnabled(parsed.data.jobId, true));
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
      return reply.send(fastify.gateway.setCronJobEnabled(parsed.data.jobId, false));
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
      return reply.send(await fastify.gateway.runCronJobNow(parsed.data.jobId));
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
      const result = fastify.gateway.deleteCronJob(parsed.data.jobId);
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
      return reply.send({ items: fastify.gateway.listCronReviewQueue(parsed.data.limit) });
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
      return reply.send(fastify.gateway.retryCronReviewQueueItem(parsed.data.itemId));
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
      return reply.send(fastify.gateway.getCronRunDiff(parsed.data.runId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/operators", async (_request, reply) => {
    return reply.send({ items: fastify.gateway.listOperators() });
  });

  fastify.get("/api/v1/memory/files", async (request, reply) => {
    const parsed = memoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const items = await fastify.gateway.listMemoryFiles(parsed.data.dir);
    return reply.send({ items });
  });

  fastify.get("/api/v1/settings", async (_request, reply) => {
    return reply.send(fastify.gateway.getSettings());
  });

  fastify.patch("/api/v1/settings", async (request, reply) => {
    const parsed = updateSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(fastify.gateway.updateSettings(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/auth/settings", async (_request, reply) => {
    return reply.send(fastify.gateway.getAuthRuntimeSettings());
  });

  fastify.patch("/api/v1/auth/settings", async (request, reply) => {
    const parsed = authUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(fastify.gateway.updateSettings({ auth: parsed.data }).auth);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
