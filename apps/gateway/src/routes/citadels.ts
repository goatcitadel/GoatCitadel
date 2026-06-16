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

const fromTemplateSchema = z.object({
  templateId: z.string().min(1),
});

const assignAgentSchema = z.object({
  agentId: z.string().min(1),
});

const councilParamsSchema = z.object({
  citadelId: z.string().min(1),
  agentId: z.string().min(1),
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

  fastify.get("/api/v1/citadels/:citadelId/gatehouse", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const summary = citadels.getGatehouse(params.data.citadelId);
      if (!summary) {
        return reply.code(404).send({ error: `Citadel ${params.data.citadelId} not found.` });
      }
      return reply.send(summary);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/citadel-templates", operatorOnly, async (request, reply) => {
    try {
      return reply.send({ items: citadels.listTemplates() });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/citadels/:citadelId/from-template", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = fromTemplateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const citadel = citadels.createFromTemplate(params.data.citadelId, parsed.data.templateId);
      if (!citadel) {
        return reply.code(404).send({ error: `Template ${parsed.data.templateId} not found.` });
      }
      return reply.code(201).send(citadel);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/citadels/:citadelId/blueprint", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const blueprint = citadels.exportBlueprint(params.data.citadelId);
      if (!blueprint) {
        return reply.code(404).send({ error: `Citadel ${params.data.citadelId} not found.` });
      }
      return reply.send(blueprint);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/blueprints/validate", operatorOnly, async (request, reply) => {
    try {
      return reply.send(citadels.validateBlueprint(request.body ?? {}));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/citadels/:citadelId/from-blueprint", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const result = citadels.createFromBlueprint(params.data.citadelId, request.body ?? {});
      if (!result.ok) {
        return reply.code(400).send({ error: { blueprint: result.errors } });
      }
      return reply.code(201).send(result.citadel);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // Council = existing agents assigned to this Citadel (by agentId). Agent details
  // (name/role/tools) are resolved from the agents system, not duplicated here.
  fastify.get("/api/v1/citadels/:citadelId/council", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({ items: citadels.listCouncil(params.data.citadelId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/citadels/:citadelId/council", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = assignAgentSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const assignment = citadels.assignAgent({ citadelId: params.data.citadelId, agentId: parsed.data.agentId });
      return reply.code(201).send(assignment);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/citadels/:citadelId/council/:agentId", operatorOnly, async (request, reply) => {
    const params = councilParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const removed = citadels.unassignAgent(params.data.citadelId, params.data.agentId);
      if (!removed) {
        return reply.code(404).send({ error: `Agent ${params.data.agentId} is not on this Citadel's council.` });
      }
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
