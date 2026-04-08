import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  sessionParamsSchema,
  turnParamsSchema,
  streamResumeQuerySchema,
  streamSseReply,
  sendChatWriteError,
} from "./chat.shared.js";

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
  cursor: z.string().optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1),
  parts: z
    .array(
      z.union([
        z.object({
          type: z.literal("text"),
          text: z.string().min(1),
        }),
        z.object({
          type: z.literal("image_ref"),
          attachmentId: z.string().min(1),
          mimeType: z.string().optional(),
          detail: z.enum(["low", "high", "auto"]).optional(),
        }),
        z.object({
          type: z.literal("audio_ref"),
          attachmentId: z.string().min(1),
          mimeType: z.string().optional(),
        }),
        z.object({
          type: z.literal("video_ref"),
          attachmentId: z.string().min(1),
          mimeType: z.string().optional(),
        }),
        z.object({
          type: z.literal("file_ref"),
          attachmentId: z.string().min(1),
          mimeType: z.string().optional(),
        }),
      ]),
    )
    .optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  useMemory: z.boolean().optional(),
  attachments: z.array(z.string()).optional(),
  mode: z.enum(["chat", "cowork", "code"]).optional(),
  webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
  memoryMode: z.enum(["auto", "on", "off"]).optional(),
  thinkingLevel: z.enum(["minimal", "standard", "extended"]).optional(),
  commandText: z.string().optional(),
  prefsOverride: z
    .object({
      mode: z.enum(["chat", "cowork", "code"]).optional(),
      providerId: z.string().optional(),
      model: z.string().optional(),
      webMode: z.enum(["auto", "off", "quick", "deep"]).optional(),
      memoryMode: z.enum(["auto", "on", "off"]).optional(),
      thinkingLevel: z.enum(["minimal", "standard", "extended"]).optional(),
      toolAutonomy: z.enum(["safe_auto", "manual"]).optional(),
      visionFallbackModel: z.string().optional(),
      orchestrationEnabled: z.boolean().optional(),
      orchestrationIntensity: z.enum(["minimal", "balanced", "deep"]).optional(),
      orchestrationVisibility: z.enum(["hidden", "summarized", "expandable", "explicit"]).optional(),
      orchestrationProviderPreference: z.enum(["speed", "quality", "balanced", "low_cost"]).optional(),
      orchestrationReviewDepth: z.enum(["off", "standard", "strict"]).optional(),
      orchestrationParallelism: z.enum(["auto", "sequential", "parallel"]).optional(),
      codeAutoApply: z.enum(["manual", "low_risk_auto", "aggressive_auto"]).optional(),
      proactiveMode: z.enum(["off", "suggest", "auto_safe", "auto_full"]).optional(),
      autonomyBudget: z
        .object({
          maxActionsPerHour: z.coerce.number().int().positive().max(200).optional(),
          maxActionsPerTurn: z.coerce.number().int().positive().max(25).optional(),
          cooldownSeconds: z.coerce.number().int().min(0).max(3600).optional(),
        })
        .optional(),
      retrievalMode: z.enum(["standard", "layered"]).optional(),
      reflectionMode: z.enum(["off", "on"]).optional(),
    })
    .optional(),
});

const retryTurnSchema = sendMessageSchema.partial().extend({
  content: z.string().optional(),
});

const editTurnSchema = sendMessageSchema;

const cancelTurnSchema = z.object({
  cancelledBy: z.string().min(1).optional(),
});

export function registerChatMessageRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/v1/chat/sessions/:sessionId/messages", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const query = listMessagesSchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      const items = await fastify.gateway.listChatMessages(params.data.sessionId, query.data.limit, query.data.cursor);
      return reply.send({ items });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/thread", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.getChatThread(params.data.sessionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/messages", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    return reply.code(410).send({
      error: "POST /messages has been removed. Use /api/v1/chat/sessions/:sessionId/agent-send instead.",
    });
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/agent-send", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const sent = await fastify.gateway.agentSendChatMessage(params.data.sessionId, body.data);
      return reply.send(sent);
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/messages/stream", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    return reply.code(410).send({
      error: "POST /messages/stream has been removed. Use /api/v1/chat/sessions/:sessionId/agent-send/stream instead.",
    });
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/agent-send/stream", async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params);
    const body = sendMessageSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }

    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.gateway.agentSendChatMessageStream(params.data.sessionId, body.data, signal),
    );
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/turns/:turnId/stream", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const query = streamResumeQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    const headerEventId =
      typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : undefined;
    const sinceEventId = query.data.sinceEventId ?? headerEventId;
    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.gateway.resumeAgentChatTurnStream(params.data.sessionId, params.data.turnId, sinceEventId, signal),
    );
  });

  fastify.get("/api/v1/chat/sessions/:sessionId/turns/:turnId/context-manifest", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      const detail = fastify.gateway.getTurnContextManifestForSession(params.data.sessionId, params.data.turnId);
      if (!detail) {
        return reply.code(404).send({ error: "Context manifest not found" });
      }
      return reply.send(detail);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/select", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.gateway.selectChatBranchTurn(params.data.sessionId, params.data.turnId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/retry", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = retryTurnSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.retryChatTurn(params.data.sessionId, params.data.turnId, body.data));
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/retry/stream", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = retryTurnSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.gateway.retryChatTurnStream(params.data.sessionId, params.data.turnId, body.data, signal),
    );
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/edit", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = editTurnSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(await fastify.gateway.editChatTurn(params.data.sessionId, params.data.turnId, body.data));
    } catch (error) {
      return sendChatWriteError(reply, error);
    }
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/edit/stream", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = editTurnSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    return streamSseReply(reply, request, params.data.sessionId, (signal) =>
      fastify.gateway.editChatTurnStream(params.data.sessionId, params.data.turnId, body.data, signal),
    );
  });

  fastify.post("/api/v1/chat/sessions/:sessionId/turns/:turnId/cancel", async (request, reply) => {
    const params = turnParamsSchema.safeParse(request.params);
    const body = cancelTurnSchema.safeParse(request.body ?? {});
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
        await fastify.gateway.cancelChatTurn(params.data.sessionId, params.data.turnId, body.data.cancelledBy),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
}
