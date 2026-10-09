import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ChannelOAuthActor } from "../services/channel-oauth-staging-service.js";
import type { ChannelOAuthAttempt } from "@goatcitadel/contracts";
import { buildSlackOAuthStart, redactSlackOAuthConnection } from "../services/slack-oauth-service.js";
import { slackOAuthDisconnectSchema } from "./integrations-shared.js";
import { sendRouteError } from "./_error-handler.js";
import { markMutationCommitted, markMutationCommittedFromError, commitMutationIdempotencyAlongsideCanonicalWrite } from "../plugins/idempotency.js";

const routeOptions = { logLevel: "silent", config: { rateLimit: { max: 60 } } } as const;
const startSchema = z.object({ workspaceId: z.string().trim().min(1).max(160), draftId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();
const statusSchema = z.object({ workspaceId: z.string().trim().min(1).max(160), attemptId: z.string().uuid() }).strict();
const adoptSchema = startSchema.extend({ attemptId: z.string().uuid() }).strict();
const cancelSchema = statusSchema.extend({ expectedRevision: z.number().int().positive() }).strict();
const callbackSchema = z.object({ state: z.string().min(1).max(4096), code: z.string().min(1).max(4096).optional(), error: z.string().max(128).optional() }).strict()
  .refine((input) => Boolean(input.code) !== Boolean(input.error));

export function registerSlackOAuthIntegrationRoutes(fastify: FastifyInstance): void {
  fastify.addHook("preHandler", async (request, reply) => {
    if (request.url.split("?", 1)[0]?.startsWith("/api/v1/integrations/slack/oauth/")) {
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
    }
  });
  fastify.addHook("onReady", async () => {
    if (fastify.services.channelSetup.recoverInterruptedChannelOAuthAttempts) {
      await fastify.services.channelSetup.recoverInterruptedChannelOAuthAttempts();
    }
    await fastify.services.channelSetup.cleanupChannelOAuthAttempts?.();
  });
  const cleanupTimer = setInterval(() => {
    void Promise.resolve(fastify.services.channelSetup.cleanupChannelOAuthAttempts?.()).catch(() => {
      fastify.log.warn("Staged channel OAuth credential cleanup will be retried.");
    });
  }, 60_000);
  cleanupTimer.unref();
  fastify.addHook("onClose", async () => { clearInterval(cleanupTimer); });

  fastify.get("/api/v1/integrations/slack/oauth/status", routeOptions, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (!query || Object.keys(query).length === 0) {
      const { configured, mode, scopes, missing } = buildSlackOAuthStart(readSlackOAuthConfig());
      return reply.send({ configured, mode, scopes, missing, connections: [] });
    }
    const parsed = statusSchema.safeParse(query);
    if (!parsed.success) return reply.code(400).send({ error: "An exact workspace and OAuth attempt are required." });
    try {
      return reply.send(await fastify.services.channelSetup.getChannelOAuthAttempt(actorFor(request, parsed.data.workspaceId), parsed.data));
    } catch (error) { await markMutationCommittedFromError(request, error); return sendRouteError(reply, error, request.log); }
  });
  fastify.post("/api/v1/integrations/slack/oauth/start", routeOptions, async (request, reply) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "A workspace, Slack draft, and current draft revision are required." });
    try {
      const result = await fastify.services.channelSetup.startSlackOAuthAttempt(
        actorFor(request, parsed.data.workspaceId), parsed.data, { ...readSlackOAuthConfig(), origin: allowedRequestOrigin(request) },
      );
      if (!result.configured) return reply.code(400).send({ error: "Slack OAuth is not configured.", missing: result.missing });
      await markMutationCommitted(request);
      return reply.send(result);
    } catch (error) { await markMutationCommittedFromError(request, error); return sendRouteError(reply, error, request.log); }
  });
  fastify.get("/api/v1/integrations/slack/oauth/callback", routeOptions, async (request, reply) => {
    const parsed = callbackSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "A valid Slack OAuth state and result are required." });
    try {
      const attempt: ChannelOAuthAttempt = await fastify.services.channelSetup.completeSlackOAuthAttempt(
        parsed.data.state, readSlackOAuthConfig(), parsed.data.code, Boolean(parsed.data.error),
      );
      if (request.headers.accept?.includes("text/html")) {
        return reply.type("text/html").send(renderSlackOAuthResultPage(attempt));
      }
      return reply.send(attempt);
    } catch (error) { await markMutationCommittedFromError(request, error); return sendRouteError(reply, error, request.log); }
  });
  fastify.post("/api/v1/integrations/slack/oauth/adopt", routeOptions, async (request, reply) => {
    const parsed = adoptSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "An exact OAuth attempt and current draft revision are required." });
    try {
      const result = await fastify.services.channelSetup.adoptSlackOAuthAttempt(actorFor(request, parsed.data.workspaceId), parsed.data, () => commitMutationIdempotencyAlongsideCanonicalWrite(request));
      await markMutationCommitted(request);
      return reply.send(result);
    } catch (error) { await markMutationCommittedFromError(request, error); return sendRouteError(reply, error, request.log); }
  });
  fastify.post("/api/v1/integrations/slack/oauth/cancel", routeOptions, async (request, reply) => {
    const parsed = cancelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "An exact OAuth attempt and revision are required." });
    try {
      const result = await fastify.services.channelSetup.cancelChannelOAuthAttempt(actorFor(request, parsed.data.workspaceId), parsed.data);
      await markMutationCommitted(request);
      return reply.send(result);
    } catch (error) { await markMutationCommittedFromError(request, error); return sendRouteError(reply, error, request.log); }
  });
  fastify.post("/api/v1/integrations/slack/oauth/disconnect", routeOptions, async (request, reply) => {
    const parsed = slackOAuthDisconnectSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "A Slack connection is required." });
    try {
      const current = await fastify.services.integrations.getIntegrationConnection(parsed.data.connectionId);
      if (current.catalogId !== "channel.slack" || current.config.authMode !== "oauth") {
        return reply.code(400).send({ error: "Connection is not a Slack OAuth install." });
      }
      const connection = await fastify.services.integrations.updateIntegrationConnection(current.connectionId, {
        expectedRevision: current.revision, enabled: false, status: "disconnected", lastError: undefined,
      });
      await markMutationCommitted(request);
      return reply.send({ connection: redactSlackOAuthConnection(connection) });
    } catch (error) { await markMutationCommittedFromError(request, error); return sendRouteError(reply, error, request.log); }
  });
}
function actorFor(request: FastifyRequest, workspaceId: string): ChannelOAuthActor {
  return { actorId: request.authActorId?.trim() || "anonymous", workspaceId };
}
function readSlackOAuthConfig() {
  return {
    clientId: process.env.GOATCITADEL_SLACK_OAUTH_CLIENT_ID, clientSecret: process.env.GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.GOATCITADEL_SLACK_OAUTH_REDIRECT_URI, stateSecret: process.env.GOATCITADEL_SLACK_OAUTH_STATE_SECRET,
    scopes: process.env.GOATCITADEL_SLACK_OAUTH_SCOPES, brokerAuthorizeUrl: process.env.GOATCITADEL_SLACK_OAUTH_BROKER_AUTHORIZE_URL,
  };
}
function allowedRequestOrigin(request: FastifyRequest): string | undefined {
  const raw = request.headers.origin || request.headers.referer;
  if (typeof raw !== "string") return undefined;
  try {
    const origin = new URL(raw).origin;
    const allowed = (process.env.GOATCITADEL_ALLOWED_ORIGINS ??
      "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,http://127.0.0.1:8787")
      .split(",").map((value) => value.trim());
    return allowed.includes(origin) ? origin : undefined;
  } catch { return undefined; }
}
function renderSlackOAuthResultPage(attempt: ChannelOAuthAttempt): string {
  const ready = attempt.status === "ready";
  const title = ready ? "Slack installation ready for review" : "Slack installation needs attention";
  const name = escapeHtml(attempt.install?.teamName ?? "Slack workspace");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;color:#dff7f4;background:#071112}main{max-width:560px;padding:32px;text-align:center}p{color:#9ac7c2;line-height:1.5}</style>
</head><body><main><h1>${title}</h1><p>${ready ? `${name} was authorized. Return to GoatCitadel to review and adopt this installation, choose targets, and apply its Change Plan.` : "Return to GoatCitadel to review this attempt and start again if needed."}</p></main></body></html>`;
}
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}