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

const wardSchema = z.object({
  name: z.string().min(1),
  actionPattern: z.string().min(1),
  effect: z.enum(["allow", "deny", "require_approval", "require_dry_run", "redact", "route_local"]),
});

const wardParamsSchema = z.object({
  citadelId: z.string().min(1),
  wardId: z.string().min(1),
});

const passageSchema = z.object({
  destinationCitadelId: z.string().min(1),
  allowedFields: z.array(z.string().min(1)),
  sourceChamberId: z.string().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
});

const passageParamsSchema = z.object({
  citadelId: z.string().min(1),
  passageId: z.string().min(1),
});

const memberSchema = z.object({
  subjectId: z.string().min(1),
  role: z.enum(["owner", "steward", "builder", "operator", "contributor", "viewer", "guest", "agent"]),
});

const memberRouteParamsSchema = z.object({
  citadelId: z.string().min(1),
  subjectId: z.string().min(1),
});

const evaluateActionSchema = z.object({
  action: z.string().min(1),
});

const masonAnswersSchema = z.object({
  kind: z.enum(["personal", "company", "project", "household", "client", "creator", "learning", "team", "custom"]),
  purpose: z.string().min(1),
  name: z.string().min(1).optional(),
  goals: z.array(z.string().min(1)).optional(),
  sensitiveAreas: z.array(z.string().min(1)).optional(),
  boundaries: z.array(z.string().min(1)).optional(),
  successDefinition: z.array(z.string().min(1)).optional(),
  riskPosture: z.enum(["conservative", "balanced", "collaborative", "automation_forward"]).optional(),
  preferLocalForSensitive: z.boolean().optional(),
});

const masonAnswersPatchSchema = masonAnswersSchema.partial();

const sessionParamsSchema = z.object({
  sessionId: z.string().min(1),
});

const masonMessageSchema = z.object({
  message: z.string().min(1),
});

const integrationSchema = z.object({
  provider: z.string().min(1),
  account: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)),
  mode: z.enum(["read", "write", "destructive"]),
  expiresAt: z.string().datetime().optional(),
});

const integrationParamsSchema = z.object({
  citadelId: z.string().min(1),
  grantId: z.string().min(1),
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

  // Wards = the Citadel's Gatehouse policy rules (deny-wins; see evaluateWards).
  fastify.get("/api/v1/citadels/:citadelId/wards", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({ items: citadels.listWards(params.data.citadelId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/citadels/:citadelId/wards", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = wardSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const ward = citadels.addWard({ citadelId: params.data.citadelId, ...parsed.data });
      return reply.code(201).send(ward);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/citadels/:citadelId/wards/:wardId", operatorOnly, async (request, reply) => {
    const params = wardParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const removed = citadels.removeWard(params.data.citadelId, params.data.wardId);
      if (!removed) {
        return reply.code(404).send({ error: `Ward ${params.data.wardId} not found.` });
      }
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // Passages = explicit cross-Citadel sharing bridges originating from this Citadel.
  fastify.get("/api/v1/citadels/:citadelId/passages", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({ items: citadels.listPassages(params.data.citadelId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/citadels/:citadelId/passages", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = passageSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const passage = citadels.createPassage({ sourceCitadelId: params.data.citadelId, ...parsed.data });
      return reply.code(201).send(passage);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/citadels/:citadelId/passages/:passageId", operatorOnly, async (request, reply) => {
    const params = passageParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const removed = citadels.removePassage(params.data.citadelId, params.data.passageId);
      if (!removed) {
        return reply.code(404).send({ error: `Passage ${params.data.passageId} not found.` });
      }
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // Members = subjects granted a sharing role on this Citadel (see roleCan for the matrix).
  fastify.get("/api/v1/citadels/:citadelId/members", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({ items: citadels.listMembers(params.data.citadelId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/citadels/:citadelId/members", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = memberSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const member = citadels.upsertMember({ citadelId: params.data.citadelId, ...parsed.data });
      return reply.code(201).send(member);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/citadels/:citadelId/members/:subjectId", operatorOnly, async (request, reply) => {
    const params = memberRouteParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const removed = citadels.removeMember(params.data.citadelId, params.data.subjectId);
      if (!removed) {
        return reply.code(404).send({ error: `Member ${params.data.subjectId} not found.` });
      }
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // Gatehouse integration grants (§15.3): capabilities only — secrets stay in the Secret Vault.
  fastify.get("/api/v1/citadels/:citadelId/integrations", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({ items: citadels.listIntegrations(params.data.citadelId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/citadels/:citadelId/integrations", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = integrationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const grant = citadels.addIntegration({ citadelId: params.data.citadelId, ...parsed.data });
      return reply.code(201).send(grant);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/citadels/:citadelId/integrations/:grantId", operatorOnly, async (request, reply) => {
    const params = integrationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const removed = citadels.removeIntegration(params.data.citadelId, params.data.grantId);
      if (!removed) {
        return reply.code(404).send({ error: `Integration grant ${params.data.grantId} not found.` });
      }
      return reply.code(204).send();
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // The Mason: deterministic setup surface — setup questions + blueprint review
  // (validates, then summarizes; never connects or activates anything).
  fastify.get("/api/v1/mason/setup-questions", operatorOnly, async (request, reply) => {
    try {
      return reply.send({ items: citadels.getMasonSetupQuestions() });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/mason/draft", operatorOnly, async (request, reply) => {
    const parsed = masonAnswersSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(citadels.draftBlueprint(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // Mason sessions (§22.2): create -> accumulate answers -> draft.
  fastify.post("/api/v1/mason/sessions", operatorOnly, async (request, reply) => {
    try {
      return reply.code(201).send(citadels.createMasonSession());
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/mason/sessions/:sessionId", operatorOnly, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const session = citadels.getMasonSession(params.data.sessionId);
      if (!session) {
        return reply.code(404).send({ error: `Mason session ${params.data.sessionId} not found.` });
      }
      return reply.send(session);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/mason/sessions/:sessionId/answers", operatorOnly, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = masonAnswersPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const session = citadels.updateMasonSessionAnswers(params.data.sessionId, parsed.data);
      if (!session) {
        return reply.code(404).send({ error: `Mason session ${params.data.sessionId} not found.` });
      }
      return reply.send(session);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/mason/sessions/:sessionId/draft", operatorOnly, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const result = citadels.draftFromSession(params.data.sessionId);
      if (!result.ok) {
        if (result.reason === "not_found") {
          return reply.code(404).send({ error: `Mason session ${params.data.sessionId} not found.` });
        }
        return reply.code(400).send({ error: "Session is missing required answers (kind and purpose)." });
      }
      return reply.send(result.blueprint);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/mason/sessions/:sessionId/message", operatorOnly, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = masonMessageSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const result = await citadels.interpretSessionMessage(params.data.sessionId, parsed.data.message);
      if (!result.ok) {
        if (result.reason === "not_found") {
          return reply.code(404).send({ error: `Mason session ${params.data.sessionId} not found.` });
        }
        return reply
          .code(503)
          .send({ error: "No language model is configured for the Mason; use the structured /answers endpoint instead." });
      }
      return reply.send(result.session);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/mason/review", operatorOnly, async (request, reply) => {
    try {
      const result = citadels.reviewBlueprint(request.body ?? {});
      if (!result.ok) {
        return reply.code(400).send({ error: { blueprint: result.errors } });
      }
      return reply.send(result.review);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // Gatehouse decision point: evaluate an action against this Citadel's Wards.
  fastify.post("/api/v1/citadels/:citadelId/gatehouse/evaluate", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const parsed = evaluateActionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const effect = citadels.evaluateGatehouseAction(params.data.citadelId, parsed.data.action);
      return reply.send({ action: parsed.data.action, effect });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  // The Mason's stage step: validate + stage a Citadel from a Blueprint, returning
  // it with a review summary. Nothing is activated.
  fastify.post("/api/v1/citadels/:citadelId/mason/stage", operatorOnly, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const result = citadels.stageBlueprint(params.data.citadelId, request.body ?? {});
      if (!result.ok) {
        return reply.code(400).send({ error: { blueprint: result.errors } });
      }
      return reply.code(201).send({ citadel: result.citadel, review: result.review });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
