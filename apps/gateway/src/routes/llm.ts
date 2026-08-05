import { createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { LlmProviderCapabilitiesSchema, LlmProviderGoogleCloudConfigSchema } from "@goatcitadel/contracts";
import {
  projectLlmConfigPublicValue,
  projectLlmProviderSummariesPublicValue,
  projectProviderRuntimePublicValue,
} from "../services/provider-settings-public-projection.js";
import { sendRouteError } from "./_error-handler.js";

const DEFAULT_WORKSPACE_ID = "default";

function buildDirectLlmUsageIdentity(
  request: { id: string; idempotencyKey?: string },
  routeKind: "chat" | "image",
): { operationId: string; dispatchGeneration: string; taskId: string } {
  const replayKey = request.idempotencyKey?.trim() || request.id;
  const identityHash = createHash("sha256").update(`llm-route:${routeKind}\0${replayKey}`).digest("hex");
  const operationId = `http:llm:${routeKind}:${identityHash}`;
  return {
    operationId,
    dispatchGeneration: `http-idempotency:${identityHash}`,
    taskId: operationId,
  };
}

const llmApiStyleSchema = z.enum([
  "openai-chat-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-messages",
]);

const providerRequestAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bearer"),
    token: z.string().min(1).optional(),
    tokenEnv: z.string().min(1).optional(),
    headerName: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("header"),
    headerName: z.string().min(1),
    value: z.string().min(1).optional(),
    valueEnv: z.string().min(1).optional(),
    scheme: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("query"),
    queryParam: z.string().min(1),
    value: z.string().min(1).optional(),
    valueEnv: z.string().min(1).optional(),
    prefix: z.string().optional(),
  }),
]);

const providerProxyAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bearer"),
    token: z.string().min(1).optional(),
    tokenEnv: z.string().min(1).optional(),
    headerName: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("header"),
    headerName: z.string().min(1),
    value: z.string().min(1).optional(),
    valueEnv: z.string().min(1).optional(),
    scheme: z.string().min(1).optional(),
  }),
]);

const providerRequestTlsSchema = z
  .object({
    insecureSkipVerify: z.boolean().optional(),
    caCertPath: z.string().min(1).optional(),
    clientCertPath: z.string().min(1).optional(),
    clientKeyPath: z.string().min(1).optional(),
    serverName: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.clientCertPath) !== Boolean(value.clientKeyPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "clientCertPath and clientKeyPath must be provided together",
      });
    }
    if (value.insecureSkipVerify && value.caCertPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "caCertPath cannot be combined with insecureSkipVerify",
      });
    }
  });

const providerRequestSchema = z.object({
  headers: z.record(z.string()).optional(),
  auth: providerRequestAuthSchema.optional(),
  proxy: z
    .object({
      url: z.string().url(),
      bypassHosts: z.array(z.string().min(1)).optional(),
      auth: providerProxyAuthSchema.optional(),
      tls: providerRequestTlsSchema.optional(),
    })
    .optional(),
  tls: providerRequestTlsSchema.optional(),
});

const updateConfigSchema = z.object({
  expectedRevision: z.number().int().positive(),
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
      authMode: z
        .enum(["api-key", "codex-oauth", "claude-code-oauth", "google-service-account", "google-adc"])
        .optional(),
      defaultModel: z.string().min(1).optional(),
      apiKey: z.string().min(1).optional(),
      apiKeyEnv: z.string().min(1).optional(),
      googleCloud: LlmProviderGoogleCloudConfigSchema.optional(),
      request: providerRequestSchema.optional(),
      headers: z.record(z.string()).optional(),
      capabilities: LlmProviderCapabilitiesSchema.partial().optional(),
    })
    .optional(),
});

const modelQuerySchema = z.object({
  providerId: z.string().min(1).optional(),
});

const providerAdviceSchema = z.object({
  preference: z.enum(["low_cost", "balanced", "capability_fit", "runtime_fit"]).optional(),
  taskHint: z.string().trim().min(1).optional(),
  requireConfiguredKey: z.boolean().optional(),
  maxCandidates: z.number().int().positive().max(20).optional(),
});

const runtimeMeasurementQuerySchema = z.object({
  providerId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  source: z.enum(["live", "cached", "estimated", "unavailable"]).optional(),
  status: z.enum(["completed", "failed", "partial"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const evalProofQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const evalProofRunSchema = z.object({
  prompt: z.string().min(1),
  sessionId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  candidates: z
    .array(
      z.object({
        providerId: z.string().trim().min(1),
        model: z.string().trim().min(1),
        qualityScore: z.number().min(0).max(1).optional(),
      }),
    )
    .optional(),
});

const modelPreviewSchema = z.object({
  providerId: z.string().min(1),
  baseUrl: z.string().url(),
  apiStyle: llmApiStyleSchema.optional(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  request: providerRequestSchema.optional(),
  headers: z.record(z.string()).optional(),
});

const codexOAuthPollSchema = z.object({
  flowId: z.string().min(1),
});

const imageAssetSchema = z.object({
  bytesBase64: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
});

const imageGenerationSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  prompt: z.string().min(1),
  referenceImages: z.array(imageAssetSchema).optional(),
  maskImage: imageAssetSchema.optional(),
  n: z.number().int().positive().max(10).optional(),
  size: z.string().min(1).optional(),
  quality: z.string().min(1).optional(),
  background: z.string().min(1).optional(),
  outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  responseFormat: z.enum(["b64_json", "url"]).optional(),
  moderation: z.enum(["auto", "low"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const chatCompletionSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "developer", "user", "assistant", "tool"]),
        content: z.union([z.string(), z.array(z.record(z.unknown()))]),
        name: z.string().optional(),
        tool_call_id: z.string().optional(),
      }),
    )
    .min(1),
  memory: z
    .object({
      enabled: z.boolean().optional(),
      mode: z.enum(["qmd", "off"]).optional(),
      sessionId: z.string().min(1).optional(),
      taskId: z.string().min(1).optional(),
      runId: z.string().min(1).optional(),
      workspace: z.string().min(1).optional(),
      maxContextTokens: z.number().int().positive().optional(),
      forceRefresh: z.boolean().optional(),
    })
    .optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  reasoning: z
    .object({
      effort: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra"]),
    })
    .optional(),
  verbosity: z.enum(["low", "medium", "high"]).optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.record(z.unknown())).optional(),
  tool_choice: z.union([z.string(), z.record(z.unknown())]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  response_format: z.record(z.unknown()).optional(),
  service_tier: z.string().min(1).optional(),
  prompt_cache_retention: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const llmRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/llm/providers", async (_request, reply) => {
    return reply.send(projectLlmProviderSummariesPublicValue({ items: fastify.services.llm.listLlmProviders() }));
  });

  fastify.get("/api/v1/llm/providers/openai-codex/oauth/status", async (_request, reply) => {
    try {
      return reply.send(fastify.services.llm.getOpenAICodexOAuthStatus());
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post(
    "/api/v1/llm/providers/openai-codex/oauth/device/start",
    {
      config: {
        rateLimit: {
          max: 180,
        },
      },
    },
    async (_request, reply) => {
      try {
        return reply.send(await fastify.services.llm.startOpenAICodexOAuthDeviceFlow());
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.post(
    "/api/v1/llm/providers/openai-codex/oauth/device/poll",
    {
      config: {
        rateLimit: {
          max: 180,
        },
      },
    },
    async (request, reply) => {
      const parsed = codexOAuthPollSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      try {
        return reply.send(await fastify.services.llm.pollOpenAICodexOAuthDeviceFlow(parsed.data.flowId));
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.delete(
    "/api/v1/llm/providers/openai-codex/oauth",
    {
      config: {
        rateLimit: {
          max: 180,
        },
      },
    },
    async (_request, reply) => {
      try {
        return reply.send(fastify.services.llm.deleteOpenAICodexOAuthCredential());
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.get("/api/v1/llm/config", async (request, reply) => {
    try {
      return reply.send(projectLlmConfigPublicValue(fastify.services.llm.getLlmConfigWithDetails()));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/llm/config", async (request, reply) => {
    const parsed = updateConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(projectLlmConfigPublicValue(await fastify.services.llm.updateLlmConfig(parsed.data)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/llm/models", async (request, reply) => {
    const parsed = modelQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(
        projectProviderRuntimePublicValue(await fastify.services.llm.listLlmModels(parsed.data.providerId)),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llm/provider-advice", async (request, reply) => {
    const parsed = providerAdviceSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(projectProviderRuntimePublicValue(await fastify.services.llm.getProviderAdvice(parsed.data)));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/llm/runtime-measurements", async (request, reply) => {
    const parsed = runtimeMeasurementQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(
        projectProviderRuntimePublicValue(await fastify.services.llm.listLlmRuntimeMeasurements(parsed.data)),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/llm/local-engines", async (_request, reply) => {
    try {
      return reply.send(projectProviderRuntimePublicValue(await fastify.services.llm.listLlmLocalEngines()));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/llm/eval-proof", async (request, reply) => {
    const parsed = evalProofQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(
        projectProviderRuntimePublicValue(await fastify.services.llm.listLlmEvalProofRuns(parsed.data.limit)),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/llm/eval-proof/export", async (request, reply) => {
    const parsed = evalProofQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(
        projectProviderRuntimePublicValue(await fastify.services.llm.exportLlmEvalProofRuns(parsed.data.limit)),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llm/eval-proof", async (request, reply) => {
    const parsed = evalProofRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(projectProviderRuntimePublicValue(await fastify.services.llm.runLlmEvalProof(parsed.data)));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llm/models/preview", async (request, reply) => {
    const parsed = modelPreviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(projectProviderRuntimePublicValue(await fastify.services.llm.previewLlmModels(parsed.data)));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/llm/images", async (request, reply) => {
    const parsed = imageGenerationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const usageIdentity = buildDirectLlmUsageIdentity(request, "image");
      return reply.send(
        projectProviderRuntimePublicValue(
          await fastify.services.llm.generateImage(parsed.data, {
            ...usageIdentity,
            callKind: "image_generation",
            workspaceId: DEFAULT_WORKSPACE_ID,
          }),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/llm/chat-completions", async (request, reply) => {
    const parsed = chatCompletionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const usageIdentity = buildDirectLlmUsageIdentity(request, "chat");
      const result = await fastify.services.llm.createChatCompletion(parsed.data, {
        ...usageIdentity,
        callKind: "chat_initial",
        workspaceId: DEFAULT_WORKSPACE_ID,
      });
      return reply.send(projectProviderRuntimePublicValue(result));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
