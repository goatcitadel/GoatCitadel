import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { RealtimeEvent } from "@goatcitadel/contracts";
import { withRouteAccess } from "./route-access.js";
import { writeSseChunk, writeSsePayload } from "./sse-writer.js";

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
const SEQUENCE_CURSOR_PATTERN = /^\d+$/;

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

    const send = (payload: unknown, eventId?: number) => {
      return writeSsePayload(raw, payload, {
        eventId: typeof eventId === "number" && Number.isFinite(eventId) ? eventId : undefined,
        signal: controller.signal,
      });
    };

    const sendNamedEvent = (eventName: string, payload: unknown) => {
      return writeSsePayload(raw, payload, { eventName, signal: controller.signal });
    };

    const requestedCursor =
      parseSequenceCursor(parsed.data.afterCursor) ??
      parseSequenceCursor(readLastEventId(request.headers["last-event-id"]));
    const clientId = parsed.data.clientId?.trim() || randomUUID();
    // Open inside an IIFE so a throw here (e.g. a storage-layer failure) releases the per-IP
    // connection slot that was incremented above. Without this, a failed open would skip the
    // disconnect handlers wired further down, leaking the slot permanently and eventually
    // 429-ing every future stream from this IP.
    const lease = (() => {
      try {
        return fastify.services.realtimeEvents.openRealtimeStreamLease({
          streamName: "events",
          clientId,
          requestedCursor,
          connectedAt: new Date().toISOString(),
        });
      } catch (error) {
        releaseConnection();
        throw error;
      }
    })();
    let closed = false;
    let writeChain = Promise.resolve();
    let unsubscribe = () => undefined;
    // Declared up-front (and cleared in cleanup) because cleanup() can run
    // before the keep-alive interval is created — e.g. a replay-gap early return
    // or a disconnect during replay. Assigned after the replay buffer is flushed.
    let keepAlive: ReturnType<typeof setInterval> | undefined = undefined;
    function cleanup(closeReason = "client_disconnect") {
      if (closed) {
        return;
      }
      closed = true;
      controller.abort(new Error(closeReason));
      if (keepAlive !== undefined) {
        clearInterval(keepAlive);
      }
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
    }

    // Attach the live subscription BEFORE taking the replay snapshot so events
    // published in the gap between snapshot and subscribe are not lost. Live
    // events are buffered in memory until the replay snapshot has been flushed,
    // then drained (deduplicated against the snapshot by monotonic sequence) and
    // finally delivered directly. See INFRA-003.
    let replayFlushed = false;
    let lastDeliveredSequence = requestedCursor;
    const liveBuffer: RealtimeEvent[] = [];
    const deliverLiveEvent = (event: RealtimeEvent) => {
      writeChain = writeChain
        .then(async () => {
          if (closed) {
            return;
          }
          // Drop events already covered by the replay snapshot or an earlier
          // delivery so nothing is forwarded twice.
          if (lastDeliveredSequence !== undefined && event.sequence <= lastDeliveredSequence) {
            return;
          }
          const wrote = await send(event, event.sequence);
          if (!wrote) {
            cleanup("stream_write_error");
            return;
          }
          lastDeliveredSequence = event.sequence;
          fastify.services.realtimeEvents.touchRealtimeStreamLease({
            leaseId: lease.leaseId,
            lastSentSequence: event.sequence,
            lastEventAt: event.timestamp,
          });
        })
        .catch(() => cleanup("stream_write_error"));
    };
    unsubscribe = fastify.services.realtimeEvents.subscribeRealtime((event: RealtimeEvent) => {
      if (replayFlushed) {
        deliverLiveEvent(event);
        return;
      }
      liveBuffer.push(event);
    });

    raw.on("close", () => cleanup("client_disconnect"));
    request.raw.on("aborted", () => cleanup("client_aborted"));

    const bounds = fastify.services.realtimeEvents.getRealtimeEventSequenceBounds();
    if (
      requestedCursor !== undefined &&
      bounds.oldestSequence !== undefined &&
      requestedCursor < bounds.oldestSequence
    ) {
      await sendNamedEvent("replay-gap", {
        error: "replay_gap",
        requestedCursor,
        oldestCursor: bounds.oldestSequence,
        newestCursor: bounds.newestSequence,
      });
      cleanup("replay_gap");
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
      await sendNamedEvent("replay-gap", {
        error: "replay_gap",
        reason: "replay_window_truncated",
        requestedCursor,
        oldestCursor: bounds.oldestSequence,
        lastReplayCursor: latestReplayEvent?.sequence,
        newestCursor: bounds.newestSequence,
        replayLimit: STREAM_REPLAY_LIMIT,
      });
      cleanup("replay_gap");
      reply.hijack();
      return;
    }
    for (const event of replay) {
      await send(event, event.sequence);
    }
    if (latestReplayEvent !== undefined) {
      lastDeliveredSequence = latestReplayEvent.sequence;
    }

    // Flush events that arrived while the snapshot was being read/written.
    // Drain in a loop because additional events may be buffered while we await
    // each write. Dedup by monotonic sequence so events already covered by the
    // snapshot (or earlier flushed entries) are not sent twice, and preserve
    // ascending order. Once the buffer is empty we switch to direct delivery;
    // the listener guard means no event can slip in between the final drain and
    // the flag flip.
    let flushIndex = 0;
    let flushedEventCount = 0;
    let lastFlushedEvent: RealtimeEvent | undefined;
    while (!closed && flushIndex < liveBuffer.length) {
      const event = liveBuffer[flushIndex];
      flushIndex += 1;
      if (!event) {
        continue;
      }
      if (lastDeliveredSequence !== undefined && event.sequence <= lastDeliveredSequence) {
        continue;
      }
      const wrote = await send(event, event.sequence);
      if (!wrote) {
        cleanup("stream_write_error");
        reply.hijack();
        return;
      }
      lastDeliveredSequence = event.sequence;
      flushedEventCount += 1;
      lastFlushedEvent = event;
    }
    replayFlushed = true;

    if (closed) {
      reply.hijack();
      return;
    }

    const lastSentEvent = lastFlushedEvent ?? latestReplayEvent;
    fastify.services.realtimeEvents.touchRealtimeStreamLease({
      leaseId: lease.leaseId,
      requestedCursor,
      lastSentSequence: lastSentEvent?.sequence,
      lastEventAt: lastSentEvent?.timestamp,
    });
    await sendNamedEvent("stream-ready", {
      leaseId: lease.leaseId,
      clientId: lease.clientId,
      gatewayNodeId: lease.gatewayNodeId,
      requestedCursor,
      replayedEventCount: replay.length + flushedEventCount,
      lastSentSequence: lastSentEvent?.sequence,
    });

    keepAlive = setInterval(() => {
      void writeSseChunk(raw, ": keep-alive\n\n", controller.signal)
        .then((wrote) => {
          if (!wrote) {
            cleanup("keepalive_write_error");
            return;
          }
          fastify.services.realtimeEvents.touchRealtimeStreamLease({
            leaseId: lease.leaseId,
          });
        })
        .catch(() => cleanup("keepalive_write_error"));
    }, 25000);

    reply.hijack();
  });
};

function parseSequenceCursor(cursor?: string): number | undefined {
  if (!cursor) {
    return undefined;
  }
  const trimmed = cursor.trim();
  if (!SEQUENCE_CURSOR_PATTERN.test(trimmed)) {
    return undefined;
  }
  const value = Number.parseInt(trimmed, 10);
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
