import type { FastifyInstance, FastifyRequest } from "fastify";
import { isGoatError, type ChatDelegateRequest } from "@goatcitadel/contracts";
import { z } from "zod";
import {
  projectChatDelegateResponseForPublic,
  projectChatDelegateSuggestionForPublic,
  projectChatDelegationRunForPublic,
  projectChatDelegationStreamValueForPublic,
} from "../services/chat-secret-projection.js";
import { sessionParamsSchema, getPublicChatSseErrorMessage } from "./chat.shared.js";
import { writeSseChunk, writeSsePayload } from "./sse-writer.js";

const delegateStepSchema = z.object({
  stepId: z.string().min(1).optional(),
  index: z.number().int().nonnegative().optional(),
  role: z.string().min(1),
  parallelizable: z.boolean().optional(),
  dependsOnStepIds: z.array(z.string().min(1)).optional(),
});

const chatOnlyModeSchema = z.enum(["chat", "cowork", "code"]).transform(() => "chat" as const);

const delegateBodySchema = z.object({
  objective: z.string().min(1),
  roles: z.array(z.string().min(1)).min(1),
  mode: z.enum(["sequential", "parallel"]).default("sequential"),
  surfaceMode: chatOnlyModeSchema.optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  steps: z.array(delegateStepSchema).optional(),
  permissionProfileId: z.string().trim().min(1).optional(),
  localOperatorOverrideId: z.string().trim().min(1).optional(),
  policyRunId: z.string().trim().min(1).optional(),
  policyTaskId: z.string().trim().min(1).optional(),
  fullWebAccess: z.boolean().optional(),
  executionProfile: z.enum(["standard", "read_only_explorer"]).optional(),
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
  surfaceMode: chatOnlyModeSchema.optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  steps: z.array(delegateStepSchema).optional(),
  permissionProfileId: z.string().trim().min(1).optional(),
  localOperatorOverrideId: z.string().trim().min(1).optional(),
  policyRunId: z.string().trim().min(1).optional(),
  policyTaskId: z.string().trim().min(1).optional(),
  fullWebAccess: z.boolean().optional(),
});

function stampDelegateOperatorContext<TInput extends Partial<ChatDelegateRequest>>(
  request: FastifyRequest,
  input: TInput,
): TInput {
  return {
    ...input,
    operatorId: request.authActorId,
    authActorId: request.authActorId,
    authActorSource: request.authActorSource,
  } as TInput;
}

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
      return reply.send(
        projectChatDelegateResponseForPublic(
          await fastify.services.chatDelegate.runChatDelegation(
            params.data.sessionId,
            stampDelegateOperatorContext(request, body.data),
          ),
        ),
      );
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
    await writeSseChunk(raw, ": connected\n\n", controller.signal);
    raw.on("close", cleanup);
    request.raw.on("aborted", cleanup);

    const send = async (payload: unknown): Promise<boolean> => {
      if (closed || raw.destroyed || raw.writableEnded || controller.signal.aborted) {
        return false;
      }
      return writeSsePayload(raw, payload, { signal: controller.signal });
    };

    try {
      for await (const chunk of fastify.services.chatDelegate.runChatDelegationStream(
        params.data.sessionId,
        stampDelegateOperatorContext(request, body.data),
        { abortSignal: controller.signal },
      )) {
        if (controller.signal.aborted) {
          break;
        }
        const wrote = await send(projectChatDelegationStreamValueForPublic(chunk));
        if (!wrote) {
          break;
        }
      }
      finished = !controller.signal.aborted;
    } catch (error) {
      if (!controller.signal.aborted) {
        reply.log.error({ err: error, sessionId: params.data.sessionId }, "chat delegation SSE stream failed");
        await send({ type: "error", error: getPublicChatSseErrorMessage(error) });
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
      return reply.send(
        projectChatDelegationRunForPublic(
          await fastify.services.chatDelegate.getChatDelegationRun(params.data.sessionId, params.data.runId),
        ),
      );
    } catch (error) {
      if (isGoatError(error)) {
        return reply.code(error.httpStatus).send(error.toJSON());
      }
      const message = (error as Error).message;
      const statusCode = message.toLowerCase().includes("not found") ? 404 : 400;
      return reply.code(statusCode).send({ error: message });
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
      return reply.send(
        projectChatDelegateSuggestionForPublic(
          await fastify.services.chatDelegate.suggestChatDelegation(params.data.sessionId, body.data),
        ),
      );
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
      return reply.send(
        projectChatDelegateResponseForPublic(
          await fastify.services.chatDelegate.acceptChatDelegation(
            params.data.sessionId,
            stampDelegateOperatorContext(request, body.data),
          ),
        ),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
}
