import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const nodesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(200),
});

const joinSchema = z.object({
  token: z.string().min(1),
  nodeId: z.string().min(1),
  label: z.string().optional(),
  advertiseAddress: z.string().optional(),
  transport: z.enum(["lan", "wan", "tailnet"]).optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  tlsFingerprint: z.string().optional(),
});

const leaseAcquireSchema = z.object({
  leaseKey: z.string().min(1),
  holderNodeId: z.string().min(1),
  ttlSeconds: z.number().int().positive().max(3600).optional(),
});

const leaseRenewSchema = z.object({
  leaseKey: z.string().min(1),
  holderNodeId: z.string().min(1),
  fencingToken: z.number().int().positive(),
  ttlSeconds: z.number().int().positive().max(3600).optional(),
});

const leaseReleaseSchema = z.object({
  leaseKey: z.string().min(1),
  holderNodeId: z.string().min(1),
  fencingToken: z.number().int().positive(),
});

const claimSchema = z.object({
  ownerNodeId: z.string().min(1),
  expectedEpoch: z.number().int().positive().optional(),
  force: z.boolean().optional(),
});

const replicationSchema = z.object({
  sourceNodeId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.record(z.unknown()),
  idempotencyKey: z.string().min(1),
});

const replicationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
  cursor: z.string().optional(),
});

export const meshRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/mesh/status", async (_request, reply) => {
    return reply.send(fastify.services.mesh.getMeshStatus());
  });

  fastify.get("/api/v1/mesh/readiness", async (_request, reply) => {
    return reply.send(fastify.services.mesh.getMeshReadinessDiagnostics());
  });

  fastify.get("/api/v1/mesh/nodes", async (request, reply) => {
    const parsed = nodesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({ items: fastify.services.mesh.listMeshNodes(parsed.data.limit) });
  });

  fastify.post("/api/v1/mesh/join", async (request, reply) => {
    const parsed = joinSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.services.mesh.meshJoin(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/mesh/leases/acquire", async (request, reply) => {
    const parsed = leaseAcquireSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.mesh.acquireMeshLease(parsed.data));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/mesh/leases/renew", async (request, reply) => {
    const parsed = leaseRenewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.mesh.renewMeshLease(parsed.data));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/mesh/leases/release", async (request, reply) => {
    const parsed = leaseReleaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.mesh.releaseMeshLease(parsed.data));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/mesh/leases", async (request, reply) => {
    const parsed = nodesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({ items: fastify.services.mesh.listMeshLeases(parsed.data.limit) });
  });

  fastify.post("/api/v1/mesh/sessions/:sessionId/claim", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.services.mesh.claimMeshSessionOwner(sessionId, parsed.data));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/mesh/sessions/:sessionId/owner", async (request, reply) => {
    const sessionId = (request.params as { sessionId: string }).sessionId;
    try {
      return reply.send(fastify.services.mesh.getMeshSessionOwner(sessionId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/mesh/sessions/owners", async (request, reply) => {
    const parsed = nodesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({ items: fastify.services.mesh.listMeshSessionOwners(parsed.data.limit) });
  });

  fastify.post("/api/v1/mesh/replication/events", async (request, reply) => {
    const parsed = replicationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(202).send(fastify.services.mesh.ingestMeshReplicationEvent(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/mesh/replication/events", async (request, reply) => {
    const parsed = replicationQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const items = fastify.services.mesh.listMeshReplicationEvents(parsed.data.limit, parsed.data.cursor);
    const last = items[items.length - 1];
    const nextCursor = items.length === parsed.data.limit ? last?.createdAt : undefined;
    return reply.send({ items, nextCursor });
  });

  fastify.get("/api/v1/mesh/replication/offsets", async (request, reply) => {
    const parsed = nodesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({ items: fastify.services.mesh.listMeshReplicationOffsets(parsed.data.limit) });
  });
};
