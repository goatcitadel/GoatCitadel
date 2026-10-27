import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  ConflictError,
  ServiceUnavailableError,
  type ChangePlanRecord,
  type ChangePlanReceipt,
  type ConnectorInstallResponse,
} from "@goatcitadel/contracts";
import { sendRouteError } from "./_error-handler.js";

const querySchema = z.object({ workspaceId: z.string().min(1).max(200) }).strict();
const installBodySchema = z
  .object({ templateId: z.string().min(1).max(200), enableChatConnectors: z.boolean() })
  .strict();

/** Capabilities › Apps: the list of every app the AI can use, and installing one from its template. */
export const capabilityConnectorsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * One merged, read-only list for a workspace. It reads local state only: no live checks, no realtime events, and no
   * secret value ever appears in the response.
   */
  fastify.get(
    "/api/v1/capabilities/connectors",
    // Tighter than the general read bucket: each list reads MCP, integrations, web search and settings.
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const query = querySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
      try {
        markNoStore(reply);
        return reply.send(await requireOwner(fastify).list(query.data.workspaceId));
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  /**
   * Installs a connector from its template through one Change Plan: allow its hosts, save it switched off with
   * "Reading is free", and optionally let Chat use connectors. The answer is 202 with the plan's receipt, which either
   * finished or waits for an approval in the Inbox.
   */
  fastify.post(
    "/api/v1/capabilities/connectors/install",
    // The body is a template id and one switch; the bound matches the other operator save routes.
    { bodyLimit: 20 * 1_024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = installBodySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
      try {
        markNoStore(reply);
        const evolution = await requireEvolution(fastify);
        // Installs are installation-wide: the allowed hosts, saved connectors and the Chat switch have no workspace.
        const actor = {
          workspaceId: "default",
          actorId: request.authActorId?.trim() || `ip:${request.ip ?? "unknown"}`,
          surface: "capabilities" as const,
          requestId: request.id,
        };
        const plan = await evolution.create({
          actor,
          request: { kind: "connector_install", ...body.data },
          idempotencyKey: `capabilities:install:${request.idempotencyKey || request.id}:${body.data.templateId}`,
        });
        if (plan.requiredAction?.kind !== "confirmation") {
          throw new ConflictError({
            message: "This install is no longer waiting to be confirmed. Try installing again.",
          });
        }
        // This route is the operator's own install, so it may ask for the opt-in approval skip.
        const settled = await evolution.confirm(actor, plan.planId, plan.revision, plan.requiredAction.actionNonce, {
          operatorSettingsSave: true,
        });
        const response: ConnectorInstallResponse = {
          templateId: body.data.templateId,
          changePlanReceipt: receiptFor(settled),
        };
        return reply.code(202).send(response);
      } catch (error) {
        return sendRouteError(reply, error, request.log);
      }
    },
  );
};

function requireOwner(fastify: FastifyInstance) {
  const owner = fastify.services.capabilityConnectors;
  if (!owner) throw new ServiceUnavailableError("The Capabilities app list is unavailable.");
  return owner;
}

/** Installs are Change Plans, with no direct-write fallback, so they wait for Change Plans to be on. */
async function requireEvolution(fastify: FastifyInstance) {
  const evolution = fastify.services.evolution;
  if (!evolution || !(await evolution.isEnabled())) {
    throw new ServiceUnavailableError("Installing connectors needs Change Plans, which are off on this install.");
  }
  return evolution;
}

function receiptFor(plan: ChangePlanRecord): ChangePlanReceipt {
  return {
    planId: plan.planId,
    status: plan.status,
    revision: plan.revision,
    risk: plan.risk,
    ...(plan.requiredAction ? { requiredAction: plan.requiredAction } : {}),
    summary: plan.result?.summary ?? plan.summary,
  };
}

function markNoStore(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store");
}
