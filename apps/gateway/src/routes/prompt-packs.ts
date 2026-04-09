import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const promptPackImportSchema = z.object({
  content: z.string().min(1),
  name: z.string().optional(),
  sourceLabel: z.string().optional(),
  packId: z.string().optional(),
});

const promptPackListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(2000).default(200),
});

const promptPackParamsSchema = z.object({
  packId: z.string().min(1),
});

const promptPackTestParamsSchema = z.object({
  packId: z.string().min(1),
  testId: z.string().min(1),
});

const promptPackRunBodySchema = z.object({
  sessionId: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  mode: z.enum(["chat", "cowork", "code"]).optional(),
  toolTier: z.enum(["no-tools", "implicit-tools", "explicit-tools"]).optional(),
  toolAutonomy: z.enum(["manual", "safe_auto"]).optional(),
  webMode: z.enum(["off", "auto", "quick", "deep"]).optional(),
  memoryMode: z.enum(["off", "on", "auto"]).optional(),
  thinkingLevel: z.enum(["minimal", "standard", "extended"]).optional(),
  placeholderValues: z.record(z.string(), z.string()).optional(),
});

const promptPackReviewBodySchema = z.object({
  runId: z.string().min(1),
  taskSuccess: z.coerce.number().int().min(0).max(4).nullable().optional(),
  honesty: z.coerce.number().int().min(0).max(4).nullable().optional(),
  executionQuality: z.coerce.number().int().min(0).max(4).nullable().optional(),
  robustness: z.coerce.number().int().min(0).max(4).nullable().optional(),
  usability: z.coerce.number().int().min(0).max(4).nullable().optional(),
  overrideVerdict: z.enum(["pass", "fail", "review"]).optional(),
  reviewerId: z.string().optional(),
  routingScore: z.coerce.number().int().min(0).max(2).optional(),
  honestyScore: z.coerce.number().int().min(0).max(2).optional(),
  handoffScore: z.coerce.number().int().min(0).max(2).optional(),
  robustnessScore: z.coerce.number().int().min(0).max(2).optional(),
  usabilityScore: z.coerce.number().int().min(0).max(2).optional(),
  notes: z.string().optional(),
});

const promptPackAutoScoreBodySchema = z.object({
  runId: z.string().min(1).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  force: z.boolean().optional(),
});

const promptPackAutoScoreBatchBodySchema = z.object({
  onlyUnscored: z.boolean().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  force: z.boolean().optional(),
});

const promptPackExportBodySchema = z.object({
  includeHistory: z.boolean().optional(),
});

const promptPackResetBodySchema = z.object({
  clearRuns: z.boolean().optional(),
  clearScores: z.boolean().optional(),
});

const promptPackBenchmarkRunBodySchema = z.object({
  testCodes: z.array(z.string().min(1)).min(1).max(200),
  providers: z
    .array(
      z.object({
        providerId: z.string().min(1),
        model: z.string().min(1),
      }),
    )
    .min(1)
    .max(10),
});

const promptPackBenchmarkParamsSchema = z.object({
  benchmarkRunId: z.string().min(1),
});

const promptPackReplayRegressionRunBodySchema = z.object({
  testCodes: z.array(z.string().min(1)).min(1).max(200),
  baselineRef: z.string().optional(),
});

const promptPackReplayRegressionParamsSchema = z.object({
  runId: z.string().min(1),
});

export const promptPackRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/prompt-packs/import", async (request, reply) => {
    const body = promptPackImportSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.importPromptPack(body.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/prompt-packs", async (request, reply) => {
    const query = promptPackListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: query.error.flatten() });
    }
    return reply.send({
      items: fastify.gateway.listPromptPacks(query.data.limit),
    });
  });

  fastify.get("/api/v1/prompt-packs/:packId/tests", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const query = promptPackListQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          query: query.success ? undefined : query.error.flatten(),
        },
      });
    }
    try {
      return reply.send({
        items: fastify.gateway.listPromptPackTests(params.data.packId, query.data.limit),
      });
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/tests/:testId/run", async (request, reply) => {
    const params = promptPackTestParamsSchema.safeParse(request.params);
    const body = promptPackRunBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const run = await fastify.gateway.runPromptPackTest(params.data.packId, params.data.testId, body.data);
      return reply.send(run);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/tests/:testId/score", async (request, reply) => {
    const params = promptPackTestParamsSchema.safeParse(request.params);
    const body = promptPackReviewBodySchema.safeParse(request.body);
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
        fastify.gateway.scorePromptPackTest({
          packId: params.data.packId,
          testId: params.data.testId,
          runId: body.data.runId,
          taskSuccess: body.data.taskSuccess as 0 | 1 | 2 | 3 | 4 | null | undefined,
          honesty: body.data.honesty as 0 | 1 | 2 | 3 | 4 | null | undefined,
          executionQuality: body.data.executionQuality as 0 | 1 | 2 | 3 | 4 | null | undefined,
          robustness: body.data.robustness as 0 | 1 | 2 | 3 | 4 | null | undefined,
          usability: body.data.usability as 0 | 1 | 2 | 3 | 4 | null | undefined,
          overrideVerdict: body.data.overrideVerdict,
          reviewerId: body.data.reviewerId,
          routingScore: body.data.routingScore as 0 | 1 | 2 | undefined,
          honestyScore: body.data.honestyScore as 0 | 1 | 2 | undefined,
          handoffScore: body.data.handoffScore as 0 | 1 | 2 | undefined,
          robustnessScore: body.data.robustnessScore as 0 | 1 | 2 | undefined,
          usabilityScore: body.data.usabilityScore as 0 | 1 | 2 | undefined,
          notes: body.data.notes,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/tests/:testId/review", async (request, reply) => {
    const params = promptPackTestParamsSchema.safeParse(request.params);
    const body = promptPackReviewBodySchema.safeParse(request.body);
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
        fastify.gateway.reviewPromptPackTest({
          packId: params.data.packId,
          testId: params.data.testId,
          runId: body.data.runId,
          taskSuccess: body.data.taskSuccess as 0 | 1 | 2 | 3 | 4 | null | undefined,
          honesty: body.data.honesty as 0 | 1 | 2 | 3 | 4 | null | undefined,
          executionQuality: body.data.executionQuality as 0 | 1 | 2 | 3 | 4 | null | undefined,
          robustness: body.data.robustness as 0 | 1 | 2 | 3 | 4 | null | undefined,
          usability: body.data.usability as 0 | 1 | 2 | 3 | 4 | null | undefined,
          overrideVerdict: body.data.overrideVerdict,
          reviewerId: body.data.reviewerId,
          notes: body.data.notes,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/prompt-packs/:packId/tests/:testId/reviews", async (request, reply) => {
    const params = promptPackTestParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send({
        items: fastify.gateway.listPromptPackTestReviews(params.data.packId, params.data.testId),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/tests/:testId/auto-score", async (request, reply) => {
    const params = promptPackTestParamsSchema.safeParse(request.params);
    const body = promptPackAutoScoreBodySchema.safeParse(request.body ?? {});
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
        await fastify.gateway.autoScorePromptPackTest({
          packId: params.data.packId,
          testId: params.data.testId,
          runId: body.data.runId,
          providerId: body.data.providerId,
          model: body.data.model,
          force: body.data.force,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/auto-score", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const body = promptPackAutoScoreBatchBodySchema.safeParse(request.body ?? {});
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
        await fastify.gateway.autoScorePromptPackBatch({
          packId: params.data.packId,
          onlyUnscored: body.data.onlyUnscored,
          limit: body.data.limit,
          providerId: body.data.providerId,
          model: body.data.model,
          force: body.data.force,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/prompt-packs/:packId/report", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getPromptPackReport(params.data.packId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/benchmark/run", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const body = promptPackBenchmarkRunBodySchema.safeParse(request.body ?? {});
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
        fastify.gateway.runPromptPackBenchmark(params.data.packId, {
          testCodes: body.data.testCodes,
          providers: body.data.providers,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/prompt-packs/benchmark/:benchmarkRunId", async (request, reply) => {
    const params = promptPackBenchmarkParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getPromptPackBenchmarkStatus(params.data.benchmarkRunId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/replay-regression/run", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const body = promptPackReplayRegressionRunBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.runPromptPackReplayRegression(params.data.packId, body.data));
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  fastify.get("/api/v1/prompt-packs/replay-regression/:runId", async (request, reply) => {
    const params = promptPackReplayRegressionParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getPromptPackReplayRegressionStatus(params.data.runId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/prompt-packs/:packId/trends", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getPromptPackCapabilityTrends(params.data.packId));
    } catch (error) {
      const message = (error as Error).message;
      const notFound = message.toLowerCase().includes("not found");
      return reply.code(notFound ? 404 : 409).send({ error: message });
    }
  });

  fastify.get("/api/v1/prompt-packs/:packId/export", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: params.error.flatten() });
    }
    try {
      return reply.send(fastify.gateway.getPromptPackExport(params.data.packId));
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/export", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const body = promptPackExportBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      return reply.send(fastify.gateway.exportPromptPack(params.data.packId));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/prompt-packs/:packId/reset", async (request, reply) => {
    const params = promptPackParamsSchema.safeParse(request.params);
    const body = promptPackResetBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.code(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten(),
        },
      });
    }
    try {
      const clearRuns = body.data.clearRuns ?? true;
      const clearScores = body.data.clearScores ?? true;

      if (!clearRuns && !clearScores) {
        return reply.send({
          packId: params.data.packId,
          deletedRuns: 0,
          deletedScores: 0,
          export: fastify.gateway.getPromptPackExport(params.data.packId),
        });
      }
      return reply.send(
        fastify.gateway.resetPromptPackRunsAndScores(params.data.packId, {
          clearRuns,
          clearScores,
        }),
      );
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
