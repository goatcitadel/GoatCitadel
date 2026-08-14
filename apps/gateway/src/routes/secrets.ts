import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { ConflictError, ServiceUnavailableError } from "@goatcitadel/contracts";
import type { EvolutionControlPlaneActor } from "../services/evolution-control-plane-service.js";
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
      const evolution = fastify.services.evolution;
      if (evolution && (await evolution.isEnabled())) {
        const owner = fastify.services.evolutionProviderConnection;
        if (!owner) throw new ServiceUnavailableError("The governed provider credential owner is unavailable.");
        const actor = settingsActor(request);
        const plan = await evolution.create({
          actor,
          request: {
            kind: "provider_connection",
            providerId: parsedParams.data.providerId,
            credentialAction: "replace_api_key",
            credentialStorage: parsedBody.data.storage ?? "keychain",
            ...(parsedBody.data.envVar ? { credentialEnvVar: parsedBody.data.envVar } : {}),
          },
          idempotencyKey: `provider-secret-save:${request.id}:${parsedBody.data.expectedRevision}`,
          expectedTargetRevision: parsedBody.data.expectedRevision,
        });
        if (plan.requiredAction?.kind !== "secure_input") {
          throw new ConflictError({ message: "The provider credential plan is not awaiting secure input." });
        }
        const supplied = await owner.submitSecret({
          actor,
          planId: plan.planId,
          expectedRevision: plan.revision,
          actionId: plan.requiredAction.actionId,
          actionNonce: plan.requiredAction.actionNonce,
          apiKey: parsedBody.data.apiKey,
        });
        if (supplied.requiredAction?.kind !== "confirmation") {
          throw new ConflictError({ message: "The provider credential plan is not ready for exact confirmation." });
        }
        const settled = await evolution.confirm(
          actor,
          supplied.planId,
          supplied.revision,
          supplied.requiredAction.actionNonce,
        );
        return reply.send({
          ...fastify.services.secrets.getProviderSecretStatus(parsedParams.data.providerId),
          revision: settled.result?.appliedRevision ?? parsedBody.data.expectedRevision,
          changePlanReceipt: receipt(settled),
        });
      }
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
      const evolution = fastify.services.evolution;
      if (evolution && (await evolution.isEnabled())) {
        const actor = settingsActor(request);
        const plan = await evolution.create({
          actor,
          request: {
            kind: "provider_connection",
            providerId: parsedParams.data.providerId,
            credentialAction: "remove_api_key",
            credentialDeleteScope: parsedBody.data.storage ?? "all",
          },
          idempotencyKey: `provider-secret-delete:${request.id}:${parsedBody.data.expectedRevision}`,
          expectedTargetRevision: parsedBody.data.expectedRevision,
        });
        if (plan.requiredAction?.kind !== "confirmation") {
          throw new ConflictError({ message: "The provider credential removal plan is not ready for confirmation." });
        }
        const settled = await evolution.confirm(actor, plan.planId, plan.revision, plan.requiredAction.actionNonce);
        return reply.send({
          ...fastify.services.secrets.getProviderSecretStatus(parsedParams.data.providerId),
          revision: settled.result?.appliedRevision ?? parsedBody.data.expectedRevision,
          changePlanReceipt: receipt(settled),
        });
      }
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

function settingsActor(request: FastifyRequest): EvolutionControlPlaneActor {
  return {
    workspaceId: "default",
    actorId: request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`,
    surface: "settings",
    requestId: request.id,
  };
}

function receipt(plan: {
  planId: string;
  status: string;
  revision: number;
  risk: string;
  summary: string;
  requiredAction?: unknown;
  result?: { summary?: string };
}) {
  return {
    planId: plan.planId,
    status: plan.status,
    revision: plan.revision,
    risk: plan.risk,
    requiredAction: plan.requiredAction,
    summary: plan.result?.summary ?? plan.summary,
  };
}
