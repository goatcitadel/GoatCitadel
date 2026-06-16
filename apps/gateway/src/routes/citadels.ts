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

const councilMemberSchema = z.object({
  name: z.string().min(1),
  archetype: z.enum([
    "chief_of_staff",
    "planner",
    "researcher",
    "operator",
    "archivist",
    "watcher",
    "finance",
    "relationships",
    "coach",
    "automation_builder",
    "builder",
    "specialist",
  ]),
  role: z.string().min(1),
});

const memberParamsSchema = z.object({
  citadelId: z.string().min(1),
  memberId: z.string().min(1),
});

const missionSchema = z.object({
  title: z.string().min(1),
  objective: z.string().min(1),
  mode: z.enum(["ask", "plan", "cowork", "forge", "watch", "review"]).optional(),
});

const missionStateSchema = z.object({
  state: z.enum([
    "draft",
    "planned",
    "waiting_for_approval",
    "running",
    "paused",
    "blocked",
    "completed",
    "failed",
    "cancelled",
    "archived",
  ]),
});

const missionParamsSchema = z.object({
  missionId: z.string().min(1),
});

const archiveItemSchema = z.object({
  kind: z.enum(["memory", "note", "decision", "artifact", "reference"]),
  title: z.string().min(1),
  body: z.string().min(1),
  chamberId: z.string().min(1).optional(),
});

const archiveQuerySchema = z.object({
  chamberId: z.string().min(1).optional(),
});

const archiveParamsSchema = z.object({
  citadelId: z.string().min(1),
  itemId: z.string().min(1),
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
    const parsed = councilMemberSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const member = citadels.addCouncilMember({ citadelId: params.data.citadelId, ...parsed.data });
      return reply.code(201).send(member);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/citadels/:citadelId/council/:memberId", operatorOnly, async (request, reply) => {
    const params = memberParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const removed = citadels.removeCouncilMember(params.data.memberId);
      if (!removed) {
        return reply.code(404).send({ error: `Council member ${params.data.memberId} not found.` });
      }
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/citadels/:citadelId/missions", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({ items: citadels.listMissions(params.data.citadelId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/citadels/:citadelId/missions", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = missionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const mission = citadels.createMission({ citadelId: params.data.citadelId, ...parsed.data });
      return reply.code(201).send(mission);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/missions/:missionId", operatorOnly, async (request, reply) => {
    const params = missionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const mission = citadels.getMission(params.data.missionId);
      if (!mission) {
        return reply.code(404).send({ error: `Mission ${params.data.missionId} not found.` });
      }
      return reply.send(mission);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/missions/:missionId", operatorOnly, async (request, reply) => {
    const params = missionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = missionStateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const mission = citadels.updateMissionState(params.data.missionId, parsed.data.state);
      if (!mission) {
        return reply.code(404).send({ error: `Mission ${params.data.missionId} not found.` });
      }
      return reply.send(mission);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/citadels/:citadelId/archive", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const query = archiveQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    try {
      return reply.send({ items: citadels.listArchive(params.data.citadelId, query.data.chamberId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/citadels/:citadelId/archive", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = archiveItemSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const item = citadels.addArchiveItem({ citadelId: params.data.citadelId, ...parsed.data });
      return reply.code(201).send(item);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/citadels/:citadelId/archive/:itemId", operatorOnly, async (request, reply) => {
    const params = archiveParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const removed = citadels.removeArchiveItem(params.data.itemId);
      if (!removed) {
        return reply.code(404).send({ error: `Archive item ${params.data.itemId} not found.` });
      }
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
