import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ValidationError } from "@goatcitadel/contracts";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const summaryQuery = z.object({
  scope: z.enum(["session", "day", "agent", "task"]).default("day"),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const boundedId = z.string().trim().min(1).max(256);
const workspaceParams = z.object({ workspaceId: boundedId }).strict();
const workspaceEventParams = z.object({ workspaceId: boundedId, eventId: boundedId }).strict();
const modelUsageListQuery = z
  .object({
    sessionId: boundedId.optional(),
    turnId: boundedId.optional(),
    durableRunId: boundedId.optional(),
    taskId: boundedId.optional(),
    assemblyRunId: boundedId.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    availability: z.enum(["tracked", "unknown"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(1_024).optional(),
  })
  .strict();
const modelUsageReconciliationBody = z
  .object({
    reconciliation: z.enum([
      "confirmed_not_dispatched",
      "confirmed_dispatched_usage_unknown",
      "superseded_by_new_generation",
    ]),
    evidence: z.string().trim().min(1).max(2_048),
  })
  .strict();

export const costsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/costs/summary", async (request, reply) => {
    const parsed = summaryQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const now = new Date();
    const to = parsed.data.to ?? now.toISOString();
    const from = parsed.data.from ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [items, dailySeries, usageAvailability] = await Promise.all([
      fastify.services.costs.costSummary(parsed.data.scope, from, to),
      fastify.services.costs.costDailySeries(from, to),
      fastify.services.costs.costUsageAvailability(from, to),
    ]);
    return reply.send({
      items,
      dailySeries,
      scope: parsed.data.scope,
      from,
      to,
      usageAvailability,
    });
  });

  fastify.post("/api/v1/costs/run-cheaper", async (_request, reply) => {
    return reply.send(await fastify.services.costs.runCheaper());
  });

  fastify.get(
    "/api/v1/ops/workspaces/:workspaceId/model-usage",
    withRouteAccess(fastify, "operator"),
    async (request, reply) => {
      const params = workspaceParams.safeParse(request.params);
      const query = modelUsageListQuery.safeParse(request.query);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      try {
        return reply.send(await fastify.services.costs.listModelUsageEvents(params.data.workspaceId, query.data));
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.get(
    "/api/v1/ops/workspaces/:workspaceId/model-usage/:eventId",
    withRouteAccess(fastify, "operator"),
    async (request, reply) => {
      const params = workspaceEventParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      try {
        return reply.send(
          await fastify.services.costs.getModelUsageEvent(params.data.workspaceId, params.data.eventId),
        );
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.post(
    "/api/v1/ops/workspaces/:workspaceId/model-usage/:eventId/reconcile",
    withRouteAccess(fastify, "operator"),
    async (request, reply) => {
      const params = workspaceEventParams.safeParse(request.params);
      const body = modelUsageReconciliationBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        const actorId = request.authActorId?.trim();
        if (!actorId) throw new ValidationError({ code: "FIELD_REQUIRED", field: "authActorId" });
        return reply.send(
          await fastify.services.costs.reconcileModelUsageDispatch({
            workspaceId: params.data.workspaceId,
            eventId: params.data.eventId,
            reconciliation: body.data.reconciliation,
            evidence: body.data.evidence,
            actorId,
          }),
        );
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
};
