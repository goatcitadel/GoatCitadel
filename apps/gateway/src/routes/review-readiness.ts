import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const findingSchema = z.object({
  source: z.string().trim().min(1),
  component: z.string().trim().min(1),
  title: z.string().trim().min(1),
  files: z.array(z.string().trim().min(1)).min(1),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  summary: z.string().trim().min(1).optional(),
  evidenceRef: z.string().trim().min(1).optional(),
  severity: z.enum(["p0", "p1", "p2", "p3"]).optional(),
  whyItMatters: z.string().trim().min(1).optional(),
  confidence: z.union([z.literal(0), z.literal(25), z.literal(50), z.literal(75), z.literal(100)]).optional(),
  evidence: z
    .array(
      z.object({
        path: z.string().trim().min(1).optional(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        quote: z.string().trim().min(1).optional(),
        artifactRef: z.string().trim().min(1).optional(),
      }),
    )
    .optional(),
  preExisting: z.boolean().optional(),
  fixClass: z.enum(["approval_gated", "manual", "advisory"]).optional(),
  ownerRole: z.string().trim().min(1).optional(),
  suggestedFix: z.string().trim().min(1).optional(),
  requiresVerification: z.boolean().optional(),
  testingGaps: z.array(z.string().trim().min(1)).optional(),
  residualRisks: z.array(z.string().trim().min(1)).optional(),
});

const importFindingsSchema = z.object({
  findings: z.array(findingSchema).min(1).max(200),
});

const reviewRunParamsSchema = z.object({ reviewRunId: z.string().trim().min(1) });
const reviewFindingParamsSchema = z.object({ findingId: z.string().trim().min(1) });
const reviewRunsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const startReviewSchema = z.object({
  participants: z
    .array(
      z.object({
        participantId: z.string().trim().min(1),
        providerId: z.string().trim().min(1),
        model: z.string().trim().min(1),
        label: z.string().trim().min(1).optional(),
      }),
    )
    .min(1)
    .max(6),
  workspaceId: z.string().trim().min(1).optional(),
  sourceSessionId: z.string().trim().min(1).optional(),
  sourceTaskId: z.string().trim().min(1).optional(),
  costBudgetUsd: z.number().min(0).max(1_000).optional(),
  tokenBudget: z.number().int().min(1_000).max(250_000).optional(),
});
const acceptFindingSchema = z.object({ mirrorToTask: z.boolean().default(true) });
const closeFindingSchema = z.object({
  verificationEvidence: z.array(z.string().trim().min(1)).min(1).max(100),
  followUpReviewRunId: z.string().trim().min(1),
});

// `_opts` is declared but unused: Fastify always supplies plugin options, and
// the unit tests invoke this plugin directly. Declaring it keeps the arity of
// the implementation aligned with `FastifyPluginAsync`, which requires two
// arguments at every call site (CodeQL js/superfluous-trailing-arguments).
export const reviewReadinessRoutes: FastifyPluginAsync = async (fastify, _opts) => {
  const operatorOnly = withRouteAccess(fastify, "operator");
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;

  fastify.get("/api/v1/review/readiness", operatorOnly, async (request, reply) => {
    try {
      return reply.send(fastify.gatewayRuntime.reviewReadinessService.getReadiness());
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/review/identity", operatorOnly, async (request, reply) => {
    try {
      return reply.send(fastify.gatewayRuntime.reviewReadinessService.getRuntimeIdentity());
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/review/readiness/runtime-release/refresh", operatorOnly, async (request, reply) => {
    try {
      return reply.send(await fastify.gatewayRuntime.reviewReadinessService.refreshRuntimeReleaseTrust());
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/review/findings/import", operatorOnly, async (request, reply) => {
    try {
      const body = importFindingsSchema.parse(request.body);
      return reply.send(
        fastify.gatewayRuntime.reviewReadinessService.importFindings({
          findings: body.findings,
          actorId: resolveActorId(request),
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/review/runs", operatorOnly, async (request, reply) => {
    try {
      const body = startReviewSchema.parse(request.body);
      return reply.code(202).send(
        await fastify.gatewayRuntime.reviewReadinessService.startStructuredReview({
          ...body,
          actorId: resolveActorId(request),
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/review/runs", operatorOnly, async (request, reply) => {
    try {
      const query = reviewRunsQuerySchema.parse(request.query ?? {});
      return reply.send(fastify.gatewayRuntime.reviewReadinessService.listStructuredReviewRuns(query.limit));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/review/runs/:reviewRunId", operatorOnly, async (request, reply) => {
    try {
      const params = reviewRunParamsSchema.parse(request.params);
      return reply.send(fastify.gatewayRuntime.reviewReadinessService.getStructuredReviewRun(params.reviewRunId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/review/findings/:findingId/accept", operatorOnly, async (request, reply) => {
    try {
      const params = reviewFindingParamsSchema.parse(request.params);
      const body = acceptFindingSchema.parse(request.body ?? {});
      return reply.send(
        fastify.gatewayRuntime.reviewReadinessService.acceptStructuredReviewFinding(params.findingId, {
          actorId: resolveActorId(request),
          mirrorToTask: body.mirrorToTask,
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/review/findings/:findingId/dismiss", operatorOnly, async (request, reply) => {
    try {
      const params = reviewFindingParamsSchema.parse(request.params);
      return reply.send(
        fastify.gatewayRuntime.reviewReadinessService.dismissStructuredReviewFinding(
          params.findingId,
          resolveActorId(request),
        ),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/review/findings/:findingId/request-fix", operatorOnly, async (request, reply) => {
    try {
      const params = reviewFindingParamsSchema.parse(request.params);
      return reply
        .code(202)
        .send(
          await fastify.gatewayRuntime.reviewReadinessService.requestStructuredReviewFix(
            params.findingId,
            resolveActorId(request),
          ),
        );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/review/findings/:findingId/close", operatorOnly, async (request, reply) => {
    try {
      const params = reviewFindingParamsSchema.parse(request.params);
      const body = closeFindingSchema.parse(request.body);
      return reply.send(
        fastify.gatewayRuntime.reviewReadinessService.closeStructuredReviewFinding(params.findingId, {
          ...body,
          actorId: resolveActorId(request),
        }),
      );
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
