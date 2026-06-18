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

const DEFAULT_MAX_DEV_DIAGNOSTICS_SSE_CONNECTIONS_PER_IP = 25;

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
  const activeSseConnectionsByIp = new Map<string, number>();
  const maxSseConnectionsPerIp = resolveMaxDevDiagnosticsSseConnectionsPerIp();

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

  fastify.get("/api/v1/dev/diagnostics/startup", async (_request, reply) => {
    if (!fastify.services.devDiagnostics.isDevDiagnosticsEnabled()) {
      return reply.code(404).send({ error: "Development diagnostics are disabled." });
    }
    return reply.send(fastify.services.devDiagnostics.getStartupPhaseSnapshot());
  });

  fastify.get("/api/v1/dev/diagnostics/stream", async (request, reply) => {
    if (!fastify.services.devDiagnostics.isDevDiagnosticsEnabled()) {
      return reply.code(404).send({ error: "Development diagnostics are disabled." });
    }
    const parsed = streamQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const connectionKey = normalizeSseConnectionKey(request.ip);
    const activeConnections = activeSseConnectionsByIp.get(connectionKey) ?? 0;
    if (activeConnections >= maxSseConnectionsPerIp) {
      return reply.code(429).send({
        error: "Too many active dev diagnostics streams for this client.",
        code: "DEV_DIAGNOSTICS_SSE_CONNECTION_LIMIT",
        limit: maxSseConnectionsPerIp,
      });
    }
    activeSseConnectionsByIp.set(connectionKey, activeConnections + 1);
    let connectionReleased = false;
    const releaseConnection = () => {
      if (connectionReleased) {
        return;
      }
      connectionReleased = true;
      const current = activeSseConnectionsByIp.get(connectionKey) ?? 0;
      if (current <= 1) {
        activeSseConnectionsByIp.delete(connectionKey);
        return;
      }
      activeSseConnectionsByIp.set(connectionKey, current - 1);
    };

    const raw = reply.raw;
    const controller = new AbortController();
    const corsOrigin = reply.getHeader("Access-Control-Allow-Origin");
    const corsCredentials = reply.getHeader("Access-Control-Allow-Credentials");
    const corsVary = reply.getHeader("Vary");
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(typeof corsOrigin === "string" ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
      ...(typeof corsCredentials === "string" ? { "Access-Control-Allow-Credentials": corsCredentials } : {}),
      ...(typeof corsVary === "string" ? { Vary: corsVary } : {}),
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
    let keepAlive: ReturnType<typeof setInterval> | undefined = undefined;
    function cleanup() {
      if (closed) {
        return;
      }
      closed = true;
      controller.abort(new Error("dev_diagnostics_sse_closed"));
      if (keepAlive !== undefined) {
        clearInterval(keepAlive);
      }
      unsubscribe();
      releaseConnection();
      try {
        raw.end();
      } catch {
        // ignore
      }
    }

    keepAlive = setInterval(() => {
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

function normalizeSseConnectionKey(ip: string): string {
  return ip.trim().toLowerCase().replace(/%.+$/, "");
}

function resolveMaxDevDiagnosticsSseConnectionsPerIp(): number {
  const specific = process.env.GOATCITADEL_DEV_DIAGNOSTICS_SSE_MAX_CONNECTIONS_PER_IP?.trim();
  const shared = process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP?.trim();
  const raw = specific || shared;
  if (!raw) {
    return DEFAULT_MAX_DEV_DIAGNOSTICS_SSE_CONNECTIONS_PER_IP;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_DEV_DIAGNOSTICS_SSE_CONNECTIONS_PER_IP;
}

export const __internal = {
  normalizeSseConnectionKey,
  resolveMaxDevDiagnosticsSseConnectionsPerIp,
};
