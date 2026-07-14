import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";

const paramsSchema = z.object({
  providerId: z.string().min(1),
});

const upsertSchema = z.object({
  apiKey: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  storage: z.enum(["keychain", "env"]).optional(),
  envVar: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
    .optional(),
});

const deleteSchema = z.object({
  expectedRevision: z.number().int().positive(),
  storage: z.enum(["all", "keychain", "env", "inline"]).optional(),
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
      const status = await fastify.services.secrets.saveProviderSecret(
        parsedParams.data.providerId,
        parsedBody.data.apiKey,
        parsedBody.data.expectedRevision,
        parsedBody.data.storage,
        parsedBody.data.envVar,
      );
      return reply.send(status);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/secrets/providers/:providerId", secretMutationRouteOptions, async (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: parsedParams.error.flatten() });
    }
    const parsedBody = deleteSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ error: parsedBody.error.flatten() });
    }

    try {
      return reply.send(
        await fastify.services.secrets.deleteProviderSecret(
          parsedParams.data.providerId,
          parsedBody.data.expectedRevision,
          parsedBody.data.storage,
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
