import { WORK_PASSPORT_DOMAINS, type WorkPassportBaselineResponse } from "@goatcitadel/contracts";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const querySchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
});

const updateSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  roleLabel: z.string().trim().max(120).optional(),
  primaryDomains: z.array(z.enum(WORK_PASSPORT_DOMAINS)).max(8),
});

export const workPassportRoutes: FastifyPluginAsync = async (fastify, _opts) => {
  const operatorOnly = withRouteAccess(fastify, "operator");

  fastify.get("/api/v1/work-passport/baseline", operatorOnly, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const query = parsed.data;
      await fastify.services.workspaces.getWorkspace(query.workspaceId);
      const response: WorkPassportBaselineResponse = {
        workspaceId: query.workspaceId,
        baseline: await fastify.gatewayRuntime.workPassportService.getBaseline(query.workspaceId),
      };
      return reply.send(response);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.put("/api/v1/work-passport/baseline", operatorOnly, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const body = parsed.data;
      await fastify.services.workspaces.getWorkspace(body.workspaceId);
      const response: WorkPassportBaselineResponse = {
        workspaceId: body.workspaceId,
        baseline: await fastify.gatewayRuntime.workPassportService.updateBaseline(body),
      };
      return reply.send(response);
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
