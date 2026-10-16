import { NotFoundError, PolicyViolationError } from "@goatcitadel/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CronAutomationService } from "../services/gateway/cron-automation-service.js";
import { projectPublicSecretValue } from "../services/public-secret-projection.js";

const cronJobListQuerySchema = z.object({
  citadelId: z.string().trim().min(1).max(200).optional(),
});

type CronListPort = Pick<CronAutomationService, "listCronJobs">;

/** Route options declaring the operator access class the citadel scope is derived from. */
export const CRON_JOBS_LIST_ROUTE_OPTIONS = { config: { goatcitadelRouteAccessClass: "operator" } } as const;

/**
 * `GET /api/v1/cron/jobs`. With `?citadelId=` the response is scope-checked (the service builds the
 * access scope); without it the unscoped list is returned unchanged.
 */
export async function replyWithCronJobs(cron: CronListPort, request: FastifyRequest, reply: FastifyReply) {
  const query = cronJobListQuerySchema.safeParse(request.query ?? {});
  if (!query.success) {
    return reply.code(400).send({ error: query.error.flatten() });
  }
  const { citadelId } = query.data;
  if (!citadelId) {
    return reply.send(projectPublicSecretValue({ items: await cron.listCronJobs() }));
  }
  // Fail closed: the route must declare its access class in config (see CRON_JOBS_LIST_ROUTE_OPTIONS);
  // a missing class reaches the service as `undefined`, which builds an empty readable set (403).
  const accessClass = request.routeOptions.config?.goatcitadelRouteAccessClass;
  try {
    const items = await cron.listCronJobs({ citadelId, accessClass });
    return reply.send(projectPublicSecretValue({ items }));
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof PolicyViolationError) {
      return reply.code(error.httpStatus).send({ error: error.message });
    }
    throw error;
  }
}
