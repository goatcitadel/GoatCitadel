import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CAPABILITY_SKILL_SOURCE_REFUSED_CODE,
  ConflictError,
  NotFoundError,
  redactStructuredSecrets,
  ServiceUnavailableError,
  type CapabilitySkillSourceRefusal,
  type CapabilitySkillStateRefusal,
} from "@goatcitadel/contracts";
import { CapabilitySkillSourceRefusedError } from "../services/capability-skill-actions-service.js";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const usageQuerySchema = z.object({ refresh: z.enum(["true", "false"]).optional() }).strict();
const listQuerySchema = z.object({ workspaceId: z.string().min(1).max(200) }).strict();
const installsQuerySchema = z
  .object({ workspaceId: z.string().min(1).max(200), snapshotId: z.string().min(1).max(200).optional() })
  .strict();
// A search term is 2 to 100 characters once trimmed; the Gateway lower-cases it. Without one nothing goes online.
const discoverQuerySchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    q: z.string().trim().min(2).max(100).optional(),
    refresh: z.enum(["true", "false"]).optional(),
  })
  .strict();
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

// The same bounds the Skill Hub review applies, so a key it would refuse is refused here as a plain 400.
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\p{L}\p{N}._:@/+*-]+$/u);
// A pack by its id or a Git address, nothing else: no source type, no server path. The Gateway reviews a Git address
// as `git_url` and refuses any host but the trusted forges.
const reviewBodySchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("pack"), packId: z.string().regex(/^[a-z0-9-]{1,64}$/u) }).strict(),
      z.object({ kind: z.literal("git"), sourceRef: z.string().min(1).max(2_048) }).strict(),
    ]),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
// Only the two install steps, and no field that chooses the skip.
const operationBodySchema = z
  .object({
    workspaceId: z.string().min(1).max(200),
    snapshotId: z.string().min(1).max(256),
    operationKind: z.enum(["install_inactive", "activate"]),
  })
  .strict();

const UNREADABLE_MESSAGE = "Skill use counts can't be read right now.";
const UNAVAILABLE_LIST_MESSAGE = "Skills can't be read right now.";
const UNAVAILABLE_SWITCH_MESSAGE = "Skills can't be switched right now.";
const NOT_SWITCHABLE_MESSAGE = "This skill can't be switched from here.";
const UNAVAILABLE_CHECK_MESSAGE = "Skills can't be checked right now.";
const UNAVAILABLE_INSTALL_MESSAGE = "Skills can't be installed right now.";
const UNAVAILABLE_INSTALLS_MESSAGE = "Skill installs can't be read right now.";
const UNAVAILABLE_DISCOVER_MESSAGE = "Skills to install can't be listed right now.";
const STEP_BLOCKED_MESSAGE = "GoatCitadel's checks don't allow this step right now.";
const CHECK_NOT_FOUND_MESSAGE = "This skill's check wasn't found. Check it again.";
/** The owner's refusals, in plain copy with no skill id, each with its own code (contract: CapabilitySkillStateRefusal). */
const REFUSALS = {
  pinned: { code: "STATE_CONFLICT", message: "This skill is pinned. Change it through a proposal in Library." },
  stale: { code: "WRITE_CONFLICT", message: "This skill changed since you opened it. Reload and try again." },
  duplicate: {
    code: "ALREADY_EXISTS",
    message: "Someone already asked for this exact change, and it is waiting for approval.",
  },
} as const satisfies Record<CapabilitySkillStateRefusal, { code: ConflictError["code"]; message: string }>;
// Each read lists the workspace's skills, its choices, the inspectable catalog and the waiting approvals.
const LIST_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
// A check reads a whole source (a Git clone, say) and keeps its bytes.
const REVIEW_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
const OPERATION_RATE_LIMIT = { max: 20, timeWindow: "1 minute" } as const;
// The installs read lists the workspace's newest 100 checks with their approvals.
const INSTALLS_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
// A search can ask two marketplaces over the network; their answer is kept for 10 minutes.
const DISCOVER_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;
// A check or step body is a workspace, a source or a check id, and a key; the bound matches the other operator saves.
const BODY_LIMIT = 20 * 1_024;

/**
 * Capabilities › Skills: the installed skills, one skill's details, how often the AI has used each skill, the switch
 * that turns a skill on, pauses it or turns it off, and checking and installing a new skill.
 */
export const capabilitySkillsRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorSwitch = withRouteAccess(fastify, "operator", {
    // The body is a workspace, a skill id, a state and a revision; the bound matches the other operator save routes.
    bodyLimit: 20 * 1_024,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  });
  const operatorReview = withRouteAccess(fastify, "operator", {
    bodyLimit: BODY_LIMIT,
    config: { rateLimit: REVIEW_RATE_LIMIT },
  });
  const operatorStep = withRouteAccess(fastify, "operator", {
    bodyLimit: BODY_LIMIT,
    config: { rateLimit: OPERATION_RATE_LIMIT },
  });
  const operatorInstalls = withRouteAccess(fastify, "operator", { config: { rateLimit: INSTALLS_RATE_LIMIT } });

  /**
   * Every skill loaded for a workspace, with its category, origin, state, whether it is callable, whether it can be
   * switched, and any approval it waits on. It reads local state only and publishes no events.
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
   * own effect applies the change. 202 with `approved` or `waiting`; 200 with `unchanged`, or `declined` when the
   * approval ran out of time just as the skip approved it (`expired`); asking again then makes a fresh approval. A
   * pinned skill, a stale revision or someone else's identical request is a 409 with its own code; so is the same
   * change turned down many times in a row (`STATE_CONFLICT`, with no `details.reason`). A skill the switch can't
   * reach is a 404. None names the skill.
   */
  fastify.post("/api/v1/capabilities/skills/state", operatorSwitch, async (request, reply) => {
    const body = stateBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      markNoStore(reply);
      const outcome = await requireActions(fastify).setState({
        ...body.data,
        actorId: actorIdFor(request),
      });
      return reply.code(outcome.status === "approved" || outcome.status === "waiting" ? 202 : 200).send(outcome);
    } catch (error) {
      return sendRouteError(reply, plainRefusal(error), request.log);
    }
  });

  /**
   * Checks a skill source through Skill Hub's own review: one of GoatCitadel's packs, or an `https` Git address on
   * GitHub, GitLab, Bitbucket or Codeberg. It installs nothing and asks for no approval. 201 with the checked skill and
   * where its install stands (`check_passed`, or `blocked` with its codes); 200 when the same key hands back the same
   * check. A refused source is a 422 (`SKILL_SOURCE_REFUSED`) with plain words and the check's own code as
   * `details.reason`. No server path is ever sent.
   */
  fastify.post("/api/v1/capabilities/skills/reviews", operatorReview, async (request, reply) => {
    const body = reviewBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      markNoStore(reply);
      const checked = await requireActions(fastify, UNAVAILABLE_CHECK_MESSAGE).checkSource({
        ...body.data,
        actorId: actorIdFor(request),
      });
      return reply.code(checked.replayed ? 200 : 201).send(checked.install);
    } catch (error) {
      if (error instanceof CapabilitySkillSourceRefusedError) return sendSourceRefusal(reply, error, request.log);
      return sendRouteError(reply, error, request.log);
    }
  });

  /**
   * The workspace's installs still on their way in, or stopped on the way, so an install left between its two steps is
   * found again after a reload, and whether the operator's skip applies. With `snapshotId`, just that check at any step
   * (done, passed and blocked included), or none when the workspace's checks don't hold it. It reads local state only.
   */
  fastify.get("/api/v1/capabilities/skills/installs", operatorInstalls, async (request, reply) => {
    const query = installsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      markNoStore(reply);
      const { workspaceId, snapshotId } = query.data;
      return reply.send(await requireSkills(fastify, UNAVAILABLE_INSTALLS_MESSAGE).installs(workspaceId, snapshotId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  /**
   * The skills on offer to install. With no `q`, GoatCitadel's own packs and the curated listings, and no network call.
   * With `q` (2 to 100 characters), the packs and listings that match it, with the marketplaces' listings ranked in;
   * a marketplace that couldn't be searched is named in `unavailableProviders` and the rest is still answered. The
   * marketplaces' answer is kept for 10 minutes; `refresh=true` asks them again. Each item says whether it is
   * available, installed, on its way in, or only a listing to look at. It writes nothing and publishes no events.
   */
  fastify.get(
    "/api/v1/capabilities/skills/discover",
    { config: { rateLimit: DISCOVER_RATE_LIMIT } },
    async (request, reply) => {
      const query = discoverQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      try {
        markNoStore(reply);
        const { workspaceId, q, refresh } = query.data;
        return reply.send(
          await requireDiscover(fastify).list(workspaceId, { ...(q ? { query: q } : {}), refresh: refresh === "true" }),
        );
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  /**
   * Asks for one install step of a checked skill (`install_inactive`, then `activate`). It always asks Skill Hub's
   * approval owner, which creates the step's usual approval; when the operator's setting to skip approvals applies
   * (never on `remote_hardened`), the step approves that approval at once as the operator, and the approval's own
   * effect applies it. 202 with `approved` or `waiting`. A step GoatCitadel's checks don't allow now is a 409
   * (`STATE_CONFLICT`, `details: { reason: "blocked", blockers }`); a check that isn't there is a 404.
   */
  fastify.post("/api/v1/capabilities/skills/operations", operatorStep, async (request, reply) => {
    const body = operationBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      markNoStore(reply);
      const outcome = await requireActions(fastify, UNAVAILABLE_INSTALL_MESSAGE).requestStep({
        ...body.data,
        actorId: actorIdFor(request),
      });
      return reply.code(outcome.status === "approved" || outcome.status === "waiting" ? 202 : 200).send(outcome);
    } catch (error) {
      return sendRouteError(reply, plainStepRefusal(error), request.log);
    }
  });
};

/** The operator who asked; without an actor from sign-in, the caller's address. */
function actorIdFor(request: { authActorId?: string; ip?: string }): string {
  return request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;
}

/** A refused source: plain words and the check's own code. The owner's own message stays in the log. */
function sendSourceRefusal(reply: FastifyReply, refusal: CapabilitySkillSourceRefusedError, log: FastifyBaseLogger) {
  const cause = refusal.cause instanceof Error ? { name: refusal.cause.name, message: refusal.cause.message } : {};
  log.warn({ reason: refusal.reason, err: redactStructuredSecrets(cause).value }, "a skill source was refused");
  const body: CapabilitySkillSourceRefusal = {
    error: refusal.message,
    code: CAPABILITY_SKILL_SOURCE_REFUSED_CODE,
    details: { reason: refusal.reason },
  };
  return reply.code(422).send(body);
}

/**
 * Skill Hub's guard refusal and its missing check, in plain copy: the guard's own message names Skill Hub and its codes,
 * so only the codes pass through, as `details.blockers`. Anything else passes through as its owner wrote it.
 */
function plainStepRefusal(error: unknown): unknown {
  if (error instanceof ConflictError && Array.isArray(error.details?.blockers)) {
    return new ConflictError({
      code: "STATE_CONFLICT",
      message: STEP_BLOCKED_MESSAGE,
      details: { reason: "blocked", blockers: error.details.blockers },
    });
  }
  if (error instanceof NotFoundError && error.details?.entity === "Skill Hub snapshot") {
    return new NotFoundError(CHECK_NOT_FOUND_MESSAGE);
  }
  return error;
}

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

function requireSkills(fastify: FastifyInstance, unavailableMessage = UNAVAILABLE_LIST_MESSAGE) {
  const owner = fastify.services.capabilitySkills?.skills;
  if (!owner) throw new ServiceUnavailableError(unavailableMessage);
  return owner;
}

function requireDiscover(fastify: FastifyInstance) {
  const owner = fastify.services.capabilitySkills?.discover;
  if (!owner) throw new ServiceUnavailableError(UNAVAILABLE_DISCOVER_MESSAGE);
  return owner;
}

function requireActions(fastify: FastifyInstance, unavailableMessage = UNAVAILABLE_SWITCH_MESSAGE) {
  const owner = fastify.services.capabilitySkills?.actions;
  if (!owner) throw new ServiceUnavailableError(unavailableMessage);
  return owner;
}

/**
 * The owners' refusals name the skill (and the stale one its revisions), so each known one becomes plain copy with its
 * own code; only that plain refusal reaches the request log. Anything else passes through as its owner wrote it.
 */
function plainRefusal(error: unknown): unknown {
  // The skill state owner looks the skill up among the loaded skills; a workspace's self-authored skill isn't there.
  if (error instanceof NotFoundError && error.details?.entity === "skill")
    return new NotFoundError(NOT_SWITCHABLE_MESSAGE);
  const reason = error instanceof ConflictError ? refusalReason(error) : undefined;
  return reason ? new ConflictError({ ...REFUSALS[reason], details: { reason } }) : error;
}

/** Which of the skill state owner's own 409s this is. Their messages are pinned by the owners' tests. */
function refusalReason(error: ConflictError): CapabilitySkillStateRefusal | undefined {
  if (error.code === "STATE_CONFLICT" && error.message.startsWith("Pinned skill ")) return "pinned";
  if (error.code === "WRITE_CONFLICT" && error.details?.resourceKind === "runtime_skill") return "stale";
  // The approval id follows from the change and the state it starts from; its payload also names who asked.
  if (
    error.code === "STATE_CONFLICT" &&
    error.message.includes("already exists with different immutable request bytes")
  ) {
    return "duplicate";
  }
  return undefined;
}

function markNoStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
}
