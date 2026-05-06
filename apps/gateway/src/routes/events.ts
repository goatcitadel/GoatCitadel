import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import { withRouteAccess } from "./route-access.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  cursor: z.string().optional(),
});

const streamQuerySchema = z.object({
  replay: z.coerce.number().int().nonnegative().max(500).default(50),
  afterCursor: z.string().optional(),
  clientId: z.string().trim().min(1).max(128).optional(),
});

const STREAM_REPLAY_LIMIT = 500;
const DEFAULT_MAX_SSE_CONNECTIONS_PER_IP = 25;

export const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  const activeSseConnectionsByIp = new Map<string, number>();
  const maxSseConnectionsPerIp = resolveMaxSseConnectionsPerIp();

  fastify.get("/api/v1/events", withRouteAccess(fastify, "authenticated-read"), async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const requestedSequenceCursor = parseSequenceCursor(parsed.data.cursor);
    const bounds = fastify.services.realtimeEvents.getRealtimeEventSequenceBounds();
    if (
      requestedSequenceCursor !== undefined &&
      bounds.oldestSequence !== undefined &&
      requestedSequenceCursor < bounds.oldestSequence
    ) {
      return reply.code(409).send({
        error: "replay_gap",
        requestedCursor: String(requestedSequenceCursor),
        oldestCursor: String(bounds.oldestSequence),
        newestCursor: bounds.newestSequence !== undefined ? String(bounds.newestSequence) : undefined,
      });
    }

    const items = fastify.services.realtimeEvents.listRealtimeEvents(parsed.data.limit, parsed.data.cursor);
    const last = items[items.length - 1];
    const nextCursor = items.length === parsed.data.limit && last ? String(last.sequence) : undefined;
    return reply.send({ items, nextCursor });
  });

  fastify.get("/api/v1/events/stream", withRouteAccess(fastify, "sse-read"), async (request, reply) => {
    const parsed = streamQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const connectionKey = normalizeSseConnectionKey(request.ip);
    const activeConnections = activeSseConnectionsByIp.get(connectionKey) ?? 0;
    if (activeConnections >= maxSseConnectionsPerIp) {
      return reply.code(429).send({
        error: "Too many active realtime streams for this client.",
        code: "SSE_CONNECTION_LIMIT",
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
    raw.write(": connected\n\n");

    const send = (payload: unknown, eventId?: number) => {
      if (typeof eventId === "number" && Number.isFinite(eventId)) {
        raw.write(`id: ${eventId}\n`);
      }
      raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const sendNamedEvent = (eventName: string, payload: unknown) => {
      raw.write(`event: ${eventName}\n`);
      raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const requestedCursor =
      parseSequenceCursor(parsed.data.afterCursor) ??
      parseSequenceCursor(readLastEventId(request.headers["last-event-id"]));
    const clientId = parsed.data.clientId?.trim() || randomUUID();
    const lease = fastify.services.realtimeEvents.openRealtimeStreamLease({
      streamName: "events",
      clientId,
      requestedCursor,
      connectedAt: new Date().toISOString(),
    });
    const bounds = fastify.services.realtimeEvents.getRealtimeEventSequenceBounds();
    if (
      requestedCursor !== undefined &&
      bounds.oldestSequence !== undefined &&
      requestedCursor < bounds.oldestSequence
    ) {
      sendNamedEvent("replay-gap", {
        error: "replay_gap",
        requestedCursor,
        oldestCursor: bounds.oldestSequence,
        newestCursor: bounds.newestSequence,
      });
      fastify.services.realtimeEvents.closeRealtimeStreamLease({
        leaseId: lease.leaseId,
        closeReason: "replay_gap",
      });
      releaseConnection();
      raw.end();
      reply.hijack();
      return;
    }

    const replay =
      requestedCursor !== undefined
        ? fastify.services.realtimeEvents.listRealtimeEventsAfterSequence(requestedCursor, STREAM_REPLAY_LIMIT)
        : fastify.services.realtimeEvents.listRealtimeEvents(parsed.data.replay).reverse();
    const latestReplayEvent = replay[replay.length - 1];
    if (
      requestedCursor !== undefined &&
      bounds.newestSequence !== undefined &&
      (latestReplayEvent?.sequence ?? requestedCursor) < bounds.newestSequence
    ) {
      sendNamedEvent("replay-gap", {
        error: "replay_gap",
        reason: "replay_window_truncated",
        requestedCursor,
        oldestCursor: bounds.oldestSequence,
        lastReplayCursor: latestReplayEvent?.sequence,
        newestCursor: bounds.newestSequence,
        replayLimit: STREAM_REPLAY_LIMIT,
      });
      fastify.services.realtimeEvents.closeRealtimeStreamLease({
        leaseId: lease.leaseId,
        closeReason: "replay_gap",
      });
      releaseConnection();
      raw.end();
      reply.hijack();
      return;
    }
    for (const event of replay) {
      send(event, event.sequence);
    }
    fastify.services.realtimeEvents.touchRealtimeStreamLease({
      leaseId: lease.leaseId,
      requestedCursor,
      lastSentSequence: latestReplayEvent?.sequence,
      lastEventAt: latestReplayEvent?.timestamp,
    });
    sendNamedEvent("stream-ready", {
      leaseId: lease.leaseId,
      clientId: lease.clientId,
      gatewayNodeId: lease.gatewayNodeId,
      requestedCursor,
      replayedEventCount: replay.length,
      lastSentSequence: latestReplayEvent?.sequence,
    });

    const unsubscribe = fastify.services.realtimeEvents.subscribeRealtime((event: RealtimeEvent) => {
      try {
        send(event, event.sequence);
        fastify.services.realtimeEvents.touchRealtimeStreamLease({
          leaseId: lease.leaseId,
          lastSentSequence: event.sequence,
          lastEventAt: event.timestamp,
        });
      } catch {
        cleanup("stream_write_error");
      }
    });

    const keepAlive = setInterval(() => {
      try {
        raw.write(": keep-alive\n\n");
        fastify.services.realtimeEvents.touchRealtimeStreamLease({
          leaseId: lease.leaseId,
        });
      } catch {
        cleanup("keepalive_write_error");
      }
    }, 25000);

    let closed = false;
    const cleanup = (closeReason = "client_disconnect") => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(keepAlive);
      unsubscribe();
      fastify.services.realtimeEvents.closeRealtimeStreamLease({
        leaseId: lease.leaseId,
        closeReason,
      });
      releaseConnection();
      try {
        raw.end();
      } catch {
        // ignore
      }
    };

    raw.on("close", () => cleanup("client_disconnect"));
    request.raw.on("aborted", () => cleanup("client_aborted"));
    reply.hijack();
  });
};

function parseSequenceCursor(cursor?: string): number | undefined {
  if (!cursor || !/^\d+$/.test(cursor.trim())) {
    return undefined;
  }
  const value = Number.parseInt(cursor.trim(), 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readLastEventId(value: string | string[] | undefined): string | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function normalizeSseConnectionKey(ip: string): string {
  return ip.trim().toLowerCase().replace(/%.+$/, "");
}

function resolveMaxSseConnectionsPerIp(): number {
  const raw = process.env.GOATCITADEL_SSE_MAX_CONNECTIONS_PER_IP?.trim();
  if (!raw) {
    return DEFAULT_MAX_SSE_CONNECTIONS_PER_IP;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SSE_CONNECTIONS_PER_IP;
}

export const __internal = {
  normalizeSseConnectionKey,
  resolveMaxSseConnectionsPerIp,
};
