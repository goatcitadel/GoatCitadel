import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  projectSessionMetaForPublic,
  projectSessionSummaryForPublic,
  projectSessionTimelineItemForPublic,
  projectTranscriptEventForPublic,
} from "../services/session-operational-public-projection.js";

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  cursor: z.string().optional(),
});

const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

const runtimeLifecycleIdentifierSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  turnId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  approvalId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
});

const runtimeLifecycleQuerySchema = runtimeLifecycleIdentifierSchema.refine(
  (value) => Boolean(value.sessionId || value.turnId || value.runId || value.approvalId || value.taskId),
  {
    message: "Provide at least one lifecycle identifier.",
    path: ["sessionId"],
  },
);

const runtimeLifecycleExportQuerySchema = runtimeLifecycleIdentifierSchema
  .extend({
    includeTranscript: z.coerce.boolean().optional(),
    includeTimeline: z.coerce.boolean().optional(),
    timelineLimit: z.coerce.number().int().positive().max(1000).optional(),
    format: z.enum(["bundle", "trust_report", "siem_ndjson"]).optional(),
  })
  .refine((value) => Boolean(value.sessionId || value.turnId || value.runId || value.approvalId || value.taskId), {
    message: "Provide at least one lifecycle identifier.",
    path: ["sessionId"],
  });

type RuntimeLifecycleExportRouteQuery = z.infer<typeof runtimeLifecycleExportQuerySchema>;
interface RuntimeLifecycleExporterRouteShape {
  exportLifecycle(input: RuntimeLifecycleExportRouteQuery): Promise<unknown>;
  exportLifecycleSiemNdjson(input: RuntimeLifecycleExportRouteQuery): Promise<string>;
}

export const sessionsListRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/runtime/lifecycle", async (request, reply) => {
    const parsed = runtimeLifecycleQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.runtimeLifecycle.getLifecycle(parsed.data));
  });

  fastify.get("/api/v1/runtime/lifecycle/export", async (request, reply) => {
    const parsed = runtimeLifecycleExportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const runtimeLifecycleExporter = fastify.services.runtimeLifecycle as unknown as RuntimeLifecycleExporterRouteShape;
    if (parsed.data.format === "siem_ndjson") {
      return reply
        .type("application/x-ndjson")
        .send(await runtimeLifecycleExporter.exportLifecycleSiemNdjson(parsed.data));
    }
    return reply.send(await runtimeLifecycleExporter.exportLifecycle(parsed.data));
  });

  fastify.get("/api/v1/sessions", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const items = fastify.services.sessionsList.listSessions(parsed.data.limit, parsed.data.cursor);
    const last = items[items.length - 1];
    const nextCursor = items.length === parsed.data.limit && last ? `${last.updatedAt}|${last.sessionId}` : undefined;

    return reply.send({ items: items.map(projectSessionMetaForPublic), nextCursor });
  });

  fastify.get("/api/v1/sessions/:sessionId", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    return reply.send(projectSessionMetaForPublic(fastify.services.sessionsList.getSession(sessionId)));
  });

  fastify.get("/api/v1/sessions/:sessionId/transcript", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const events = await fastify.services.sessionsList.getTranscript(sessionId);
    return reply.send({ items: events.map(projectTranscriptEventForPublic) });
  });

  fastify.get("/api/v1/sessions/:sessionId/summary", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    return reply.send(projectSessionSummaryForPublic(await fastify.services.sessionsList.getSessionSummary(sessionId)));
  });

  fastify.get("/api/v1/sessions/:sessionId/timeline", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const parsed = timelineQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const items = await fastify.services.sessionsList.listSessionTimeline(sessionId, parsed.data.limit);
    return reply.send({ items: items.map(projectSessionTimelineItemForPublic) });
  });
};
