import type { HookRecord } from "@goatcitadel/contracts";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1),
});

const hookParamsSchema = workspaceParamsSchema.extend({
  hookId: z.string().min(1),
});

const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(200),
});

const hookActionSchema = z.object({
  type: z.literal("webhook"),
  webhook: z.object({
    url: z.string().url(),
    secret: z.string().min(1).optional(),
  }),
});

const createHookSchema = z.object({
  label: z.string().min(1),
  trigger: z.enum([
    "llm.model.select.before",
    "llm.request.before",
    "llm.response.after",
    "tool.call.before",
    "tool.call.after",
    "tool.call.error",
    "approval.create.before",
    "approval.resolve.after",
    "orchestration.run.before",
    "orchestration.phase.before",
    "orchestration.phase.after",
    "orchestration.retry.scheduled",
    "orchestration.run.woken",
  ]),
  mode: z.enum(["observe", "mutate", "intercept"]),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  timeoutMs: z.number().int().positive().optional(),
  failPolicy: z.enum(["open", "closed"]).optional(),
  action: hookActionSchema,
});

const updateHookSchema = z.object({
  label: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  timeoutMs: z.number().int().positive().optional(),
  failPolicy: z.enum(["open", "closed"]).optional(),
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
      items: fastify.gateway.listWorkspaceHooks(params.data.workspaceId, query.data.limit).map(redactHookRecord),
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
      items: fastify.gateway.listWorkspaceHookRuns(params.data.workspaceId, query.data.limit),
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
      const created = fastify.gateway.createWorkspaceHook({
        ...body.data,
        workspaceId: params.data.workspaceId,
      });
      return reply.code(201).send(redactHookRecord(created));
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
      return reply.send(
        redactHookRecord(
          fastify.gateway.updateWorkspaceHook(
            params.data.workspaceId,
            params.data.hookId,
            body.data,
          ),
        ),
      );
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
      deleted: fastify.gateway.deleteWorkspaceHook(params.data.workspaceId, params.data.hookId),
    });
  });
};

function redactHookRecord(record: HookRecord): HookRecord {
  return {
    ...record,
    action: {
      ...record.action,
      webhook: {
        url: record.action.webhook.url,
      },
    },
  };
}
