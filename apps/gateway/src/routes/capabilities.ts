import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

export const capabilitiesRoutes: FastifyPluginAsync = async (fastify) => {
  const catalogQuerySchema = z.object({
    scope: z.enum(["inspectable", "callable"]).optional(),
  });

  const snapshotParamsSchema = z.object({
    snapshotId: z.string().min(1),
  });

  const proposalBodySchema = z.object({
    proposalKind: z.enum(["skill", "tool"]),
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    payload: z.record(z.unknown()).default({}),
    candidateId: z.string().trim().min(1).optional(),
    activationTargetId: z.string().trim().min(1).optional(),
  });

  const proposalsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  const proposalParamsSchema = z.object({
    proposalId: z.string().min(1),
  });
  const candidateParamsSchema = z.object({
    candidateId: z.string().min(1),
  });
  const candidateActionBodySchema = z.object({
    versionId: z.string().trim().min(1).optional(),
  });
  const candidateRollbackBodySchema = z.object({
    targetVersionId: z.string().trim().min(1),
  });

  const codeModeRunBodySchema = z.object({
    language: z.enum(["javascript", "typescript"]),
    source: z.string().min(1),
    input: z.record(z.unknown()).optional(),
    requestedOutputIntent: z.string().trim().min(1).optional(),
    saveCandidateOnSuccess: z.boolean().optional(),
    sessionId: z.string().trim().min(1).optional(),
    turnId: z.string().trim().min(1).optional(),
  });

  const runParamsSchema = z.object({
    runId: z.string().min(1),
  });

  const runsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });

  fastify.get("/api/v1/capabilities/catalog", async (request, reply) => {
    const parsed = catalogQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const scope = parsed.data.scope ?? "inspectable";
    return reply.send({
      scope,
      items: fastify.gateway.listCapabilityCatalog(scope),
    });
  });

  fastify.get("/api/v1/capabilities/snapshots/:snapshotId", async (request, reply) => {
    const parsed = snapshotParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getCapabilityCatalogSnapshot(parsed.data.snapshotId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/capabilities/proposals", async (request, reply) => {
    const parsed = proposalsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.gateway.listCapabilityProposals(parsed.data.limit ?? 100),
    });
  });

  fastify.post("/api/v1/capabilities/proposals", async (request, reply) => {
    const parsed = proposalBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.gateway.createCapabilityProposal(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/capabilities/proposals/:proposalId", async (request, reply) => {
    const parsed = proposalParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getCapabilityProposalDetail(parsed.data.proposalId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/capabilities/candidates/:candidateId", async (request, reply) => {
    const parsed = candidateParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getCapabilityCandidateDetail(parsed.data.candidateId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/capabilities/candidates/:candidateId/promote", async (request, reply) => {
    const params = candidateParamsSchema.safeParse(request.params);
    const body = candidateActionBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.promoteCapabilityCandidate(params.data.candidateId, body.data.versionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/capabilities/candidates/:candidateId/revoke", async (request, reply) => {
    const params = candidateParamsSchema.safeParse(request.params);
    const body = candidateActionBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.revokeCapabilityCandidate(params.data.candidateId, body.data.versionId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/capabilities/candidates/:candidateId/rollback", async (request, reply) => {
    const params = candidateParamsSchema.safeParse(request.params);
    const body = candidateRollbackBodySchema.safeParse(request.body);
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
        fastify.gateway.rollbackCapabilityCandidate(params.data.candidateId, body.data.targetVersionId),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/code-mode/runs", async (request, reply) => {
    const parsed = runsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: fastify.gateway.listCodeModeRuns(parsed.data.limit ?? 100),
    });
  });

  fastify.get("/api/v1/code-mode/runs/:runId", async (request, reply) => {
    const parsed = runParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getCodeModeRun(parsed.data.runId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/code-mode/runs", async (request, reply) => {
    const parsed = codeModeRunBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(await fastify.gateway.createCodeModeRun(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
