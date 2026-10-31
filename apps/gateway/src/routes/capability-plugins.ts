import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CAPABILITY_PLUGIN_REFUSED_CODE,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  pluginManifestSchema,
  redactStructuredSecrets,
  type CapabilityPluginRefusal,
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
// A key names one attempt, so the same key from the same operator gets the same answer: up to 256 plain characters, the
// bound the Gateway's own attempt read takes.
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\p{L}\p{N}._:@/+*-]+$/u);

const UNAVAILABLE_MESSAGE = "Plugins can't be read right now.";
const KEY_MESSAGE = "Send an Idempotency-Key header of up to 256 letters, digits or . _ : @ / + * - characters.";
// The list reads the plugin store, the shipped manifests and, for installed plugins with skills, Skill Hub's checks.
const LIST_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
// An inspection fetches a whole source (a Git clone, say) and runs every piece's check.
const INSPECTION_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;
const READ_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
// The body is a workspace and a source; the bound matches the other operator saves.
const BODY_LIMIT = 20 * 1_024;

/**
 * Capabilities › Plugins: the installed and built-in plugins, inspecting a plugin source, and reading an inspection
 * back. Inspecting installs nothing and asks for no approval.
 */
export const capabilityPluginsRoutes: FastifyPluginAsync = async (fastify) => {
  const operatorList = withRouteAccess(fastify, "operator", { config: { rateLimit: LIST_RATE_LIMIT } });
  const operatorInspect = withRouteAccess(fastify, "operator", {
    bodyLimit: BODY_LIMIT,
    config: { rateLimit: INSPECTION_RATE_LIMIT },
  });
  const operatorRead = withRouteAccess(fastify, "operator", { config: { rateLimit: READ_RATE_LIMIT } });

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
 * A refused source or manifest in plain words with its code, a 409 or 404 written by the plugin owners, and anything
 * else as a plain 503. A fault's own message can carry a temp path or another owner's words, so it stays in the log.
 */
function sendPluginError(reply: FastifyReply, error: unknown, log: FastifyBaseLogger) {
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
  if (error instanceof ConflictError || error instanceof NotFoundError) return sendRouteError(reply, error, log);
  log.error({ err: diagnosticOf(error) }, "plugins could not be read");
  return sendRouteError(reply, new ServiceUnavailableError(UNAVAILABLE_MESSAGE), log);
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
