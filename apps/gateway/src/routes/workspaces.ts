import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";

const workspaceDocTypeSchema = z.enum(["goatcitadel", "agents", "claude", "vision"]);

const globalDocTypeSchema = z.enum(["goatcitadel", "agents", "claude", "contributing", "security", "vision"]);

const listWorkspacesQuerySchema = z.object({
  view: z.enum(["active", "archived", "all"]).default("active"),
  limit: z.coerce.number().int().positive().max(500).default(200),
  citadelId: z.string().min(1).optional(),
});

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

const createWorkspaceSchema = z.object({
  citadelId: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  slug: z.string().min(1).optional(),
  workspacePrefs: z.record(z.unknown()).optional(),
});

const updateWorkspaceSchema = z.object({
  expectedRevision: z.number().int().positive(),
  citadelId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  slug: z.string().min(1).optional(),
  workspacePrefs: z.record(z.unknown()).optional(),
});

const workspaceRevisionSchema = z.object({
  expectedRevision: z.number().int().positive(),
});

const globalGuidanceParamsSchema = z.object({
  docType: globalDocTypeSchema,
});

const workspaceGuidanceParamsSchema = z.object({
  workspaceId: z.string().min(1),
  docType: workspaceDocTypeSchema,
});

const guidanceBodySchema = z.object({
  content: z.string(),
});

export const workspacesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/workspaces", async (request, reply) => {
    const query = listWorkspacesQuerySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    return reply.send({
      items: fastify.services.workspaces.listWorkspaces(query.data.view, query.data.limit, query.data.citadelId),
      view: query.data.view,
      citadelId: query.data.citadelId,
    });
  });

  fastify.post("/api/v1/workspaces", async (request, reply) => {
    const body = createWorkspaceSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.services.workspaces.createWorkspace(body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.workspaces.getWorkspace(params.data.workspaceId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/workspaces/:workspaceId", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const body = updateWorkspaceSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const { expectedRevision, ...input } = body.data;
      return reply.send(fastify.services.workspaces.updateWorkspace(params.data.workspaceId, input, expectedRevision));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/workspaces/:workspaceId/archive", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const body = workspaceRevisionSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        fastify.services.workspaces.archiveWorkspace(params.data.workspaceId, body.data.expectedRevision),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/workspaces/:workspaceId/restore", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const body = workspaceRevisionSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        fastify.services.workspaces.restoreWorkspace(params.data.workspaceId, body.data.expectedRevision),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/guidance/global", async (_request, reply) => {
    return reply.send({
      items: await fastify.services.workspaces.listGlobalGuidance(),
    });
  });

  fastify.put("/api/v1/guidance/global/:docType", async (request, reply) => {
    const params = globalGuidanceParamsSchema.safeParse(request.params);
    const body = guidanceBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.services.workspaces.updateGlobalGuidance(params.data.docType, body.data.content));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/workspaces/:workspaceId/guidance", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.workspaces.listWorkspaceGuidance(params.data.workspaceId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.put("/api/v1/workspaces/:workspaceId/guidance/:docType", async (request, reply) => {
    const params = workspaceGuidanceParamsSchema.safeParse(request.params);
    const body = guidanceBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        await fastify.services.workspaces.updateWorkspaceGuidance(
          params.data.workspaceId,
          params.data.docType,
          body.data.content,
        ),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
