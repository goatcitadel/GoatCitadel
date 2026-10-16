import { NotFoundError, PolicyViolationError, type CronJobRecord } from "@goatcitadel/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { projectPublicSecretValue } from "../services/public-secret-projection.js";

const cronJobListQuerySchema = z.object({
  citadelId: z.string().trim().min(1).max(200).optional(),
});

interface CronListPort {
  listCronJobs(citadel?: { citadelId: string; accessClass: string | undefined }): Promise<CronJobRecord[]>;
}

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
  // The central route-access preHandler already enforced the "/api/v1/cron" prefix policy
  // (operator), so a request that reaches the handler holds that class even when the route
  // config does not declare it explicitly.
  const accessClass = request.routeOptions.config?.goatcitadelRouteAccessClass ?? "operator";
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
