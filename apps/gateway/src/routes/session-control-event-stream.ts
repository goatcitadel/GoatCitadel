import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SESSION_CONTROL_MAX_LIST_ITEMS } from "@goatcitadel/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ControlEventStreamEnvelope,
  ControlEventStreamPage,
  SessionControlProtocolActor,
} from "../services/session-control-service.js";
import { sendRouteError } from "./_error-handler.js";
import { writeSseChunk, writeSsePayload } from "./sse-writer.js";

/**
 * HX-411 session-scoped control-event stream (`GET .../control/events/stream`,
 * access class `operator-or-session-control-companion`; the external branch also
 * requires delegated `read`). It is a session/workspace-filtered, ordered,
 * retained SSE projection of the append-only, content-free control-event log —
 * NOT the global `/api/v1/events` stream, and it never touches the realtime
 * event store, so no approval action token, message text, prompt, or token
 * material can ride it. Authorization, session binding, and the delegated-`read`
 * gate all live behind the single service method `pageControlEventStream`
 * (which delegates to `authorizeExternalSessionRead`), so a send-only, unbound,
 * or (post-revoke/superseded-to-operator) reader fails closed before any event
 * is served and, mid-stream, its next page throws — closing the stream with a
 * terminal `control-revoked` frame rather than leaking events it no longer owns.
 */

// Frozen per-connection unsent-envelope watermarks. Crossing the high watermark
// closes the stream with a named `backpressure` reason rather than growing the
// queue without bound or silently dropping envelopes.
const STREAM_LOW_WATERMARK = 64;
const STREAM_HIGH_WATERMARK = 256;
const DEFAULT_STREAM_POLL_MS = 1000;
const LIVE_BATCH_LIMIT = SESSION_CONTROL_MAX_LIST_ITEMS;

const streamQuerySchema = z.object({
  replay: z.coerce.number().int().nonnegative().max(SESSION_CONTROL_MAX_LIST_ITEMS).default(50),
  afterCursor: z.coerce.number().int().nonnegative().optional(),
  clientId: z.string().trim().min(1).max(128).optional(),
});

export interface SessionControlEventStreamContext {
  readonly sessionId: string;
  readonly actor: SessionControlProtocolActor;
}

interface StreamSnapshot {
  oldestSequence: number;
  newestSequence: number;
  truncated: boolean;
  generation: number;
}

/**
 * Drive the session-control event SSE stream. The first (replay) page is read
 * BEFORE any SSE header is written so an unauthorized reader receives a normal
 * typed HTTP error (never a hijacked stream). After headers are written the
 * stream pages FORWARD by true `event_sequence` — replaying (and catching up
 * through every truncated page) then tailing from the last sent sequence — so a
 * session with >200 lifetime control events is fully reachable. The control
 * secret is read only from the frozen header on mutation routes and is NEVER
 * consulted here — a token in the URL/query cannot authorize this read.
 */
export async function streamSessionControlEvents(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  context: SessionControlEventStreamContext,
): Promise<unknown> {
  const parsed = streamQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const service = fastify.services.sessionControl;
  const clientCursor = parsed.data.afterCursor ?? readLastEventIdCursor(request.headers["last-event-id"]);
  // `acknowledgedThrough` advances ONLY from a client-supplied retained cursor,
  // never from a successful TCP write. Within one connection it stays at the
  // cursor the client presented at connect; a reconnect presents a higher one.
  const acknowledgedThrough = clientCursor ?? 0;
  const replayLimit = parsed.data.replay > 0 ? parsed.data.replay : SESSION_CONTROL_MAX_LIST_ITEMS;

  // Authorize + read the replay page before writing SSE headers. A send-only,
  // wrong-bound, non-controller, unknown-session, or revoked reader throws here
  // and is mapped to its typed HTTP status with no stream ever opened.
  let initialPage: ControlEventStreamPage;
  try {
    initialPage = service.pageControlEventStream({
      actor: context.actor,
      sessionId: context.sessionId,
      afterCursor: clientCursor,
      limit: replayLimit,
    });
  } catch (error) {
    return sendRouteError(reply, error, request.log);
  }

  const raw = reply.raw;
  const controller = new AbortController();
  const signal = controller.signal;
  const corsOrigin = reply.getHeader("Access-Control-Allow-Origin");
  const corsCredentials = reply.getHeader("Access-Control-Allow-Credentials");
  const corsVary = reply.getHeader("Vary");
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    // Control routes use `no-store` (not `no-cache`): never persist control
    // protocol evidence in any shared or browser cache.
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...(typeof corsOrigin === "string" ? { "Access-Control-Allow-Origin": corsOrigin } : {}),
    ...(typeof corsCredentials === "string" ? { "Access-Control-Allow-Credentials": corsCredentials } : {}),
    ...(typeof corsVary === "string" ? { Vary: corsVary } : {}),
  });
  raw.flushHeaders?.();

  const clientId = parsed.data.clientId?.trim() || randomUUID();
  const snapshot: StreamSnapshot = {
    oldestSequence: initialPage.oldestSequence,
    newestSequence: initialPage.newestSequence,
    truncated: initialPage.truncated,
    generation: initialPage.generation,
  };
  const pending: ControlEventStreamEnvelope[] = [];
  let sentThrough = clientCursor ?? 0;
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  // Two distinct, explicitly named bounds so neither is overclaimed:
  //  - `bufferLow/HighWatermark`: the frozen bounded unsent-envelope buffer
  //    limits (crossing high closes with a named `backpressure` reason);
  //  - `oldest/newestRetainedCursor`: the retained event_sequence window bounds
  //    (a client cursor before the oldest drives `replay-gap`; `truncated` means
  //    "keep paging forward", never a dead end).
  // `sentThrough` is what was handed to the socket write path; `acknowledgedThrough`
  // advances ONLY from a client-supplied cursor; `pending` is the queued-unsent count.
  const diagnostics = () => ({
    sentThrough,
    acknowledgedThrough,
    pending: pending.length,
    bufferLowWatermark: STREAM_LOW_WATERMARK,
    bufferHighWatermark: STREAM_HIGH_WATERMARK,
    oldestRetainedCursor: snapshot.oldestSequence,
    newestRetainedCursor: snapshot.newestSequence,
    truncated: snapshot.truncated,
    generation: snapshot.generation,
  });

  const cleanup = (closeReason = "client_disconnect") => {
    if (closed) {
      return;
    }
    closed = true;
    controller.abort(new Error(closeReason));
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
    }
    try {
      raw.end();
    } catch {
      // ignore
    }
  };

  const sendNamed = (eventName: string, payload: unknown) => writeSsePayload(raw, payload, { eventName, signal });
  const sendControlEvent = (envelope: ControlEventStreamEnvelope) =>
    writeSsePayload(
      raw,
      { type: "control-event", cursor: envelope.cursor, generation: snapshot.generation, event: envelope.event },
      { eventName: "control-event", eventId: envelope.cursor, signal },
    );

  // Emit a terminal frame (best-effort, before the abort) and tear down.
  const closeStream = async (eventName: string, reason: string): Promise<void> => {
    if (closed) {
      return;
    }
    await sendNamed(eventName, { reason, ...diagnostics() }).catch(() => undefined);
    cleanup(reason);
  };

  raw.on("close", () => cleanup("client_disconnect"));
  request.raw.on("aborted", () => cleanup("client_aborted"));

  await writeSseChunk(raw, ": connected\n\n", signal);

  // Control events are never pruned, so the normal case is "keep paging
  // forward", NOT a gap. Emit replay-gap ONLY when the client's next-needed
  // sequence is genuinely older than the oldest retained event (unreachable),
  // then close so the client does a bounded canonical re-read instead of us
  // fabricating events. A cursor ahead of the newest is not a gap — the tail
  // simply has nothing new yet.
  if (clientCursor !== undefined && initialPage.oldestSequence > 0 && clientCursor + 1 < initialPage.oldestSequence) {
    await sendNamed("replay-gap", {
      reason: "cursor_before_retained",
      requestedCursor: clientCursor,
      oldestRetainedCursor: snapshot.oldestSequence,
      newestRetainedCursor: snapshot.newestSequence,
    });
    cleanup("replay_gap");
    reply.hijack();
    return;
  }

  const applySnapshot = (page: ControlEventStreamPage) => {
    snapshot.oldestSequence = page.oldestSequence;
    snapshot.newestSequence = page.newestSequence;
    snapshot.truncated = page.truncated;
    snapshot.generation = page.generation;
  };

  // Deliver the replay page(s) and page FORWARD until caught up. Because the
  // cursor is the true `event_sequence`, a session with >200 lifetime events is
  // fully reachable: each truncated page is followed from its last cursor, so
  // the recent handoff/reconnect/revoke state arrives rather than only ancient
  // rows. Writes are awaited (socket back-pressure); a mid-replay authority loss
  // (revoke/takeover/auth-revoke) closes with a terminal `control-revoked`.
  let replayPage = initialPage;
  for (;;) {
    let interrupted = false;
    for (const envelope of replayPage.events) {
      if (closed) {
        interrupted = true;
        break;
      }
      const wrote = await sendControlEvent(envelope);
      if (!wrote) {
        cleanup("stream_write_error");
        reply.hijack();
        return;
      }
      sentThrough = envelope.cursor;
    }
    if (interrupted || closed || !replayPage.truncated) {
      break;
    }
    let next: ControlEventStreamPage;
    try {
      next = service.pageControlEventStream({
        actor: context.actor,
        sessionId: context.sessionId,
        afterCursor: sentThrough,
        limit: replayLimit,
      });
    } catch (error) {
      await closeStream("control-revoked", closeReasonForReadDenial(error));
      reply.hijack();
      return;
    }
    applySnapshot(next);
    replayPage = next;
  }
  applySnapshot(replayPage);

  if (!closed) {
    await sendNamed("stream-ready", { clientId, ...diagnostics() });
  }

  const pump = async (): Promise<void> => {
    if (closed) {
      return;
    }
    let page: ControlEventStreamPage;
    try {
      page = service.pageControlEventStream({
        actor: context.actor,
        sessionId: context.sessionId,
        afterCursor: sentThrough,
        limit: LIVE_BATCH_LIMIT,
      });
    } catch (error) {
      // The reader lost control-read authority mid-stream (revoke, emergency
      // takeover, auth/device revocation, or identity-ambiguity revocation all
      // atomically return the session to a new operator generation, so the
      // ex-controller's page now throws). Surface the terminal transition and
      // stop; its generation is terminal and it can read no further events.
      await closeStream("control-revoked", closeReasonForReadDenial(error));
      return;
    }
    applySnapshot(page);

    for (const envelope of page.events) {
      pending.push(envelope);
    }
    if (pending.length > STREAM_HIGH_WATERMARK) {
      // A single intake batch crossed the frozen high watermark. Stop intake and
      // close rather than grow unbounded or drop silently.
      await closeStream("backpressure", "high_watermark_exceeded");
      return;
    }
    while (!closed && pending.length > 0) {
      const envelope = pending.shift();
      if (envelope === undefined) {
        break;
      }
      const wrote = await sendControlEvent(envelope);
      if (!wrote) {
        cleanup("stream_write_error");
        return;
      }
      sentThrough = envelope.cursor;
    }
    if (closed) {
      return;
    }
    // Re-surface the truthful counters/watermarks on the tail every poll (this
    // frame also serves as keep-alive). `truncated` here means "more remain, the
    // next poll continues"; `pending` is the queued-unsent depth.
    const wrote = await sendNamed("control-diagnostics", diagnostics());
    if (!wrote) {
      cleanup("diagnostics_write_error");
    }
  };

  const pollMs = resolveStreamPollMs();
  const scheduleNextPoll = () => {
    if (closed) {
      return;
    }
    pollTimer = setTimeout(() => {
      void pump()
        .then(scheduleNextPoll)
        .catch(() => cleanup("stream_poll_error"));
    }, pollMs);
    pollTimer.unref?.();
  };
  scheduleNextPoll();

  reply.hijack();
  return;
}

function readLastEventIdCursor(value: string | string[] | undefined): number | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function closeReasonForReadDenial(error: unknown): string {
  const code = (error as { details?: { sessionControlCode?: string } } | undefined)?.details?.sessionControlCode;
  if (typeof code === "string" && code.length > 0) {
    return code;
  }
  if (error instanceof Error && error.name === "NotFoundError") {
    return "session_not_found";
  }
  return "control_read_denied";
}

function resolveStreamPollMs(): number {
  const raw = process.env.GOATCITADEL_SESSION_CONTROL_STREAM_POLL_MS?.trim();
  if (!raw) {
    return DEFAULT_STREAM_POLL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STREAM_POLL_MS;
}

export const __internal = {
  STREAM_LOW_WATERMARK,
  STREAM_HIGH_WATERMARK,
  resolveStreamPollMs,
  readLastEventIdCursor,
  closeReasonForReadDenial,
};
