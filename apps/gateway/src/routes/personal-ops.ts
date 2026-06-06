import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PersonalOpsRouteService } from "../services/personal-ops-route-service.js";
import { sendRouteError } from "./_error-handler.js";

const workspaceIdSchema = z.string().trim().min(1).max(120).optional();
const noteTextSchema = z.string().max(20_000).optional();
const noteTagSchema = z.string().trim().max(60);
const sourceRefSchema = z.string().trim().max(1_000);

const noteListQuerySchema = z.object({
  workspaceId: workspaceIdSchema,
  lifecycleStatus: z.enum(["active", "archived", "all"]).optional(),
  includeArchived: z.coerce.boolean().optional(),
});

const createNoteSchema = z.object({
  workspaceId: workspaceIdSchema,
  title: z.string().trim().min(1).max(300),
  body: noteTextSchema,
  tags: z.array(noteTagSchema).max(32).optional(),
  sourceRefs: z.array(sourceRefSchema).max(50).optional(),
});

const updateNoteSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    title: z.string().trim().min(1).max(300).optional(),
    body: noteTextSchema,
    tags: z.array(noteTagSchema).max(32).optional(),
    sourceRefs: z.array(sourceRefSchema).max(50).optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== "workspaceId"), {
    message: "At least one note field is required.",
  });

const noteParamsSchema = z.object({
  noteId: z.string().trim().min(1),
});

const workspaceBodySchema = z
  .object({
    workspaceId: workspaceIdSchema,
  })
  .optional();

const reminderStatusSchema = z.enum(["scheduled", "completed", "cancelled", "all"]);

const reminderListQuerySchema = z.object({
  workspaceId: workspaceIdSchema,
  status: reminderStatusSchema.optional(),
  includeCompleted: z.coerce.boolean().optional(),
});

const createReminderSchema = z.object({
  workspaceId: workspaceIdSchema,
  title: z.string().trim().min(1).max(300),
  dueAt: z.string().datetime(),
  recurrenceRule: z.string().trim().max(500).optional(),
  sourceRef: sourceRefSchema.optional(),
});

const reminderParamsSchema = z.object({
  reminderId: z.string().trim().min(1),
});

export const personalOpsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/notes", async (request, reply) => {
    const parsed = noteListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const lifecycleStatus =
        parsed.data.lifecycleStatus ?? (parsed.data.includeArchived === true ? "all" : "active");
      return reply.send(
        getPersonalOpsRouteService(fastify).listNotes({
          workspaceId: parsed.data.workspaceId,
          lifecycleStatus,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/notes", async (request, reply) => {
    const parsed = createNoteSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply
        .code(201)
        .send(getPersonalOpsRouteService(fastify).createNote(parsed.data, readWorkspaceAccess(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/notes/:noteId", async (request, reply) => {
    const params = noteParamsSchema.safeParse(request.params);
    const body = updateNoteSchema.safeParse(request.body ?? {});
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
        getPersonalOpsRouteService(fastify).updateNote(params.data.noteId, body.data, readWorkspaceAccess(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/notes/:noteId/archive", async (request, reply) => {
    const params = noteParamsSchema.safeParse(request.params);
    const body = workspaceBodySchema.safeParse(request.body ?? {});
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
        getPersonalOpsRouteService(fastify).archiveNote(params.data.noteId, readWorkspaceAccess(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/reminders", async (request, reply) => {
    const parsed = reminderListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const status = parsed.data.status ?? (parsed.data.includeCompleted === true ? "all" : "scheduled");
      return reply.send(
        getPersonalOpsRouteService(fastify).listReminders({
          workspaceId: parsed.data.workspaceId,
          status,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/reminders", async (request, reply) => {
    const parsed = createReminderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply
        .code(201)
        .send(getPersonalOpsRouteService(fastify).createReminder(parsed.data, readWorkspaceAccess(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/reminders/:reminderId/complete", async (request, reply) => {
    const params = reminderParamsSchema.safeParse(request.params);
    const body = workspaceBodySchema.safeParse(request.body ?? {});
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
        getPersonalOpsRouteService(fastify).completeReminder(params.data.reminderId, readWorkspaceAccess(request)),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};

function getPersonalOpsRouteService(fastify: FastifyInstance): PersonalOpsRouteService {
  const services = fastify.services as unknown as { personalOps?: PersonalOpsRouteService };
  if (!services.personalOps) {
    throw new Error("Personal Ops route service is not configured.");
  }
  return services.personalOps;
}

function readWorkspaceAccess(request: FastifyRequest): { workspaceId?: string } {
  return {
    workspaceId:
      readWorkspaceIdFromQuery(request.query) ??
      readWorkspaceIdFromBody(request.body) ??
      readWorkspaceIdFromHeader(request.headers["x-goatcitadel-workspace-id"]),
  };
}

function readWorkspaceIdFromQuery(query: unknown): string | undefined {
  if (!query || typeof query !== "object") {
    return undefined;
  }
  const value = (query as Record<string, unknown>).workspaceId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readWorkspaceIdFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>).workspaceId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readWorkspaceIdFromHeader(value: string | string[] | undefined): string | undefined {
  if (!value || Array.isArray(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
