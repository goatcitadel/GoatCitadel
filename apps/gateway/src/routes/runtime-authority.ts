import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const projectionQuerySchema = z
  .object({
    workspaceId: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9._-]+$/),
  })
  .strict();

// `_opts` is declared but unused: Fastify always supplies plugin options, and
// the unit tests invoke this plugin directly. Declaring it keeps the arity of
// the implementation aligned with `FastifyPluginAsync`, which requires two
// arguments at every call site (CodeQL js/superfluous-trailing-arguments).
export const runtimeAuthorityRoutes: FastifyPluginAsync = async (fastify, _opts) => {
  const operatorOnly = withRouteAccess(fastify, "operator");

  fastify.get("/api/v1/ops/runtime-authority", operatorOnly, async (request, reply) => {
    try {
      const query = projectionQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: "Invalid runtime authority query." });
      }
      try {
        fastify.services.workspaces.getWorkspace(query.data.workspaceId);
      } catch {
        return reply.code(404).send({ error: "Workspace not found." });
      }
      return reply.send(await fastify.gatewayRuntime.runtimeAuthorityProjectionService.getProjection(query.data));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};
