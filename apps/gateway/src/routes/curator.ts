import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";

const CURATOR_PROPOSAL_ONLY_MESSAGE =
  "Curator runs are proposal-only; use the confirmed curator archive endpoint to mutate skills.";

export const curatorRoutes: FastifyPluginAsync = async (fastify) => {
  const curator = fastify.services.curator;

  fastify.get("/api/v1/curator/status", async (_request, reply) => {
    try {
      return reply.send(await curator.listStatus());
    } catch (error) {
      return sendRouteError(reply, error, _request.log);
    }
  });

  const archiveSchema = z.object({
    skillId: z.string().min(1),
    confirm: z.literal(true),
    reason: z.string().trim().max(300).optional(),
    actorId: z.string().optional(),
  });
  fastify.post("/api/v1/curator/archive", async (request, reply) => {
    const parsed = archiveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await curator.archive(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  const pruneSchema = z.object({
    skillId: z.string().min(1),
    confirm: z.literal(true),
    actorId: z.string().optional(),
  });
  fastify.post("/api/v1/curator/prune", async (request, reply) => {
    const parsed = pruneSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await curator.prune(parsed.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/curator/archived", async (_request, reply) => {
    try {
      return reply.send(await curator.listArchived());
    } catch (error) {
      return sendRouteError(reply, error, _request.log);
    }
  });

  const runSchema = z.object({
    sync: z.boolean().optional(),
    dryRun: z.literal(true).optional(),
    actorId: z.string().optional(),
    triggerMode: z.enum(["manual", "scheduled", "synchronous"]).optional(),
  });
  fastify.post("/api/v1/curator/run", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.dryRun === false) {
      return reply.code(400).send({ error: CURATOR_PROPOSAL_ONLY_MESSAGE });
    }
    const parsed = runSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const result = await curator.run(parsed.data);
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
