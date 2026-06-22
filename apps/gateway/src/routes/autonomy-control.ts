import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AUTONOMY_AUDIT_KINDS } from "@goatcitadel/contracts";
import { withRouteAccess } from "./route-access.js";

/**
 * Operator-facing autonomy control surface (cross-cutting kill-switch & rollback).
 *
 *   GET  /api/v1/admin/autonomy/status        — kill-switch state + audit summary
 *   POST /api/v1/admin/autonomy/revert        — revert all autonomous changes since T
 *   POST /api/v1/admin/autonomy/kill-switch   — engage/disengage the master kill switch
 *
 * All routes are operator-gated (mirrors admin.ts). The `/api/v1/admin` prefix is
 * also covered by the route-access policy table, so operator auth is enforced
 * regardless; the explicit `withRouteAccess` wrapper attaches per-route limits.
 */

const RATE_LIMIT_READ_MAX = 500;
const RATE_LIMIT_MUTATION_MAX = 180;

const recentLimitQuery = z.object({
  recentLimit: z.coerce.number().int().positive().max(200).optional(),
});

const revertSchema = z.object({
  since: z.string().datetime({ offset: true }),
  kinds: z.array(z.enum(AUTONOMY_AUDIT_KINDS as unknown as [string, ...string[]])).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const killSwitchSchema = z.object({
  disabled: z.boolean(),
});

export const autonomyControlRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorReadRoute = withRouteAccess(fastify, "operator", {
    config: { rateLimit: { max: RATE_LIMIT_READ_MAX } },
  });
  const operatorMutationRoute = withRouteAccess(fastify, "operator", {
    config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } },
  });
  const autonomyControl = fastify.services.autonomyControl;

  fastify.get("/api/v1/admin/autonomy/status", operatorReadRoute, async (request, reply) => {
    const parsed = recentLimitQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(autonomyControl.getStatus(parsed.data.recentLimit));
  });

  fastify.post("/api/v1/admin/autonomy/revert", operatorMutationRoute, async (request, reply) => {
    const parsed = revertSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const opts: { kinds?: string[]; limit?: number } = {};
    if (parsed.data.kinds !== undefined) {
      opts.kinds = parsed.data.kinds;
    }
    if (parsed.data.limit !== undefined) {
      opts.limit = parsed.data.limit;
    }
    try {
      const summary = autonomyControl.revertAutonomousChangesSince(parsed.data.since, opts);
      return reply.send(summary);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/admin/autonomy/kill-switch", operatorMutationRoute, async (request, reply) => {
    const parsed = killSwitchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const status = autonomyControl.setKillSwitch(parsed.data.disabled);
      return reply.send(status);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });
};
