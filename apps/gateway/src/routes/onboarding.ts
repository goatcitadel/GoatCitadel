import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const llmApiStyleSchema = z.enum([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);

const bootstrapSchema = z.object({
  defaultToolProfile: z.enum(["minimal", "standard", "coding", "ops", "research", "danger"]).optional(),
  budgetMode: z.enum(["saver", "balanced", "power"]).optional(),
  networkAllowlist: z.array(z.string().min(1)).optional(),
  auth: z.object({
    mode: z.enum(["none", "token", "basic"]).optional(),
    allowLoopbackBypass: z.boolean().optional(),
    token: z.string().optional(),
    basicUsername: z.string().optional(),
    basicPassword: z.string().optional(),
  }).optional(),
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
  mesh: z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(["lan", "wan", "tailnet"]).optional(),
    nodeId: z.string().min(1).optional(),
    mdns: z.boolean().optional(),
    staticPeers: z.array(z.string().min(1)).optional(),
    requireMtls: z.boolean().optional(),
    tailnetEnabled: z.boolean().optional(),
  }).optional(),
  markComplete: z.boolean().optional(),
  completedBy: z.string().optional(),
});

const completeSchema = z.object({
  completedBy: z.string().optional(),
});

export const onboardingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/onboarding/startup", async (_request, reply) => {
    return reply.send(fastify.gateway.getOnboardingStartupState());
  });

  fastify.get("/api/v1/onboarding/state", async (_request, reply) => {
    return reply.send(fastify.gateway.getOnboardingState());
  });

  fastify.post("/api/v1/onboarding/bootstrap", async (request, reply) => {
    const parsed = bootstrapSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(fastify.gateway.bootstrapOnboarding(parsed.data));
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
      state: fastify.gateway.markOnboardingComplete(parsed.data.completedBy),
    });
  });
};
