import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { structuredSourceRefSchema } from "./memory-context-request-schemas.js";
import { withRouteAccess } from "./route-access.js";

const traceCandidateParamsSchema = z.object({
  candidateId: z.string().trim().min(1),
});

const traceCandidateTypeSchema = z.enum([
  "fact",
  "decision",
  "tool_outcome",
  "operator_preference",
  "repo_fact",
  "workflow",
]);
const traceCandidateStatusQuerySchema = z.enum(["proposed", "rejected", "promoted", "all"]);

const traceCandidateListQuerySchema = z.object({
  reconciliationCursor: z.string().min(1).max(1024).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  status: traceCandidateStatusQuerySchema.optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const traceCandidateCreateSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  candidateType: traceCandidateTypeSchema.optional(),
  sourceText: z.string().trim().min(1).optional(),
  sourceSessionId: z.string().trim().min(1).optional(),
  sourceMessageId: z.string().trim().min(1).optional(),
  sourceRunId: z.string().trim().min(1).optional(),
  sourceTurnId: z.string().trim().min(1).optional(),
  toolCallId: z.string().trim().min(1).optional(),
  proposedInsight: z.string().trim().min(1),
  confidence: z.number().min(0).max(1).optional(),
  sourceRefs: z.array(structuredSourceRefSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function registerMemoryTraceCandidateRoutes(fastify: FastifyInstance): void {
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;
  const operatorOnly = withRouteAccess(fastify, "operator");
  const memory = fastify.services.memory;

  fastify.get("/api/v1/memory/trace-candidates", operatorOnly, async (request, reply) => {
    const parsed = traceCandidateListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const [items, reconciliationPreview] = await Promise.all([
        memory.listTraceCandidates(parsed.data),
        memory.previewTraceCandidateReconciliation({
          workspaceId: parsed.data.workspaceId,
          cursor: parsed.data.reconciliationCursor,
        }),
      ]);
      return reply.send({ items, reconciliationPreview });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/memory/trace-candidates/:candidateId", operatorOnly, async (request, reply) => {
    const params = traceCandidateParamsSchema.safeParse(request.params);
    const query = traceCandidateListQuerySchema.pick({ workspaceId: true }).safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid trace candidate read." });
    try {
      return reply.send(await memory.getTraceCandidate(params.data.candidateId, query.data.workspaceId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/memory/trace-candidates", operatorOnly, async (request, reply) => {
    const parsed = traceCandidateCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(202).send(await memory.proposeTraceCandidate(parsed.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.patch("/api/v1/memory/trace-candidates/:candidateId", operatorOnly, async (request, reply) => {
    const params = traceCandidateParamsSchema.safeParse(request.params),
      input = z
        .object({
          workspaceId: z.string().trim().min(1).max(256),
          expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
          proposedInsight: z.string().trim().min(1).max(1000),
        })
        .strict()
        .safeParse(request.body);
    if (!params.success || !input.success)
      return reply.code(400).send({ error: "Refresh and review the exact memory proposal before editing." });
    try {
      return reply.send(await memory.editTraceCandidate(params.data.candidateId, input.data, resolveActorId(request)));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  for (const action of ["promote", "reject"] as const) {
    fastify.post(`/api/v1/memory/trace-candidates/:candidateId/${action}`, operatorOnly, async (request, reply) => {
      const parsed = traceCandidateParamsSchema.safeParse(request.params);
      const review = z
        .object({
          workspaceId: z.string().trim().min(1).max(256),
          expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .strict()
        .safeParse(request.body);
      if (!parsed.success || !review.success) {
        return reply.code(400).send({ error: "Refresh the exact memory proposal before deciding." });
      }
      try {
        const candidate =
          action === "promote"
            ? await memory.promoteTraceCandidate(parsed.data.candidateId, resolveActorId(request), review.data)
            : await memory.rejectTraceCandidate(parsed.data.candidateId, resolveActorId(request), review.data);
        return reply.send(candidate);
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    });
  }
}
