import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ChannelDeliveryRuntimeRecord } from "../services/channel-delivery-runtime-service.js";

const channelAttachmentSchema = z.object({
  url: z.string().url().optional(),
  title: z.string().optional(),
  mimeType: z.string().optional(),
  dataBase64: z.string().min(1).optional(),
  attachmentId: z.string().uuid().optional(),
});

const channelSendBaseSchema = z.object({
  connectionId: z.string().uuid(),
  target: z.string().min(1),
  message: z.string().default(""),
  attachments: z.array(channelAttachmentSchema).optional(),
  attachmentIds: z.array(z.string().uuid()).optional(),
  replyToMessageId: z.string().min(1).optional(),
  replyToPartIndex: z.number().int().min(0).optional(),
  effectId: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

function validateChannelSendLike(
  value: {
    message: string;
    attachments?: unknown[];
    attachmentIds?: string[];
  },
  ctx: z.RefinementCtx,
): void {
  const hasMessage = value.message.trim().length > 0;
  const hasAttachments = (value.attachments?.length ?? 0) > 0 || (value.attachmentIds?.length ?? 0) > 0;
  if (!hasMessage && !hasAttachments) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["message"],
      message: "message or at least one attachment is required",
    });
  }
}

const channelSendSchema = channelSendBaseSchema.superRefine(validateChannelSendLike);

const channelReactSchema = z.object({
  connectionId: z.string().uuid(),
  messageId: z.string().min(1),
  reaction: z.string().min(1),
  target: z.string().min(1).optional(),
  partIndex: z.number().int().min(0).optional(),
  messageText: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

const channelReplySchema = channelSendBaseSchema
  .extend({
    replyToMessageId: z.string().min(1),
  })
  .superRefine(validateChannelSendLike);

const channelUnsendSchema = z.object({
  connectionId: z.string().uuid(),
  messageId: z.string().min(1),
  target: z.string().min(1).optional(),
  partIndex: z.number().int().min(0).optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

const channelTypingSchema = z.object({
  connectionId: z.string().uuid(),
  target: z.string().min(1),
  threadId: z.string().min(1).optional(),
  durationMs: z.number().int().positive().max(60_000).optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

const connectionParamsSchema = z.object({
  connectionId: z.string().uuid(),
});

const deliveriesQuerySchema = z.object({
  connectionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const gmailReadSchema = z.object({
  connectionId: z.string().uuid(),
  query: z.string().optional(),
  maxResults: z.number().int().positive().max(100).optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

const gmailSendSchema = z.object({
  connectionId: z.string().uuid(),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1),
  bodyText: z.string().min(1),
  bodyHtml: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

const calendarListSchema = z.object({
  connectionId: z.string().uuid(),
  calendarId: z.string().optional(),
  fromIso: z.string().datetime().optional(),
  toIso: z.string().datetime().optional(),
  maxResults: z.number().int().positive().max(200).optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

const calendarCreateSchema = z.object({
  connectionId: z.string().uuid(),
  calendarId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  startIso: z.string().datetime(),
  endIso: z.string().datetime(),
  attendees: z.array(z.string().email()).optional(),
  timeZone: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

export const commsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/comms/deliveries", async (request, reply) => {
    const parsed = deliveriesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const deliveryRecords = fastify.services.comms.listChannelDeliveryRuntime() as ChannelDeliveryRuntimeRecord[];
    const deliveries = deliveryRecords
      .filter((record) => !parsed.data.connectionId || record.connectionId === parsed.data.connectionId)
      .slice(0, parsed.data.limit)
      .map((record) => ({
        deliveryId: record.deliveryId,
        connectionId: record.connectionId,
        channelKey: record.channelKey,
        target: record.target,
        status: record.status,
        deliveryStatus: record.deliveryStatus,
        attempts: record.attempts,
        maxAttempts: record.maxAttempts,
        nextAttemptAt: record.nextAttemptAt,
        staleReason: record.staleReason,
        providerMessageId: record.providerMessageId,
        error: record.error,
        fallbackReason: record.fallbackReason,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
    return reply.send({ deliveries, count: deliveries.length });
  });

  fastify.post("/api/v1/comms/send", async (request, reply) => {
    const parsed = channelSendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(
      await fastify.services.comms.commsSend({
        ...parsed.data,
        idempotencyKey: request.idempotencyKey,
      } as never),
    );
  });

  fastify.post("/api/v1/comms/reply", async (request, reply) => {
    const parsed = channelReplySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(
      await fastify.services.comms.commsReply({
        ...parsed.data,
        idempotencyKey: request.idempotencyKey,
      } as never),
    );
  });

  fastify.post("/api/v1/comms/react", async (request, reply) => {
    const parsed = channelReactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.comms.commsReact(parsed.data));
  });

  fastify.post("/api/v1/comms/unsend", async (request, reply) => {
    const parsed = channelUnsendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.comms.commsUnsend(parsed.data));
  });

  fastify.post("/api/v1/comms/typing", async (request, reply) => {
    const parsed = channelTypingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.comms.commsTyping(parsed.data));
  });

  fastify.get("/api/v1/comms/capabilities/:connectionId", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.comms.getIntegrationConnectionChannelCapabilities(params.data.connectionId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("unknown integration connection");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/comms/runtime/:connectionId", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.services.comms.getIntegrationConnectionChannelRuntimeStatus(params.data.connectionId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("unknown integration connection");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/comms/diagnostics/:connectionId", async (request, reply) => {
    const params = connectionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await fastify.services.comms.runIntegrationConnectionDiagnostics(params.data.connectionId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("unknown integration connection");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.post("/api/v1/comms/gmail/read", async (request, reply) => {
    const parsed = gmailReadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.comms.commsGmailRead(parsed.data));
  });

  fastify.post("/api/v1/comms/gmail/send", async (request, reply) => {
    const parsed = gmailSendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.comms.commsGmailSend(parsed.data));
  });

  fastify.post("/api/v1/comms/calendar/list", async (request, reply) => {
    const parsed = calendarListSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.comms.commsCalendarList(parsed.data));
  });

  fastify.post("/api/v1/comms/calendar/create", async (request, reply) => {
    const parsed = calendarCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.services.comms.commsCalendarCreate(parsed.data));
  });
};
