import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const toolRunParamsSchema = z.object({
  toolRunId: z.string().trim().min(1).max(200),
});

const errandParamsSchema = z.object({
  errandId: z.string().trim().min(1).max(200),
});

/** The errand card's live state and its Stop button. Operator-only: errands drive the operator's own browser. */
export const browserErrandsRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorOnly = withRouteAccess(fastify, "operator");
  const resolveActorId = (request: { authActorId?: string; ip?: string }) =>
    request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;

  fastify.get("/api/v1/browser-errands/by-tool-run/:toolRunId", operatorOnly, async (request, reply) => {
    try {
      const { toolRunId } = toolRunParamsSchema.parse(request.params);
      const view = fastify.gatewayRuntime.browserErrandService.getStatus(toolRunId);
      if (!view) {
        return reply.code(404).send({ error: "No errand ran for this tool run." });
      }
      return reply.send(view);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/browser-errands/:errandId/stop", operatorOnly, async (request, reply) => {
    try {
      const { errandId } = errandParamsSchema.parse(request.params);
      const stopped = await fastify.gatewayRuntime.browserErrandService.stop(errandId, resolveActorId(request));
      return reply.send({ stopped });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
