import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ConflictError, redactStructuredSecrets, ServiceUnavailableError } from "@goatcitadel/contracts";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const usageQuerySchema = z.object({ refresh: z.enum(["true", "false"]).optional() }).strict();
const listQuerySchema = z.object({ workspaceId: z.string().min(1).max(200) }).strict();
const detailQuerySchema = z
  .object({ workspaceId: z.string().min(1).max(200), skillId: z.string().min(1).max(300) })
  .strict();
// No field chooses the skip, and an extra key is refused: the Gateway alone decides whether the operator is asked.
const stateBodySchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    skillId: z.string().min(1).max(300),
    state: z.enum(["enabled", "sleep", "disabled"]),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

const UNREADABLE_MESSAGE = "Skill use counts can't be read right now.";
const UNAVAILABLE_LIST_MESSAGE = "Skills can't be read right now.";
const UNAVAILABLE_SWITCH_MESSAGE = "Skills can't be switched right now.";
const PINNED_MESSAGE = "This skill is pinned. Change it through a proposal in Library.";
// Each read lists the workspace's skills, its choices, the inspectable catalog and the waiting approvals.
const LIST_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;

/**
 * Capabilities › Skills: the installed skills, one skill's details, how often the AI has used each skill, and the
 * switch that turns a skill on, pauses it or turns it off.
 */
export const capabilitySkillsRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorSwitch = withRouteAccess(fastify, "operator", {
    // The body is a workspace, a skill id, a state and a revision; the bound matches the other operator save routes.
    bodyLimit: 20 * 1_024,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  });

  /**
   * Every skill loaded for a workspace, with its category, origin, state, whether it is callable, whether the
   * workspace's skill choices leave it out, and any approval it waits on. It reads local state only and publishes no
   * events.
   */
  fastify.get("/api/v1/capabilities/skills", { config: { rateLimit: LIST_RATE_LIMIT } }, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      markNoStore(reply);
      return reply.send(await requireSkills(fastify).list(query.data.workspaceId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  /** One skill's details, including its SKILL.md text. 404 for a skill the workspace doesn't load. */
  fastify.get(
    "/api/v1/capabilities/skills/detail",
    { config: { rateLimit: LIST_RATE_LIMIT } },
    async (request, reply) => {
      const query = detailQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      try {
        markNoStore(reply);
        return reply.send(await requireSkills(fastify).detail(query.data.workspaceId, query.data.skillId));
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

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

  /**
   * Switches one skill, install-wide. It always asks the skill state owner, which creates the skill's usual approval;
   * when the operator's skip applies, the switch approves that approval at once as the operator, and the approval's
   * own effect applies the change. 202 with `approved` or `waiting`; 200 with `unchanged`, or `declined` when this
   * same request was already turned down. A pinned skill or a stale revision is a 409.
   */
  fastify.post("/api/v1/capabilities/skills/state", operatorSwitch, async (request, reply) => {
    const body = stateBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      markNoStore(reply);
      const outcome = await requireActions(fastify).setState({
        ...body.data,
        actorId: request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`,
      });
      return reply.code(outcome.status === "approved" || outcome.status === "waiting" ? 202 : 200).send(outcome);
    } catch (error) {
      return sendRouteError(reply, plainPinnedRefusal(error), request.log);
    }
  });
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

function requireSkills(fastify: FastifyInstance) {
  const owner = fastify.services.capabilitySkills?.skills;
  if (!owner) throw new ServiceUnavailableError(UNAVAILABLE_LIST_MESSAGE);
  return owner;
}

function requireActions(fastify: FastifyInstance) {
  const owner = fastify.services.capabilitySkills?.actions;
  if (!owner) throw new ServiceUnavailableError(UNAVAILABLE_SWITCH_MESSAGE);
  return owner;
}

/**
 * The skill state owner refuses a pinned skill with a conflict that names the skill and its proposal flow. The
 * operator sees where to go instead; any other conflict, such as a stale revision, passes through as the owner wrote it.
 */
function plainPinnedRefusal(error: unknown): unknown {
  return error instanceof ConflictError && error.code === "STATE_CONFLICT" && error.message.startsWith("Pinned skill ")
    ? new ConflictError({ message: PINNED_MESSAGE })
    : error;
}

function markNoStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
}
