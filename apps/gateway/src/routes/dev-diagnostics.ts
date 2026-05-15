import type { DevDiagnosticsEvent } from "@goatcitadel/contracts";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { writeSseChunk, writeSsePayload } from "./sse-writer.js";

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

export function matchesDevDiagnosticsRouteFilter(
  event: DevDiagnosticsEvent,
  filter: DevDiagnosticsRouteFilter,
): boolean {
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
    const controller = new AbortController();
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.flushHeaders?.();
    await writeSseChunk(raw, ": connected\n\n", controller.signal);

    const send = (payload: unknown) => {
      return writeSsePayload(raw, payload, { signal: controller.signal });
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
      await send(item);
    }

    let closed = false;
    let writeChain = Promise.resolve();
    let unsubscribe = () => undefined;
    function cleanup() {
      if (closed) {
        return;
      }
      closed = true;
      controller.abort(new Error("dev_diagnostics_sse_closed"));
      clearInterval(keepAlive);
      unsubscribe();
      try {
        raw.end();
      } catch {
        // ignore
      }
    }

    const keepAlive = setInterval(() => {
      void writeSseChunk(raw, ": keep-alive\n\n", controller.signal).catch(() => cleanup());
    }, 25000);

    unsubscribe = fastify.services.devDiagnostics.subscribeDevDiagnostics((event: DevDiagnosticsEvent) => {
      if (!matchesDevDiagnosticsRouteFilter(event, parsed.data)) {
        return;
      }
      writeChain = writeChain
        .then(async () => {
          const wrote = await send(event);
          if (!wrote) {
            cleanup();
          }
        })
        .catch(() => cleanup());
    });

    raw.on("close", cleanup);
    request.raw.on("aborted", cleanup);
    reply.hijack();
  });
};
