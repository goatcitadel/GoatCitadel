import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const onboardingTimingEnabled = process.env.GOATCITADEL_DEBUG_ONBOARDING_TIMING === "1";

const llmApiStyleSchema = z.enum(["openai-chat-completions", "openai-responses", "anthropic-messages"]);

const llmProviderRequestAuthSchema = z.discriminatedUnion("type", [
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

const llmProviderProxyAuthSchema = z.discriminatedUnion("type", [
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

const llmProviderRequestTlsSchema = z
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

const llmProviderRequestSchema = z.object({
  headers: z.record(z.string()).optional(),
  auth: llmProviderRequestAuthSchema.optional(),
  proxy: z
    .object({
      url: z.string().url(),
      bypassHosts: z.array(z.string().min(1)).optional(),
      auth: llmProviderProxyAuthSchema.optional(),
      tls: llmProviderRequestTlsSchema.optional(),
    })
    .optional(),
  tls: llmProviderRequestTlsSchema.optional(),
});

const bootstrapSchema = z.object({
  defaultToolProfile: z.enum(["minimal", "standard", "coding", "ops", "research", "danger"]).optional(),
  budgetMode: z.enum(["saver", "balanced", "power"]).optional(),
  networkAllowlist: z.array(z.string().min(1)).optional(),
  auth: z
    .object({
      mode: z.enum(["none", "token", "basic"]).optional(),
      allowLoopbackBypass: z.boolean().optional(),
      token: z.string().optional(),
      basicUsername: z.string().optional(),
      basicPassword: z.string().optional(),
    })
    .optional(),
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
          persistSecretToSecureStore: z.boolean().optional(),
          request: llmProviderRequestSchema.optional(),
          headers: z.record(z.string()).optional(),
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
  markComplete: z.boolean().optional(),
  completedBy: z.string().optional(),
});

const completeSchema = z.object({
  completedBy: z.string().optional(),
});

export const onboardingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/onboarding/startup", async (_request, reply) => {
    return reply.send(fastify.services.onboarding.getOnboardingStartupState());
  });

  fastify.get("/api/v1/onboarding/state", async (request, reply) => {
    const startedAt = Date.now();
    const state = fastify.services.onboarding.getOnboardingState();
    const afterState = Date.now();
    if (onboardingTimingEnabled) {
      request.log.info(
        {
          route: "onboarding.state",
          totalMs: afterState - startedAt,
          gatewayMs: afterState - startedAt,
        },
        "onboarding route timing",
      );
    }
    return reply.send(state);
  });

  fastify.post("/api/v1/onboarding/bootstrap", async (request, reply) => {
    const parsed = bootstrapSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(fastify.services.onboarding.bootstrapOnboarding(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/onboarding/complete", async (request, reply) => {
    const parsed = completeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    return reply.send({
      state: fastify.services.onboarding.markOnboardingComplete(parsed.data.completedBy),
    });
  });
};
