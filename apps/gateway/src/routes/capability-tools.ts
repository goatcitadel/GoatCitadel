import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { redactStructuredSecrets, ServiceUnavailableError } from "@goatcitadel/contracts";
import { sendRouteError } from "./_error-handler.js";

const listQuerySchema = z.object({ workspaceId: z.string().min(1).max(200) }).strict();
const usageQuerySchema = z.object({ refresh: z.enum(["true", "false"]).optional() }).strict();

const UNREADABLE_MESSAGE = "Tool call counts can't be read right now.";

/** Capabilities › Tools: the tool groups with their state, and how often the AI has used each tool and group. */
export const capabilityToolsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Every tool group for a workspace, with whether it is on and, per tool, whether the AI asks first or a rule blocks
   * it. Each tool is checked with the read-only policy probe: it records no access decision and publishes no event.
   * Nothing is cached, so a switch shows on the next request.
   */
  fastify.get(
    "/api/v1/capabilities/tools",
    // Each list probes every tool, so this is tighter than the general read bucket.
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      try {
        markNoStore(reply);
        // The probes run as the caller, so the operator's own permission profile applies.
        return reply.send(
          await requireListOwner(fastify).list(query.data.workspaceId, {
            operatorId: request.authActorId,
            authActorId: request.authActorId,
            authActorSource: request.authActorSource,
          }),
        );
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  /**
   * Call counts from the last year of chats. The counts are cached for 10 minutes; `refresh=true` reads them again.
   * It reads local history only: no realtime events, and no tool arguments or results.
   */
  fastify.get(
    "/api/v1/capabilities/tools/usage",
    // An uncached read scans every finished tool run in the window, so this is tighter than the general read bucket.
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const query = usageQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      try {
        markNoStore(reply);
        return reply.send(await readUsage(fastify, query.data.refresh === "true", request.log));
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
};

function requireListOwner(fastify: FastifyInstance) {
  const owner = fastify.services.capabilityTools;
  if (!owner) throw new ServiceUnavailableError("The capability tool list is not composed.");
  return owner;
}

/** A read that fails answers with plain wording only. The real error stays in the log. */
async function readUsage(fastify: FastifyInstance, refresh: boolean, log: FastifyBaseLogger) {
  const owner = fastify.services.capabilityToolUsage;
  if (!owner) throw new ServiceUnavailableError(UNREADABLE_MESSAGE);
  try {
    return await owner.read({ refresh });
  } catch (error) {
    const diagnostic =
      error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
    log.error({ err: redactStructuredSecrets(diagnostic).value }, "tool call counts could not be read");
    throw new ServiceUnavailableError(UNREADABLE_MESSAGE);
  }
}

function markNoStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
}
