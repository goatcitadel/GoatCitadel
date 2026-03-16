import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";

const statusSchema = z.enum([
  "planning",
  "inbox",
  "assigned",
  "in_progress",
  "testing",
  "review",
  "done",
  "blocked",
]);

const prioritySchema = z.enum(["low", "normal", "high", "urgent"]);

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
  workspaceId: z.string().min(1).optional(),
  status: statusSchema.optional(),
  view: z.enum(["active", "trash", "all"]).optional(),
  includeDeleted: z.coerce.boolean().optional(),
});

const createTaskSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  assignedAgentId: z.string().min(1).optional(),
  createdBy: z.string().min(1).optional(),
  dueAt: z.string().datetime().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  assignedAgentId: z.string().min(1).nullable().optional(),
  dueAt: z.string().datetime().optional(),
});

const createActivitySchema = z.object({
  agentId: z.string().min(1).optional(),
  activityType: z.enum(["spawned", "updated", "completed", "file_created", "status_changed", "comment"]),
  message: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

const createDeliverableSchema = z.object({
  deliverableType: z.enum(["file", "url", "artifact"]),
  title: z.string().min(1),
  path: z.string().optional(),
  description: z.string().optional(),
});

const createSubagentSchema = z.object({
  agentSessionId: z.string().min(1),
  agentName: z.string().min(1).optional(),
});

const updateSubagentSchema = z.object({
  status: z.enum(["active", "completed", "failed", "killed"]).optional(),
  endedAt: z.string().datetime().optional(),
});

const deleteTaskQuerySchema = z.object({
  mode: z.enum(["soft", "hard"]).default("soft"),
});

const deleteTaskBodySchema = z.object({
  mode: z.enum(["soft", "hard"]).optional(),
  deletedBy: z.string().min(1).optional(),
  deleteReason: z.string().min(1).max(400).optional(),
  confirmToken: z.string().optional(),
}).optional();

export const tasksRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/tasks", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const view = parsed.data.view ?? (parsed.data.includeDeleted ? "all" : "active");
    const items = fastify.gateway.listTasks(
      parsed.data.limit,
      parsed.data.status,
      parsed.data.cursor,
      view,
      parsed.data.workspaceId,
    );
    const last = items[items.length - 1];
    const nextCursor = items.length === parsed.data.limit && last
      ? `${last.updatedAt}|${last.taskId}`
      : undefined;
    return reply.send({ items, nextCursor, view });
  });

  fastify.post("/api/v1/tasks", async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const task = fastify.gateway.createTask(parsed.data);
    return reply.code(201).send(task);
  });

  fastify.get("/api/v1/tasks/:taskId", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    try {
      return reply.send(fastify.gateway.getTask(taskId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/tasks/:taskId", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const task = fastify.gateway.updateTask(taskId, parsed.data);
      return reply.send(task);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/tasks/:taskId", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const queryParsed = deleteTaskQuerySchema.safeParse(request.query);
    const bodyParsed = deleteTaskBodySchema.safeParse(request.body);
    if (!queryParsed.success || !bodyParsed.success) {
      return reply.code(400).send({
        error: {
          query: queryParsed.success ? undefined : queryParsed.error.flatten(),
          body: bodyParsed.success ? undefined : bodyParsed.error.flatten(),
        },
      });
    }

    const mode = bodyParsed.data?.mode ?? queryParsed.data.mode;
    const deletedBy = bodyParsed.data?.deletedBy;
    const deleteReason = bodyParsed.data?.deleteReason;
    const confirmToken = bodyParsed.data?.confirmToken;

    let deleted = false;
    if (mode === "hard") {
      if (confirmToken !== "PERMANENT_DELETE") {
        return reply.code(400).send({ error: "Hard delete requires confirmToken=PERMANENT_DELETE" });
      }
      deleted = fastify.gateway.hardDeleteTask(taskId);
    } else {
      deleted = fastify.gateway.softDeleteTask(taskId, deletedBy, deleteReason);
    }

    if (!deleted) {
      return reply.code(404).send({ error: `Task ${taskId} not found` });
    }
    return reply.send({ deleted: true, taskId, mode });
  });

  fastify.post("/api/v1/tasks/:taskId/restore", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const restored = fastify.gateway.restoreTask(taskId);
    if (!restored) {
      return reply.code(404).send({ error: `Task ${taskId} not found or not deleted` });
    }
    return reply.send({ restored: true, taskId });
  });

  fastify.get("/api/v1/tasks/:taskId/activities", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    try {
      return reply.send({ items: fastify.gateway.listTaskActivities(taskId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/tasks/:taskId/activities", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const parsed = createActivitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.code(201).send(fastify.gateway.appendTaskActivity(taskId, parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/tasks/:taskId/deliverables", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    try {
      return reply.send({ items: fastify.gateway.listTaskDeliverables(taskId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/tasks/:taskId/deliverables", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const parsed = createDeliverableSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.code(201).send(fastify.gateway.appendTaskDeliverable(taskId, parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/tasks/:taskId/subagents", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    try {
      return reply.send({ items: fastify.gateway.listTaskSubagents(taskId) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/tasks/:taskId/subagents", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const parsed = createSubagentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.code(201).send(fastify.gateway.registerTaskSubagent(taskId, parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/subagents/:agentSessionId", async (request, reply) => {
    const agentSessionId = (request.params as { agentSessionId: string }).agentSessionId;
    const parsed = updateSubagentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      return reply.send(fastify.gateway.updateTaskSubagent(agentSessionId, parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
