import type { FastifyPluginAsync } from "fastify";
import type { RuntimeRepairsRouteService } from "../services/runtime-repair/runtime-repair-sweep-service.js";
import { withRouteAccess } from "./route-access.js";

export interface RuntimeRepairsRoutesOptions {
  service: RuntimeRepairsRouteService;
}

/** Read-only view of the detect-only Runtime Repair Sweep (docs/RUNTIME_REPAIR_SWEEP.md). */
export const runtimeRepairsRoutes: FastifyPluginAsync<RuntimeRepairsRoutesOptions> = async (fastify, options) => {
  if (!options.service) throw new Error("Runtime repair routes require an explicit service.");
  const operatorRead = withRouteAccess(fastify, "operator", {
    onRequest: async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    },
  });

  fastify.get("/api/v1/ops/runtime-repairs", operatorRead, async (_request, reply) => {
    return reply.send(options.service.snapshot());
  });
};
