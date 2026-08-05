import type { FastifyPluginAsync } from "fastify";
import type { CapabilityPackManifest } from "@goatcitadel/contracts";
import { z } from "zod";
import { withRouteAccess } from "./route-access.js";

const paramsSchema = z.object({
  packId: z.string().trim().min(1),
});

const installSchema = z.object({
  actorId: z.string().trim().min(1).optional(),
});

const localPackSchema = z.object({
  actorId: z.string().trim().min(1).optional(),
  manifest: z.unknown(),
});

const materializeParamsSchema = z.object({
  evidenceEnvelopeId: z.string().trim().min(1),
});

const materializeSchema = z.object({
  actorId: z.string().trim().min(1).optional(),
  confirmReview: z.literal(true),
  assetIds: z.array(z.string().trim().min(1)).optional(),
  note: z.string().trim().min(1).optional(),
});

export const capabilityPacksRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");

  fastify.get("/api/v1/capability-packs", operatorOnly, async (_request, reply) => {
    return reply.send({ items: fastify.services.capabilityPacks.listPacks() });
  });

  fastify.get("/api/v1/capability-packs/staged", operatorOnly, async (_request, reply) => {
    return reply.send({ items: await fastify.services.capabilityPacks.listStagedPacks() });
  });

  fastify.post(
    "/api/v1/capability-packs/staged/:evidenceEnvelopeId/materialize",
    operatorOnly,
    async (request, reply) => {
      const params = materializeParamsSchema.safeParse(request.params);
      const body = materializeSchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: {
            params: params.success ? undefined : params.error.flatten(),
            body: body.success ? undefined : body.error.flatten(),
          },
        });
      }
      try {
        const actorId =
          body.data.actorId ??
          (typeof request.authActorId === "string" && request.authActorId.trim()
            ? request.authActorId.trim()
            : undefined);
        return reply.send(
          await fastify.services.capabilityPacks.materializeStagedPack(params.data.evidenceEnvelopeId, {
            ...body.data,
            actorId,
          }),
        );
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    },
  );

  fastify.post("/api/v1/capability-packs/local/preview", operatorOnly, async (request, reply) => {
    const body = localPackSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.send(
        fastify.services.capabilityPacks.previewLocalPack(body.data.manifest as CapabilityPackManifest),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/capability-packs/:packId/preview", operatorOnly, async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.capabilityPacks.previewPack(parsed.data.packId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/capability-packs/:packId/export", operatorOnly, async (request, reply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.capabilityPacks.exportPack(parsed.data.packId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/capability-packs/local/install", operatorOnly, async (request, reply) => {
    const body = localPackSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      const actorId =
        body.data.actorId ??
        (typeof request.authActorId === "string" && request.authActorId.trim()
          ? request.authActorId.trim()
          : undefined);
      return reply.code(201).send(
        await fastify.services.capabilityPacks.installLocalPack({
          manifest: body.data.manifest as CapabilityPackManifest,
          actorId,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/capability-packs/:packId/install", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = installSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const actorId =
        body.data.actorId ??
        (typeof request.authActorId === "string" && request.authActorId.trim()
          ? request.authActorId.trim()
          : undefined);
      return reply.code(201).send(await fastify.services.capabilityPacks.installPack(params.data.packId, { actorId }));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
