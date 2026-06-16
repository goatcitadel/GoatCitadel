import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const charterSchema = z.object({
  purpose: z.string().min(1),
  kind: z.enum([
    "personal",
    "company",
    "project",
    "household",
    "client",
    "creator",
    "learning",
    "team",
    "custom",
  ]),
  goals: z.array(z.string().min(1)).optional(),
  boundaries: z.array(z.string().min(1)).optional(),
  successDefinition: z.array(z.string().min(1)).optional(),
  defaultChamberId: z.string().min(1).optional(),
  riskPosture: z.enum(["conservative", "balanced", "collaborative", "automation_forward"]).optional(),
  modelPolicyDefault: z.enum(["local_only", "hybrid_guarded", "approved_cloud", "hosted_team"]).optional(),
});

const chamberSchema = z.object({
  name: z.string().min(1),
  sensitivity: z.enum(["public", "internal", "private", "sensitive", "restricted", "secret"]).optional(),
  sealed: z.boolean().optional(),
});

const paramsSchema = z.object({
  citadelId: z.string().min(1),
});

export const citadelsRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");
  const citadels = fastify.services.citadels;

  fastify.get("/api/v1/citadels/:citadelId", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const citadel = citadels.getCitadel(params.data.citadelId);
      if (!citadel) {
        return reply.code(404).send({ error: `Citadel ${params.data.citadelId} not found.` });
      }
      return reply.send(citadel);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.put("/api/v1/citadels/:citadelId/charter", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = charterSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const charter = citadels.upsertCharter({ citadelId: params.data.citadelId, ...parsed.data });
      return reply.send(charter);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/citadels/:citadelId/chambers", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({ items: citadels.listChambers(params.data.citadelId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/citadels/:citadelId/chambers", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = chamberSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const chamber = citadels.createChamber({ citadelId: params.data.citadelId, ...parsed.data });
      return reply.code(201).send(chamber);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
