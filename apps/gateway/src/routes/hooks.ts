import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HOOK_TRIGGER_VALUES, type HookTrigger } from "@goatcitadel/contracts";
import {
  projectHookRecordForPublicResponse,
  projectHookRecordsForPublicResponse,
  projectHookRunsForPublicResponse,
} from "../services/hooks-public-projection.js";

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

const hookParamsSchema = workspaceParamsSchema.extend({
  hookId: z.string().min(1),
});

const hookRunParamsSchema = workspaceParamsSchema.extend({
  runId: z.string().min(1),
});

const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(200),
});

const hookActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("webhook"),
    webhook: z.object({
      url: z.string().url(),
      /** Raw write-only input; the service replaces it with an opaque keychain reference. */
      secret: z.string().min(1).optional(),
      secretRef: z.string().min(1).optional(),
    }),
  }),
  z.object({
    type: z.literal("managed_package"),
    managedPackage: z.object({ packageId: z.string().min(1), manifestHash: z.string().min(16) }),
  }),
]);

const createHookSchema = z.object({
  label: z.string().min(1),
  trigger: z.enum(HOOK_TRIGGER_VALUES as unknown as [HookTrigger, ...HookTrigger[]]),
  mode: z.enum(["observe", "mutate", "intercept"]),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  timeoutMs: z.number().int().positive().optional(),
  failPolicy: z.enum(["open", "closed"]).optional(),
  dataScope: z.enum(["metadata", "content"]).optional(),
  action: hookActionSchema,
});

const updateHookSchema = z.object({
  label: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  timeoutMs: z.number().int().positive().optional(),
  failPolicy: z.enum(["open", "closed"]).optional(),
  dataScope: z.enum(["metadata", "content"]).optional(),
  action: hookActionSchema.optional(),
});

export const hooksRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/workspaces/:workspaceId/hooks", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const query = listRunsQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    return reply.send({
      items: projectHookRecordsForPublicResponse(
        await fastify.services.hooks.listWorkspaceHooks(params.data.workspaceId, query.data.limit),
      ),
    });
  });

  fastify.get("/api/v1/workspaces/:workspaceId/hooks/runs", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const query = listRunsQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    return reply.send({
      items: projectHookRunsForPublicResponse(
        await fastify.services.hooks.listWorkspaceHookRuns(params.data.workspaceId, query.data.limit),
      ),
    });
  });

  fastify.post("/api/v1/workspaces/:workspaceId/hooks", async (request, reply) => {
    const params = workspaceParamsSchema.safeParse(request.params);
    const body = createHookSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const created = await fastify.services.hooks.createWorkspaceHook({
        ...body.data,
        workspaceId: params.data.workspaceId,
      });
      return reply.code(201).send(projectHookRecordForPublicResponse(created));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.patch("/api/v1/workspaces/:workspaceId/hooks/:hookId", async (request, reply) => {
    const params = hookParamsSchema.safeParse(request.params);
    const body = updateHookSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const updated = await fastify.services.hooks.updateWorkspaceHook(
        params.data.workspaceId,
        params.data.hookId,
        body.data,
      );
      return reply.send(projectHookRecordForPublicResponse(updated));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.delete("/api/v1/workspaces/:workspaceId/hooks/:hookId", async (request, reply) => {
    const params = hookParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    return reply.send({
      deleted: await fastify.services.hooks.deleteWorkspaceHook(params.data.workspaceId, params.data.hookId),
    });
  });

  fastify.post("/api/v1/workspaces/:workspaceId/hooks/:hookId/test", async (request, reply) => {
    const params = hookParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      return reply.code(202).send(
        projectHookRunsForPublicResponse([
          await fastify.services.hooks.testWorkspaceHook(params.data.workspaceId, params.data.hookId),
        ])[0],
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/workspaces/:workspaceId/hooks/runs/:runId/redrive", async (request, reply) => {
    const params = hookRunParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      return reply.code(202).send(
        projectHookRunsForPublicResponse([
          await fastify.services.hooks.redriveWorkspaceHookRun(params.data.workspaceId, params.data.runId),
        ])[0],
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
