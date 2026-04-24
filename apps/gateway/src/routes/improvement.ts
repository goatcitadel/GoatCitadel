import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";

const reportListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(260).default(24),
});

const runListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(300).default(40),
});

const ledgerListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  workspaceId: z.string().trim().min(1).optional(),
});

const reportParamsSchema = z.object({
  reportId: z.string().min(1),
});

const runParamsSchema = z.object({
  runId: z.string().min(1),
});

const replayRunParamsSchema = z.object({
  replayRunId: z.string().min(1),
});

const tuneParamsSchema = z.object({
  tuneId: z.string().min(1),
});

const signalParamsSchema = z.object({
  signalId: z.string().min(1),
});

const candidateParamsSchema = z.object({
  candidateId: z.string().min(1),
});

const activationParamsSchema = z.object({
  activationId: z.string().min(1),
});

const repairCandidateValidationBodySchema = z.object({
  status: z.enum(["not_started", "queued", "running", "needs_review", "passed", "failed"]),
  summary: z.string().trim().min(1).max(2000).optional(),
});

const manualReplayBodySchema = z.object({
  sampleSize: z.coerce.number().int().positive().max(2000).optional(),
});

const replayOverrideStepSchema = z.object({
  stepKey: z.string().min(1),
  overrideKind: z.enum(["tool_output", "prompt_patch", "policy_decision"]),
  override: z.record(z.unknown()).default({}),
});

const replayDraftBodySchema = z.object({
  overrides: z.array(replayOverrideStepSchema).default([]),
});

export const improvementRoutes: FastifyPluginAsync = async (fastify) => {
  const improvement = fastify.services.improvement;
  const replyWithImprovementMutationError = (reply: FastifyReply, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = message.toLowerCase().includes("not found") ? 404 : 409;
    return reply.code(statusCode).send({ error: message });
  };

  fastify.get("/api/v1/improvement/capability-gaps", async (request, reply) => {
    const parsed = ledgerListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: improvement.listCapabilityGapEvents(parsed.data.limit),
    });
  });

  fastify.get("/api/v1/improvement/repair-candidates", async (request, reply) => {
    const parsed = ledgerListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: improvement.listRepairCandidates(parsed.data.limit),
    });
  });

  fastify.patch("/api/v1/improvement/repair-candidates/:candidateId/validation", async (request, reply) => {
    const params = candidateParamsSchema.safeParse(request.params);
    const body = repairCandidateValidationBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(improvement.updateRepairCandidateValidation(params.data.candidateId, body.data));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/improvement/signals", async (request, reply) => {
    const parsed = ledgerListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: improvement.listImprovementSignals(parsed.data.limit, parsed.data.workspaceId),
    });
  });

  fastify.get("/api/v1/improvement/signals/:signalId", async (request, reply) => {
    const params = signalParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(improvement.getImprovementSignal(params.data.signalId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/improvement/candidates", async (request, reply) => {
    const parsed = ledgerListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: improvement.listImprovementCandidates(parsed.data.limit, parsed.data.workspaceId),
    });
  });

  fastify.get("/api/v1/improvement/candidates/:candidateId", async (request, reply) => {
    const params = candidateParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(improvement.getImprovementCandidate(params.data.candidateId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/improvement/candidates/:candidateId/activation-request", async (request, reply) => {
    const params = candidateParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await improvement.requestImprovementActivation(params.data.candidateId));
    } catch (error) {
      return replyWithImprovementMutationError(reply, error);
    }
  });

  fastify.get("/api/v1/improvement/activations/:activationId", async (request, reply) => {
    const params = activationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(improvement.getImprovementActivation(params.data.activationId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/improvement/activations/:activationId/pause", async (request, reply) => {
    const params = activationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(improvement.pauseImprovementActivation(params.data.activationId));
    } catch (error) {
      return replyWithImprovementMutationError(reply, error);
    }
  });

  fastify.post("/api/v1/improvement/activations/:activationId/rollback", async (request, reply) => {
    const params = activationParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(improvement.rollbackImprovementActivation(params.data.activationId));
    } catch (error) {
      return replyWithImprovementMutationError(reply, error);
    }
  });

  fastify.get("/api/v1/improvement/reports", async (request, reply) => {
    const parsed = reportListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: improvement.listImprovementReports(parsed.data.limit),
    });
  });

  fastify.get("/api/v1/improvement/harness-audit", async (_request, reply) => {
    return reply.send(improvement.getHarnessAuditReport());
  });

  fastify.get("/api/v1/improvement/reports/:reportId", async (request, reply) => {
    const params = reportParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(improvement.getImprovementReport(params.data.reportId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/improvement/replay/run", async (request, reply) => {
    const parsed = manualReplayBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.send(await improvement.runImprovementReplayManually(parsed.data));
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/improvement/replay/runs", async (request, reply) => {
    const parsed = runListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send({
      items: improvement.listDecisionReplayRuns(parsed.data.limit),
    });
  });

  fastify.get("/api/v1/improvement/replay/runs/:runId", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(improvement.getDecisionReplayRun(params.data.runId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/improvement/autotune/:tuneId/approve", async (request, reply) => {
    const params = tuneParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(improvement.approveDecisionAutoTune(params.data.tuneId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/improvement/autotune/:tuneId/revert", async (request, reply) => {
    const params = tuneParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(improvement.revertDecisionAutoTune(params.data.tuneId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/replay/runs/:runId/draft", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = replayDraftBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(improvement.createReplayOverrideDraft(params.data.runId, body.data.overrides));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/replay/runs/:runId/execute", async (request, reply) => {
    const params = runParamsSchema.safeParse(request.params);
    const body = replayDraftBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(improvement.executeReplayOverride(params.data.runId, body.data.overrides));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/replay/:replayRunId/diff", async (request, reply) => {
    const params = replayRunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(improvement.getReplayDiffSummary(params.data.replayRunId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });
};
