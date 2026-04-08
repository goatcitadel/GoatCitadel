import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionParamsSchema, getPublicChatSseErrorMessage } from "./chat.shared.js";

const delegateBodySchema = z.object({
  objective: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
  mode: z.enum(["sequential", "parallel"]).default("sequential"),
  providerId: z.string().optional(),
  model: z.string().optional(),
});

const delegationRunParamsSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
});

const delegateSuggestSchema = z.object({
  objective: z.string().optional(),
  roles: z.array(z.string().min(1)).optional(),
  mode: z.enum(["sequential", "parallel"]).optional(),
});

const delegateAcceptSchema = z.object({
  suggestionId: z.string().optional(),
  objective: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
  mode: z.enum(["sequential", "parallel"]).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
});

export function registerChatDelegateRoutes(fastify: FastifyInstance): void {
  fastify.post("/api/v1/chat/sessions/:sessionId/delegate", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = delegateBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.runChatDelegation(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/delegate/stream", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = delegateBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }

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
        controller.abort(new Error("chat_delegation_client_disconnected"));
      }
    };
    const detach = () => {
      raw.off?.("close", cleanup);
      request.raw.off?.("aborted", cleanup);
    };
    const corsOrigin = reply.getHeader("Access-Control-Allow-Origin");
    const corsCredentials = reply.getHeader("Access-Control-Allow-Credentials");
    const corsVary = reply.getHeader("Vary");
    reply.hijack();
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
    raw.on("close", cleanup);
    request.raw.on("aborted", cleanup);

    const send = (payload: unknown) => {
      if (closed || raw.destroyed || raw.writableEnded || controller.signal.aborted) {
        return;
      }
      raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      for await (const chunk of fastify.gateway.runChatDelegationStream(params.data.sessionId, body.data)) {
        if (controller.signal.aborted) {
          break;
        }
        send(chunk);
      }
      finished = !controller.signal.aborted;
    } catch (error) {
      if (!controller.signal.aborted) {
        reply.log.error({ err: error, sessionId: params.data.sessionId }, "chat delegation SSE stream failed");
        send({ type: "error", error: getPublicChatSseErrorMessage(error) });
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
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/delegations/:runId", async (request, reply) => {
    const params = delegationRunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getChatDelegationRun(params.data.sessionId, params.data.runId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/delegate/suggest", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = delegateSuggestSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.suggestChatDelegation(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/delegate/accept", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = delegateAcceptSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.acceptChatDelegation(params.data.sessionId, body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
}
