import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { isGoatError, redactStructuredSecrets, type ModelComparisonJudgeRequest } from "@goatcitadel/contracts";
import { z } from "zod";
import type { ModelComparisonRoutePort } from "../services/model-comparison-route-service.js";

const candidateSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
});

const createComparisonSchema = z
  .object({
    packId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    testIds: z.array(z.string().trim().min(1)).max(200).optional(),
    allTests: z.boolean().optional(),
    candidates: z.array(candidateSchema).min(2).max(10),
    executionStyle: z.enum(["single_turn_harness", "agentic_surface"]).optional(),
  })
  .refine((value) => value.allTests === true || (value.testIds?.length ?? 0) > 0, {
    message: "allTests or testIds is required",
    path: ["testIds"],
  });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});

const paramsSchema = z.object({
  comparisonId: z.string().trim().min(1),
});

const scoreSchema = z.object({
  candidateId: z.string().trim().min(1),
  quality: z.coerce.number().int().min(0).max(4),
  honesty: z.coerce.number().int().min(0).max(4).optional(),
  usefulness: z.coerce.number().int().min(0).max(4).optional(),
});

const judgmentSchema = z.object({
  testId: z.string().trim().min(1),
  winnerCandidateId: z.string().trim().min(1).optional(),
  scores: z.array(scoreSchema).min(1).max(10),
  notes: z.string().trim().max(4000).optional(),
  reviewerId: z.string().trim().min(1).optional(),
});

export const modelComparisonRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/model-comparisons", async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    return reply.send(await getModelComparisonService(fastify).listComparisons(query.data.limit));
  });

  fastify.post("/api/v1/model-comparisons", async (request, reply) => {
    const body = createComparisonSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.code(201).send(await getModelComparisonService(fastify).createComparison(body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/model-comparisons/:comparisonId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await getModelComparisonService(fastify).getComparison(params.data.comparisonId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/model-comparisons/:comparisonId/judgments", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = judgmentSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply
        .code(201)
        .send(
          await getModelComparisonService(fastify).addJudgment(params.data.comparisonId, toJudgeRequest(body.data)),
        );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/model-comparisons/:comparisonId/run", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.code(202).send(await getModelComparisonService(fastify).startComparison(params.data.comparisonId));
    } catch (error) {
      return sendRunControlError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/model-comparisons/:comparisonId/cancel", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(await getModelComparisonService(fastify).cancelComparison(params.data.comparisonId));
    } catch (error) {
      return sendRunControlError(reply, error, request.log);
    }
  });
};

const RUN_CONTROL_FAILURE_MESSAGE = "Comparison run control failed.";

/**
 * Typed domain errors (not found 404, conflict 409, validation 400, ...) keep
 * their own status and message. Anything else is a server fault: the raw
 * message stays in the redacted server log and the client gets a fixed body.
 */
function sendRunControlError(
  reply: FastifyReply,
  error: unknown,
  log: FastifyBaseLogger,
): ReturnType<FastifyReply["send"]> {
  if (isGoatError(error)) {
    return reply.code(error.httpStatus).send({ error: redactStructuredSecrets(error.message).value });
  }
  const diagnostic =
    error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
  log.error({ err: redactStructuredSecrets(diagnostic).value }, "model comparison run control failed");
  return reply.code(500).send({ error: RUN_CONTROL_FAILURE_MESSAGE });
}

function getModelComparisonService(fastify: FastifyInstance): ModelComparisonRoutePort {
  const services = fastify.services as unknown as { modelComparisons?: ModelComparisonRoutePort };
  if (!services.modelComparisons) {
    throw new Error("Model comparison route service is not registered.");
  }
  return services.modelComparisons;
}

function toJudgeRequest(input: z.infer<typeof judgmentSchema>): ModelComparisonJudgeRequest {
  return {
    testId: input.testId,
    winnerCandidateId: input.winnerCandidateId,
    scores: input.scores.map((score) => ({
      candidateId: score.candidateId,
      quality: score.quality as ModelComparisonJudgeRequest["scores"][number]["quality"],
      honesty: score.honesty as ModelComparisonJudgeRequest["scores"][number]["honesty"],
      usefulness: score.usefulness as ModelComparisonJudgeRequest["scores"][number]["usefulness"],
    })),
    notes: input.notes,
    reviewerId: input.reviewerId,
  };
}
