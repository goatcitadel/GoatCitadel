import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const paramsSchema = z.object({
  providerId: z.string().min(1),
});

const upsertSchema = z.object({
  apiKey: z.string().min(1),
});

const secretStatusRouteOptions = {
  config: {
    rateLimit: {
      max: 60,
      timeWindow: "1 minute",
    },
  },
};

const secretMutationRouteOptions = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: "1 minute",
    },
  },
};

export const secretsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/secrets/providers/:providerId/status", secretStatusRouteOptions, async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(fastify.services.secrets.getProviderSecretStatus(parsed.data.providerId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/secrets/providers/:providerId", secretMutationRouteOptions, async (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: parsedParams.error.flatten() });
    }
    const parsedBody = upsertSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error.flatten() });
    }

    try {
      const status = fastify.services.secrets.saveProviderSecret(parsedParams.data.providerId, parsedBody.data.apiKey);
      return reply.send(status);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/secrets/providers/:providerId", secretMutationRouteOptions, async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(fastify.services.secrets.deleteProviderSecret(parsed.data.providerId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
