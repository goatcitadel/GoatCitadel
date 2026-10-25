import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GOOGLE_WORKSPACE_CAPABILITIES } from "@goatcitadel/contracts";
import { GOOGLE_OAUTH_CALLBACK_PATH } from "../services/google-workspace-oauth-service.js";
import { markMutationCommitted, markMutationCommittedFromError } from "../plugins/idempotency.js";
import { sendRouteError } from "./_error-handler.js";
import { allowedRequestOrigin, rejectDisallowedRequestOrigin } from "./allowed-request-origin.js";
import { createOAuthCallbackHandoff } from "./oauth-callback-handoff.js";

/** Mission Control lands Google's redirect on Integrations; the code travels only in the URL fragment. */
export const GOOGLE_OAUTH_RETURN_ROUTE = "/settings/connections";
export const GOOGLE_OAUTH_RETURN_FRAGMENT = "google-oauth-return";

const handoff = createOAuthCallbackHandoff({
  path: GOOGLE_OAUTH_CALLBACK_PATH,
  returnRoute: GOOGLE_OAUTH_RETURN_ROUTE,
  fragment: GOOGLE_OAUTH_RETURN_FRAGMENT,
});

export function __resetGoogleOAuthReturnsForTests(): void {
  handoff.reset();
}

// Bodies carry a client secret or an authorization code: never log them.
const mutationRoute = { logLevel: "silent", config: { rateLimit: { max: 30 } } } as const;
const paramsSchema = z.object({ connectionId: z.string().trim().min(1).max(160) }).strict();
const startSchema = z
  .object({
    capabilities: z.array(z.enum(GOOGLE_WORKSPACE_CAPABILITIES)).min(1).max(GOOGLE_WORKSPACE_CAPABILITIES.length),
    clientSecret: z.string().max(512).optional(),
  })
  .strict();
const completeSchema = z.object({ state: z.guid(), code: z.string().trim().min(1).max(4096) }).strict();
const disconnectSchema = z.object({}).strict();

export function registerGoogleOAuthIntegrationRoutes(fastify: FastifyInstance): void {
  handoff.register(fastify);

  fastify.get("/api/v1/integrations/connections/:connectionId/google-oauth", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "A connection id is required." });
    reply.header("cache-control", "no-store");
    try {
      return reply.send(await fastify.services.integrations.getGoogleWorkspaceOAuthStatus(params.data.connectionId));
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/google-oauth/start",
    mutationRoute,
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const body = startSchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "Choose the Google capabilities to request." });
      }
      if (rejectDisallowedRequestOrigin(request, reply)) return reply;
      reply.header("cache-control", "no-store");
      try {
        const flow = await fastify.services.integrations.startGoogleWorkspaceOAuth(params.data.connectionId, body.data);
        handoff.remember(flow.state, allowedRequestOrigin(request));
        await markMutationCommitted(request);
        return reply.send(flow);
      } catch (error) {
        await markMutationCommittedFromError(request, error);
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/google-oauth/complete",
    mutationRoute,
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const body = completeSchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "The sign-in state and code from Google are required." });
      }
      reply.header("cache-control", "no-store");
      try {
        const status = await fastify.services.integrations.completeGoogleWorkspaceOAuth(
          params.data.connectionId,
          body.data,
        );
        await markMutationCommitted(request);
        return reply.send(status);
      } catch (error) {
        await markMutationCommittedFromError(request, error);
        return sendRouteError(reply, error, request.log);
      }
    },
  );

  fastify.post(
    "/api/v1/integrations/connections/:connectionId/google-oauth/disconnect",
    mutationRoute,
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success || !disconnectSchema.safeParse(request.body ?? {}).success) {
        return reply.code(400).send({ error: "A connection id is required." });
      }
      try {
        const result = await fastify.services.integrations.disconnectGoogleWorkspaceOAuth(params.data.connectionId);
        await markMutationCommitted(request);
        return reply.send(result);
      } catch (error) {
        await markMutationCommittedFromError(request, error);
        return sendRouteError(reply, error, request.log);
      }
    },
  );
}
