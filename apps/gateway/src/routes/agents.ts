import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";

const listQuerySchema = z.object({
  view: z.enum(["active", "archived", "all"]).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(300),
});

const catalogListQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  division: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  state: z.enum(["disabled", "approved", "active", "retired", "all"]).optional(),
  parseStatus: z.enum(["supported", "supported_with_warnings", "unsupported", "all"]).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(300),
});

const catalogImportSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    repoUrl: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
  })
  .optional();

const catalogStatePatchSchema = z.object({
  state: z.enum(["disabled", "approved", "active", "retired"]),
});

const catalogActivationSchema = z.object({
  sessionId: z.string().min(1),
});

const presetDefaultsSchema = z.object({
  presetLabel: z.string().min(1).optional(),
  presetSummary: z.string().min(1).optional(),
  routeHint: z.enum(["chat", "cowork", "code"]).optional(),
  preferredProviderId: z.string().min(1).optional(),
  preferredModel: z.string().min(1).optional(),
  toolsPosture: z.enum(["safe_auto", "manual"]).optional(),
  knowledgeAttachmentIds: z.array(z.string().min(1)).optional(),
  promptFraming: z.string().min(1).optional(),
});

const createSchema = z.object({
  roleId: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  specialties: z.array(z.string().min(1)).optional(),
  defaultTools: z.array(z.string().min(1)).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  presetDefaults: presetDefaultsSchema.optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  specialties: z.array(z.string().min(1)).optional(),
  defaultTools: z.array(z.string().min(1)).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  presetDefaults: presetDefaultsSchema.optional(),
});

const archiveSchema = z
  .object({
    archivedBy: z.string().min(1).optional(),
    archiveReason: z.string().min(1).max(400).optional(),
  })
  .optional();

const deleteQuerySchema = z.object({
  mode: z.literal("hard"),
});

export const agentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/agents", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const view = parsed.data.view ?? "active";
    const items = fastify.gateway.listAgents(view, parsed.data.limit);
    return reply.send({ items, view });
  });

  fastify.get("/api/v1/agents/catalog", async (request, reply) => {
    const parsed = catalogListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.listImportedAgentCatalog(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/agents/catalog/:entryId", async (request, reply) => {
    const entryId = (request.params as { entryId: string }).entryId;
    try {
      return reply.send(fastify.gateway.getImportedAgentCatalogEntry(entryId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/agents/catalog/import/agency-agents", async (request, reply) => {
    const parsed = catalogImportSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const imported = await fastify.gateway.importAgencyAgentCatalog(parsed.data ?? {});
      return reply.code(201).send(imported);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/agents/catalog/:entryId/state", async (request, reply) => {
    const entryId = (request.params as { entryId: string }).entryId;
    const parsed = catalogStatePatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.patchImportedAgentCatalogEntryState(entryId, parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/agents/catalog/:entryId/activate-session", async (request, reply) => {
    const entryId = (request.params as { entryId: string }).entryId;
    const parsed = catalogActivationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.activateImportedAgentCatalogEntryForSession(parsed.data.sessionId, entryId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/agents/:agentId", async (request, reply) => {
    const agentId = (request.params as { agentId: string }).agentId;
    try {
      return reply.send(fastify.gateway.getAgent(agentId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/agents", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const created = fastify.gateway.createAgentProfile(parsed.data);
      return reply.code(201).send(created);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/agents/:agentId", async (request, reply) => {
    const agentId = (request.params as { agentId: string }).agentId;
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.updateAgentProfile(agentId, parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/agents/:agentId/archive", async (request, reply) => {
    const agentId = (request.params as { agentId: string }).agentId;
    const parsed = archiveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.archiveAgentProfile(agentId, parsed.data ?? {}));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/agents/:agentId/restore", async (request, reply) => {
    const agentId = (request.params as { agentId: string }).agentId;
    try {
      return reply.send(fastify.gateway.restoreAgentProfile(agentId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/agents/:agentId", async (request, reply) => {
    const agentId = (request.params as { agentId: string }).agentId;
    const parsed = deleteQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const deleted = fastify.gateway.hardDeleteAgentProfile(agentId);
      if (!deleted) {
        return reply.code(404).send({ error: `Agent profile ${agentId} not found` });
      }
      return reply.send({ deleted: true, agentId, mode: parsed.data.mode });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
