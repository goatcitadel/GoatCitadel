import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES } from "@goatcitadel/contracts";
import {
  RemoteWorkerRegistryInputError,
  type RemoteWorkersRouteService,
} from "../services/remote-workers-route-service.js";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.normalize("NFKC").trim() && !/\p{Cc}/u.test(value));
const paramsSchema = z.object({ workspaceId: identifierSchema }).strict();
const detailParamsSchema = paramsSchema.extend({ workerId: identifierSchema }).strict();
const emptyQuerySchema = z.object({}).strict();
const listQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9]\d|100)$/u)
      .transform(Number)
      .optional(),
    cursor: z.string().min(1).max(REMOTE_WORKER_REGISTRY_MAX_CURSOR_BYTES).optional(),
  })
  .strict();

const RATE_LIMIT_MAX = 120;
const resolveRateLimitKey = (request: { authActorId?: string; ip?: string }): string =>
  request.authActorId?.trim() ? `actor:${request.authActorId.trim()}` : `ip:${request.ip ?? "unknown"}`;

export const remoteWorkersRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorRead = withRouteAccess(fastify, "operator", {
    config: {
      rateLimit: {
        max: RATE_LIMIT_MAX,
        hook: "preHandler",
        keyGenerator: resolveRateLimitKey,
      },
    },
    onSend: async (_request, reply, payload) => {
      setReadHeaders(reply);
      return payload;
    },
  });

  fastify.get("/api/v1/ops/workspaces/:workspaceId/remote-workers", operatorRead, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = listQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalidRequest(reply);
    const service = resolveService(fastify.services);
    if (!service) return reply.code(503).send({ error: "Remote worker registry service is unavailable." });
    try {
      return reply.send(
        service.listRegistry({
          workspaceId: params.data.workspaceId,
          ...(query.data.limit === undefined ? {} : { limit: query.data.limit }),
          ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
        }),
      );
    } catch (error) {
      if (error instanceof RemoteWorkerRegistryInputError) return invalidRequest(reply);
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/ops/workspaces/:workspaceId/remote-workers/:workerId", operatorRead, async (request, reply) => {
    const params = detailParamsSchema.safeParse(request.params);
    const query = emptyQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalidRequest(reply);
    const service = resolveService(fastify.services);
    if (!service) return reply.code(503).send({ error: "Remote worker registry service is unavailable." });
    try {
      return reply.send(
        service.getRegistryEntry({
          workspaceId: params.data.workspaceId,
          workerId: params.data.workerId,
        }),
      );
    } catch (error) {
      if (error instanceof RemoteWorkerRegistryInputError) return invalidRequest(reply);
      return sendRouteError(reply, error, request.log);
    }
  });
};

function resolveService(services: unknown): RemoteWorkersRouteService | undefined {
  return (services as { remoteWorkers?: RemoteWorkersRouteService }).remoteWorkers;
}

function invalidRequest(reply: FastifyReply): ReturnType<FastifyReply["send"]> {
  return reply.code(400).send({ error: "Remote worker registry request is invalid." });
}

function setReadHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  const current = reply.getHeader("Vary");
  const values = new Set(
    (Array.isArray(current) ? current : current === undefined ? [] : [String(current)])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  );
  values.add("Authorization");
  reply.header("Vary", [...values].join(", "));
}
