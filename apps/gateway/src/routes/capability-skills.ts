import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { redactStructuredSecrets, ServiceUnavailableError } from "@goatcitadel/contracts";
import { sendRouteError } from "./_error-handler.js";

const usageQuerySchema = z.object({ refresh: z.enum(["true", "false"]).optional() }).strict();

const UNREADABLE_MESSAGE = "Skill use counts can't be read right now.";

/** Capabilities › Skills: how often the AI has used each skill. */
export const capabilitySkillsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Use counts from the last year of chats. The counts are cached for 10 minutes; `refresh=true` reads them again.
   * It reads local history only: no realtime events, and no turn text, tool arguments or results.
   */
  fastify.get(
    "/api/v1/capabilities/skills/usage",
    // An uncached read scans a year of chat turn profiles, so this is tighter than the general read bucket.
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

/** A read that fails answers with plain wording only, and no counts. The real error stays in the log. */
async function readUsage(fastify: FastifyInstance, refresh: boolean, log: FastifyBaseLogger) {
  const owner = fastify.services.capabilitySkills?.usage;
  if (!owner) throw new ServiceUnavailableError(UNREADABLE_MESSAGE);
  try {
    return await owner.read({ refresh });
  } catch (error) {
    const diagnostic =
      error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
    log.error({ err: redactStructuredSecrets(diagnostic).value }, "skill use counts could not be read");
    throw new ServiceUnavailableError(UNREADABLE_MESSAGE);
  }
}

function markNoStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
}
