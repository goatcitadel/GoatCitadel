import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { AGENTIC_DIAGNOSTIC_CODES, type AgenticSubagentMetadata } from "@goatcitadel/contracts";
import process from "node:process";
import { z } from "zod";
import { buildAgenticRuntimeAvailability } from "../services/agentic-capability-availability.js";
import { probeAgenticHarnessAvailability } from "../services/agentic-harness-availability.js";
import {
  MAX_TASK_ARTIFACT_CLAIM_LABEL_CHARS,
  MAX_TASK_ARTIFACT_CLAIM_VALUE_CHARS,
  MAX_TASK_ARTIFACT_CLAIMS,
} from "../services/task-artifact-verifier.js";
import type { TaskWorkspaceAccessOptions } from "../services/task-lifecycle-service.js";
import { sendRouteError } from "./_error-handler.js";

const KANBAN_MUTATION_RATE_LIMIT_MAX = 180;

const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
  request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;

const statusSchema = z.enum(["planning", "inbox", "assigned", "in_progress", "testing", "review", "done", "blocked"]);

const prioritySchema = z.enum(["low", "normal", "high", "urgent"]);
const agenticRunStatusSchema = z.enum([
  "queued",
  "planning",
  "running",
  "approval_required",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "stopped_by_limit",
]);

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
  activityType: z.enum([
    "spawned",
    "updated",
    "completed",
    "file_created",
    "status_changed",
    "comment",
    "diagnostic",
    "heartbeat",
    "control",
    "handoff",
    "delivery",
  ]),
  message: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

const createDeliverableSchema = z.object({
  deliverableType: z.enum(["file", "url", "artifact"]),
  title: z.string().min(1),
  path: z.string().optional(),
  description: z.string().optional(),
});

const agenticSubagentMetadataSchema = z
  .object({
    runId: z.string().min(1).optional(),
    parentRunId: z.string().min(1).optional(),
    profileId: z.string().min(1).optional(),
    contextMode: z.enum(["isolated", "fork"]).optional(),
    index: z.number().int().nonnegative().optional(),
    dependsOnStepIds: z.array(z.string().min(1)).optional(),
    heartbeatAt: z.string().datetime().optional(),
    timeoutAt: z.string().datetime().optional(),
    failureClass: z
      .enum([
        "spawn_failure",
        "timeout",
        "crash",
        "stale_worker",
        "invalid_assignee",
        "unsafe_transition",
        "missing_handoff",
        "missing_artifact",
        "repeated_tool_loop",
        "approval_stale",
        "delivery_failed",
        "provider_fallback_loop",
        "other",
      ])
      .optional(),
    diagnostics: z.array(z.record(z.unknown())).optional(),
    costUsd: z.number().nonnegative().optional(),
    tokenTotal: z.number().int().nonnegative().optional(),
    filesTouched: z.array(z.string().min(1)).optional(),
    handoffEvidence: z.record(z.unknown()).optional(),
  })
  .strict()
  .transform((value) => value as AgenticSubagentMetadata);

const createSubagentSchema = z.object({
  agentSessionId: z.string().min(1),
  agentName: z.string().min(1).optional(),
  metadata: agenticSubagentMetadataSchema.optional(),
});

const updateSubagentSchema = z.object({
  status: z.enum(["active", "paused", "completed", "failed", "killed", "stale"]).optional(),
  metadata: agenticSubagentMetadataSchema.nullable().optional(),
  endedAt: z.string().datetime().optional(),
});

const agenticRunsQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  status: agenticRunStatusSchema.optional(),
  surface: z.enum(["chat", "cowork", "code"]).optional(),
  sessionId: z.string().min(1).optional(),
  boardId: z.string().min(1).optional(),
  parentRunId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const agenticRunParamsSchema = z.object({
  runId: z.string().min(1),
});

const agenticRunAccessQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
});

const agenticControlSchema = z.object({
  action: z.enum(["pause", "cancel", "retry", "steer", "kill_child", "approve", "reject", "open_child"]),
  controlId: z.string().min(1).optional(),
  reason: z.string().optional(),
  instruction: z.string().optional(),
  agentSessionId: z.string().optional(),
  approvalId: z.string().optional(),
  actorId: z.string().optional(),
});

const agenticDiagnosticSchema = z.object({
  code: z.enum(AGENTIC_DIAGNOSTIC_CODES),
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string().min(1),
  summary: z.string().min(1),
  evidenceRef: z.string().optional(),
  signalId: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  resolvedAt: z.string().datetime().optional(),
});

const distressSignalCodeSchema = z.enum([
  "needs_user",
  "tool_error",
  "provider_outage",
  "hallucination_suspected",
  "stale_heartbeat",
  "worker_crash",
  "artifact_missing",
  "retry_budget_exhausted",
]);
const distressSeveritySchema = z.enum(["info", "warn", "critical"]);

const emitDistressBodySchema = z.object({
  code: distressSignalCodeSchema,
  severity: distressSeveritySchema,
  title: z.string().min(1),
  summary: z.string(),
  emittedBy: z.string().min(1).optional(),
  evidenceRef: z.string().min(1).optional(),
});

const resolveDistressBodySchema = z.object({});

const retryBudgetBodySchema = z.object({
  maxRetries: z.number().int().nonnegative(),
});

const artifactClaimSchema = z.object({
  kind: z.enum(["file", "url", "commit_sha"]),
  value: z.string().min(1).max(MAX_TASK_ARTIFACT_CLAIM_VALUE_CHARS),
  label: z.string().min(1).max(MAX_TASK_ARTIFACT_CLAIM_LABEL_CHARS).optional(),
});

const verifyArtifactsBodySchema = z.object({
  claims: z.array(artifactClaimSchema).min(1).max(MAX_TASK_ARTIFACT_CLAIMS),
});

const bulkActionBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("unblock"), taskIds: z.array(z.string().min(1)).min(1) }),
  z.object({ action: z.literal("retry"), taskIds: z.array(z.string().min(1)).min(1), reason: z.string().min(1) }),
  z.object({
    action: z.literal("reassign"),
    taskIds: z.array(z.string().min(1)).min(1),
    assignedAgentId: z.string().min(1),
  }),
  z.object({ action: z.literal("close"), taskIds: z.array(z.string().min(1)).min(1) }),
]);

const deleteTaskQuerySchema = z.object({
  mode: z.enum(["soft", "hard"]).default("soft"),
});

const deleteTaskBodySchema = z
  .object({
    mode: z.enum(["soft", "hard"]).optional(),
    deletedBy: z.string().min(1).optional(),
    deleteReason: z.string().min(1).max(400).optional(),
    confirmToken: z.string().optional(),
  })
  .optional();

export const tasksRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/agentic/availability", async (_request, reply) => {
    const generatedAt = new Date().toISOString();
    try {
      return reply.send(
        buildAgenticRuntimeAvailability({
          generatedAt,
          harnesses: probeAgenticHarnessAvailability(buildAgenticHarnessProbeOptions(generatedAt)),
          providers: fastify.services.llm.listLlmProviders(),
          plugins: fastify.services.integrations.listIntegrationPlugins(),
          channelCatalog: fastify.services.integrations.listIntegrationCatalog("channel"),
          channelConnections: fastify.services.integrations.listIntegrationConnections("channel"),
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, _request.log);
    }
  });

  fastify.get("/api/v1/agentic/runs", async (request, reply) => {
    const parsed = agenticRunsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.tasks.listAgenticRuns(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/agentic/runs/:runId/tree", async (request, reply) => {
    const parsed = agenticRunParamsSchema.safeParse(request.params);
    const query = agenticRunAccessQuerySchema.safeParse(request.query);
    if (!parsed.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: parsed.success ? undefined : parsed.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        fastify.services.tasks.getAgenticRunTree(parsed.data.runId, {
          workspaceId: query.data.workspaceId,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/agentic/runs/:runId/control", async (request, reply) => {
    await fastify.requireOperatorAuth(request, reply);
    if (reply.sent) return reply;
    const params = agenticRunParamsSchema.safeParse(request.params);
    const query = agenticRunAccessQuerySchema.safeParse(request.query);
    const body = agenticControlSchema.safeParse(request.body);
    if (!params.success || !query.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(
        fastify.services.tasks.invokeAgenticControl(
          params.data.runId,
          {
            ...body.data,
            actorId: request.authActorId,
          },
          { workspaceId: query.data.workspaceId },
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/tasks/:taskId/agentic/diagnostics", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const parsed = agenticDiagnosticSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply
        .code(201)
        .send(fastify.services.tasks.appendTaskDiagnostic(taskId, parsed.data, readTaskWorkspaceAccess(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/tasks", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const view = parsed.data.view ?? (parsed.data.includeDeleted ? "all" : "active");
    const items = fastify.services.tasks.listTasks(
      parsed.data.limit,
      parsed.data.status,
      parsed.data.cursor,
      view,
      parsed.data.workspaceId,
    );
    const last = items[items.length - 1];
    const nextCursor = items.length === parsed.data.limit && last ? `${last.updatedAt}|${last.taskId}` : undefined;
    return reply.send({ items, nextCursor, view });
  });

  fastify.post("/api/v1/tasks", async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const task = fastify.services.tasks.createTask(parsed.data);
    return reply.code(201).send(task);
  });

  fastify.get("/api/v1/tasks/:taskId", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    try {
      return reply.send(fastify.services.tasks.getTask(taskId, readTaskWorkspaceAccess(request)));
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
      const task = fastify.services.tasks.updateTask(taskId, parsed.data, readTaskWorkspaceAccess(request));
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

    const deleted =
      mode === "hard"
        ? (() => {
            if (confirmToken !== "PERMANENT_DELETE") {
              return undefined;
            }
            return fastify.services.tasks.hardDeleteTask(taskId, readTaskWorkspaceAccess(request));
          })()
        : fastify.services.tasks.softDeleteTask(taskId, deletedBy, deleteReason, readTaskWorkspaceAccess(request));

    if (mode === "hard" && deleted === undefined) {
      if (confirmToken !== "PERMANENT_DELETE") {
        return reply.code(400).send({ error: "Hard delete requires confirmToken=PERMANENT_DELETE" });
      }
    }

    if (!deleted) {
      return reply.code(404).send({ error: `Task ${taskId} not found` });
    }
    return reply.send({ deleted: true, taskId, mode });
  });

  fastify.post("/api/v1/tasks/:taskId/restore", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const restored = fastify.services.tasks.restoreTask(taskId, readTaskWorkspaceAccess(request));
    if (!restored) {
      return reply.code(404).send({ error: `Task ${taskId} not found or not deleted` });
    }
    return reply.send({ restored: true, taskId });
  });

  fastify.get("/api/v1/tasks/:taskId/activities", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    try {
      return reply.send({
        items: fastify.services.tasks.listTaskActivities(taskId, 200, readTaskWorkspaceAccess(request)),
      });
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
      return reply
        .code(201)
        .send(fastify.services.tasks.appendTaskActivity(taskId, parsed.data, readTaskWorkspaceAccess(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/tasks/:taskId/deliverables", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    try {
      return reply.send({
        items: fastify.services.tasks.listTaskDeliverables(taskId, 200, readTaskWorkspaceAccess(request)),
      });
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
      return reply
        .code(201)
        .send(fastify.services.tasks.appendTaskDeliverable(taskId, parsed.data, readTaskWorkspaceAccess(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/tasks/:taskId/subagents", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    try {
      return reply.send({
        items: fastify.services.tasks.listTaskSubagents(taskId, 200, readTaskWorkspaceAccess(request)),
      });
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
      return reply
        .code(201)
        .send(fastify.services.tasks.registerTaskSubagent(taskId, parsed.data, readTaskWorkspaceAccess(request)));
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
      return reply.send(
        fastify.services.tasks.updateTaskSubagent(agentSessionId, parsed.data, readTaskWorkspaceAccess(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  const kanbanMutationRouteConfig = { config: { rateLimit: { max: KANBAN_MUTATION_RATE_LIMIT_MAX } } };

  fastify.post("/api/v1/tasks/:taskId/distress", kanbanMutationRouteConfig, async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const parsed = emitDistressBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const task = fastify.services.tasks.emitDistressSignal(taskId, parsed.data, readTaskWorkspaceAccess(request));
      return reply.code(201).send(task);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/tasks/:taskId/distress/:signalId", kanbanMutationRouteConfig, async (request, reply) => {
    const { taskId, signalId } = request.params as { taskId: string; signalId: string };
    const parsed = resolveDistressBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const task = fastify.services.tasks.resolveDistressSignal(
        taskId,
        signalId,
        { resolvedBy: resolveActorId(request) },
        readTaskWorkspaceAccess(request),
      );
      return reply.send(task);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/tasks/:taskId/retry-budget", kanbanMutationRouteConfig, async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const parsed = retryBudgetBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const task = fastify.services.tasks.setRetryBudget(
        taskId,
        parsed.data.maxRetries,
        readTaskWorkspaceAccess(request),
      );
      return reply.send(task);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/tasks/:taskId/verify-artifacts", kanbanMutationRouteConfig, async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const parsed = verifyArtifactsBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const task = await fastify.services.tasks.verifyTaskArtifacts(
        taskId,
        parsed.data.claims,
        readTaskWorkspaceAccess(request),
      );
      return reply.send(task);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/tasks/bulk", kanbanMutationRouteConfig, async (request, reply) => {
    const parsed = bulkActionBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    try {
      const tasks = fastify.services.tasks.bulkUpdateTasks(parsed.data, readTaskWorkspaceAccess(request));
      return reply.send({ tasks });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};

function readTaskWorkspaceAccess(request: FastifyRequest): TaskWorkspaceAccessOptions {
  return {
    workspaceId:
      readWorkspaceIdFromQuery(request.query) ??
      readWorkspaceIdFromBody(request.body) ??
      readWorkspaceIdFromHeader(request.headers["x-goatcitadel-workspace-id"]),
  };
}

function readWorkspaceIdFromQuery(query: unknown): string | undefined {
  if (!query || typeof query !== "object") {
    return undefined;
  }
  const value = (query as Record<string, unknown>).workspaceId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readWorkspaceIdFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>).workspaceId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readWorkspaceIdFromHeader(value: string | string[] | undefined): string | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildAgenticHarnessProbeOptions(generatedAt: string): Parameters<typeof probeAgenticHarnessAvailability>[0] {
  return {
    env: process.env,
    now: () => generatedAt,
    permissions: {
      codex_cli: readBooleanEnv("GOATCITADEL_AGENTIC_HARNESS_CODEX_CLI_APPROVED"),
      claude_code: readBooleanEnv("GOATCITADEL_AGENTIC_HARNESS_CLAUDE_CODE_APPROVED"),
      opencode: readBooleanEnv("GOATCITADEL_AGENTIC_HARNESS_OPENCODE_APPROVED"),
      gemini_cli: readBooleanEnv("GOATCITADEL_AGENTIC_HARNESS_GEMINI_CLI_APPROVED"),
      acp: readBooleanEnv("GOATCITADEL_AGENTIC_HARNESS_ACP_APPROVED"),
      scripted_runner: readBooleanEnv("GOATCITADEL_SCRIPTED_RUNNER_APPROVED"),
    },
    sandbox: {
      required: readBooleanEnv("GOATCITADEL_AGENTIC_HARNESS_SANDBOX_REQUIRED") ?? true,
      satisfied: readBooleanEnv("GOATCITADEL_AGENTIC_HARNESS_SANDBOX_SATISFIED") === true,
      reason: process.env.GOATCITADEL_AGENTIC_HARNESS_SANDBOX_REASON,
    },
    policyApprovedToolNames: readCsvEnv("GOATCITADEL_SCRIPTED_RUNNER_APPROVED_TOOLS"),
  };
}

function readBooleanEnv(key: string): boolean | undefined {
  const value = process.env[key]?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return undefined;
}

function readCsvEnv(key: string): string[] {
  return (process.env[key] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
