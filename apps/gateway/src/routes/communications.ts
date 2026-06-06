import type { FastifyPluginAsync } from "fastify";
import type { CalendarEventRecord } from "@goatcitadel/contracts";
import { z } from "zod";
import { createCommunicationsDashboardService } from "../services/communications-dashboard-service.js";

const communicationsQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  inboxLimit: z.coerce.number().int().positive().max(50).optional(),
  agendaLimit: z.coerce.number().int().positive().max(100).optional(),
});

const mailDraftSchema = z.object({
  accountId: z.string().min(1),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1),
  bodyText: z.string().min(1),
});

const draftParamsSchema = z.object({
  draftId: z.string().min(1),
});

const calendarEventSchema = z.object({
  accountId: z.string().min(1),
  calendarId: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  startIso: z.string().datetime(),
  endIso: z.string().datetime(),
  attendees: z.array(z.string().email()).default([]),
  location: z.string().optional(),
  approvalId: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
});

export const communicationsRoutes: FastifyPluginAsync = async (fastify) => {
  const service = createCommunicationsDashboardService({
    createApproval: (input) => fastify.services.approvals.createApproval(input),
    listIntegrationConnections: (kind, limit) =>
      fastify.services.integrations.listIntegrationConnections(kind, limit),
    commsGmailRead: (input) => fastify.services.comms.commsGmailRead(input),
    commsCalendarList: (input) => fastify.services.comms.commsCalendarList(input),
  });

  fastify.get("/api/v1/communications", async (request, reply) => {
    const parsed = communicationsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(await service.getDashboard(parsed.data));
  });

  fastify.post("/api/v1/mail/drafts", async (request, reply) => {
    const parsed = mailDraftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.code(201).send(service.createDraft(parsed.data));
  });

  fastify.post("/api/v1/mail/drafts/:draftId/send", async (request, reply) => {
    const params = draftParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    return reply.send(await service.sendDraft(params.data.draftId));
  });

  fastify.post("/api/v1/calendar/events", async (request, reply) => {
    const parsed = calendarEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.code(202).send(await service.createCalendarEventPlaceholder(parsed.data as CalendarEventDraftInput));
  });
};

type CalendarEventDraftInput = Omit<CalendarEventRecord, "eventId" | "createdAt" | "updatedAt">;
