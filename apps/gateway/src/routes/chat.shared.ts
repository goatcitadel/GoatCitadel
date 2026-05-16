import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { isGoatError } from "@goatcitadel/contracts";
import { env } from "../env.js";
import { sendRouteError } from "./_error-handler.js";
import { writeSseChunk, writeSsePayload } from "./sse-writer.js";

export const sessionParamsSchema = z.object({
  sessionId: z.string().min(1),
});

export const turnParamsSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});

export const streamResumeQuerySchema = z.object({
  sinceEventId: z.string().min(1).optional(),
});

export function isChatTurnWriteConflictError(error: unknown): boolean {
  return error instanceof Error && error.name === "ChatTurnWriteConflictError";
}

export function getPublicChatSseErrorMessage(error: unknown): string {
  if (isChatTurnWriteConflictError(error) && error instanceof Error) {
    return error.message;
  }
  if (isGoatError(error)) {
    return error.message;
  }
  return "Chat stream failed before completion. Check gateway diagnostics and retry.";
}

export function sendChatWriteError(reply: FastifyReply, error: unknown) {
  if (isChatTurnWriteConflictError(error) && error instanceof Error) {
    return reply.code(409).send({ error: error.message });
  }
  if (isGoatError(error)) {
    return sendRouteError(reply, error, reply.log);
  }
  reply.log.error({ err: error }, "chat write failed");
  return reply.code(400).send({ error: "Chat write failed. Check gateway diagnostics and retry." });
}

export async function streamSseReply(
  reply: FastifyReply,
  request: {
    raw: { on: (event: string, listener: () => void) => void; off?: (event: string, listener: () => void) => void };
  },
  sessionId: string,
  source: (signal: AbortSignal) => AsyncGenerator<unknown>,
): Promise<void> {
  const raw = reply.raw;
  const controller = new AbortController();
  let closed = false;
  let finished = false;
  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (!controller.signal.aborted) {
      controller.abort(new Error("chat_sse_client_disconnected"));
    }
  };
  const detach = () => {
    raw.off?.("close", cleanup);
    request.raw.off?.("aborted", cleanup);
  };

  reply.hijack();
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
  raw.on("close", cleanup);
  request.raw.on("aborted", cleanup);

  const send = async (payload: unknown): Promise<boolean> => {
    if (closed || raw.destroyed || raw.writableEnded || controller.signal.aborted) {
      return false;
    }
    const eventId =
      typeof payload === "object" &&
      payload &&
      "eventId" in payload &&
      typeof (payload as { eventId?: unknown }).eventId === "string"
        ? (payload as { eventId: string }).eventId
        : undefined;
    return writeSsePayload(raw, payload, { eventId, signal: controller.signal });
  };

  const coalesceEnabled = env.GOATCITADEL_STREAM_COALESCE_OFF !== "true";
  const stream: AsyncIterable<unknown> = coalesceEnabled
    ? coalesceStreamingDeltas(source(controller.signal))
    : source(controller.signal);
  try {
    for await (const chunk of stream) {
      if (controller.signal.aborted) {
        break;
      }
      const wrote = await send(chunk);
      if (!wrote) {
        break;
      }
    }
    finished = !controller.signal.aborted;
  } catch (error) {
    if (!controller.signal.aborted) {
      reply.log.error({ err: error, sessionId }, "chat SSE stream failed");
      await send({
        type: "error",
        sessionId,
        eventId: randomUUID(),
        sequence: 0,
        error: getPublicChatSseErrorMessage(error),
      });
    }
  } finally {
    if (!finished) {
      cleanup();
    }
    detach();
    if (!raw.destroyed && !raw.writableEnded) {
      raw.end();
    }
  }
}

interface CoalesceOptions {
  windowMs?: number;
  coalescableTypes?: ReadonlySet<string>;
}

const DEFAULT_COALESCABLE_TYPES: ReadonlySet<string> = new Set(["delta", "assistant.delta", "thinking.delta"]);

export async function* coalesceStreamingDeltas(
  source: AsyncIterable<unknown>,
  options: CoalesceOptions = {},
): AsyncGenerator<unknown> {
  const types = options.coalescableTypes ?? DEFAULT_COALESCABLE_TYPES;
  const window = Math.max(0, options.windowMs ?? 25);

  let pendingType: string | null = null;
  let pendingDelta = "";
  let pendingTemplate: Record<string, unknown> | null = null;

  const flush = (): unknown | null => {
    if (pendingType === null || pendingTemplate === null) {
      return null;
    }
    const out = { ...pendingTemplate, delta: pendingDelta };
    pendingType = null;
    pendingDelta = "";
    pendingTemplate = null;
    return out;
  };

  let lastEmit = Date.now();

  for await (const raw of source) {
    if (!raw || typeof raw !== "object") {
      const drained = flush();
      if (drained) yield drained;
      yield raw;
      continue;
    }
    const event = raw as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    if (!types.has(type) || typeof event.delta !== "string") {
      const drained = flush();
      if (drained) yield drained;
      yield event;
      lastEmit = Date.now();
      continue;
    }

    if (pendingType !== null && pendingType !== type) {
      const drained = flush();
      if (drained) yield drained;
    }
    pendingType = type;
    pendingDelta += event.delta;
    pendingTemplate = { ...event };
    delete pendingTemplate.delta;

    if (Date.now() - lastEmit >= window) {
      const drained = flush();
      if (drained) {
        yield drained;
        lastEmit = Date.now();
      }
    }
  }

  const tail = flush();
  if (tail) yield tail;
}
