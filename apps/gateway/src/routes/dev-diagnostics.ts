import type { DevDiagnosticsEvent } from "@goatcitadel/contracts";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const listQuerySchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  category: z.string().trim().min(1).optional(),
  correlationId: z.string().trim().min(1).optional(),
  runtimeKind: z.string().trim().min(1).optional(),
  runtimeStatus: z.enum(["started", "running", "completed", "failed", "cancelled", "blocked", "degraded"]).optional(),
  runId: z.string().trim().min(1).optional(),
  toolName: z.string().trim().min(1).optional(),
  meetingSessionId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const streamQuerySchema = z.object({
  replay: z.coerce.number().int().positive().max(500).default(50),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  category: z.string().trim().min(1).optional(),
  correlationId: z.string().trim().min(1).optional(),
  runtimeKind: z.string().trim().min(1).optional(),
  runtimeStatus: z.enum(["started", "running", "completed", "failed", "cancelled", "blocked", "degraded"]).optional(),
  runId: z.string().trim().min(1).optional(),
  toolName: z.string().trim().min(1).optional(),
  meetingSessionId: z.string().trim().min(1).optional(),
});

type DevDiagnosticsRouteFilter = Omit<z.infer<typeof streamQuerySchema>, "replay">;

function matchesDevDiagnosticsRouteFilter(event: DevDiagnosticsEvent, filter: DevDiagnosticsRouteFilter): boolean {
  if (filter.level && event.level !== filter.level) {
    return false;
  }
  if (filter.category && event.category !== filter.category) {
    return false;
  }
  if (filter.correlationId && event.correlationId !== filter.correlationId) {
    return false;
  }
  if (filter.runtimeKind && event.runtimeKind !== filter.runtimeKind) {
    return false;
  }
  if (filter.runtimeStatus && event.runtimeStatus !== filter.runtimeStatus) {
    return false;
  }
  if (filter.runId && event.runId !== filter.runId) {
    return false;
  }
  if (filter.toolName && event.toolName !== filter.toolName) {
    return false;
  }
  if (filter.meetingSessionId && event.meetingSessionId !== filter.meetingSessionId) {
    return false;
  }
  return true;
}

export const devDiagnosticsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/dev/diagnostics", async (request, reply) => {
    if (!fastify.services.devDiagnostics.isDevDiagnosticsEnabled()) {
      return reply.code(404).send({ error: "Development diagnostics are disabled." });
    }
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(fastify.services.devDiagnostics.listDevDiagnostics(parsed.data));
  });

  fastify.get("/api/v1/dev/diagnostics/stream", async (request, reply) => {
    if (!fastify.services.devDiagnostics.isDevDiagnosticsEnabled()) {
      return reply.code(404).send({ error: "Development diagnostics are disabled." });
    }
    const parsed = streamQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.flushHeaders?.();
    raw.write(": connected\n\n");

    const send = (payload: unknown) => {
      raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const replay = fastify.services.devDiagnostics
      .listDevDiagnostics({
        level: parsed.data.level,
        category: parsed.data.category,
        correlationId: parsed.data.correlationId,
        runtimeKind: parsed.data.runtimeKind,
        runtimeStatus: parsed.data.runtimeStatus,
        runId: parsed.data.runId,
        toolName: parsed.data.toolName,
        meetingSessionId: parsed.data.meetingSessionId,
        limit: parsed.data.replay,
      })
      .items.reverse();
    for (const item of replay) {
      send(item);
    }

    const unsubscribe = fastify.services.devDiagnostics.subscribeDevDiagnostics((event: DevDiagnosticsEvent) => {
      if (!matchesDevDiagnosticsRouteFilter(event, parsed.data)) {
        return;
      }
      try {
        send(event);
      } catch {
        cleanup();
      }
    });

    const keepAlive = setInterval(() => {
      try {
        raw.write(": keep-alive\n\n");
      } catch {
        cleanup();
      }
    }, 25000);

    let closed = false;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(keepAlive);
      unsubscribe();
      try {
        raw.end();
      } catch {
        // ignore
      }
    };

    raw.on("close", cleanup);
    request.raw.on("aborted", cleanup);
    reply.hijack();
  });
};
