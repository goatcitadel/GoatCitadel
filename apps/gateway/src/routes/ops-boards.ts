import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  OPS_SAVED_BOARD_LIMITS,
  OPS_SAVED_BOARD_WIDGET_KINDS,
  normalizeOpsSavedBoardCreateInput,
  normalizeOpsSavedBoardStatusInput,
  normalizeOpsSavedBoardUpdateInput,
  type OpsSavedBoardCreateInput,
  type OpsSavedBoardRecord,
  type OpsSavedBoardStatusInput,
  type OpsSavedBoardUpdateInput,
} from "@goatcitadel/contracts";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const canonicalIdentifier = (maxCharacters: number) =>
  z
    .string()
    .min(1)
    .max(maxCharacters * 2)
    .refine(
      (value) =>
        value === value.normalize("NFKC").trim() && [...value].length <= maxCharacters && !/\p{Cc}/u.test(value),
    );
const normalizedPlainText = (maxCharacters: number) =>
  z.string().refine((value) => {
    if (/\p{Cc}/u.test(value)) return false;
    const normalized = value.normalize("NFKC").trim();
    return [...normalized].length >= 1 && [...normalized].length <= maxCharacters;
  });
const identifier = canonicalIdentifier(OPS_SAVED_BOARD_LIMITS.identifierCharacters);
const boardParamsSchema = z.object({ boardId: identifier }).strict();
const workspaceQuerySchema = z.object({ workspaceId: identifier }).strict();
const listQuerySchema = z
  .object({
    workspaceId: identifier,
    includeArchived: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
  })
  .strict();
const placementSchema = z
  .object({
    widgetId: canonicalIdentifier(OPS_SAVED_BOARD_LIMITS.widgetIdCharacters),
    kind: z.enum(OPS_SAVED_BOARD_WIDGET_KINDS),
    x: z
      .number()
      .int()
      .min(0)
      .max(OPS_SAVED_BOARD_LIMITS.gridColumns - 1),
    y: z.number().int().min(0).max(OPS_SAVED_BOARD_LIMITS.maxGridRow),
    width: z.number().int().min(1).max(OPS_SAVED_BOARD_LIMITS.maxWidgetSpan),
    height: z.number().int().min(1).max(OPS_SAVED_BOARD_LIMITS.maxWidgetSpan),
  })
  .strict();
const createBodyBoundary = z
  .object({
    workspaceId: identifier,
    name: normalizedPlainText(OPS_SAVED_BOARD_LIMITS.nameCharacters),
    description: normalizedPlainText(OPS_SAVED_BOARD_LIMITS.descriptionCharacters).optional(),
    placements: z.array(placementSchema).min(1).max(OPS_SAVED_BOARD_LIMITS.placementsPerBoard),
    idempotencyKey: canonicalIdentifier(OPS_SAVED_BOARD_LIMITS.idempotencyKeyCharacters),
  })
  .strict();
const updateBodyBoundary = z
  .object({
    workspaceId: identifier,
    name: normalizedPlainText(OPS_SAVED_BOARD_LIMITS.nameCharacters).optional(),
    description: z.union([normalizedPlainText(OPS_SAVED_BOARD_LIMITS.descriptionCharacters), z.null()]).optional(),
    placements: z.array(placementSchema).min(1).max(OPS_SAVED_BOARD_LIMITS.placementsPerBoard).optional(),
    expectedRevision: z.number().int().positive().safe(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.description !== undefined || value.placements !== undefined);
const statusBodyBoundary = z
  .object({
    workspaceId: identifier,
    expectedRevision: z.number().int().positive().safe(),
  })
  .strict();

export interface OpsSavedBoardRouteService {
  list(workspaceId: string, includeArchived?: boolean): OpsSavedBoardRecord[];
  get(workspaceId: string, boardId: string): OpsSavedBoardRecord;
  create(input: OpsSavedBoardCreateInput, actorId: string): OpsSavedBoardRecord;
  update(boardId: string, input: OpsSavedBoardUpdateInput, actorId: string): OpsSavedBoardRecord;
  archive(boardId: string, input: OpsSavedBoardStatusInput, actorId: string): OpsSavedBoardRecord;
  restore(boardId: string, input: OpsSavedBoardStatusInput, actorId: string): OpsSavedBoardRecord;
}

export interface OpsSavedBoardRoutesOptions {
  service: OpsSavedBoardRouteService;
}

export const opsSavedBoardRoutes: FastifyPluginAsync<OpsSavedBoardRoutesOptions> = async (fastify, options) => {
  if (!options.service) throw new Error("Ops saved board routes require an explicit service.");

  const operatorRead = withRouteAccess(fastify, "operator", {
    onRequest: async (request, reply) => {
      markReadResponse(reply);
      resolveAuthenticatedOperator(request, reply);
    },
  });
  const operatorMutation = withRouteAccess(fastify, "operator", {
    onRequest: async (request, reply) => {
      markNoStore(reply);
      resolveAuthenticatedOperator(request, reply);
    },
  });

  fastify.get("/api/v1/ops/boards", operatorRead, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid ops saved board list query." });
    try {
      return reply.send({
        workspaceId: query.data.workspaceId,
        items: options.service.list(query.data.workspaceId, query.data.includeArchived),
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/ops/boards/:boardId", operatorRead, async (request, reply) => {
    const params = boardParamsSchema.safeParse(request.params);
    const query = workspaceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "Invalid ops saved board inspection query." });
    }
    try {
      return reply.send(options.service.get(query.data.workspaceId, params.data.boardId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/ops/boards", operatorMutation, async (request, reply) => {
    const body = parseCreateBody(request.body);
    if (!body) return reply.code(400).send({ error: "Invalid ops saved board create request." });
    const actorId = resolveAuthenticatedOperator(request, reply);
    if (!actorId) return;
    try {
      const record = options.service.create(body, actorId);
      reply.header(
        "Location",
        `/api/v1/ops/boards/${encodeURIComponent(record.boardId)}?workspaceId=${encodeURIComponent(record.workspaceId)}`,
      );
      return reply.code(201).send(record);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/ops/boards/:boardId", operatorMutation, async (request, reply) => {
    const params = boardParamsSchema.safeParse(request.params);
    const body = parseUpdateBody(request.body);
    if (!params.success || !body) {
      return reply.code(400).send({ error: "Invalid ops saved board update request." });
    }
    const actorId = resolveAuthenticatedOperator(request, reply);
    if (!actorId) return;
    try {
      return reply.send(options.service.update(params.data.boardId, body, actorId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  registerStatusRoute("archive");
  registerStatusRoute("restore");

  function registerStatusRoute(operation: "archive" | "restore"): void {
    fastify.post(`/api/v1/ops/boards/:boardId/${operation}`, operatorMutation, async (request, reply) => {
      const params = boardParamsSchema.safeParse(request.params);
      const body = parseStatusBody(request.body);
      if (!params.success || !body) {
        return reply.code(400).send({ error: `Invalid ops saved board ${operation} request.` });
      }
      const actorId = resolveAuthenticatedOperator(request, reply);
      if (!actorId) return;
      try {
        return reply.send(options.service[operation](params.data.boardId, body, actorId));
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    });
  }
};

function parseCreateBody(value: unknown): OpsSavedBoardCreateInput | undefined {
  const parsed = createBodyBoundary.safeParse(value);
  if (!parsed.success) return undefined;
  try {
    return normalizeOpsSavedBoardCreateInput(parsed.data);
  } catch {
    return undefined;
  }
}

function parseUpdateBody(value: unknown): OpsSavedBoardUpdateInput | undefined {
  const parsed = updateBodyBoundary.safeParse(value);
  if (!parsed.success) return undefined;
  try {
    return normalizeOpsSavedBoardUpdateInput(parsed.data);
  } catch {
    return undefined;
  }
}

function parseStatusBody(value: unknown): OpsSavedBoardStatusInput | undefined {
  const parsed = statusBodyBoundary.safeParse(value);
  if (!parsed.success) return undefined;
  try {
    return normalizeOpsSavedBoardStatusInput(parsed.data);
  } catch {
    return undefined;
  }
}

function resolveAuthenticatedOperator(request: FastifyRequest, reply: FastifyReply): string | undefined {
  if (!request.authActorSource || !["token", "basic", "loopback"].includes(request.authActorSource)) {
    void reply.code(403).send({ error: "An authenticated operator route is required." });
    return undefined;
  }
  const actorId = request.authActorId;
  if (
    typeof actorId !== "string" ||
    actorId !== actorId.normalize("NFKC").trim() ||
    [...actorId].length < 1 ||
    actorId === "anonymous" ||
    actorId === "auth:none" ||
    [...actorId].length > OPS_SAVED_BOARD_LIMITS.identifierCharacters ||
    /\p{Cc}/u.test(actorId)
  ) {
    void reply.code(401).send({ error: "A specific authenticated operator identity is required." });
    return undefined;
  }
  return actorId;
}

function markNoStore(reply: Pick<FastifyReply, "header">): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
}

function markReadResponse(reply: Pick<FastifyReply, "header">): void {
  markNoStore(reply);
  reply.header("x-goatcitadel-execution-authority", "none");
}
