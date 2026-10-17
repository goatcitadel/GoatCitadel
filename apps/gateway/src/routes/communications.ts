import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import { z } from "zod";
import {
  createCommunicationsDashboardService,
  MailDraftStoreUnavailableError,
  type CreateCalendarEventInput,
} from "../services/communications-dashboard-service.js";

const communicationsQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
  inboxLimit: z.coerce.number().int().positive().max(50).optional(),
  agendaLimit: z.coerce.number().int().positive().max(100).optional(),
});

const mailDraftSchema = z.object({
  workspaceId: z.string().trim().min(1).max(256).optional(),
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

/** A draft is read or sent only inside the workspace that owns it; a mismatch answers 404 like a missing draft. */
const draftScopeSchema = z.object({
  workspaceId: z.string().trim().min(1).max(256),
});

const MAIL_DRAFT_NOT_FOUND = { error: "Mail draft not found." } as const;

const calendarEventSchema = z.object({
  workspaceId: z.string().trim().min(1).max(256).optional(),
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

const communicationsVerificationFixtureSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.literal("uncredentialed-read-only"),
  messages: z.array(
    z.object({
      id: z.string().min(1),
      threadId: z.string().min(1).optional(),
      from: z.string().email(),
      to: z.array(z.string().email()),
      subject: z.string().min(1),
      snippet: z.string().min(1),
      receivedAt: z.string().datetime(),
      labels: z.array(z.string()).optional(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.string().min(1),
      calendarId: z.string().min(1).optional(),
      title: z.string().min(1),
      description: z.string().optional(),
      startIso: z.string().datetime(),
      endIso: z.string().datetime(),
      attendees: z.array(z.string().email()).optional(),
      location: z.string().optional(),
    }),
  ),
});

type CommunicationsVerificationFixture = z.infer<typeof communicationsVerificationFixtureSchema>;

export const communicationsRoutes: FastifyPluginAsync = async (fastify) => {
  const service = createCommunicationsDashboardService({
    createApproval: (input) => fastify.services.approvals.createApproval(input),
    listIntegrationConnections: (kind, limit) => fastify.services.integrations.listIntegrationConnections(kind, limit),
    commsGmailRead: async (input) => {
      const fixture = await resolveCommunicationsVerificationFixture(fastify, input.connectionId);
      return fixture ? { messages: fixture.messages } : await fastify.services.comms.commsGmailRead(input);
    },
    commsCalendarList: async (input) => {
      const fixture = await resolveCommunicationsVerificationFixture(fastify, input.connectionId);
      return fixture ? { items: fixture.events } : await fastify.services.comms.commsCalendarList(input);
    },
    mailDrafts: fastify.services.mailDrafts,
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
    if (
      parsed.data.workspaceId &&
      !(await service.isMailAccountVisible(parsed.data.workspaceId, parsed.data.accountId))
    ) {
      return reply.code(404).send({ error: "This mail account is not connected to the requested workspace." });
    }
    return await withDraftStore(reply, async () => reply.code(201).send(await service.createDraft(parsed.data)));
  });

  fastify.get("/api/v1/mail/drafts/:draftId", async (request, reply) => {
    const params = draftParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const query = draftScopeSchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    return await withDraftStore(reply, async () => {
      const draft = await service.getDraft(params.data.draftId);
      // Scope is checked before any draft content is exposed.
      return draft && draft.workspaceId === query.data.workspaceId
        ? reply.send(draft)
        : reply.code(404).send(MAIL_DRAFT_NOT_FOUND);
    });
  });

  fastify.post("/api/v1/mail/drafts/:draftId/send", async (request, reply) => {
    const params = draftParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    const scope = draftScopeSchema.safeParse({
      workspaceId:
        readOptionalRecordString(request.query, "workspaceId") ?? readOptionalRecordString(request.body, "workspaceId"),
    });
    if (!scope.success) {
      return reply.code(400).send({ error: scope.error.flatten() });
    }
    return await withDraftStore(reply, async () => {
      const draft = await service.getDraft(params.data.draftId);
      if (!draft || draft.workspaceId !== scope.data.workspaceId) {
        return reply.code(404).send(MAIL_DRAFT_NOT_FOUND);
      }
      return reply.send(await service.sendDraft(params.data.draftId));
    });
  });

  fastify.post("/api/v1/calendar/events", async (request, reply) => {
    const parsed = calendarEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    if (
      parsed.data.workspaceId &&
      !(await service.isCalendarAccountVisible(parsed.data.workspaceId, parsed.data.accountId))
    ) {
      return reply.code(404).send({ error: "This calendar account is not connected to the requested workspace." });
    }
    return reply.code(202).send(await service.createCalendarEventPlaceholder(parsed.data as CreateCalendarEventInput));
  });
};

function readOptionalRecordString(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Draft routes fail closed with 503 when draft persistence is not composed, instead of holding drafts in memory. */
async function withDraftStore(reply: FastifyReply, handle: () => Promise<FastifyReply>): Promise<FastifyReply> {
  try {
    return await handle();
  } catch (error) {
    if (error instanceof MailDraftStoreUnavailableError) {
      return reply.code(503).send({ error: error.message });
    }
    throw error;
  }
}

async function resolveCommunicationsVerificationFixture(
  fastify: FastifyInstance,
  connectionId: string,
): Promise<CommunicationsVerificationFixture | undefined> {
  if (fastify.services.devVerification?.isDevDiagnosticsEnabled?.() !== true) {
    return undefined;
  }
  const connections: IntegrationConnection[] = await fastify.services.integrations.listIntegrationConnections(
    undefined,
    200,
  );
  const connection = connections.find((candidate) => candidate.connectionId === connectionId);
  if (!isUncredentialedVerificationConnection(connection)) {
    return undefined;
  }
  const parsed = communicationsVerificationFixtureSchema.safeParse(connection.config.verificationCommunicationsFixture);
  return parsed.success ? parsed.data : undefined;
}

function isUncredentialedVerificationConnection(
  connection: IntegrationConnection | undefined,
): connection is IntegrationConnection {
  return Boolean(
    connection &&
    connection.catalogId === "automation.gmail" &&
    connection.enabled === false &&
    connection.status === "disconnected",
  );
}
