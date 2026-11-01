import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CAPABILITY_PLUGIN_REFUSED_CODE,
  PLUGIN_LIMITS,
  PLUGIN_PIECE_ID_PATTERN,
  ServiceUnavailableError,
  isGoatError,
  pluginManifestSchema,
  redactStructuredSecrets,
  type CapabilityPluginDetail,
  type CapabilityPluginRefusal,
  type PluginActionOutcome,
} from "@goatcitadel/contracts";
import { CapabilityPluginManifestRefusedError } from "../services/capability-plugin-inspection-service.js";
import { PluginSourceError } from "../services/plugin-source-service.js";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

// The Skill Hub review's identity rule (`normalizeIdentity`), so a workspace it would refuse is a 400 here, not a 503:
// text with no space at either end that NFKC leaves as it is.
const workspaceIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.normalize("NFKC").trim(), "must be NFKC text with no space at either end");
const listQuerySchema = z.object({ workspaceId: workspaceIdSchema }).strict();
const detailQuerySchema = z
  .object({ pluginId: pluginManifestSchema.shape.pluginId, workspaceId: workspaceIdSchema })
  .strict();
const inspectionParamsSchema = z.object({ inspectionId: z.uuid() }).strict();
const inspectionQuerySchema = z.object({}).strict();
// A plugin source by kind, nothing else: a shipped plugin by its id, an https Git address with an optional commit,
// branch or tag, or a folder path. The Gateway checks each one again before it reads anything.
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("built_in"), pluginId: pluginManifestSchema.shape.pluginId }).strict(),
  z
    .object({ kind: z.literal("git"), url: z.string().min(1).max(2_048), ref: z.string().min(1).max(256).optional() })
    .strict(),
  z.object({ kind: z.literal("folder"), path: z.string().min(1).max(4_096) }).strict(),
]);
const inspectionBodySchema = z.object({ workspaceId: workspaceIdSchema, source: sourceSchema }).strict();
// A kept check and one signing secret per hook piece, by piece id; the service checks which pieces are hooks and each
// secret's exact shape. Only values come in here: the key store's references are minted by the service.
const installBodySchema = z
  .object({
    workspaceId: workspaceIdSchema,
    inspectionId: z.uuid(),
    hookSecrets: z
      .record(z.string().regex(PLUGIN_PIECE_ID_PATTERN), z.string().max(1_024))
      .refine((secrets) => Object.keys(secrets).length <= PLUGIN_LIMITS.maxPieces, "too many secrets")
      .optional(),
  })
  .strict();
// The plugin, by the manifest's own id rule, in the workspace it was installed in: nothing else comes in.
const uninstallBodySchema = z
  .object({ workspaceId: workspaceIdSchema, pluginId: pluginManifestSchema.shape.pluginId })
  .strict();
// A key names one attempt, so the same key from the same operator gets the same answer: up to 256 plain characters, the
// bound the Gateway's own attempt read takes.
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\p{L}\p{N}._:@/+*-]+$/u);

const UNAVAILABLE_MESSAGE = "Plugins can't be read right now.";
const INSTALL_UNAVAILABLE_MESSAGE = "This plugin can't be installed right now.";
const UNINSTALL_UNAVAILABLE_MESSAGE = "This plugin can't be uninstalled right now.";
const KEY_MESSAGE = "Send an Idempotency-Key header of up to 256 letters, digits or . _ : @ / + * - characters.";
// The list reads the plugin store, the shipped manifests and, for installed plugins with skills, Skill Hub's checks.
const LIST_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
// A detail reads the plugin store, its install plan and snapshot, and its skills' Skill Hub checks by their ids.
const DETAIL_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
// An inspection fetches a whole source (a Git clone, say) and runs every piece's check.
const INSPECTION_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
const READ_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
// The body is a workspace and a source; the bound matches the other operator saves.
const BODY_LIMIT = 20 * 1_024;
// An install makes one Change Plan, as the connector install does.
const INSTALL_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
// A workspace, a check and up to 32 secrets of up to 1,024 characters each.
const INSTALL_BODY_LIMIT = 64 * 1_024;
// An uninstall makes one Change Plan, as an install does.
const UNINSTALL_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
// The plain refusals an owner writes for the operator, answered with their own status: anything else is a fault.
const ANSWERED_STATUSES: ReadonlySet<number> = new Set([403, 404, 409, 422]);
// The 503s an install answers in its own plain words: Change Plans are off, or the key store can't be used.
const ANSWERED_UNAVAILABLE_REASONS: ReadonlySet<unknown> = new Set(["change_plans_off", "key_store_unavailable"]);

/**
 * Capabilities › Plugins: the installed and built-in plugins, inspecting a plugin source, reading an inspection back,
 * and installing and uninstalling a plugin. Inspecting installs nothing and asks for no approval.
 */
export const capabilityPluginsRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorList = withRouteAccess(fastify, "operator", { config: { rateLimit: LIST_RATE_LIMIT } });
  const operatorDetail = withRouteAccess(fastify, "operator", { config: { rateLimit: DETAIL_RATE_LIMIT } });
  const operatorInspect = withRouteAccess(fastify, "operator", {
    bodyLimit: BODY_LIMIT,
    config: { rateLimit: INSPECTION_RATE_LIMIT },
  });
  const operatorRead = withRouteAccess(fastify, "operator", { config: { rateLimit: READ_RATE_LIMIT } });
  const operatorInstall = withRouteAccess(fastify, "operator", {
    bodyLimit: INSTALL_BODY_LIMIT,
    config: { rateLimit: INSTALL_RATE_LIMIT },
  });
  const operatorUninstall = withRouteAccess(fastify, "operator", {
    bodyLimit: BODY_LIMIT,
    config: { rateLimit: UNINSTALL_RATE_LIMIT },
  });

  /**
   * The installed plugins, install-wide, and the ones that ship with GoatCitadel and aren't installed. A plugin reads
   * `installed` only once its install finished and every skill is switched on. Listing fetches and checks nothing, and
   * publishes no events.
   */
  fastify.get("/api/v1/capabilities/plugins", operatorList, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      markNoStore(reply);
      return reply.send(await requirePlugins(fastify).list());
    } catch (error) {
      return sendPluginError(reply, error, request.log);
    }
  });

  /**
   * One installed plugin, install-wide like the list, and each of its pieces with its state and a link to its own item,
   * all written by the Gateway: a skill read by its Skill Hub check's id, the rest from the plugin's record. Its state
   * follows the list's own rule. 404 for a plugin that isn't installed. Reading writes nothing and publishes no events.
   */
  fastify.get("/api/v1/capabilities/plugins/detail", operatorDetail, async (request, reply) => {
    const query = detailQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    try {
      markNoStore(reply);
      const detail: CapabilityPluginDetail = await requirePlugins(fastify).detail({
        pluginId: query.data.pluginId,
        actorId: actorIdFor(request),
      });
      return reply.send(detail);
    } catch (error) {
      return sendPluginError(reply, error, request.log);
    }
  });

  /**
   * Fetches a plugin source into a snapshot and checks every piece with its owner's normal check: a skill through
   * Skill Hub's review, a connector through the shipped template rule, a tool group through the Tools tab's list, a
   * hook through the hooks address rules and a public host, and a prompt pack through the prompt-pack parser. It
   * installs nothing. 201 with the inspection. A source that can't be fetched answers its own status (403 on
   * `remote_hardened` for a folder, 400 for a bad address or path, 404 for a missing one, 422 for a refused or private
   * one, 502 when its host can't be reached or Git fails) and a refused manifest a 422, each with plain words and
   * `details.code` (`CapabilityPluginRefusal`); a refused manifest's inspection is kept and named by
   * `details.inspectionId`. A plugin that is already installed is a 409. No server path is ever sent. The
   * `Idempotency-Key` names the attempt: sent again by the same operator (or, without sign-in, by any caller, as the
   * idempotency plugin scopes it) for the same request while the inspection is kept (24 hours, the newest 50), it gets
   * the first answer again, the same 201 or the same refused-manifest 422, without fetching or checking anything; with
   * a different request it is a 409. A source refusal keeps nothing, so its key can be tried again.
   */
  fastify.post("/api/v1/capabilities/plugins/inspections", operatorInspect, async (request, reply) => {
    const body = inspectionBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const key = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
    if (!key.success) return reply.code(400).send({ error: KEY_MESSAGE });
    try {
      markNoStore(reply);
      const inspection = await requirePlugins(fastify).inspect({
        workspaceId: body.data.workspaceId,
        source: body.data.source,
        actorId: actorIdFor(request),
        actorScope: idempotencyScopeFor(request),
        idempotencyKey: key.data,
        log: request.log,
        // The Gateway's attempt record says this key was answered: only the kept answer may be sent again.
        replayOnly: request.mutationIdempotencyOutcome === "committed",
      });
      return reply.code(201).send(inspection);
    } catch (error) {
      // A refused manifest's inspection is kept, so its key is answered (and a retry gets the same answer).
      if (error instanceof CapabilityPluginManifestRefusedError) request.mutationCommitted = true;
      return sendPluginError(reply, error, request.log);
    }
  });

  /**
   * Installs a kept inspection's pieces through one Change Plan, confirmed by this request as the operator's own
   * action: 202 with `PluginActionOutcome`, `applied` when the operator's approval skip applies, `waiting` with the
   * Inbox approval's id otherwise, `failed` when the plan stopped (its summary says what was added). Each hook needs a
   * signing secret, kept in the key store; the plan holds only its reference. Every refusal comes before any secret or
   * plan, with its own status and plain words: 404 for a check that ran out of time or a workspace that isn't there,
   * 409 for a plugin already installed, a check that changed, or an id a shipped plugin uses, and 400 for the secrets.
   * The `Idempotency-Key` names the attempt: sent again, it gets the first plan's answer and no secret is stored again.
   */
  fastify.post("/api/v1/capabilities/plugins/install", operatorInstall, async (request, reply) => {
    const body = installBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const key = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
    if (!key.success) return reply.code(400).send({ error: KEY_MESSAGE });
    try {
      markNoStore(reply);
      const outcome: PluginActionOutcome = await requirePlugins(fastify).install({
        workspaceId: body.data.workspaceId,
        inspectionId: body.data.inspectionId,
        ...(body.data.hookSecrets ? { hookSecrets: body.data.hookSecrets } : {}),
        actorId: actorIdFor(request),
        idempotencyKey: key.data,
        requestId: request.id,
        // The Gateway's attempt record says this key was answered: only the first plan's answer may be sent again.
        replayOnly: request.mutationIdempotencyOutcome === "committed",
      });
      return reply.code(202).send(outcome);
    } catch (error) {
      // The input refusals are the service's own plain words, so they answer 400 here.
      if (isGoatError(error) && error.httpStatus === 400) return sendRouteError(reply, error, request.log);
      return sendPluginError(reply, error, request.log, INSTALL_UNAVAILABLE_MESSAGE);
    }
  });

  /**
   * Removes exactly what a plugin added, through one Change Plan confirmed by this request as the operator's own
   * action: 202 with `PluginActionOutcome`, `applied` once the plugin is gone, `waiting` with the approval's id while
   * the plan or a skill's removal waits, `failed` when the plan stopped (its summary says what was removed). What was
   * already there stays, and so do the hosts it allowed. 404 for a plugin that isn't installed, or was installed in
   * another workspace; 409 while another plan for it is under way. The `Idempotency-Key` names the attempt: sent
   * again, it gets the first plan's answer.
   */
  fastify.post("/api/v1/capabilities/plugins/uninstall", operatorUninstall, async (request, reply) => {
    const body = uninstallBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const key = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
    if (!key.success) return reply.code(400).send({ error: KEY_MESSAGE });
    try {
      markNoStore(reply);
      const outcome: PluginActionOutcome = await requirePlugins(fastify).uninstall({
        workspaceId: body.data.workspaceId,
        pluginId: body.data.pluginId,
        actorId: actorIdFor(request),
        idempotencyKey: key.data,
        requestId: request.id,
        // The Gateway's attempt record says this key was answered: only the first plan's answer may be sent again.
        replayOnly: request.mutationIdempotencyOutcome === "committed",
      });
      return reply.code(202).send(outcome);
    } catch (error) {
      return sendPluginError(reply, error, request.log, UNINSTALL_UNAVAILABLE_MESSAGE);
    }
  });

  /** One kept inspection, refused ones included. 404 for one that isn't kept or ran out of time (24 hours). */
  fastify.get("/api/v1/capabilities/plugins/inspections/:inspectionId", operatorRead, async (request, reply) => {
    const params = inspectionParamsSchema.safeParse(request.params);
    const query = inspectionQuerySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.code(400).send({
        error: { params: params.error?.flatten(), query: query.error?.flatten() },
      });
    }
    try {
      markNoStore(reply);
      return reply.send(await requirePlugins(fastify).inspection(params.data.inspectionId));
    } catch (error) {
      return sendPluginError(reply, error, request.log);
    }
  });
};

/** The operator who asked; without an actor from sign-in, the caller's address. */
function actorIdFor(request: { authActorId?: string; ip?: string }): string {
  return request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`;
}

/**
 * The scope the Gateway's idempotency plugin holds the key under (`plugins/idempotency.ts`): the signed-in actor, or ""
 * without sign-in. The kept inspection is found by exactly this scope, so a retry the plugin calls answered always
 * finds its answer, whatever address it comes from.
 */
function idempotencyScopeFor(request: { authActorId?: string }): string {
  return request.authActorId?.trim() || "";
}

/**
 * A refused source or manifest in plain words with its code; a 403, 404, 409 or 422 written by an owner (a plugin's
 * own piece, an id a shipped plugin uses, a check that changed) with its own status and words; "Change Plans are off"
 * and "the key store can't be used" as they say; and anything else as a plain 503. A fault's own message can carry a
 * temp path or another owner's words, so it stays in the log.
 */
function sendPluginError(
  reply: FastifyReply,
  error: unknown,
  log: FastifyBaseLogger,
  unavailableMessage = UNAVAILABLE_MESSAGE,
) {
  if (error instanceof PluginSourceError) {
    log.warn({ code: error.reason, err: diagnosticOf(error.cause) }, "a plugin source was refused");
    return reply.code(error.statusCode).send(refusalBody(error.message, { code: error.reason }));
  }
  if (error instanceof CapabilityPluginManifestRefusedError) {
    const { inspection, field } = error;
    return reply.code(422).send(
      refusalBody(inspection.refusal?.message ?? error.message, {
        code: inspection.refusal?.code ?? "MANIFEST_INVALID",
        inspectionId: inspection.inspectionId,
        ...(field ? { field } : {}),
      }),
    );
  }
  if (isGoatError(error) && ANSWERED_STATUSES.has(error.httpStatus)) return sendRouteError(reply, error, log);
  if (error instanceof ServiceUnavailableError && ANSWERED_UNAVAILABLE_REASONS.has(error.details?.reason)) {
    return sendRouteError(reply, error, log);
  }
  log.error({ err: diagnosticOf(error) }, "a plugins request failed");
  return sendRouteError(reply, new ServiceUnavailableError(unavailableMessage), log);
}

function refusalBody(message: string, details: CapabilityPluginRefusal["details"]): CapabilityPluginRefusal {
  return { error: message, code: CAPABILITY_PLUGIN_REFUSED_CODE, details };
}

function diagnosticOf(error: unknown): unknown {
  if (error === undefined) return undefined;
  const diagnostic =
    error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
  return redactStructuredSecrets(diagnostic).value;
}

function requirePlugins(fastify: FastifyInstance) {
  const owner = fastify.services.capabilityPlugins;
  if (!owner) throw new ServiceUnavailableError(UNAVAILABLE_MESSAGE);
  return owner;
}

function markNoStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
}
