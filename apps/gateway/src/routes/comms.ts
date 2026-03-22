import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const channelAttachmentSchema = z.object({
  url: z.string().url().optional(),
  title: z.string().optional(),
  mimeType: z.string().optional(),
  dataBase64: z.string().min(1).optional(),
  attachmentId: z.string().uuid().optional(),
});

const channelSendSchema = z.object({
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
}).superRefine((value, ctx) => {
  const hasMessage = value.message.trim().length > 0;
  const hasAttachments = (value.attachments?.length ?? 0) > 0 || (value.attachmentIds?.length ?? 0) > 0;
  if (!hasMessage && !hasAttachments) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["message"],
      message: "message or at least one attachment is required",
    });
  }
});

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

const channelUnsendSchema = z.object({
  connectionId: z.string().uuid(),
  messageId: z.string().min(1),
  target: z.string().min(1).optional(),
  partIndex: z.number().int().min(0).optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
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
  fastify.post("/api/v1/comms/send", async (request, reply) => {
    const parsed = channelSendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.gateway.commsSend(parsed.data));
  });

  fastify.post("/api/v1/comms/react", async (request, reply) => {
    const parsed = channelReactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.gateway.commsReact(parsed.data));
  });

  fastify.post("/api/v1/comms/unsend", async (request, reply) => {
    const parsed = channelUnsendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.gateway.commsUnsend(parsed.data));
  });

  fastify.post("/api/v1/comms/gmail/read", async (request, reply) => {
    const parsed = gmailReadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.gateway.commsGmailRead(parsed.data));
  });

  fastify.post("/api/v1/comms/gmail/send", async (request, reply) => {
    const parsed = gmailSendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.gateway.commsGmailSend(parsed.data));
  });

  fastify.post("/api/v1/comms/calendar/list", async (request, reply) => {
    const parsed = calendarListSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.gateway.commsCalendarList(parsed.data));
  });

  fastify.post("/api/v1/comms/calendar/create", async (request, reply) => {
    const parsed = calendarCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await fastify.gateway.commsCalendarCreate(parsed.data));
  });
};
