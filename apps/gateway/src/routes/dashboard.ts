import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type {
  ExtensionStarterPackArtifactRecord,
  ExtensionStarterPackDraft,
  FollowOnProofLaneArtifactIndex,
  FollowOnProofLaneArtifactLaneId,
  FollowOnProofLaneArtifactRecord,
} from "@goatcitadel/contracts";
import { buildA2UIProofLaneArtifactPath, buildA2UIProofLaneDraft } from "../services/a2ui-proof-lane.js";
import { buildBrowserProofLaneArtifactPath, buildBrowserProofLaneDraft } from "../services/browser-proof-lane.js";
import { buildCompanionBootstrapArtifactPath, buildCompanionBootstrapBrief } from "../services/companion-bootstrap-brief.js";
import { buildExtensionSdkArtifactPath, buildExtensionSdkBrief } from "../services/extension-sdk-brief.js";
import {
  buildExtensionStarterPackArtifact,
  buildExtensionStarterPackDraft,
  buildExtensionStarterPackFiles,
} from "../services/extension-starter-pack.js";
import { buildFollowOnParityReport } from "../services/follow-on-parity-report.js";
import { buildOpenclawParityProgramReport } from "../services/openclaw-parity-report.js";
import { buildPackagingProofLaneArtifactPath, buildPackagingProofLaneDraft } from "../services/packaging-proof-lane.js";
import { buildVoiceProofLaneArtifactPath, buildVoiceProofLaneDraft } from "../services/voice-proof-lane.js";

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

const llmApiStyleSchema = z.enum([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);

const updateSettingsSchema = z.object({
  deploymentProfile: z.enum(["local_dev", "trusted_local", "remote_hardened"]).optional(),
  defaultToolProfile: z.string().min(1).optional(),
  budgetMode: z.enum(["saver", "balanced", "power"]).optional(),
  readAccessMode: z.enum(["roots_only", "approval_required", "full_disk"]).optional(),
  networkAllowlist: z.array(z.string().min(1)).optional(),
  auth: authUpdateSchema.optional(),
  llm: z.object({
    activeProviderId: z.string().optional(),
    activeModel: z.string().optional(),
    upsertProvider: z.object({
      providerId: z.string().min(1),
      label: z.string().min(1).optional(),
      baseUrl: z.string().url().optional(),
      apiStyle: llmApiStyleSchema.optional(),
      defaultModel: z.string().min(1).optional(),
      apiKey: z.string().min(1).optional(),
      apiKeyEnv: z.string().min(1).optional(),
      headers: z.record(z.string()).optional(),
    }).optional(),
  }).optional(),
  memory: z.object({
    enabled: z.boolean().optional(),
    qmdEnabled: z.boolean().optional(),
    qmdApplyToChat: z.boolean().optional(),
    qmdApplyToOrchestration: z.boolean().optional(),
    qmdMaxContextTokens: z.number().int().positive().optional(),
    qmdMinPromptChars: z.number().int().nonnegative().optional(),
    qmdCacheTtlSeconds: z.number().int().positive().optional(),
    qmdDistillerProviderId: z.string().optional(),
    qmdDistillerModel: z.string().optional(),
  }).optional(),
  mesh: z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(["lan", "wan", "tailnet"]).optional(),
    nodeId: z.string().min(1).optional(),
    mdns: z.boolean().optional(),
    staticPeers: z.array(z.string().min(1)).optional(),
    requireMtls: z.boolean().optional(),
    tailnetEnabled: z.boolean().optional(),
  }).optional(),
  npu: z.object({
    enabled: z.boolean().optional(),
    autoStart: z.boolean().optional(),
    sidecarUrl: z.string().url().optional(),
  }).optional(),
  features: z.object({
    durableKernelV1Enabled: z.boolean().optional(),
    replayOverridesV1Enabled: z.boolean().optional(),
    memoryLifecycleAdminV1Enabled: z.boolean().optional(),
    memoryMaintenanceV1Enabled: z.boolean().optional(),
    connectorDiagnosticsV1Enabled: z.boolean().optional(),
    computerUseGuardrailsV1Enabled: z.boolean().optional(),
    bankrBuiltinEnabled: z.boolean().optional(),
    cronReviewQueueV1Enabled: z.boolean().optional(),
    replayRegressionV1Enabled: z.boolean().optional(),
  }).optional(),
});

export const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  const loadLatestFollowOnParityArtifacts = (): FollowOnProofLaneArtifactIndex => {
    if (typeof fastify.gateway.getLatestFollowOnParityArtifacts === "function") {
      return fastify.gateway.getLatestFollowOnParityArtifacts();
    }
    return {};
  };

  const persistFollowOnParityArtifact = (artifact: FollowOnProofLaneArtifactRecord): FollowOnProofLaneArtifactRecord => {
    if (typeof fastify.gateway.rememberFollowOnParityArtifact === "function") {
      return fastify.gateway.rememberFollowOnParityArtifact(artifact);
    }
    return artifact;
  };

  const exportFollowOnParityArtifact = async (
    laneId: FollowOnProofLaneArtifactLaneId,
    relativePath: string,
    content: string,
    generatedAt: string,
    summary: string,
  ) => {
    const uploaded = await fastify.gateway.uploadWorkspaceFile(relativePath, content);
    return persistFollowOnParityArtifact({
      laneId,
      generatedAt,
      summary,
      relativePath: uploaded.relativePath,
      fullPath: uploaded.fullPath,
      bytes: uploaded.bytes,
    });
  };

  const exportExtensionStarterPack = async (
    draft: ExtensionStarterPackDraft,
  ): Promise<ExtensionStarterPackArtifactRecord> => {
    const files = await buildExtensionStarterPackFiles(draft);
    const uploaded = await Promise.all(files.map(async (file) => {
      const uploadedFile = await fastify.gateway.uploadWorkspaceFile(file.relativePath, file.content);
      return {
        relativePath: uploadedFile.relativePath,
        fullPath: uploadedFile.fullPath,
        bytes: uploadedFile.bytes,
      };
    }));
    return buildExtensionStarterPackArtifact(draft, uploaded);
  };

  const loadFollowOnParityReport = async () => {
    const settings = fastify.gateway.getSettings();
    const [voiceStatus, voiceRuntime, installedAddons] = await Promise.all([
      fastify.gateway.getVoiceStatus(),
      fastify.gateway.getVoiceRuntimeStatus(),
      fastify.gateway.listInstalledAddons(),
    ]);
    return buildFollowOnParityReport({
      deploymentProfile: settings.deploymentProfile,
      authMode: settings.auth.mode,
      allowLoopbackBypass: settings.auth.allowLoopbackBypass,
      networkAllowlistCount: settings.networkAllowlist.length,
      toolCatalog: fastify.gateway.listToolCatalog(),
      integrationCatalog: fastify.gateway.listIntegrationCatalog(),
      integrationPlugins: fastify.gateway.listIntegrationPlugins(),
      addonsCatalog: fastify.gateway.listAddonsCatalog(),
      installedAddons,
      voiceStatus,
      voiceRuntime,
      latestArtifacts: loadLatestFollowOnParityArtifacts(),
      packagingProofCoverage: typeof fastify.gateway.getPackagingProofCoverage === "function"
        ? fastify.gateway.getPackagingProofCoverage()
        : undefined,
      voiceProofCoverage: typeof fastify.gateway.getVoiceProofCoverage === "function"
        ? fastify.gateway.getVoiceProofCoverage()
        : undefined,
    });
  };

  const loadOpenclawParityReport = async () => buildOpenclawParityProgramReport(await loadFollowOnParityReport());

  fastify.get("/api/v1/dashboard/state", async (_request, reply) => {
    return reply.send(fastify.gateway.getDashboardState());
  });

  fastify.get("/api/v1/system/vitals", async (_request, reply) => {
    return reply.send(fastify.gateway.getSystemVitals());
  });

  fastify.get("/api/v1/system/follow-on-parity", async (_request, reply) => {
    return reply.send(await loadFollowOnParityReport());
  });

  fastify.get("/api/v1/system/openclaw-parity", async (_request, reply) => {
    return reply.send(await loadOpenclawParityReport());
  });

  fastify.get("/api/v1/system/follow-on-parity/browser-proof-lane", async (_request, reply) => {
    const report = await loadFollowOnParityReport();
    return reply.send(buildBrowserProofLaneDraft(report));
  });

  fastify.post("/api/v1/system/follow-on-parity/browser-proof-lane/export", async (_request, reply) => {
    try {
      const report = await loadFollowOnParityReport();
      const draft = buildBrowserProofLaneDraft(report);
      const artifact = await exportFollowOnParityArtifact(
        "browser",
        buildBrowserProofLaneArtifactPath(draft),
        draft.markdown,
        draft.generatedAt,
        draft.summary,
      );
      return reply.code(201).send(artifact);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/system/follow-on-parity/packaging-proof-lane", async (_request, reply) => {
    const report = await loadFollowOnParityReport();
    return reply.send(buildPackagingProofLaneDraft(report));
  });

  fastify.post("/api/v1/system/follow-on-parity/packaging-proof-lane/export", async (_request, reply) => {
    try {
      const report = await loadFollowOnParityReport();
      const draft = buildPackagingProofLaneDraft(report);
      const artifact = await exportFollowOnParityArtifact(
        "packaging",
        buildPackagingProofLaneArtifactPath(draft),
        draft.markdown,
        draft.generatedAt,
        draft.summary,
      );
      return reply.code(201).send(artifact);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/system/follow-on-parity/a2ui-proof-lane", async (_request, reply) => {
    const report = await loadFollowOnParityReport();
    return reply.send(buildA2UIProofLaneDraft(report));
  });

  fastify.get("/api/v1/system/follow-on-parity/voice-proof-lane", async (_request, reply) => {
    const report = await loadFollowOnParityReport();
    return reply.send(buildVoiceProofLaneDraft(report));
  });

  fastify.post("/api/v1/system/follow-on-parity/voice-proof-lane/export", async (_request, reply) => {
    try {
      const report = await loadFollowOnParityReport();
      const draft = buildVoiceProofLaneDraft(report);
      const artifact = await exportFollowOnParityArtifact(
        "voice",
        buildVoiceProofLaneArtifactPath(draft),
        draft.markdown,
        draft.generatedAt,
        draft.summary,
      );
      return reply.code(201).send(artifact);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/system/follow-on-parity/a2ui-proof-lane/export", async (_request, reply) => {
    try {
      const report = await loadFollowOnParityReport();
      const draft = buildA2UIProofLaneDraft(report);
      const artifact = await exportFollowOnParityArtifact(
        "a2ui",
        buildA2UIProofLaneArtifactPath(draft),
        draft.markdown,
        draft.generatedAt,
        draft.summary,
      );
      return reply.code(201).send(artifact);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/system/follow-on-parity/companion-bootstrap-brief", async (_request, reply) => {
    const report = await loadFollowOnParityReport();
    return reply.send(buildCompanionBootstrapBrief(report));
  });

  fastify.post("/api/v1/system/follow-on-parity/companion-bootstrap-brief/export", async (_request, reply) => {
    try {
      const report = await loadFollowOnParityReport();
      const draft = buildCompanionBootstrapBrief(report);
      const artifact = await exportFollowOnParityArtifact(
        "companion",
        buildCompanionBootstrapArtifactPath(draft),
        draft.markdown,
        draft.generatedAt,
        draft.summary,
      );
      return reply.code(201).send(artifact);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/system/follow-on-parity/extension-sdk-brief", async (_request, reply) => {
    const report = await loadFollowOnParityReport();
    return reply.send(buildExtensionSdkBrief(report));
  });

  fastify.post("/api/v1/system/follow-on-parity/extension-sdk-brief/export", async (_request, reply) => {
    try {
      const report = await loadFollowOnParityReport();
      const draft = buildExtensionSdkBrief(report);
      const artifact = await exportFollowOnParityArtifact(
        "extensions",
        buildExtensionSdkArtifactPath(draft),
        draft.markdown,
        draft.generatedAt,
        draft.summary,
      );
      return reply.code(201).send(artifact);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/system/follow-on-parity/extension-starter-pack", async (_request, reply) => {
    const report = await loadFollowOnParityReport();
    return reply.send(buildExtensionStarterPackDraft(report));
  });

  fastify.post("/api/v1/system/follow-on-parity/extension-starter-pack/export", async (_request, reply) => {
    try {
      const report = await loadFollowOnParityReport();
      const draft = buildExtensionStarterPackDraft(report);
      return reply.code(201).send(await exportExtensionStarterPack(draft));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
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
