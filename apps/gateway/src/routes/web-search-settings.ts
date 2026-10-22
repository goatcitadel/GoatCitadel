import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { ConflictError, ServiceUnavailableError, WEB_SEARCH_CREDENTIAL_TARGET_IDS } from "@goatcitadel/contracts";
import type { EvolutionControlPlaneActor } from "../services/evolution-control-plane-service.js";
import { sendRouteError } from "./_error-handler.js";

const paramsSchema = z.object({ targetId: z.enum(WEB_SEARCH_CREDENTIAL_TARGET_IDS) });
const storeSchema = z
  .object({
    apiKey: z.string().min(1).max(8_192),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
const clearSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();

const statusRouteOptions = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
const mutationRouteOptions = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
const checkRouteOptions = { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } };

/**
 * Settings › Web & Search. Key values arrive only on PUT, are checked live and stored in the
 * OS keychain through the governed Change Plan path, and never appear in a response.
 */
export const webSearchSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/settings/web/credentials", statusRouteOptions, async (request, reply) => {
    try {
      markNoStore(reply);
      return reply.send({ items: requireOwner(fastify).listStatuses() });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post("/api/v1/settings/web/firecrawl/check", checkRouteOptions, async (request, reply) => {
    try {
      markNoStore(reply);
      return reply.send(await requireOwner(fastify).checkFirecrawl());
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.put("/api/v1/settings/web/credentials/:targetId", mutationRouteOptions, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const body = storeSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const { targetId } = params.data;
    try {
      markNoStore(reply);
      const owner = requireOwner(fastify);
      const evolution = fastify.services.evolution;
      if (!evolution || !(await evolution.isEnabled())) {
        return reply.send({ status: await owner.store(targetId, body.data.apiKey) });
      }
      const submit = fastify.services.evolutionRuntimeConfiguration?.submitWebSearchCredential;
      if (!submit) throw new ServiceUnavailableError("The web-search key secure owner is unavailable.");
      // Fail before a plan exists: an orphaned awaiting-input plan would block the next save.
      if (!owner.status(targetId).keychainAvailable) {
        throw new ServiceUnavailableError("Saving a web-search key requires an available OS keychain.");
      }
      const actor = settingsActor(request);
      const plan = await evolution.create({
        actor,
        request: {
          kind: "runtime_configuration",
          change: { operation: "web_search_credential", targetId, action: "replace" },
        },
        idempotencyKey: `web-search-key-save:${request.idempotencyKey || request.id}:${body.data.expectedRevision}`,
        expectedTargetRevision: body.data.expectedRevision,
      });
      if (plan.requiredAction?.kind !== "secure_input") {
        throw new ConflictError({ message: "The web-search key plan is not awaiting secure input." });
      }
      const supplied = await submit({
        actor,
        planId: plan.planId,
        expectedRevision: plan.revision,
        actionId: plan.requiredAction.actionId,
        actionNonce: plan.requiredAction.actionNonce,
        apiKey: body.data.apiKey,
      }).catch(async (error: unknown) => {
        await evolution.cancel(actor, plan.planId, plan.revision).catch((cancelError: unknown) => {
          request.log.warn({ planId: plan.planId, err: cancelError }, "web-search key plan cancel failed");
        });
        throw error;
      });
      if (supplied.requiredAction?.kind !== "confirmation") {
        throw new ConflictError({ message: "The web-search key plan is not ready for confirmation." });
      }
      const settled = await evolution.confirm(
        actor,
        supplied.planId,
        supplied.revision,
        supplied.requiredAction.actionNonce,
      );
      return reply.send({ status: owner.status(targetId), changePlanReceipt: receipt(settled) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.delete("/api/v1/settings/web/credentials/:targetId", mutationRouteOptions, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const body = clearSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const { targetId } = params.data;
    try {
      markNoStore(reply);
      const owner = requireOwner(fastify);
      const evolution = fastify.services.evolution;
      if (!evolution || !(await evolution.isEnabled())) {
        return reply.send({ status: await owner.clear(targetId) });
      }
      const actor = settingsActor(request);
      const plan = await evolution.create({
        actor,
        request: {
          kind: "runtime_configuration",
          change: { operation: "web_search_credential", targetId, action: "remove" },
        },
        idempotencyKey: `web-search-key-remove:${request.idempotencyKey || request.id}:${body.data.expectedRevision}`,
        expectedTargetRevision: body.data.expectedRevision,
      });
      if (plan.requiredAction?.kind !== "confirmation") {
        throw new ConflictError({ message: "The web-search key removal plan is not ready for confirmation." });
      }
      const settled = await evolution.confirm(actor, plan.planId, plan.revision, plan.requiredAction.actionNonce);
      return reply.send({ status: owner.status(targetId), changePlanReceipt: receipt(settled) });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};

function requireOwner(fastify: FastifyInstance) {
  const owner = fastify.services.webSearchCredentials;
  if (!owner) throw new ServiceUnavailableError("The web-search credential owner is unavailable.");
  return owner;
}

function markNoStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
}

function settingsActor(request: FastifyRequest): EvolutionControlPlaneActor {
  return {
    workspaceId: "default",
    actorId: request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`,
    surface: "settings",
    requestId: request.id,
  };
}

function receipt(plan: {
  planId: string;
  status: string;
  revision: number;
  risk: string;
  summary: string;
  requiredAction?: unknown;
  result?: { summary?: string };
}) {
  return {
    planId: plan.planId,
    status: plan.status,
    revision: plan.revision,
    risk: plan.risk,
    requiredAction: plan.requiredAction,
    summary: plan.result?.summary ?? plan.summary,
  };
}
