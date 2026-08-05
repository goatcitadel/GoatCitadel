import type { FastifyInstance } from "fastify";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  buildSlackOAuthConnectionInput,
  buildSlackOAuthStart,
  exchangeSlackOAuthCode,
  redactSlackOAuthConnection,
  summarizeSlackOAuthInstall,
  verifySlackOAuthState,
} from "../services/slack-oauth-service.js";
import { readConfigString, slackOAuthCallbackQuerySchema, slackOAuthDisconnectSchema } from "./integrations-shared.js";

const SLACK_OAUTH_RATE_LIMIT_MAX = 60;
const slackOAuthRouteOptions = {
  config: {
    rateLimit: {
      max: SLACK_OAUTH_RATE_LIMIT_MAX,
    },
  },
} as const;

export function registerSlackOAuthIntegrationRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/v1/integrations/slack/oauth/status", slackOAuthRouteOptions, async (_request, reply) => {
    const start = buildSlackOAuthStart(readSlackOAuthConfig());
    const allConnections: IntegrationConnection[] = await fastify.services.integrations.listIntegrationConnections(
      "channel",
      300,
    );
    const connections = allConnections
      .filter((connection) => connection.catalogId === "channel.slack" && connection.config.authMode === "oauth")
      .map((connection) => ({
        connection: redactSlackOAuthConnection(connection),
        install: summarizeSlackOAuthInstall(connection),
      }));
    return reply.send({
      configured: start.configured,
      mode: start.mode,
      scopes: start.scopes,
      missing: start.missing,
      connections,
    });
  });

  fastify.post("/api/v1/integrations/slack/oauth/start", slackOAuthRouteOptions, async (request, reply) => {
    const rawOrigin = request.headers.origin || request.headers.referer;
    let origin: string | undefined;
    if (typeof rawOrigin === "string" && rawOrigin.trim().length > 0) {
      try {
        origin = new URL(rawOrigin).origin;
      } catch {
        // ignore malformed URLs
      }
    }

    const start = buildSlackOAuthStart({
      ...readSlackOAuthConfig(),
      origin,
    });
    if (!start.configured) {
      return reply.code(400).send({
        error: "Slack OAuth is not configured.",
        missing: start.missing,
      });
    }
    return reply.send(start);
  });

  fastify.get("/api/v1/integrations/slack/oauth/callback", slackOAuthRouteOptions, async (request, reply) => {
    const parsed = slackOAuthCallbackQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const config = readSlackOAuthConfig();
    if (!config.clientId || !config.clientSecret || !config.redirectUri || !config.stateSecret) {
      return reply.code(400).send({ error: "Slack OAuth is not configured." });
    }
    if (!verifySlackOAuthState(parsed.data.state, config.stateSecret)) {
      return reply.code(400).send({ error: "Invalid or expired Slack OAuth state." });
    }

    let targetOrigin = "http://localhost:5173";
    try {
      const allowedOrigins = resolveAllowedOrigins();
      const firstAllowed = Array.from(allowedOrigins)[0];
      if (firstAllowed) {
        targetOrigin = firstAllowed;
      }

      const [encoded] = parsed.data.state.split(".");
      if (encoded) {
        const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        if (typeof decoded.origin === "string" && /^https?:\/\//i.test(decoded.origin)) {
          const originUrl = new URL(decoded.origin).origin;
          if (allowedOrigins.has(originUrl)) {
            targetOrigin = originUrl;
          }
        }
      }
    } catch {
      // fallback to default targetOrigin
    }

    try {
      const payload = await exchangeSlackOAuthCode({
        code: parsed.data.code,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.redirectUri,
        fetcher: (url, init) => fetch(url, init),
      });
      const connectionInput = buildSlackOAuthConnectionInput(payload);
      const existingConnection = findExistingSlackOAuthConnection(
        await fastify.services.integrations.listIntegrationConnections("channel", 300),
        connectionInput.config,
      );
      const connection = existingConnection
        ? await fastify.services.integrations.updateIntegrationConnection(existingConnection.connectionId, {
            label: connectionInput.label,
            enabled: true,
            status: "connected",
            lastError: undefined,
            config: mergeSlackOAuthConfig(existingConnection.config, connectionInput.config),
          })
        : await fastify.services.integrations.createIntegrationConnection(connectionInput);
      const result = {
        connection: redactSlackOAuthConnection(connection),
        install: summarizeSlackOAuthInstall(connection),
      };
      if (request.headers.accept?.includes("text/html")) {
        return reply.type("text/html").send(renderSlackOAuthSuccessPage(result, targetOrigin));
      }
      return reply.send(result);
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/integrations/slack/oauth/disconnect", slackOAuthRouteOptions, async (request, reply) => {
    const parsed = slackOAuthDisconnectSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const current = await fastify.services.integrations.getIntegrationConnection(parsed.data.connectionId);
      if (current.catalogId !== "channel.slack" || current.config.authMode !== "oauth") {
        return reply.code(400).send({ error: "Connection is not a Slack OAuth install." });
      }
      const connection = await fastify.services.integrations.updateIntegrationConnection(parsed.data.connectionId, {
        enabled: false,
        status: "disconnected",
        lastError: undefined,
      });
      return reply.send({ connection: redactSlackOAuthConnection(connection) });
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });
}

function readSlackOAuthConfig() {
  return {
    clientId: process.env.GOATCITADEL_SLACK_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOATCITADEL_SLACK_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.GOATCITADEL_SLACK_OAUTH_REDIRECT_URI,
    stateSecret: process.env.GOATCITADEL_SLACK_OAUTH_STATE_SECRET,
    scopes: process.env.GOATCITADEL_SLACK_OAUTH_SCOPES,
    brokerAuthorizeUrl: process.env.GOATCITADEL_SLACK_OAUTH_BROKER_AUTHORIZE_URL,
  };
}

function findExistingSlackOAuthConnection(
  connections: IntegrationConnection[],
  nextConfig: Record<string, unknown>,
): IntegrationConnection | undefined {
  const nextTeamId = readConfigString(nextConfig, "slackTeamId");
  const nextInstallId = readConfigString(nextConfig, "slackInstallId");
  return connections.find((connection) => {
    if (connection.catalogId !== "channel.slack" || connection.config.authMode !== "oauth") {
      return false;
    }
    return Boolean(
      (nextTeamId && readConfigString(connection.config, "slackTeamId") === nextTeamId) ||
      (nextInstallId && readConfigString(connection.config, "slackInstallId") === nextInstallId),
    );
  });
}

function mergeSlackOAuthConfig(
  existingConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>,
): Record<string, unknown> {
  const nextTargets = Array.isArray(nextConfig.targets) ? nextConfig.targets : [];
  return {
    ...existingConfig,
    ...nextConfig,
    targets: nextTargets.length > 0 ? nextTargets : existingConfig.targets,
    defaultChannel:
      readConfigString(nextConfig, "defaultChannel") ?? readConfigString(existingConfig, "defaultChannel"),
    defaultThreadTs: readConfigString(existingConfig, "defaultThreadTs"),
  };
}

function renderSlackOAuthSuccessPage(
  result: {
    connection: IntegrationConnection;
    install: ReturnType<typeof summarizeSlackOAuthInstall>;
  },
  targetOrigin: string,
): string {
  const payload = JSON.stringify({
    type: "goatcitadel.slackOAuth.connected",
    connectionId: result.connection.connectionId,
    teamName: result.install.teamName,
    teamId: result.install.teamId,
  }).replaceAll("<", "\\u003c");
  const teamName = escapeHtml(result.install.teamName ?? "Slack workspace");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Slack connected</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; color: #dff7f4; background: #071112; }
      main { max-width: 560px; padding: 32px; text-align: center; }
      h1 { font-size: 24px; margin: 0 0 12px; }
      p { color: #9ac7c2; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Slack connected</h1>
      <p>${teamName} is connected. You can return to GoatCitadel and choose channel targets.</p>
    </main>
    <script>
      if (window.opener) {
        window.opener.postMessage(${payload}, ${JSON.stringify(targetOrigin)});
        window.setTimeout(() => window.close(), 700);
      }
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolveAllowedOrigins(): Set<string> {
  const defaults = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://127.0.0.1:8787",
  ];
  const envRaw = process.env.GOATCITADEL_ALLOWED_ORIGINS;
  if (!envRaw?.trim()) {
    return new Set(defaults);
  }
  const fromEnv = envRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((rawOrigin) => {
      try {
        const origin = new URL(rawOrigin);
        if (origin.protocol !== "http:" && origin.protocol !== "https:") {
          return "";
        }
        return origin.origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  return new Set(fromEnv.length > 0 ? fromEnv : defaults);
}
